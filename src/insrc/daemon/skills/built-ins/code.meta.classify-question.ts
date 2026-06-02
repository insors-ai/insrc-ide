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
import type { LLMMessage, LLMProvider, ToolDefinition } from '../../../shared/types.js';
import type {
	BootstrapTriggerKind,
	NamespaceSpec,
	OwnerId,
	SubstrateSkillExtension,
} from '../../substrate/types.js';

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
	/**
	 * Natural-language instruction telling the routed skill WHAT to achieve.
	 * Per A5 (plans/agentic-skills-architecture.md §A5): "Analyze file abc"
	 * is directionless; "Identify the join keys between this file's records
	 * and the GRN domain model's expected structure, focusing on field name
	 * overlap" is a goal a skill can plan against.
	 *
	 * Consumers:
	 *   - L2 skills: receive this as `invocationContext.goal` and plan how
	 *     to fulfill it.
	 *   - L1 skills: `code.meta.select-scope` reads this alongside the
	 *     skill's input schema to fill `input: I`.
	 */
	readonly goal:          string;
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
					// Per A5: natural-language instruction for the routed skill.
					goal:          { type: 'string', minLength: 1, maxLength: 500 },
					mustHaveScope: { type: 'string', enum: MUST_HAVE_SCOPES },
				},
				required: ['skillId', 'rationale', 'goal', 'mustHaveScope'],
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
    {
      "skillId": "code.source.file.describe",
      "rationale": "Single-file enumeration of declared entities + imports.",
      "goal": "Enumerate every entity declared in src/User.ts plus its imports; return the structured surface so the caller can decide what to drill into.",
      "mustHaveScope": "repo+file"
    }
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
    {
      "skillId": "code.entity.locate-by-name",
      "rationale": "Resolve 'compute' to a stable entity id first.",
      "goal": "Locate the function or method named 'compute' in the active repo; return its entity id so a callers walk can target it.",
      "mustHaveScope": "repo+entity"
    },
    {
      "skillId": "code.entity.callers",
      "rationale": "1-hop CALLS in-edges from the resolved entity.",
      "goal": "From the resolved 'compute' entity id, walk one hop of CALLS in-edges to identify every caller; return the caller list with file + line.",
      "mustHaveScope": "repo+entity"
    }
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
    {
      "skillId": "code.orm.resolve-model",
      "rationale": "Locate the ORM-defined User model with normalised columns + relations.",
      "goal": "Find the prisma 'User' model in the repo; return its normalised column list (name + type + nullability) and any declared relations so the caller can present the schema.",
      "mustHaveScope": "repo+model"
    }
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
    {
      "skillId": "code.quality.unused-exports",
      "rationale": "Exported entities with empty in-edge across IMPORTS / CALLS / REFERENCES.",
      "goal": "Identify every exported function / class / interface / type / variable in the repo whose in-edge set across IMPORTS, CALLS, and REFERENCES is empty; return the list grouped by file so the caller can recommend removal or downgrade.",
      "mustHaveScope": "repo"
    }
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
    {
      "skillId": "code.entity.locate-by-name",
      "rationale": "Resolve 'parseConfig' to an entity id at HEAD.",
      "goal": "Locate the function 'parseConfig' in the active repo at HEAD; return its entity id so a version-diff can target it.",
      "mustHaveScope": "repo+entity"
    },
    {
      "skillId": "code.compare.entity-versions",
      "rationale": "Diff one entity across two git refs.",
      "goal": "Diff the parseConfig function body between git ref v1.5 and HEAD; return the structural delta (signature change, body added/removed/changed lines) so the caller can summarise what evolved.",
      "mustHaveScope": "repo+entity"
    }
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
    {
      "skillId": "code.quality.complexity",
      "rationale": "Cyclomatic per function/method with histogram + top-N.",
      "goal": "Compute cyclomatic complexity for every function and method in the repo; return the full sorted list plus the severity histogram so the caller can filter to entries with cyclomatic > 30.",
      "mustHaveScope": "repo"
    }
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
    {
      "skillId": "code.compare.impl-vs-doc",
      "rationale": "Field-set drift between the implementation and a Markdown doc.",
      "goal": "Compare the User class's field set against the structure described in docs/user.md; return the drift (fields-only-in-impl, fields-only-in-docs, type mismatches) so the caller can flag what needs updating.",
      "mustHaveScope": "repo+class"
    }
  ],
  "fallbacks": [],
  "uncertaintyNotes": []
}
`.trim();

function buildSystemPrompt(): string {
	return [
		'You are a code-analyzer skill router. Map the user question to one or',
		'more candidate skill ids from the closed catalog the user message',
		`provides. Emit ONE tool_use block calling \`${SUBMIT_TOOL_NAME}\` whose`,
		'`input` matches this schema:',
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
		'4. EVERY candidate MUST include a `goal` -- a natural-language',
		'   instruction telling the routed skill WHAT to achieve, not just',
		'   THAT it should be called. Bad: "Analyze file abc". Good:',
		'   "Enumerate the field metadata for the User class; focus on',
		'   which fields are exported vs internal so the caller can decide',
		'   what to expose in the public API summary." The goal should:',
		'     - State the WHAT (what to find / compute / compare).',
		'     - State the WHERE (which file / entity / scope, when known).',
		'     - State the WHY-CALLER-NEEDS-IT (one short clause -- helps the',
		'       skill prioritise + decide how much detail to return).',
		'   The goal is what gives the skill direction beyond its catalog',
		'   summary. L2 skills consume it as planning input; L1 skills',
		'   ride select-scope, which reads the goal alongside the input',
		'   schema to fill concrete args.',
		'5. `uncertaintyNotes` should surface anything the question did not',
		'   specify (which file, which entity name, which git ref, which',
		'   threshold). Empty array if the question is fully scoped.',
		'6. Use `fallbacks` for second-choice skills the planner can pivot to',
		'   if the first candidates fail their preconditions or return',
		'   confidence: low.',
		'7. Set `questionType` to the closest fit; "free-form" only when no',
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
		`Respond by calling the \`${SUBMIT_TOOL_NAME}\` tool exactly once with the`,
		'structured payload. Do NOT emit prose, fenced JSON, or any reply outside the tool call.',
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

function parseAndValidate(parsed: unknown, catalog: readonly CatalogEntry[]): ParseResult {
	// Input is the tool-call's `input` payload -- already a parsed
	// object via the provider's wire protocol. The truncation-mid-
	// string class of failure (legacy text + responseFormat path) is
	// gone: the provider serializes JSON after token selection, not
	// before, so partial token budgets give well-formed payloads.
	if (parsed === undefined || parsed === null) {
		return { ok: false, failure: { kind: 'parse', message: 'no tool_use payload returned by provider' } };
	}
	if (typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { ok: false, failure: { kind: 'validation', message: 'tool_use payload must be a JSON object' } };
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
		const goal      = cc['goal'];
		const scope     = cc['mustHaveScope'];
		if (typeof skillId !== 'string' || !knownIds.has(skillId)) {
			return { ok: false, failure: { kind: 'validation', message: `candidates[${i}].skillId='${skillId}' not in the catalog` } };
		}
		if (typeof rationale !== 'string') {
			return { ok: false, failure: { kind: 'validation', message: `candidates[${i}].rationale must be a string` } };
		}
		// Per A5: goal is the natural-language instruction that gives the
		// routed skill direction. Non-empty required.
		if (typeof goal !== 'string' || goal.length === 0) {
			return { ok: false, failure: { kind: 'validation', message: `candidates[${i}].goal must be a non-empty string (per A5; see plans/skills/code/code.meta.classify-question.md)` } };
		}
		if (typeof scope !== 'string' || !MUST_HAVE_SCOPES.includes(scope as MustHaveScope)) {
			return { ok: false, failure: { kind: 'validation', message: `candidates[${i}].mustHaveScope must be one of: ${MUST_HAVE_SCOPES.join(', ')}` } };
		}
		candidates.push({ skillId, rationale, goal, mustHaveScope: scope as MustHaveScope });
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

// ---------------------------------------------------------------------------
// LLM call (tool-call protocol)
// ---------------------------------------------------------------------------

const SUBMIT_TOOL_NAME = 'submit_classification';

/**
 * Submission tool. The model emits ONE tool_use block whose `input`
 * carries the structured classify-question output. Mirrors the
 * data-side `data.meta.classify-question` upgrade -- truncation
 * mid-payload can't happen because the provider serializes JSON
 * after token selection, not before. The legacy text +
 * responseFormat path was prone to JSON.parse failures on max_tokens
 * truncation (the bug we hit on XL-tier code-analyze runs).
 */
const SUBMIT_TOOL: ToolDefinition = {
	name:        SUBMIT_TOOL_NAME,
	description: 'Submit the classify-question output: questionType + ordered candidate skill ids + fallbacks + uncertainty notes.',
	inputSchema: OUTPUT_SCHEMA as unknown as Record<string, unknown>,
};

async function callLLM(
	provider: LLMProvider,
	systemPrompt: string,
	userMessage: string,
	signal?: AbortSignal | undefined,
): Promise<unknown | undefined> {
	const messages: LLMMessage[] = [
		{ role: 'system', content: systemPrompt },
		{ role: 'user',   content: userMessage },
	];
	void signal;
	const response = await provider.complete(messages, {
		// 8192 tokens of structured-output budget. Cloud-LLM target;
		// the legacy 1024 was a local-LLM hangover and routinely
		// truncated the JSON payload mid-string on XL-tier sections
		// with 4 candidates. Tool-call protocol prevents the *parse*
		// failure mode entirely; this cap just stops the model running
		// indefinitely.
		maxTokens:   8192,
		temperature: 0.2,
		tools:       [SUBMIT_TOOL],
		toolChoice:  { name: SUBMIT_TOOL_NAME },
	});
	const toolCall = response.toolCalls?.find(tc => tc.name === SUBMIT_TOOL_NAME);
	return toolCall?.input;
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

		let rawPayload: unknown;
		try {
			rawPayload = await callLLM(provider, sys, user, deps.signal);
		} catch (err) {
			log.warn({ err: (err as Error).message }, 'classify-question LLM call failed');
			return {
				value:      emptyOutput(),
				confidence: 'low',
				notes:      [`LLM call failed: ${(err as Error).message}`],
				toolCalls:  [],
			};
		}

		let parsed = parseAndValidate(rawPayload, catalog);
		if (parsed.ok !== true) {
			log.info({ kind: parsed.failure.kind, message: parsed.failure.message }, 'classify-question first-pass rejected; retrying');
			const retryUser = `${user}\n\nThe previous attempt was rejected: ${parsed.failure.message}\nRe-emit a corrected \`${SUBMIT_TOOL_NAME}\` tool call.`;
			let retryPayload: unknown;
			try {
				retryPayload = await callLLM(provider, sys, retryUser, deps.signal);
			} catch (err) {
				return {
					value:      emptyOutput(),
					confidence: 'low',
					notes:      [`LLM retry failed: ${(err as Error).message}`, `first-pass rejection: ${parsed.failure.message}`],
					toolCalls:  [],
				};
			}
			parsed = parseAndValidate(retryPayload, catalog);
			if (parsed.ok !== true) {
				log.warn({ kind: parsed.failure.kind, message: parsed.failure.message }, 'classify-question retry rejected; surfacing low confidence');
				return {
					value:      emptyOutput(),
					confidence: 'low',
					notes:      [`tool_use payload failed validation twice: ${parsed.failure.message}`],
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

// ---------------------------------------------------------------------------
// Substrate-facing declarations (per plans/skills/code/code.meta.classify-question.md)
// ---------------------------------------------------------------------------
//
// Light wiring: this skill calls an LLM whose output varies per turn,
// so caching offers near-zero win. The declaration lands so D14 routing
// + future observation distillation (e.g. "questions about X always
// route through Y first") know who owns the routing decisions.

const OWNER_ID: OwnerId = 'skill:code.meta.classify-question';

const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = [
	'repo-add', 'reindex', 'manual',
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		// Future L2-distilled observations about routing patterns.
		// No writes from this L1 today.
		namespace:   'observations',
		valueType:   'WorkspacePatternObservation',
		autoDistill: 'never',
		indexing:    { kind: 'never' },
		ttl:         '30d',
	},
];

const substrateExtension: SubstrateSkillExtension = {
	ownerId:            OWNER_ID,
	schemaVersion:      1,
	interestedTriggers: INTERESTED_TRIGGERS,
	contextSlots:       [],
	memorySchema:       MEMORY_SCHEMA,
	assertionInterests: [],
};

const skillWithSubstrate = {
	...skill,
	...substrateExtension,
};

export function registerCodeMetaClassifyQuestionSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}

// Test exports.
export const _buildCatalogForTest      = buildCatalog;
export const _parseAndValidateForTest  = parseAndValidate;
export const _matchesRepoCapabilityForTest = matchesRepoCapability;
