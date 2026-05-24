/**
 * Pre-dispatch validation + coercion for local-LLM tool calls.
 *
 * Phase 1 of `plans/tool-call-guard-layer.md`:
 *   - Stage 1: tool-name fuzzy match (normalize separators,
 *     Levenshtein-bounded best-match suggestion)
 *   - Stage 3: type coercions (scalar → array for array-typed
 *     schema fields)
 *
 * Stages 2 (per-skill arg renames) and 4 (pre-dispatch schema
 * check + targeted corrective prompts) ship in subsequent
 * phases.
 *
 * Background: qwen tool emission has zero JSON-schema enforcement
 * on the wire (ollama.ts forces `formatWithTools: false` for the
 * qwen family because the combination breaks tool_calls). The
 * result is ~830 invalid tool-call responses observed in recent
 * code-analyzer runs, all dispatched + rejected by the skill
 * runner with a round-trip cost. This guard catches recurring
 * patterns *before* dispatch, saving the round-trip.
 *
 * Safe-by-default: when in doubt, pass the call through unchanged
 * and let the skill runner be the authoritative arbiter. The
 * guard's job is to catch high-confidence corrections + provide
 * useful rejections; it must NEVER silently rewrite a call in a
 * way the model didn't intend.
 */

import type { ToolCall, ToolResult } from '../shared/types.js';
import { getSkill, listSkills } from '../daemon/skills/registry.js';
import { validate } from '../daemon/skills/json-schema.js';
import { getLogger } from '../shared/logger.js';
import { getArgRenames, applyArgRenames } from './tool-call-guard-rules.js';

const log = getLogger('tool-call-guard');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type GuardOutcome =
	| {
		readonly kind: 'pass';
		readonly call: ToolCall;
	}
	| {
		readonly kind: 'coerced';
		readonly call:  ToolCall;
		readonly notes: readonly string[];
	}
	| {
		readonly kind:             'rejected';
		readonly correctiveResult: ToolResult;
		readonly reason:           string;
		/** Best-effort suggestion (only set for unknown-tool rejections). */
		readonly suggestions?:     readonly string[];
	};

/**
 * Optional dependency injection for tests. Defaults read from the
 * global skill registry. Tests inject fakes to exercise specific
 * scenarios without registering skills.
 */
export interface GuardDeps {
	readonly listSkillIds?:       () => readonly string[];
	readonly getSkillInputSchema?: (id: string) => Record<string, unknown> | undefined;
	/**
	 * Per-skill arg-rename rules. Defaults to the curated map in
	 * `tool-call-guard-rules.ts`. Tests inject synthetic rules to
	 * exercise rename behaviour in isolation.
	 */
	readonly getArgRenames?:      (skillId: string) => Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Levenshtein threshold for "close enough to coerce" -- below this
 *  AND the best match must be unambiguous (no near-tie). */
const FUZZY_COERCE_MAX_DISTANCE = 2;

/** How many close-name suggestions to surface in an unknown-tool
 *  rejection. The model picks one; surfacing too many is noise. */
const SUGGEST_TOP_N = 3;

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Run the pre-dispatch guard pipeline on a ToolCall. Returns a
 * GuardOutcome describing whether to dispatch as-is, dispatch a
 * coerced shape, or skip dispatch entirely.
 */
export async function guardLocalToolCall(
	call:   ToolCall,
	deps?:  GuardDeps,
): Promise<GuardOutcome> {
	const listIds = deps?.listSkillIds ?? defaultListSkillIds;
	const getSchema = deps?.getSkillInputSchema ?? defaultGetSkillInputSchema;
	const getRenames = deps?.getArgRenames ?? getArgRenames;

	const knownIds = listIds();

	// Stage 1: tool-name resolution.
	const nameOutcome = resolveToolName(call, knownIds);
	if (nameOutcome.kind === 'rejected') {
		return nameOutcome;
	}
	const resolvedName  = nameOutcome.name;
	const nameNotes     = nameOutcome.notes;

	// Stage 2: per-skill arg renames (rules are data; see
	// `tool-call-guard-rules.ts`). Runs AFTER name resolution so the
	// rename map looks up by the canonical skill id, not by the
	// model's possibly-misspelled emission. Runs BEFORE Stage 3 so
	// the type coercer sees the right arg names.
	const renames = getRenames(resolvedName);
	const renamed = applyArgRenames(call.input, renames);

	// Stage 3: type coercions against the resolved skill's input schema.
	const schema = getSchema(resolvedName);
	const coerced = schema !== undefined
		? coerceInputTypes(renamed.input, schema)
		: { input: renamed.input, notes: [] as string[] };

	// Stage 4: pre-dispatch schema validation. Runs after Stages 1-3
	// have applied their auto-fixes; catches the residue (missing
	// required args, unexpected props, type mismatches) and builds a
	// targeted corrective prompt instead of paying a skill-runner
	// round-trip to surface the same error.
	if (schema !== undefined) {
		const validation = validate(coerced.input, schema);
		if (!validation.ok) {
			return rejectFromSchemaFailure({
				toolCallId:    call.id,
				resolvedName,
				schema,
				input:         coerced.input,
				validationErrors: validation.errors,
			});
		}
	}

	const allNotes = [...nameNotes, ...renamed.notes, ...coerced.notes];
	if (allNotes.length === 0) {
		return { kind: 'pass', call };
	}

	const coercedCall: ToolCall = {
		id:    call.id,
		name:  resolvedName,
		input: coerced.input,
	};

	log.info(
		{
			originalName: call.name,
			resolvedName,
			notes:        allNotes,
		},
		'tool-call-guard: coerced before dispatch',
	);

	return { kind: 'coerced', call: coercedCall, notes: allNotes };
}

// ---------------------------------------------------------------------------
// Stage 1 — tool-name resolution
// ---------------------------------------------------------------------------

type NameOutcome =
	| { readonly kind: 'pass-or-coerce'; readonly name: string; readonly notes: readonly string[] }
	| Extract<GuardOutcome, { kind: 'rejected' }>;

function resolveToolName(call: ToolCall, knownIds: readonly string[]): NameOutcome {
	const raw = call.name;

	// Exact hit.
	if (knownIds.includes(raw)) {
		return { kind: 'pass-or-coerce', name: raw, notes: [] };
	}

	// Separator-normalized exact hit. `code_entity_summary` matches
	// `code.entity.summary`; `code-source-file-describe` matches
	// `code.source.file.describe`. Cheap, very common qwen pattern.
	const normalized = normalizeSeparators(raw);
	const separatorMatch = knownIds.find(id => normalizeSeparators(id) === normalized);
	if (separatorMatch !== undefined) {
		return {
			kind: 'pass-or-coerce',
			name: separatorMatch,
			notes: [`coerced tool name '${raw}' -> '${separatorMatch}' (separator normalization)`],
		};
	}

	// Levenshtein-bounded fuzzy match. Compute distance against every
	// known id; pick the best. Coerce only if:
	//   (a) the best distance is <= FUZZY_COERCE_MAX_DISTANCE, and
	//   (b) the second-best distance is at least 1 greater than the
	//       best (no near-tie -- if the model said 'code.foo' and
	//       both 'code.foo.a' and 'code.foo.b' are equidistant, we
	//       can't safely pick one).
	const ranked = knownIds
		.map(id => ({ id, dist: levenshtein(raw, id) }))
		.sort((a, b) => a.dist - b.dist);
	const best = ranked[0];
	const second = ranked[1];
	if (best !== undefined && best.dist <= FUZZY_COERCE_MAX_DISTANCE) {
		const unambiguous = second === undefined || second.dist > best.dist;
		if (unambiguous) {
			return {
				kind: 'pass-or-coerce',
				name: best.id,
				notes: [`coerced tool name '${raw}' -> '${best.id}' (fuzzy match, distance=${best.dist})`],
			};
		}
	}

	// Unknown -- build a rejection with top-N suggestions.
	const suggestions = ranked.slice(0, SUGGEST_TOP_N).map(r => r.id);
	const correctiveText = formatUnknownToolCorrective(raw, suggestions);
	return {
		kind:             'rejected',
		reason:           `unknown tool name '${raw}'`,
		correctiveResult: {
			toolCallId: call.id,
			content:    correctiveText,
			isError:    true,
		},
		suggestions,
	};
}

function normalizeSeparators(s: string): string {
	return s.toLowerCase().replace(/[_\-]/g, '.');
}

function formatUnknownToolCorrective(name: string, suggestions: readonly string[]): string {
	const suggestionLines = suggestions.length > 0
		? `\nClosest tools in the catalog:\n${suggestions.map(s => `  - ${s}`).join('\n')}`
		: '\n(no close matches found)';
	return (
		`Your call to \`${name}\` failed: that tool is not in the skill catalog.` +
		suggestionLines +
		`\n\nRe-emit your call with a valid tool name from the catalog.`
	);
}

// ---------------------------------------------------------------------------
// Stage 3 — type coercions
// ---------------------------------------------------------------------------

interface CoercionOutput {
	readonly input: Record<string, unknown>;
	readonly notes: readonly string[];
}

/**
 * Walk the skill's input JSON schema and apply coercions to the
 * call's args. Currently only handles the highest-frequency case:
 * scalar → single-element-array when the schema declares an array
 * type. Other coercions (string trimming, scalar number-string →
 * number) are deliberately omitted to keep the guard conservative.
 */
function coerceInputTypes(
	rawInput: Record<string, unknown>,
	schema:   Record<string, unknown>,
): CoercionOutput {
	const properties = (schema['properties'] ?? {}) as Record<string, unknown>;
	if (typeof properties !== 'object' || properties === null) {
		return { input: rawInput, notes: [] };
	}

	const next: Record<string, unknown> = { ...rawInput };
	const notes: string[] = [];

	for (const [key, propSchema] of Object.entries(properties)) {
		if (!(key in next)) continue;
		if (typeof propSchema !== 'object' || propSchema === null) continue;

		const expectedType = (propSchema as Record<string, unknown>)['type'];
		const value = next[key];

		// Scalar → [scalar] when schema expects an array of strings.
		// qwen drops the brackets routinely on `kinds`, `tags`,
		// `categories` style args.
		if (expectedType === 'array' && !Array.isArray(value)) {
			if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
				next[key] = [value];
				notes.push(`coerced arg '${key}' from scalar to single-element array`);
			}
		}
	}

	return { input: next, notes };
}

// ---------------------------------------------------------------------------
// Levenshtein (simple DP, bounded for our input sizes)
// ---------------------------------------------------------------------------

export function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;

	// One-row DP. Linear-space; sufficient for typical skill-id lengths
	// (under ~40 chars).
	const prev = new Array<number>(b.length + 1);
	const curr = new Array<number>(b.length + 1);
	for (let j = 0; j <= b.length; j++) prev[j] = j;

	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
			curr[j] = Math.min(
				curr[j - 1]! + 1,        // insertion
				prev[j]!     + 1,        // deletion
				prev[j - 1]! + cost,     // substitution
			);
		}
		for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
	}
	return prev[b.length]!;
}

// ---------------------------------------------------------------------------
// Stage 4 — pre-dispatch schema check + categorized corrective prompt
// ---------------------------------------------------------------------------

interface RejectFromSchemaInput {
	readonly toolCallId:       string;
	readonly resolvedName:     string;
	readonly schema:           Record<string, unknown>;
	readonly input:            Record<string, unknown>;
	readonly validationErrors: readonly string[];
}

interface CategorizedErrors {
	readonly missing:      readonly string[];   // required args not present
	readonly unexpected:   readonly string[];   // properties not in schema
	readonly typeMismatch: readonly string[];   // raw error messages for other failures
}

/**
 * Parse the existing validator's error strings into categories so
 * the corrective prompt can target each class specifically.
 *
 * Recognized formats (from `daemon/skills/json-schema.ts`):
 *   - "<path>: missing required property 'X'"
 *   - "<path>: unexpected property 'X'"
 *   - everything else -> typeMismatch bucket
 */
function categorizeValidationErrors(errors: readonly string[]): CategorizedErrors {
	const missing:      string[] = [];
	const unexpected:   string[] = [];
	const typeMismatch: string[] = [];

	for (const e of errors) {
		const missMatch = e.match(/missing required property '([^']+)'/);
		if (missMatch) {
			missing.push(missMatch[1]!);
			continue;
		}
		const unexpMatch = e.match(/unexpected property '([^']+)'/);
		if (unexpMatch) {
			unexpected.push(unexpMatch[1]!);
			continue;
		}
		typeMismatch.push(e);
	}
	return { missing, unexpected, typeMismatch };
}

/**
 * Build a corrective prompt categorized by error class. Each section
 * is only included when at least one error of that class is present.
 * For missing required args, we pull the property's description (and
 * type) from the schema so the model sees what the arg is FOR, not
 * just its name.
 */
function buildCorrectivePrompt(input: RejectFromSchemaInput): string {
	const { resolvedName, schema, validationErrors } = input;
	const cats = categorizeValidationErrors(validationErrors);

	const lines: string[] = [];
	lines.push(
		`Your previous call to \`${resolvedName}\` was rejected by the pre-dispatch validator.`,
	);
	lines.push('');

	const properties = (schema['properties'] ?? {}) as Record<string, unknown>;

	if (cats.missing.length > 0) {
		lines.push('Missing required arguments:');
		for (const argName of cats.missing) {
			const prop = (properties[argName] ?? {}) as Record<string, unknown>;
			const type = typeof prop['type'] === 'string' ? (prop['type'] as string) : 'value';
			const desc = typeof prop['description'] === 'string' ? (prop['description'] as string) : '';
			lines.push(`  - ${argName} (${type})${desc ? ': ' + desc : ''}`);
		}
		lines.push('');
	}

	if (cats.unexpected.length > 0) {
		lines.push('Unexpected arguments (not in the schema — remove them):');
		for (const argName of cats.unexpected) {
			lines.push(`  - ${argName}`);
		}
		lines.push('');
	}

	if (cats.typeMismatch.length > 0) {
		lines.push('Other validation errors:');
		for (const err of cats.typeMismatch) {
			lines.push(`  - ${err}`);
		}
		lines.push('');
	}

	lines.push('Re-emit your call with valid arguments matching the schema.');
	return lines.join('\n');
}

function rejectFromSchemaFailure(input: RejectFromSchemaInput): GuardOutcome {
	const correctiveText = buildCorrectivePrompt(input);
	const cats = categorizeValidationErrors(input.validationErrors);
	const reason = [
		cats.missing.length    > 0 ? `missing=[${cats.missing.join(',')}]`     : null,
		cats.unexpected.length > 0 ? `unexpected=[${cats.unexpected.join(',')}]` : null,
		cats.typeMismatch.length > 0 ? `typeMismatch=${cats.typeMismatch.length}` : null,
	].filter(Boolean).join(' ');

	log.info(
		{
			toolCallId:   input.toolCallId,
			resolvedName: input.resolvedName,
			missing:      cats.missing,
			unexpected:   cats.unexpected,
			typeMismatch: cats.typeMismatch,
		},
		'tool-call-guard: pre-dispatch schema check rejected the call',
	);

	return {
		kind:             'rejected',
		reason:           `schema validation failed: ${reason}`,
		correctiveResult: {
			toolCallId: input.toolCallId,
			content:    correctiveText,
			isError:    true,
		},
	};
}

// ---------------------------------------------------------------------------
// Default registry-backed dependency providers
// ---------------------------------------------------------------------------

function defaultListSkillIds(): readonly string[] {
	return listSkills().map(s => s.id);
}

function defaultGetSkillInputSchema(id: string): Record<string, unknown> | undefined {
	const skill = getSkill(id);
	return skill?.inputs;
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _resolveToolNameForTest          = resolveToolName;
export const _coerceInputTypesForTest         = coerceInputTypes;
export const _normalizeSeparatorsForTest      = normalizeSeparators;
export const _categorizeValidationErrorsForTest = categorizeValidationErrors;
export const _buildCorrectivePromptForTest    = buildCorrectivePrompt;
