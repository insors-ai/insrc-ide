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
import { getLogger } from '../shared/logger.js';

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

	const knownIds = listIds();

	// Stage 1: tool-name resolution.
	const nameOutcome = resolveToolName(call, knownIds);
	if (nameOutcome.kind === 'rejected') {
		return nameOutcome;
	}
	const resolvedName  = nameOutcome.name;
	const nameNotes     = nameOutcome.notes;

	// Stage 3: type coercions against the resolved skill's input schema.
	const schema = getSchema(resolvedName);
	const coerced = schema !== undefined
		? coerceInputTypes(call.input, schema)
		: { input: call.input, notes: [] as string[] };

	const allNotes = [...nameNotes, ...coerced.notes];
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
			coercedKeys:  Object.keys(coerced.notes.length > 0 ? coerced.input : {}),
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

export const _resolveToolNameForTest    = resolveToolName;
export const _coerceInputTypesForTest   = coerceInputTypes;
export const _normalizeSeparatorsForTest = normalizeSeparators;
