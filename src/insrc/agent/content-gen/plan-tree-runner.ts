/**
 * Two-stage skill-tree planner (P4 of plans/planner-skill-tree.md).
 *
 * Stage 1 (lightweight catalog):
 *   - One-line description per skill in the candidate set.
 *   - LLM picks 8-12 skills it thinks are relevant via `submit_shortlist`.
 *   - Output: candidate skill id array.
 *
 * Stage 2 (focused full schemas):
 *   - For each shortlisted skill: full input schema + outputPaths.
 *   - Worked examples teach the wiring DSL.
 *   - LLM emits a typed `PlannedTree` via `submit_tree`.
 *   - Server-side validation (PLANNED_TREE_SCHEMA + structural +
 *     strict lookups). On failure, one retry with the typed error.
 *
 * Caller-supplied:
 *   - `catalog`: list of skills the runner may include in stage 1.
 *     The caller builds this from the registry (typically pre-filtered
 *     by active categories / connection-family preconditions).
 *   - `fallback`: a degraded-shape tree (typically an L2 `answer-question`
 *     leaf with the full question) used when both stages fail.
 *
 * The runner stays decoupled from the orchestrator: no session access,
 * no skill-registry imports. Tests inject a fake provider + a tiny
 * catalog and verify both stages.
 */

import { getLogger } from '../../shared/logger.js';
import type { LLMProvider, LLMMessage } from '../../shared/types.js';
import {
	PLANNED_TREE_SCHEMA,
	validatePlannedTree,
	type PlannedTree,
	type ValidationLookups,
} from './plan-tree.js';

const log = getLogger('content-gen:plan-tree-runner');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single skill entry the caller advertises to the planner. Stage 1
 * uses `id` + `description` + `family` + `owner`; Stage 2 additionally
 * uses `inputs` + `outputPaths`. The caller is responsible for filtering
 * the catalog to skills that are actually available in the current
 * session (registered, owner allowed, preconditions plausibly satisfied).
 */
export interface CatalogSkill {
	readonly id:           string;
	readonly description:  string;
	readonly family:       string;
	readonly owner:        string;
	readonly inputs:       Readonly<Record<string, unknown>>;
	readonly outputPaths:  readonly string[];
}

export interface PlanTreeInput {
	readonly intent:          string;      // 'code-analysis' | 'data-analysis' | ...
	readonly request:         string;
	readonly summaryContext:  string;
	readonly catalog:         readonly CatalogSkill[];
	/**
	 * Tree returned when both stages fail. Typically an L2 `answer-question`
	 * leaf with `inputs.question = { source: 'literal', value: request }`
	 * plus owner-appropriate context bindings. Must validate cleanly
	 * (caller's responsibility); the runner does NOT re-validate it.
	 */
	readonly fallback:        PlannedTree;
	readonly maxShortlistSize?: number | undefined;     // default 12
	readonly maxTokens?:        number | undefined;     // default 3500
	readonly analyzerLabel?:    string | undefined;
}

export interface PlanTreeResult {
	readonly tree:     PlannedTree;
	/** True when the runner had to fall back -- one or both stages failed. */
	readonly degraded: boolean;
	readonly note?:    string | undefined;
	/** Stage 1 shortlist after parsing (informational; useful for telemetry). */
	readonly shortlist?: readonly string[] | undefined;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function planTree(
	input:        PlanTreeInput,
	cloudProvider: LLMProvider,
): Promise<PlanTreeResult> {
	if (input.request.trim().length === 0) {
		throw new Error('planTree: `request` must be non-empty');
	}

	const maxShortlist = clamp(input.maxShortlistSize ?? 12, 1, 24);
	const maxTokens    = input.maxTokens ?? 3500;

	// --- Stage 1: candidate shortlist ---
	const stage1 = await runStage1(input, cloudProvider, maxShortlist, maxTokens);
	if (stage1.kind === 'error') {
		log.warn({ analyzer: input.analyzerLabel, reason: stage1.reason }, 'plan-tree stage 1 failed; falling back');
		return { tree: input.fallback, degraded: true, note: `stage-1: ${stage1.reason}` };
	}
	const shortlist = stage1.shortlist;

	// --- Stage 2: tree composition ---
	const stage2 = await runStage2(input, shortlist, cloudProvider, maxTokens);
	if (stage2.kind === 'ok') {
		return { tree: stage2.tree, degraded: false, shortlist };
	}

	log.warn({ analyzer: input.analyzerLabel, reason: stage2.reason }, 'plan-tree stage 2 failed; falling back');
	return { tree: input.fallback, degraded: true, note: `stage-2: ${stage2.reason}`, shortlist };
}

// ---------------------------------------------------------------------------
// Stage 1 -- candidate shortlist
// ---------------------------------------------------------------------------

const SUBMIT_SHORTLIST_TOOL = 'submit_shortlist';

const SUBMIT_SHORTLIST_SCHEMA = {
	type: 'object',
	properties: {
		skillIds: {
			type:     'array',
			items:    { type: 'string', minLength: 1 },
			minItems: 1,
			maxItems: 24,
		},
		rationale: { type: 'string', maxLength: 600 },
	},
	required: ['skillIds'],
	additionalProperties: false,
} as const;

type Stage1Result =
	| { kind: 'ok'; shortlist: readonly string[] }
	| { kind: 'error'; reason: string };

async function runStage1(
	input:        PlanTreeInput,
	provider:     LLMProvider,
	maxShortlist: number,
	maxTokens:    number,
): Promise<Stage1Result> {
	const system = buildStage1SystemPrompt(input.intent, maxShortlist);
	const user   = buildStage1UserPrompt(input);

	const tool = {
		name:        SUBMIT_SHORTLIST_TOOL,
		description: 'Submit the shortlist of skill ids most relevant to the user question.',
		inputSchema: SUBMIT_SHORTLIST_SCHEMA as unknown as Record<string, unknown>,
	};

	const messages: LLMMessage[] = [
		{ role: 'system', content: system },
		{ role: 'user',   content: user   },
	];

	let response;
	try {
		response = await provider.complete(messages, {
			maxTokens,
			temperature: 0.2,
			tools:       [tool],
			toolChoice:  { name: SUBMIT_SHORTLIST_TOOL },
		});
	} catch (err) {
		return { kind: 'error', reason: `provider error: ${(err as Error).message}` };
	}

	const call = response.toolCalls?.[0];
	if (call === undefined || call.name !== SUBMIT_SHORTLIST_TOOL) {
		return { kind: 'error', reason: `no ${SUBMIT_SHORTLIST_TOOL} tool_use payload returned` };
	}

	const parsed = call.input as { skillIds?: unknown; rationale?: unknown };
	if (!Array.isArray(parsed.skillIds)) {
		return { kind: 'error', reason: 'submit_shortlist.skillIds is not an array' };
	}
	const known = new Set(input.catalog.map(c => c.id));
	const shortlist: string[] = [];
	for (const id of parsed.skillIds as unknown[]) {
		if (typeof id !== 'string') continue;
		const trimmed = id.trim();
		if (trimmed.length === 0) continue;
		if (!known.has(trimmed)) {
			// Drop unknown / hallucinated ids silently; the planner will
			// still get a valid shortlist subset.
			log.warn({ analyzer: input.analyzerLabel, hallucinated: trimmed }, 'stage 1 dropped unknown skill id');
			continue;
		}
		if (!shortlist.includes(trimmed)) shortlist.push(trimmed);
	}
	if (shortlist.length === 0) {
		return { kind: 'error', reason: 'shortlist was empty after dropping unknown ids' };
	}
	return { kind: 'ok', shortlist };
}

function buildStage1SystemPrompt(intent: string, maxShortlist: number): string {
	return [
		`You are the SKILL-SHORTLIST stage of a ${intent} planner.`,
		'',
		'Given the user question and a one-line description of every',
		'available skill, pick the 4-' + String(maxShortlist) + ' skills most',
		'likely to be useful in answering the question. The second stage',
		'will then compose them into a typed skill tree.',
		'',
		'Selection rules:',
		'  1. Only include skill ids that appear in the catalog below.',
		'  2. Prefer concrete data-producing skills (extract / sample /',
		'     describe / locate) over abstract synthesis skills.',
		'  3. Include skills from multiple owners when the question',
		'     genuinely spans categories (e.g. a question that compares',
		'     JSON test data to a pydantic class needs both `data.*` and',
		'     `code.*` skills).',
		'  4. If the question is open-ended ("explain", "what are the',
		'     patterns", "summarize"), shortlist the L2 fallback',
		'     `<owner>.answer-question` for that owner.',
		'',
		`Emit your answer by calling \`${SUBMIT_SHORTLIST_TOOL}\` exactly once.`,
	].join('\n');
}

function buildStage1UserPrompt(input: PlanTreeInput): string {
	const lines: string[] = [
		'## Question',
		input.request.trim(),
		'',
		'## Summary context',
		input.summaryContext.trim().length > 0 ? input.summaryContext.trim() : '(no summary supplied)',
		'',
		`## Skill catalog (${input.catalog.length} skills)`,
	];
	for (const s of input.catalog) {
		const oneLine = s.description.replace(/\s+/g, ' ').trim().slice(0, 160);
		lines.push(`- \`${s.id}\` [${s.owner} / ${s.family}] -- ${oneLine}`);
	}
	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Stage 2 -- typed tree composition
// ---------------------------------------------------------------------------

const SUBMIT_TREE_TOOL = 'submit_tree';

type Stage2Result =
	| { kind: 'ok'; tree: PlannedTree }
	| { kind: 'error'; reason: string };

async function runStage2(
	input:     PlanTreeInput,
	shortlist: readonly string[],
	provider:  LLMProvider,
	maxTokens: number,
): Promise<Stage2Result> {
	const filtered = input.catalog.filter(s => shortlist.includes(s.id));
	if (filtered.length === 0) {
		return { kind: 'error', reason: 'no candidate skills survived shortlist intersection with catalog' };
	}

	const lookups: ValidationLookups = {
		skillExists:      (id) => filtered.some(s => s.id === id),
		skillOutputPaths: (id) => filtered.find(s => s.id === id)?.outputPaths ?? [],
	};

	const system = buildStage2SystemPrompt(input.intent);
	const user   = buildStage2UserPrompt(input, filtered);

	const tool = {
		name:        SUBMIT_TREE_TOOL,
		description: 'Submit the typed skill tree the orchestrator will execute.',
		inputSchema: PLANNED_TREE_SCHEMA as unknown as Record<string, unknown>,
	};

	let messages: LLMMessage[] = [
		{ role: 'system', content: system },
		{ role: 'user',   content: user   },
	];

	const first = await attemptStage2(messages, provider, tool, lookups, maxTokens);
	if (first.kind === 'ok') return first;

	// One retry with a corrective user message. Surface the structured
	// error verbatim; the LLM has seen the typed schema and tends to fix
	// localized issues (wrong path, missing inputs, etc.).
	log.warn({ analyzer: input.analyzerLabel, reason: first.reason }, 'plan-tree stage 2: retrying with correction');
	messages = [
		...messages,
		{
			role:    'user',
			content: `Your previous submit_tree call was rejected:\n\n  ${first.reason}\n\nEmit ONE new submit_tree call with the typed payload corrected. Do NOT include prose or markdown outside the tool call.`,
		},
	];
	const second = await attemptStage2(messages, provider, tool, lookups, maxTokens);
	return second;
}

async function attemptStage2(
	messages: LLMMessage[],
	provider: LLMProvider,
	tool:     { name: string; description: string; inputSchema: Record<string, unknown> },
	lookups:  ValidationLookups,
	maxTokens: number,
): Promise<Stage2Result> {
	let response;
	try {
		response = await provider.complete(messages, {
			maxTokens,
			temperature: 0,
			tools:       [tool],
			toolChoice:  { name: SUBMIT_TREE_TOOL },
		});
	} catch (err) {
		return { kind: 'error', reason: `provider error: ${(err as Error).message}` };
	}

	const call = response.toolCalls?.[0];
	if (call === undefined || call.name !== SUBMIT_TREE_TOOL) {
		return { kind: 'error', reason: `no ${SUBMIT_TREE_TOOL} tool_use payload returned` };
	}

	const validated = validatePlannedTree(call.input, lookups);
	if (typeof validated === 'string') {
		return { kind: 'error', reason: `validation: ${validated}` };
	}
	return { kind: 'ok', tree: validated };
}

function buildStage2SystemPrompt(intent: string): string {
	return [
		`You are the TREE-COMPOSITION stage of a ${intent} planner.`,
		'',
		'Compose a typed skill tree the orchestrator will execute',
		'deterministically. Each node is either a `leaf` (one skill',
		'invocation) or a `composition` (an ordered group of children).',
		'',
		'## Wiring DSL',
		'',
		'Every node has an `inputs` object whose keys are the skill\'s',
		'input-schema argument names. Each value is an InputBinding:',
		'',
		'  { "source": "literal",  "value": <any> }            -- hardcoded',
		'  { "source": "question", "extract": "<regex>" }      -- regex on the user request',
		'  { "source": "context",  "key": "<contextKey>" }     -- session-supplied',
		'  { "source": "node",     "nodeId": "<earlier-id>",   -- output of an earlier node',
		'    "path":   "<dotted.path[*].with.iters>" }',
		'',
		'Path syntax: `prop`, `prop.sub`, `prop[*]` (array iteration),',
		'`prop[*].sub`. Positional indexes (`prop[0]`) are NOT supported.',
		'',
		'## Wiring rules',
		'',
		'  1. A node can only wire from an EARLIER node in execution order:',
		'     an ancestor or an earlier-sibling-in-the-same-composition.',
		'     Forward refs are rejected.',
		'  2. Wires must target leaf nodes (not composition nodes).',
		'     Compositions have no structured output.',
		'  3. Wire paths must exist in the source skill\'s outputPaths list',
		'     (the catalog below lists them per skill).',
		'',
		'## Emit semantics',
		'',
		'  - `emit: "section"`     -- node\'s output becomes one report section',
		'  - `emit: "intermediate"` -- output only feeds downstream wires',
		'  - `emit: "discard"`     -- output dropped after children resolve',
		'',
		'## Caps',
		'',
		'  - At most 32 leaves, 4 levels deep, 8 children per composition.',
		'',
		'## Composition rule',
		'',
		'Use `kind: "composition"` to group related skills that feed a',
		'downstream consumer; the consumer goes AFTER its dependencies in',
		'the same composition. Use `kind: "leaf"` for direct skill calls.',
		'',
		'## Context keys (available via `source: "context"`)',
		'',
		'  - `codeRepoPath`       -- absolute path of the active code repo',
		'  - `primaryConnection`  -- id of the primary data connection',
		'  - `sessionId`          -- current session id',
		'',
		`## Emit the tree via the \`${SUBMIT_TREE_TOOL}\` tool exactly once.`,
		'Do NOT include prose outside the tool call.',
	].join('\n');
}

function buildStage2UserPrompt(input: PlanTreeInput, filtered: readonly CatalogSkill[]): string {
	const lines: string[] = [
		'## Question',
		input.request.trim(),
		'',
		'## Summary context',
		input.summaryContext.trim().length > 0 ? input.summaryContext.trim() : '(no summary supplied)',
		'',
		'## Worked example',
		'',
		'For a question "Map JSON test data in /test/fixtures/Orders to the',
		'Order pydantic class", a well-shaped tree would be:',
		'',
		'```json',
		EXAMPLE_TREE_JSON,
		'```',
		'',
		`## Shortlisted skills (${filtered.length})`,
		'',
		'Each block lists the skill\'s id, owner, input schema, and the',
		'output paths you may wire downstream consumers to. Wire paths',
		'MUST come from the listed outputPaths.',
		'',
	];
	for (const s of filtered) {
		lines.push(`### \`${s.id}\`  [${s.owner} / ${s.family}]`);
		lines.push(s.description.replace(/\s+/g, ' ').trim());
		lines.push('');
		lines.push('inputSchema:');
		lines.push('```json');
		lines.push(JSON.stringify(s.inputs, null, 2));
		lines.push('```');
		lines.push('');
		if (s.outputPaths.length > 0) {
			lines.push('outputPaths: ' + s.outputPaths.map(p => `\`${p}\``).join(', '));
		} else {
			lines.push('outputPaths: (none -- this skill\'s output is opaque; do not wire from it)');
		}
		lines.push('');
	}
	return lines.join('\n');
}

// Hand-written example tree. Doubles as a smoke test (it MUST validate
// against PLANNED_TREE_SCHEMA + the structural validator under fake
// lookups; covered in the unit tests).
const EXAMPLE_TREE_JSON = `{
  "intentBrief": "Compare the Order pydantic class to the JSON fixtures in /test/fixtures/Orders.",
  "root": {
    "id": "root",
    "title": "Order: class vs fixtures",
    "objective": "Group three siblings (data-shape, class-shape, alignment) under one composition.",
    "kind": "composition",
    "composition": "sequence",
    "inputs": {},
    "emit": "discard",
    "children": [
      {
        "id": "data-shape",
        "title": "JSON fixtures shape",
        "objective": "Describe column types in the JSON fixtures.",
        "kind": "leaf",
        "skill": "data.source.file.sample-shape",
        "inputs": {
          "connectionId": { "source": "context", "key": "primaryConnection" }
        },
        "emit": "intermediate"
      },
      {
        "id": "class-shape",
        "title": "Order class fields",
        "objective": "Extract Order pydantic class field metadata.",
        "kind": "leaf",
        "skill": "code.class.extract-fields",
        "inputs": {
          "className": { "source": "question", "extract": "\\\\bOrder\\\\b" },
          "language":  { "source": "literal",  "value": "python" },
          "repoPath":  { "source": "context",  "key": "codeRepoPath" }
        },
        "emit": "intermediate"
      },
      {
        "id": "align",
        "title": "JSON ↔ Order field mapping",
        "objective": "Compute structural alignment between JSON column shape and class fields.",
        "kind": "leaf",
        "skill": "shared.compare.fields-vs-shape",
        "inputs": {
          "classFields": { "source": "node", "nodeId": "class-shape", "path": "fields" },
          "dataShape":   { "source": "node", "nodeId": "data-shape",  "path": "columns" }
        },
        "emit": "section"
      }
    ]
  }
}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, n));
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _stage1SystemPromptForTest = buildStage1SystemPrompt;
export const _stage1UserPromptForTest   = buildStage1UserPrompt;
export const _stage2SystemPromptForTest = buildStage2SystemPrompt;
export const _stage2UserPromptForTest   = buildStage2UserPrompt;
export const _exampleTreeJsonForTest    = EXAMPLE_TREE_JSON;
