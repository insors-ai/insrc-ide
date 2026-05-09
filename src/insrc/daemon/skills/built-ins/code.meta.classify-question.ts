/**
 * code.meta.classify-question -- Phase 7.1 of plans/analyzers/code-analyzer-skills.md.
 *
 * The first call in the code-analyzer planner pipeline. Maps a
 * free-form user question + active repo context to an ordered list
 * of candidate code-analyzer skill ids the planner should invoke,
 * plus a coarse question type for downstream routing.
 *
 * Design mirror of `data.meta.classify-question`:
 *
 *   1. **Catalog format** -- server-side prefilter by skill owner +
 *      family (drops meta + synthesis) PLUS repo-aware drops:
 *      `code.orm.*` skills require detectedOrms.length > 0;
 *      `code.migration.*` skills require migrationTool to be set.
 *      One-line catalog of survivors + on-demand `skill_describe`.
 *
 *   2. **Prompt structure** -- structured-output JSON, schema-
 *      validated, with few-shot examples in the system prompt
 *      (cacheable on Anthropic + OpenAI). One retry on rejection.
 *
 *   3. **Model affinity** -- cloud, smallest tier per active provider.
 *
 *   4. **Preconditions** -- this skill's only hard precondition is
 *      `skill_describe` (the LLM may invoke it for catalog detail).
 *      Per-candidate runtime preconditions re-check after
 *      `code.meta.select-scope` populates concrete inputs.
 *
 * Out-of-catalog scope:
 *   - `meta.*` skills (don't recurse-classify into the meta layer).
 *   - `synthesis` family (renderers, not analyzers; planner picks
 *     synth renderers from the analyzer skill's output shape).
 *   - skills owned by other analyzers (cross-owner calls happen
 *     inside composite skills, not from the planner).
 *
 * Family: `meta`. Owner: `code-analyzer`. Affinity: `cloud`.
 */

import { getLogger } from '../../../shared/logger.js';
import { registerSkill, listSkills } from '../registry.js';
import type { Skill, SkillContext, SkillResult } from '../types.js';
import type { LLMMessage, LLMProvider } from '../../../shared/types.js';

const log = getLogger('skill.code.meta.classify-question');

// ---------------------------------------------------------------------------
// Input / output shapes
// ---------------------------------------------------------------------------

type MustHaveScope =
	| 'repo'
	| 'repo+entity'
	| 'repo+file'
	| 'repo+class'
	| 'repo+model'
	| 'none';

type QuestionType =
	| 'describe-file'
	| 'describe-module'
	| 'describe-repo'
	| 'find-entity'
	| 'find-callers'
	| 'find-callees'
	| 'class-fields'
	| 'class-references'
	| 'orm-model'
	| 'migration-history'
	| 'signature-diff'
	| 'impl-vs-doc'
	| 'version-diff'
	| 'quality'
	| 'free-form';

interface RepoContext {
	readonly path:               string;
	readonly primaryLanguages?:  readonly string[];
	readonly detectedOrms?:      readonly string[];
	readonly migrationTool?:     string;
}

interface ClassifyInput {
	readonly question: string;
	readonly repo:     RepoContext;
}

interface Candidate {
	readonly skillId:       string;
	readonly rationale:     string;
	readonly mustHaveScope: MustHaveScope;
}

interface ClassifyOutput {
	readonly questionType:     QuestionType;
	readonly candidates:       readonly Candidate[];
	readonly fallbacks:        readonly string[];
	readonly uncertaintyNotes: readonly string[];
}

// ---------------------------------------------------------------------------
// JSON schemas
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

const INPUT_SCHEMA = {
	type: 'object',
	properties: {
		question: { type: 'string', minLength: 1, maxLength: 4000 },
		repo:     REPO_CONTEXT_SCHEMA,
	},
	required: ['question', 'repo'],
	additionalProperties: false,
} as const;

const QUESTION_TYPES: readonly QuestionType[] = [
	'describe-file', 'describe-module', 'describe-repo', 'find-entity',
	'find-callers', 'find-callees', 'class-fields', 'class-references',
	'orm-model', 'migration-history', 'signature-diff', 'impl-vs-doc',
	'version-diff', 'quality', 'free-form',
] as const;

const MUST_HAVE_SCOPES: readonly MustHaveScope[] = [
	'repo', 'repo+entity', 'repo+file', 'repo+class', 'repo+model', 'none',
] as const;

const OUTPUT_SCHEMA = {
	type: 'object',
	properties: {
		questionType: { type: 'string', enum: QUESTION_TYPES },
		candidates: {
			type: 'array',
			maxItems: 8,
			items: {
				type: 'object',
				properties: {
					skillId:       { type: 'string' },
					rationale:     { type: 'string', maxLength: 280 },
					mustHaveScope: { type: 'string', enum: MUST_HAVE_SCOPES },
				},
				required: ['skillId', 'rationale', 'mustHaveScope'],
				additionalProperties: false,
			},
		},
		fallbacks:        { type: 'array', items: { type: 'string' }, maxItems: 8 },
		uncertaintyNotes: { type: 'array', items: { type: 'string', maxLength: 280 }, maxItems: 6 },
	},
	required: ['questionType', 'candidates', 'fallbacks', 'uncertaintyNotes'],
	additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Catalog: prefilter + render
// ---------------------------------------------------------------------------

interface CatalogEntry {
	readonly id:      string;
	readonly family:  string;
	readonly summary: string;
}

const CATALOG_SUMMARY_MAX = 120;

function buildCatalog(input: ClassifyInput, _ctx: SkillContext): readonly CatalogEntry[] {
	const detectedOrms   = input.repo.detectedOrms   ?? [];
	const migrationTool  = input.repo.migrationTool;
	const out: CatalogEntry[] = [];
	for (const skill of listSkills()) {
		if (skill.owner !== 'code-analyzer') continue;
		if (skill.family === 'meta')         continue;
		if (skill.family === 'synthesis')    continue;
		if (!matchesRepoCapability(skill, detectedOrms, migrationTool)) continue;
		out.push({
			id:      skill.id,
			family:  skill.family,
			summary: truncate(skill.description, CATALOG_SUMMARY_MAX),
		});
	}
	out.sort((a, b) =>
		a.family !== b.family ? a.family.localeCompare(b.family) : a.id.localeCompare(b.id),
	);
	return out;
}

/**
 * Drop catalog skills whose runtime context obviously isn't satisfied:
 *   - `code.orm.*` requires the repo to have at least one detected ORM.
 *   - `code.migration.*` requires `migrationTool` to be set.
 *
 * Other preconditions (required-tools, cross-owner-allowed, etc.) are
 * left for the runtime feasibility-check after select-scope populates
 * concrete args -- surfacing those skills here is correct because
 * the caller may register tools dynamically.
 */
function matchesRepoCapability(
	skill: Skill,
	detectedOrms: readonly string[],
	migrationTool: string | undefined,
): boolean {
	if (skill.id.startsWith('code.orm.') && detectedOrms.length === 0) return false;
	if (skill.id.startsWith('code.migration.') && (migrationTool === undefined || migrationTool.length === 0)) return false;
	return true;
}

function truncate(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, ' ').trim();
	return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + '…';
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const FEW_SHOT = `
EXAMPLES:

Question: "What does the file src/User.ts define?"
Repo: { path: /repo/alpha, primaryLanguages: [typescript] }
Output:
{
  "questionType": "describe-file",
  "candidates": [
    { "skillId": "code.source.file.describe", "rationale": "Single-file enumeration of declared entities + imports.", "mustHaveScope": "repo+file" }
  ],
  "fallbacks": [],
  "uncertaintyNotes": []
}

Question: "Who calls the compute() function?"
Repo: { path: /repo/alpha, primaryLanguages: [typescript] }
Output:
{
  "questionType": "find-callers",
  "candidates": [
    { "skillId": "code.entity.locate-by-name", "rationale": "Resolve 'compute' to a stable entity id first.", "mustHaveScope": "repo+entity" },
    { "skillId": "code.entity.callers", "rationale": "1-hop CALLS in-edges from the resolved entity.", "mustHaveScope": "repo+entity" }
  ],
  "fallbacks": [],
  "uncertaintyNotes": []
}

Question: "Show me the fields on the User model."
Repo: { path: /repo/alpha, detectedOrms: [prisma] }
Output:
{
  "questionType": "orm-model",
  "candidates": [
    { "skillId": "code.orm.resolve-model", "rationale": "Locate the ORM-defined User model with normalised columns + relations.", "mustHaveScope": "repo+model" }
  ],
  "fallbacks": ["code.class.extract-fields"],
  "uncertaintyNotes": []
}

Question: "Are there any unused exports?"
Repo: { path: /repo/alpha }
Output:
{
  "questionType": "quality",
  "candidates": [
    { "skillId": "code.quality.unused-exports", "rationale": "Exported entities with empty in-edge across IMPORTS / CALLS / REFERENCES.", "mustHaveScope": "repo" }
  ],
  "fallbacks": [],
  "uncertaintyNotes": []
}

Question: "Did the parseConfig function change between v1.5 and HEAD?"
Repo: { path: /repo/alpha }
Output:
{
  "questionType": "version-diff",
  "candidates": [
    { "skillId": "code.entity.locate-by-name", "rationale": "Resolve 'parseConfig' to an entity id at HEAD.", "mustHaveScope": "repo+entity" },
    { "skillId": "code.compare.entity-versions", "rationale": "Diff one entity across two git refs.", "mustHaveScope": "repo+entity" }
  ],
  "fallbacks": [],
  "uncertaintyNotes": []
}

Question: "Are there any complex functions over 30 cyclomatic in this repo?"
Repo: { path: /repo/alpha }
Output:
{
  "questionType": "quality",
  "candidates": [
    { "skillId": "code.quality.complexity", "rationale": "Cyclomatic per function/method with histogram + top-N.", "mustHaveScope": "repo" }
  ],
  "fallbacks": [],
  "uncertaintyNotes": ["The user said >30 (high tier); the skill returns top-N regardless of threshold so the caller must filter."]
}

Question: "Compare the User class to the docs/user.md spec."
Repo: { path: /repo/alpha }
Output:
{
  "questionType": "impl-vs-doc",
  "candidates": [
    { "skillId": "code.compare.impl-vs-doc", "rationale": "Field-set drift between the implementation and a Markdown doc.", "mustHaveScope": "repo+class" }
  ],
  "fallbacks": [],
  "uncertaintyNotes": []
}
`.trim();

function buildSystemPrompt(): string {
	return [
		'You are a code-analyzer skill router. Map the user question to one or',
		'more candidate skill ids from the closed catalog the user message',
		'provides. Output STRICT JSON matching this schema:',
		'',
		'```json',
		JSON.stringify(OUTPUT_SCHEMA, null, 2),
		'```',
		'',
		'Hard rules:',
		'1. EVERY skillId in `candidates` and `fallbacks` MUST appear in the',
		'   catalog the user message provides. Do not invent skill ids.',
		'2. Pick at most 4 candidates. Order them by likelihood of being the',
		'   correct first call (or by the natural pipeline order, e.g. resolve',
		'   an entity before walking its callers).',
		'3. `mustHaveScope` declares the smallest scope the candidate needs:',
		'   "repo" / "repo+entity" / "repo+file" / "repo+class" / "repo+model"',
		'   / "none". select-scope (the next pipeline step) fills the args.',
		'4. `uncertaintyNotes` should surface anything the question did not',
		'   specify (which file, which entity name, which git ref, which',
		'   threshold). Empty array if the question is fully scoped.',
		'5. Use `fallbacks` for second-choice skills the planner can pivot to',
		'   if the first candidates fail their preconditions or return',
		'   confidence: low.',
		'6. Set `questionType` to the closest fit; "free-form" only when no',
		'   other type matches.',
		'',
		FEW_SHOT,
	].join('\n');
}

function buildUserMessage(input: ClassifyInput, catalog: readonly CatalogEntry[]): string {
	const catalogLines = catalog.map(e => `- \`${e.id}\` [${e.family}] -- ${e.summary}`);
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
	return [
		'Question:',
		input.question,
		'',
		'Active repo:',
		repoLines.join('\n'),
		'',
		`Skill catalog (${catalog.length} skills, pre-filtered for repo capability):`,
		catalog.length > 0 ? catalogLines.join('\n') : '(empty)',
		'',
		'Use `skill_describe` to pull a full input/output schema for any',
		'skill before picking it if the one-line summary is ambiguous.',
		'',
		'Return ONLY the JSON object matching the schema; no preamble, no',
		'fenced block, no commentary.',
	].join('\n');
}

// ---------------------------------------------------------------------------
// Output parsing + validation
// ---------------------------------------------------------------------------

interface ParseFailure {
	readonly kind: 'parse' | 'validation';
	readonly message: string;
}

type ParseResult =
	| { readonly ok: true;  readonly value: ClassifyOutput }
	| { readonly ok: false; readonly failure: ParseFailure };

function parseAndValidate(raw: string, catalog: readonly CatalogEntry[]): ParseResult {
	const text = stripFences(raw).trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		return { ok: false, failure: { kind: 'parse', message: `JSON parse failed: ${(err as Error).message}` } };
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return { ok: false, failure: { kind: 'validation', message: 'output must be a JSON object' } };
	}
	const obj = parsed as Record<string, unknown>;

	const questionType = obj['questionType'];
	if (typeof questionType !== 'string' || !QUESTION_TYPES.includes(questionType as QuestionType)) {
		return { ok: false, failure: { kind: 'validation', message: `questionType must be one of: ${QUESTION_TYPES.join(', ')}` } };
	}

	const candidatesRaw = obj['candidates'];
	if (!Array.isArray(candidatesRaw)) {
		return { ok: false, failure: { kind: 'validation', message: 'candidates must be an array' } };
	}
	const knownIds = new Set(catalog.map(e => e.id));
	const candidates: Candidate[] = [];
	for (let i = 0; i < candidatesRaw.length; i++) {
		const c = candidatesRaw[i];
		if (typeof c !== 'object' || c === null) {
			return { ok: false, failure: { kind: 'validation', message: `candidates[${i}] must be an object` } };
		}
		const cc = c as Record<string, unknown>;
		const skillId   = cc['skillId'];
		const rationale = cc['rationale'];
		const scope     = cc['mustHaveScope'];
		if (typeof skillId !== 'string' || !knownIds.has(skillId)) {
			return { ok: false, failure: { kind: 'validation', message: `candidates[${i}].skillId='${skillId}' not in the catalog` } };
		}
		if (typeof rationale !== 'string') {
			return { ok: false, failure: { kind: 'validation', message: `candidates[${i}].rationale must be a string` } };
		}
		if (typeof scope !== 'string' || !MUST_HAVE_SCOPES.includes(scope as MustHaveScope)) {
			return { ok: false, failure: { kind: 'validation', message: `candidates[${i}].mustHaveScope must be one of: ${MUST_HAVE_SCOPES.join(', ')}` } };
		}
		candidates.push({ skillId, rationale, mustHaveScope: scope as MustHaveScope });
	}

	const fallbacksRaw = obj['fallbacks'];
	if (!Array.isArray(fallbacksRaw)) {
		return { ok: false, failure: { kind: 'validation', message: 'fallbacks must be an array' } };
	}
	const fallbacks: string[] = [];
	for (let i = 0; i < fallbacksRaw.length; i++) {
		const f = fallbacksRaw[i];
		if (typeof f !== 'string' || !knownIds.has(f)) {
			return { ok: false, failure: { kind: 'validation', message: `fallbacks[${i}]='${f}' not in the catalog` } };
		}
		fallbacks.push(f);
	}

	const notesRaw = obj['uncertaintyNotes'];
	if (!Array.isArray(notesRaw)) {
		return { ok: false, failure: { kind: 'validation', message: 'uncertaintyNotes must be an array' } };
	}
	const uncertaintyNotes: string[] = [];
	for (let i = 0; i < notesRaw.length; i++) {
		const n = notesRaw[i];
		if (typeof n !== 'string') {
			return { ok: false, failure: { kind: 'validation', message: `uncertaintyNotes[${i}] must be a string` } };
		}
		uncertaintyNotes.push(n);
	}

	return {
		ok: true,
		value: {
			questionType: questionType as QuestionType,
			candidates,
			fallbacks,
			uncertaintyNotes,
		},
	};
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
	signal?: AbortSignal | undefined,
): Promise<string> {
	const messages: LLMMessage[] = [
		{ role: 'system', content: systemPrompt },
		{ role: 'user',   content: userMessage },
	];
	void signal;
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

const skill: Skill<ClassifyInput, ClassifyOutput> = {
	id: 'code.meta.classify-question',
	name: 'Meta: classify-question (code-analyzer router)',
	description:
		'Map a user question + active repo context to an ordered list of candidate ' +
		'code-analyzer skill ids the planner should invoke. First call in the ' +
		'planner pipeline. Cloud-routed; structured JSON output validated against ' +
		'the closed catalog.',
	family: 'meta',
	owner: 'code-analyzer',
	version: 1,
	inputs:  INPUT_SCHEMA as unknown as Record<string, unknown>,
	outputs: OUTPUT_SCHEMA as unknown as Record<string, unknown>,
	toolDeps: ['skill_describe'],
	providerAffinity: 'cloud',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['skill_describe'],
			reason: 'classify-question references skill_describe in its system prompt; the LLM may invoke it for catalog detail.',
		},
	],

	async execute(input, deps): Promise<SkillResult<ClassifyOutput>> {
		const ctx: SkillContext = { session: deps.session };
		const catalog = buildCatalog(input, ctx);

		if (catalog.length === 0) {
			return {
				value: {
					questionType:     'free-form',
					candidates:       [],
					fallbacks:        [],
					uncertaintyNotes: ['no skills survived the repo-capability prefilter; check that code-analyzer skills are registered'],
				},
				confidence: 'low',
				notes: ['empty catalog after prefilter'],
				toolCalls: [],
			};
		}

		const provider = deps.resolveProvider();
		const sys      = buildSystemPrompt();
		const user     = buildUserMessage(input, catalog);

		let raw: string;
		try {
			raw = await callLLM(provider, sys, user, deps.signal);
		} catch (err) {
			log.warn({ err: (err as Error).message }, 'classify-question LLM call failed');
			return {
				value:      emptyOutput(),
				confidence: 'low',
				notes:      [`LLM call failed: ${(err as Error).message}`],
				toolCalls:  [],
			};
		}

		let parsed = parseAndValidate(raw, catalog);
		if (parsed.ok !== true) {
			log.info({ kind: parsed.failure.kind, message: parsed.failure.message }, 'classify-question first-pass rejected; retrying');
			const retryUser = `${user}\n\nThe previous attempt was rejected: ${parsed.failure.message}\nReturn ONLY a JSON object matching the schema; no other text.`;
			let retryRaw: string;
			try {
				retryRaw = await callLLM(provider, sys, retryUser, deps.signal);
			} catch (err) {
				return {
					value:      emptyOutput(),
					confidence: 'low',
					notes:      [`LLM retry failed: ${(err as Error).message}`, `first-pass rejection: ${parsed.failure.message}`],
					toolCalls:  [],
				};
			}
			parsed = parseAndValidate(retryRaw, catalog);
			if (parsed.ok !== true) {
				log.warn({ kind: parsed.failure.kind, message: parsed.failure.message }, 'classify-question retry rejected; surfacing low confidence');
				return {
					value:      emptyOutput(),
					confidence: 'low',
					notes:      [`LLM output failed validation twice: ${parsed.failure.message}`],
					toolCalls:  [],
				};
			}
		}

		const value = parsed.value;
		const confidence =
			value.candidates.length === 0 ? 'low' :
			value.uncertaintyNotes.length > 0 ? 'medium' :
			'high';

		const result: SkillResult<ClassifyOutput> = { value, confidence, toolCalls: [] };
		if (value.uncertaintyNotes.length > 0) {
			return { ...result, notes: [...value.uncertaintyNotes] };
		}
		return result;
	},
};

function emptyOutput(): ClassifyOutput {
	return {
		questionType:     'free-form',
		candidates:       [],
		fallbacks:        [],
		uncertaintyNotes: [],
	};
}

export function registerCodeMetaClassifyQuestionSkill(): void {
	registerSkill(skill as unknown as Skill);
}

// Test exports.
export const _buildCatalogForTest      = buildCatalog;
export const _parseAndValidateForTest  = parseAndValidate;
export const _matchesRepoCapabilityForTest = matchesRepoCapability;
