/**
 * code.meta.select-scope -- Phase 7.2 of plans/analyzers/code-analyzer-skills.md.
 *
 * The second call in the code-analyzer planner pipeline, after
 * meta.classify-question. Takes the candidate list + question +
 * active repo and produces concrete `{ skillId, args }` invocations
 * the planner can execute. Resolves entity / file / class / model
 * refs ("the parseConfig function", "the User class", "src/foo.ts")
 * to skill args, fills out optional inputs from question context,
 * and surfaces ambiguity explicitly rather than silently picking a
 * default.
 *
 * Design mirror of `data.meta.select-scope` -- same prompt
 * structure, same retry-once-on-validation-fail loop, same
 * `multiple-matches` / `no-match` ambiguity codes. Differences:
 *
 *   - `connections: ConnectionInfo[]` -> `repo: RepoContext`
 *     (single active repo + optional language / ORM / migration
 *     hints).
 *   - `mustHaveScope` enum: 'repo' / 'repo+entity' / 'repo+file' /
 *     'repo+class' / 'repo+model' / 'none'.
 *   - `resolvedScope` shape: `{ repoPath, entityRef?, file?,
 *     className?, model? }`.
 *
 * v1 trusts the LLM's pick from the question text -- it does NOT
 * call `code.entity.locate-by-name` per candidate to verify the
 * entity exists. Resolution failures show up at execute time when
 * the actual skill returns `{ found: false, nearest }` or
 * `{ found: false, reason }`; the planner re-runs select-scope
 * with the rejection if needed.
 *
 * Family: `meta`. Owner: `code-analyzer`. Affinity: `cloud`.
 */

import { getLogger } from '../../../shared/logger.js';
import { registerSkill, getSkill } from '../registry.js';
import { validate as validateJsonSchema } from '../json-schema.js';
import type { Skill, SkillResult } from '../types.js';
import type { LLMMessage, LLMProvider } from '../../../shared/types.js';

const log = getLogger('skill.code.meta.select-scope');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MustHaveScope =
	| 'repo'
	| 'repo+entity'
	| 'repo+file'
	| 'repo+class'
	| 'repo+model'
	| 'none';

type AmbiguityKind = 'multiple-matches' | 'no-match';

interface CandidateIn {
	readonly skillId:       string;
	readonly rationale:     string;
	readonly mustHaveScope: MustHaveScope;
}

interface RepoContext {
	readonly path:               string;
	readonly primaryLanguages?:  readonly string[];
	readonly detectedOrms?:      readonly string[];
	readonly migrationTool?:     string;
}

interface SelectScopeInput {
	readonly question:    string;
	readonly candidates:  readonly CandidateIn[];
	readonly repo:        RepoContext;
	/**
	 * Optional structured facts surfaced by prior turns in this
	 * session (modules / entities / tables / ORM models). The LLM
	 * uses these to resolve label-shaped references in the user's
	 * question -- e.g. "describe HDFS Core" maps to a concrete
	 * `modulePath` from `priorFacts.modules` instead of being
	 * passed through verbatim and rejected at execute time.
	 * conversation-flow-refinement.md Phase 4.
	 */
	readonly priorFacts?: PriorFacts;
}

interface PriorFacts {
	readonly modules?:   readonly { path: string; label?: string; fileCount?: number }[];
	readonly entities?:  readonly { entityRef: string; name: string; kind: string; file?: string }[];
	readonly tables?:    readonly { connectionId: string; name: string; columns?: string[] }[];
	readonly ormModels?: readonly { name: string; table?: string; dialect: string }[];
}

interface ResolvedScope {
	readonly repoPath:    string;
	readonly entityRef?:  string;
	readonly file?:       string;
	readonly className?:  string;
	readonly model?:      string;
}

interface Ambiguity {
	readonly kind:          AmbiguityKind;
	readonly alternatives?: readonly string[];
}

interface ScopedInvocation {
	readonly skillId:       string;
	readonly args:          Record<string, unknown>;
	readonly resolvedScope: ResolvedScope;
	readonly ambiguity?:    Ambiguity;
}

interface SelectScopeOutput {
	readonly scoped: readonly ScopedInvocation[];
	readonly notes:  readonly string[];
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const REPO_CONTEXT_SCHEMA = {
	type: 'object',
	properties: {
		path:              { type: 'string', minLength: 1 },
		primaryLanguages:  { type: 'array', items: { type: 'string' }, maxItems: 12 },
		detectedOrms:      { type: 'array', items: { type: 'string' }, maxItems: 8 },
		migrationTool:     { type: 'string' },
	},
	required: ['path'],
	additionalProperties: false,
} as const;

const CANDIDATE_IN_SCHEMA = {
	type: 'object',
	properties: {
		skillId:       { type: 'string' },
		rationale:     { type: 'string' },
		mustHaveScope: {
			type: 'string',
			enum: ['repo', 'repo+entity', 'repo+file', 'repo+class', 'repo+model', 'none'],
		},
	},
	required: ['skillId', 'rationale', 'mustHaveScope'],
	additionalProperties: false,
} as const;

const PRIOR_FACTS_SCHEMA = {
	type: 'object',
	properties: {
		modules: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					path:      { type: 'string' },
					label:     { type: 'string' },
					fileCount: { type: 'number' },
				},
				required: ['path'],
				additionalProperties: false,
			},
			maxItems: 32,
		},
		entities: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					entityRef: { type: 'string' },
					name:      { type: 'string' },
					kind:      { type: 'string' },
					file:      { type: 'string' },
				},
				required: ['entityRef', 'name', 'kind'],
				additionalProperties: false,
			},
			maxItems: 32,
		},
		tables: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					connectionId: { type: 'string' },
					name:         { type: 'string' },
					columns:      { type: 'array', items: { type: 'string' } },
				},
				required: ['connectionId', 'name'],
				additionalProperties: false,
			},
			maxItems: 32,
		},
		ormModels: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					name:    { type: 'string' },
					table:   { type: 'string' },
					dialect: { type: 'string' },
				},
				required: ['name', 'dialect'],
				additionalProperties: false,
			},
			maxItems: 32,
		},
	},
	additionalProperties: false,
} as const;

const INPUT_SCHEMA = {
	type: 'object',
	properties: {
		question:   { type: 'string', minLength: 1, maxLength: 4000 },
		candidates: { type: 'array', items: CANDIDATE_IN_SCHEMA, minItems: 0, maxItems: 8 },
		repo:       REPO_CONTEXT_SCHEMA,
		priorFacts: PRIOR_FACTS_SCHEMA,
	},
	required: ['question', 'candidates', 'repo'],
	additionalProperties: false,
} as const;

const RESOLVED_SCOPE_SCHEMA = {
	type: 'object',
	properties: {
		repoPath:  { type: 'string' },
		entityRef: { type: 'string' },
		file:      { type: 'string' },
		className: { type: 'string' },
		model:     { type: 'string' },
	},
	required: ['repoPath'],
	additionalProperties: false,
} as const;

const AMBIGUITY_SCHEMA = {
	type: 'object',
	properties: {
		kind:         { type: 'string', enum: ['multiple-matches', 'no-match'] },
		alternatives: { type: 'array', items: { type: 'string' } },
	},
	required: ['kind'],
	additionalProperties: false,
} as const;

const SCOPED_INVOCATION_SCHEMA = {
	type: 'object',
	properties: {
		skillId:       { type: 'string' },
		args:          { type: 'object' },
		resolvedScope: RESOLVED_SCOPE_SCHEMA,
		ambiguity:     AMBIGUITY_SCHEMA,
	},
	required: ['skillId', 'args', 'resolvedScope'],
	additionalProperties: false,
} as const;

const OUTPUT_SCHEMA = {
	type: 'object',
	properties: {
		scoped: { type: 'array', items: SCOPED_INVOCATION_SCHEMA, maxItems: 16 },
		notes:  { type: 'array', items: { type: 'string', maxLength: 280 }, maxItems: 8 },
	},
	required: ['scoped', 'notes'],
	additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

interface CandidateManifest {
	readonly skillId:     string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
}

function buildCandidateManifests(
	candidates: readonly CandidateIn[],
): { readonly resolved: readonly CandidateManifest[]; readonly missing: readonly string[] } {
	const resolved: CandidateManifest[] = [];
	const missing: string[] = [];
	for (const c of candidates) {
		const skill = getSkill(c.skillId);
		if (skill === undefined) {
			missing.push(c.skillId);
			continue;
		}
		resolved.push({
			skillId:     c.skillId,
			description: skill.description,
			inputSchema: skill.inputs,
		});
	}
	return { resolved, missing };
}

function buildSystemPrompt(): string {
	return [
		'You are a code-analyzer scope-selector. For each candidate skill the',
		'planner picked, fill in concrete `args` (matching the skill\'s input',
		'schema) using information from the user question + active repo.',
		'Output STRICT JSON matching this schema:',
		'',
		'```json',
		JSON.stringify(OUTPUT_SCHEMA, null, 2),
		'```',
		'',
		'Hard rules:',
		'1. EVERY entry in `scoped` MUST have `skillId` matching one of the',
		'   candidates the user message provides. Never invent a skill id.',
		'2. `args` MUST satisfy the candidate\'s declared input schema. Read',
		'   the schema in the user message; only emit properties the schema',
		'   declares; respect required fields and enum constraints.',
		'3. `resolvedScope.repoPath` MUST equal the active repo\'s path.',
		'4. When the question references a name that could match several',
		'   things in the codebase ("the User class" with both a model class',
		'   and an enum), EMIT ONE entry per plausible match and set',
		'   `ambiguity: { kind: "multiple-matches", alternatives: [<labels>] }`.',
		'   The planner gates on this for a user clarification.',
		'5. When the question references a name that no obvious entity / file',
		'   matches, emit ONE entry with the best-effort fill + `ambiguity:',
		'   { kind: "no-match" }` and surface the issue in `notes`. Do NOT',
		'   silently pick a default.',
		'6. Use `notes` to flag anything ambiguous in the question that you',
		'   had to guess (default git refs, default thresholds, etc.).',
		'   Empty array if every arg came directly from the question.',
		'7. PRIOR FACTS: when the user message includes a `Prior facts`',
		'   section, prefer those concrete identifiers over guessing. A',
		'   reference like "HDFS Core" that maps uniquely to one of the',
		'   listed `modules.label` MUST be replaced by that module\'s',
		'   `path` in the skill `args`. Same rule for entities, tables,',
		'   and ORM models. If a label matches multiple prior facts,',
		'   surface via the existing ambiguity arm (rule 4). If no fact',
		'   matches, treat the reference as cold per rule 5 -- DO NOT',
		'   invent a fact-shaped identifier.',
		'',
		'Output ONLY the JSON object; no preamble, no fenced block.',
	].join('\n');
}

function buildUserMessage(input: SelectScopeInput, manifests: readonly CandidateManifest[]): string {
	const repoLines: string[] = [`- path=\`${input.repo.path}\``];
	if (input.repo.primaryLanguages !== undefined && input.repo.primaryLanguages.length > 0) {
		repoLines.push(`- primaryLanguages=[${input.repo.primaryLanguages.join(', ')}]`);
	}
	if (input.repo.detectedOrms !== undefined && input.repo.detectedOrms.length > 0) {
		repoLines.push(`- detectedOrms=[${input.repo.detectedOrms.join(', ')}]`);
	}
	if (input.repo.migrationTool !== undefined && input.repo.migrationTool.length > 0) {
		repoLines.push(`- migrationTool=${input.repo.migrationTool}`);
	}
	const candidateBlocks = input.candidates.map((c, i) => {
		const manifest = manifests.find(m => m.skillId === c.skillId);
		if (manifest === undefined) {
			return `### Candidate ${i + 1}: \`${c.skillId}\` (not in registry; skip)`;
		}
		return [
			`### Candidate ${i + 1}: \`${c.skillId}\``,
			`mustHaveScope: ${c.mustHaveScope}`,
			`rationale (from classify-question): ${c.rationale}`,
			`description: ${manifest.description}`,
			'inputSchema:',
			'```json',
			JSON.stringify(manifest.inputSchema, null, 2),
			'```',
		].join('\n');
	});
	const sections: string[] = [
		'Question:',
		input.question,
		'',
		'Active repo:',
		repoLines.join('\n'),
		'',
	];

	const factLines = renderPriorFacts(input.priorFacts);
	if (factLines.length > 0) {
		sections.push('Prior facts (from prior turns -- prefer these for label->identifier resolution):');
		sections.push(...factLines);
		sections.push('');
	}

	sections.push(
		`Candidates (${input.candidates.length}):`,
		candidateBlocks.length > 0 ? candidateBlocks.join('\n\n') : '(empty)',
		'',
		'Return ONLY the JSON object matching the schema; no preamble.',
	);
	return sections.join('\n');
}

function renderPriorFacts(facts: PriorFacts | undefined): string[] {
	if (facts === undefined) return [];
	const out: string[] = [];

	if (facts.modules !== undefined && facts.modules.length > 0) {
		out.push(`Modules (${facts.modules.length}):`);
		for (const m of facts.modules) {
			const label = m.label !== undefined ? `  (label: "${m.label}")` : '';
			const size  = m.fileCount !== undefined ? `  ${m.fileCount} files` : '';
			out.push(`  - ${m.path}${label}${size}`);
		}
	}
	if (facts.entities !== undefined && facts.entities.length > 0) {
		out.push(`Entities (${facts.entities.length}):`);
		for (const e of facts.entities) {
			const file = e.file !== undefined ? `  in ${e.file}` : '';
			out.push(`  - ${e.kind} \`${e.name}\` (id: ${e.entityRef})${file}`);
		}
	}
	if (facts.tables !== undefined && facts.tables.length > 0) {
		out.push(`Tables (${facts.tables.length}):`);
		for (const t of facts.tables) {
			const cols = t.columns !== undefined && t.columns.length > 0
				? `  cols: ${t.columns.slice(0, 8).join(', ')}${t.columns.length > 8 ? ', ...' : ''}`
				: '';
			out.push(`  - ${t.connectionId}.${t.name}${cols}`);
		}
	}
	if (facts.ormModels !== undefined && facts.ormModels.length > 0) {
		out.push(`ORM models (${facts.ormModels.length}):`);
		for (const o of facts.ormModels) {
			const tbl = o.table !== undefined ? ` -> ${o.table}` : '';
			out.push(`  - ${o.dialect}: ${o.name}${tbl}`);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Output parsing + validation
// ---------------------------------------------------------------------------

interface ParseFailure {
	readonly message: string;
}

type ParseResult =
	| { readonly ok: true;  readonly value: SelectScopeOutput }
	| { readonly ok: false; readonly failure: ParseFailure };

function parseAndValidate(
	raw: string,
	candidates: readonly CandidateIn[],
	repo: RepoContext,
): ParseResult {
	const text = stripFences(raw).trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		return { ok: false, failure: { message: `JSON parse failed: ${(err as Error).message}` } };
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return { ok: false, failure: { message: 'output must be a JSON object' } };
	}
	const obj = parsed as Record<string, unknown>;

	const shape = validateJsonSchema(obj, OUTPUT_SCHEMA as Record<string, unknown>);
	if (shape.ok !== true) {
		return { ok: false, failure: { message: `output shape rejected: ${shape.errors.join('; ')}` } };
	}

	const candidateIds = new Set(candidates.map(c => c.skillId));
	const scopedRaw    = obj['scoped'] as readonly unknown[];
	const scoped: ScopedInvocation[] = [];

	for (let i = 0; i < scopedRaw.length; i++) {
		const entry = scopedRaw[i] as Record<string, unknown>;
		const skillId = entry['skillId'] as string;

		if (!candidateIds.has(skillId)) {
			return { ok: false, failure: { message: `scoped[${i}].skillId='${skillId}' is not in the candidate list` } };
		}
		const skill = getSkill(skillId);
		if (skill === undefined) {
			return { ok: false, failure: { message: `scoped[${i}].skillId='${skillId}' is not a registered skill` } };
		}

		const args = entry['args'] as Record<string, unknown>;
		const argResult = validateJsonSchema(args, skill.inputs);
		if (argResult.ok !== true) {
			return { ok: false, failure: { message: `scoped[${i}].args (skillId='${skillId}') failed inputSchema: ${argResult.errors.join('; ')}` } };
		}

		const resolvedScopeRaw = entry['resolvedScope'] as Record<string, unknown>;
		const repoPath = resolvedScopeRaw['repoPath'] as string;
		if (repoPath !== repo.path) {
			return { ok: false, failure: { message: `scoped[${i}].resolvedScope.repoPath='${repoPath}' does not match the active repo path '${repo.path}'` } };
		}

		const scope: ResolvedScope = { repoPath };
		if (typeof resolvedScopeRaw['entityRef'] === 'string') (scope as { entityRef?: string }).entityRef = resolvedScopeRaw['entityRef'] as string;
		if (typeof resolvedScopeRaw['file']      === 'string') (scope as { file?: string }).file = resolvedScopeRaw['file'] as string;
		if (typeof resolvedScopeRaw['className'] === 'string') (scope as { className?: string }).className = resolvedScopeRaw['className'] as string;
		if (typeof resolvedScopeRaw['model']     === 'string') (scope as { model?: string }).model = resolvedScopeRaw['model'] as string;

		const ambiguityRaw = entry['ambiguity'] as Record<string, unknown> | undefined;
		const inv: ScopedInvocation = ambiguityRaw === undefined
			? { skillId, args, resolvedScope: scope }
			: {
				skillId,
				args,
				resolvedScope: scope,
				ambiguity: {
					kind: ambiguityRaw['kind'] as AmbiguityKind,
					...(Array.isArray(ambiguityRaw['alternatives'])
						? { alternatives: ambiguityRaw['alternatives'] as readonly string[] }
						: {}),
				},
			};
		scoped.push(inv);
	}

	const notesRaw = obj['notes'] as readonly unknown[];
	const notes: string[] = [];
	for (const n of notesRaw) {
		if (typeof n === 'string') notes.push(n);
	}

	return { ok: true, value: { scoped, notes } };
}

function stripFences(text: string): string {
	const fenceMatch = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(text);
	return fenceMatch !== null ? fenceMatch[1]! : text;
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

async function callLLM(
	provider: LLMProvider,
	systemPrompt: string,
	userMessage: string,
): Promise<string> {
	const messages: LLMMessage[] = [
		{ role: 'system', content: systemPrompt },
		{ role: 'user',   content: userMessage },
	];
	const response = await provider.complete(messages, {
		maxTokens: 1024,
		temperature: 0.2,
		responseFormat: { schema: OUTPUT_SCHEMA as Record<string, unknown> },
	});
	return response.text;
}

// ---------------------------------------------------------------------------
// Skill body
// ---------------------------------------------------------------------------

const skill: Skill<SelectScopeInput, SelectScopeOutput> = {
	id: 'code.meta.select-scope',
	name: 'Meta: select-scope (fill skill args from question + repo context)',
	description:
		'Take classify-question\'s candidate list and the user question and fill ' +
		'concrete args per candidate against its inputSchema. Resolves entity / ' +
		'file / class / model refs to skill args and surfaces ambiguity ' +
		'(multiple-matches / no-match) for the planner to gate on. Cloud-routed; ' +
		'structured JSON output validated against each skill\'s inputSchema before ' +
		'returning.',
	family: 'meta',
	owner: 'code-analyzer',
	version: 1,
	inputs:  INPUT_SCHEMA as unknown as Record<string, unknown>,
	outputs: OUTPUT_SCHEMA as unknown as Record<string, unknown>,
	toolDeps: [],
	providerAffinity: 'cloud',
	preconditions: [],

	async execute(input, deps): Promise<SkillResult<SelectScopeOutput>> {
		if (input.candidates.length === 0) {
			return {
				value: { scoped: [], notes: ['no candidates supplied; classify-question returned an empty list'] },
				confidence: 'low',
				notes: ['no candidates'],
				toolCalls: [],
			};
		}

		const { resolved, missing } = buildCandidateManifests(input.candidates);
		if (resolved.length === 0) {
			return {
				value: { scoped: [], notes: [`every candidate is missing from the registry: [${missing.join(', ')}]`] },
				confidence: 'low',
				notes: ['no candidates resolved against the registry'],
				toolCalls: [],
			};
		}

		const provider = deps.resolveProvider();
		const sys      = buildSystemPrompt();
		const user     = buildUserMessage(input, resolved);

		let raw: string;
		try {
			raw = await callLLM(provider, sys, user);
		} catch (err) {
			log.warn({ err: (err as Error).message }, 'select-scope LLM call failed');
			return {
				value: emptyOutput(),
				confidence: 'low',
				notes: [`LLM call failed: ${(err as Error).message}`],
				toolCalls: [],
			};
		}

		let parsed = parseAndValidate(raw, input.candidates, input.repo);
		if (parsed.ok !== true) {
			log.info({ message: parsed.failure.message }, 'select-scope first-pass rejected; retrying');
			const retryUser = `${user}\n\nThe previous attempt was rejected: ${parsed.failure.message}\nReturn ONLY a JSON object matching the schema; no other text.`;
			let retryRaw: string;
			try {
				retryRaw = await callLLM(provider, sys, retryUser);
			} catch (err) {
				return {
					value: emptyOutput(),
					confidence: 'low',
					notes: [`LLM retry failed: ${(err as Error).message}`, `first-pass rejection: ${parsed.failure.message}`],
					toolCalls: [],
				};
			}
			parsed = parseAndValidate(retryRaw, input.candidates, input.repo);
			if (parsed.ok !== true) {
				log.warn({ message: parsed.failure.message }, 'select-scope retry rejected; surfacing low confidence');
				return {
					value: emptyOutput(),
					confidence: 'low',
					notes: [`LLM output failed validation twice: ${parsed.failure.message}`],
					toolCalls: [],
				};
			}
		}

		const value = parsed.value;
		const hasAmbiguity = value.scoped.some(s => s.ambiguity !== undefined);
		const confidence =
			value.scoped.length === 0 ? 'low' :
			hasAmbiguity            ? 'medium' :
			value.notes.length > 0  ? 'medium' :
			'high';

		const result: SkillResult<SelectScopeOutput> = { value, confidence, toolCalls: [] };
		if (value.notes.length > 0 || missing.length > 0) {
			const notes = [...value.notes];
			if (missing.length > 0) {
				notes.unshift(`unresolved candidate ids dropped: [${missing.join(', ')}]`);
			}
			return { ...result, notes };
		}
		return result;
	},
};

function emptyOutput(): SelectScopeOutput {
	return { scoped: [], notes: [] };
}

export function registerCodeMetaSelectScopeSkill(): void {
	registerSkill(skill as unknown as Skill);
}

// Test exports.
export const _parseAndValidateForTest      = parseAndValidate;
export const _buildCandidateManifestsForTest = buildCandidateManifests;
