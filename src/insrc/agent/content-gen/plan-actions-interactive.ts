/**
 * Interactive (tool-using) cloud planner -- Plan 4 Phase 2 of
 * plans/code-analyzer-planner-discovery-loop.md.
 *
 * The cloud planner runs as a tool-using agent on the tool-loop
 * substrate. It is handed a curated subset of the existing skill
 * catalog + a `submit_plan` termination tool; it probes the repo
 * via real skill calls, then emits the final plan as a structured
 * payload via submit_plan.
 *
 * Replaces the static `planActions()` one-shot with a discovery
 * loop -- the planner sees what's actually in the repo instead of
 * a precomputed summary that often surfaced test fixtures and SQL
 * deltas instead of real subsystems.
 *
 * Same outward contract as `planActions`: returns
 * `PlanActionsResult` (`{ intentBrief, actions, degraded, note? }`).
 * On any failure path (turn-cap exhaustion, provider error,
 * unrecoverable schema violation), returns `degraded: true` so the
 * orchestrator can fall back to its existing synthetic action.
 *
 * This is the only code-analyzer planner. The legacy
 * `INSRC_ANALYZER_PLANNER_FLOW=static` rollback hatch was removed
 * once the discovery loop accumulated enough live miles; data-
 * analyzer callers still use the static `planActions` directly
 * because their planning shape differs.
 */

import type {
	LLMProvider,
	LLMMessage,
	ToolCall,
	ToolDefinition,
	ToolResult,
} from '../../shared/types.js';
import type { ScopeSize } from '../../shared/classify.js';
import type { AnalysisSubtype } from '../classify/scope.js';
import type { Session } from '../session.js';
import { runToolLoop, type TerminationTool } from '../tool-loop.js';
import { runSkill, getSkill } from '../../daemon/skills/index.js';
import type { SkillResult } from '../../daemon/skills/types.js';
import { getLogger } from '../../shared/logger.js';
import { PLAN_ACTIONS_SCHEMA } from './schema.js';
import {
	DEFAULT_MAX_ACTIONS,
	type AvailableCategory,
	type PlanActionsResult,
	type PlannedAction,
	_validatePlanForTest as validatePlan,
} from './plan-actions.js';
import { PLANNER_DISCOVERY_SKILL_IDS } from './planner-discovery-skills.js';

const log = getLogger('content-gen:plan-actions-interactive');

/**
 * Default per-call turn budget for the planner-discovery loop. Each
 * turn maps to exactly one LLM round-trip; since the substrate
 * dispatches discovery skills serially (no-parallel-LLM rule), each
 * turn also yields exactly one skill invocation. 12 turns gives the
 * planner enough room to walk a multi-module repo (repo summary +
 * top-level modules + a couple of file probes + git changes + a
 * subsystem deep-dive) before committing via submit_plan. The
 * substrate's degenerate-repeat detector still fires earlier if the
 * planner stalls on the same call, so the worst-case wall clock is
 * bounded by either convergence or stall, not the raw cap.
 */
const DEFAULT_MAX_TURNS = 12;

// ---------------------------------------------------------------------------
// Public input/output
// ---------------------------------------------------------------------------

export interface PlanActionsInteractiveInput {
	readonly intent:         string;
	readonly request:        string;
	readonly repoPath:       string;
	readonly tier:           ScopeSize;
	/** Work-shape hint from the scope classifier (Plan 3). Used to
	 *  bias the planner's section emphasis with a single-line note in
	 *  the system prompt. Defaults to 'review'. */
	readonly subtype?:       AnalysisSubtype | undefined;
	/** Session needed by `runSkill` for the dispatcher's deps. */
	readonly session:        Session;
	/** Provider resolver used by `runSkill` for skills whose
	 *  affinity matters (the discovery skills are all 'auto' so the
	 *  resolver is rarely invoked, but kept for parity). */
	readonly resolveProvider: (affinity: 'local' | 'cloud' | 'auto') => LLMProvider;
	readonly maxActions?:    number | undefined;
	readonly maxTurns?:      number | undefined;
	readonly maxTokens?:     number | undefined;
	readonly analyzerLabel?: string | undefined;
	/**
	 * Cross-category capabilities the orchestrator advertises to the
	 * planner. The planner may then tag any action with
	 * `requiredCategories` drawn from this list. The orchestrator's own
	 * category is implicit (always allowed); only OTHER categories are
	 * listed here. Undefined / empty disables cross-category planning.
	 * See plans/planner-cross-category-skills.md.
	 */
	readonly availableCategories?: readonly AvailableCategory[] | undefined;
}

/**
 * Run the interactive planner. Throws only if `request` is empty;
 * every other error path returns `degraded: true` with an empty
 * `actions` array.
 */
export async function planActionsInteractive(
	input: PlanActionsInteractiveInput,
	cloudProvider: LLMProvider,
): Promise<PlanActionsResult> {
	if (input.request.trim().length === 0) {
		throw new Error('planActionsInteractive: `request` must be non-empty');
	}

	const requested  = input.maxActions ?? DEFAULT_MAX_ACTIONS;
	const maxActions = Math.max(1, Math.min(32, requested));
	const maxTurns   = Math.max(2, Math.min(20, input.maxTurns ?? DEFAULT_MAX_TURNS));
	const subtype    = input.subtype ?? 'review';

	// Build the tool catalog from the curated planner skill list.
	// Skills not registered are silently skipped -- means tests can
	// run with a subset registered without crashing the planner.
	// `nameToSkillId` maps the sanitized wire-format name (dots ->
	// underscores) back to the original dotted skill id so the
	// dispatcher can `runSkill` against the real registry key.
	const { tools, nameToSkillId } = buildPlannerToolCatalog();
	if (tools.length === 0) {
		log.warn({ analyzer: input.analyzerLabel }, 'planActionsInteractive: no planner skills registered; degrading');
		return { intentBrief: '', actions: [], degraded: true, note: 'no planner skills registered' };
	}

	const messages = buildSeedMessages({
		intent:    input.intent,
		request:   input.request,
		repoPath:  input.repoPath,
		tier:      input.tier,
		subtype,
		tools,
		availableCategories: input.availableCategories,
	});

	// Dispatcher: route each tool-call to the actual skill via runSkill.
	// `call.name` is the sanitized wire-format name (e.g.
	// `code_source_repo_describe`); we resolve it back to the dotted
	// skill id (`code.source.repo.describe`) via `nameToSkillId` before
	// hitting runSkill. Unknown names get an explicit isError so the
	// LLM sees the typed feedback instead of a stack trace.
	//
	// Planner-discovery skills declare `repoPath` as required on most
	// of their schemas but the LLM (cloud or local) routinely omits it
	// because the active session has exactly one repo. We auto-inject
	// `repoPath: input.repoPath` into any call missing it BEFORE
	// hitting runSkill -- prevents the rejection chain that otherwise
	// burns the discovery turn budget on schema-validation retries.
	const sessionRepoPath = input.repoPath;
	const dispatcher = async (call: ToolCall): Promise<ToolResult> => {
		const skillId = nameToSkillId.get(call.name);
		if (skillId === undefined) {
			return {
				toolCallId: call.id,
				content:
					`[planner-discovery] '${call.name}' is not in the planner catalog. ` +
					`Available tools: ${[...nameToSkillId.keys()].join(', ')}.`,
				isError: true,
			};
		}
		const callInput: Record<string, unknown> = call.input === undefined || call.input === null
			? {}
			: { ...call.input };
		if (
			sessionRepoPath !== undefined &&
			sessionRepoPath.length > 0 &&
			(callInput['repoPath'] === undefined || callInput['repoPath'] === null || callInput['repoPath'] === '')
		) {
			callInput['repoPath'] = sessionRepoPath;
		}
		try {
			const result = await runSkill(skillId, callInput, {
				session:         input.session,
				resolveProvider: input.resolveProvider,
			});
			return {
				toolCallId: call.id,
				content:    renderSkillResultForLLM(skillId, result),
				isError:    result.confidence === 'low',
			};
		} catch (err) {
			return {
				toolCallId: call.id,
				content:    `[planner-discovery] runSkill('${skillId}') threw: ${(err as Error).message}`,
				isError:    true,
			};
		}
	};

	// Termination pseudo-tool. Reuses the existing PLAN_ACTIONS_SCHEMA
	// as its inputSchema so the cloud provider validates server-side.
	const submitPlan: TerminationTool<{ intentBrief: string; actions: readonly PlannedAction[] }> = {
		name:        'submit_plan',
		description:
			'Submit the final section plan when discovery is complete. Input is the typed ' +
			'PlanActionsResult payload: { intentBrief, actions: [...] }. The substrate intercepts ' +
			'this call -- it is NOT dispatched as a regular tool. Emit it ONLY when you have ' +
			'enough repo context to commit; if combined with other tool calls in the same turn ' +
			'the batch is rejected.',
		inputSchema: PLAN_ACTIONS_SCHEMA as unknown as Record<string, unknown>,
		validate:    (raw) => {
			const result = validatePlan(raw);
			if (typeof result === 'string') {
				return result;
			}
			return { intentBrief: result.intentBrief, actions: result.actions };
		},
	};

	const outcome = await runToolLoop<{ intentBrief: string; actions: readonly PlannedAction[] }>({
		provider:     cloudProvider,
		messages,
		tools,
		dispatchTool: dispatcher,
		policy: {
			maxTurns,
			toolChoice:             'auto',
			...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
			terminationTool:        submitPlan,
			onMixedTermination:     'reject',
			onSchemaViolation:      'retry-with-correction',
			// Planner discovery is read-only and the individual skill
			// calls are independent (each describes a different module
			// / file / entity). Let Anthropic batch-dispatch them in
			// parallel instead of forcing one-tool-per-turn rejections
			// that burn the turn budget without making progress.
			onMultipleToolsPerTurn: 'dispatch-all',
			stopOnDegenerateRepeat: true,
		},
		label: 'planner-discovery',
	});

	if (outcome.kind === 'terminated') {
		const clamped = outcome.payload.actions.slice(0, maxActions);
		log.info(
			{
				analyzer:        input.analyzerLabel,
				turnCount:       outcome.turnCount,
				actionCount:     clamped.length,
				intentBriefLen:  outcome.payload.intentBrief.length,
			},
			'planActionsInteractive: complete (terminated via submit_plan)',
		);
		return {
			intentBrief: outcome.payload.intentBrief,
			actions:     clamped,
			degraded:    false,
		};
	}

	const note = describeOutcomeForDegraded(outcome);
	log.warn(
		{
			analyzer:  input.analyzerLabel,
			outcome:   outcome.kind,
			turnCount: outcome.turnCount,
			note,
		},
		'planActionsInteractive: degraded (loop did not terminate cleanly)',
	);
	return {
		intentBrief: '',
		actions:     [],
		degraded:    true,
		note:        `planner-discovery: ${note}`,
	};
}

// ---------------------------------------------------------------------------
// Tool catalog construction
// ---------------------------------------------------------------------------

/**
 * Sanitize a dotted skill id (e.g. `code.source.repo.describe`) into
 * a wire-format tool name (e.g. `code_source_repo_describe`).
 *
 * Anthropic enforces `^[a-zA-Z0-9_-]{1,128}$` on `tools[].custom.name`
 * and rejects requests with a 400 if any tool carries a dotted name.
 * OpenAI / Mistral / Gemini share the same alphanumeric+underscore
 * convention. Underscoring is the lowest-friction transform that
 * keeps the name unique (no two registered skill ids differ only in
 * `.` vs `_`).
 *
 * Pure function; exported for testability.
 */
export function sanitizeToolName(skillId: string): string {
	return skillId.replace(/\./g, '_');
}

interface PlannerToolCatalog {
	readonly tools:         ToolDefinition[];
	/** Map sanitized wire-format name -> original dotted skill id. */
	readonly nameToSkillId: ReadonlyMap<string, string>;
}

function buildPlannerToolCatalog(): PlannerToolCatalog {
	const tools: ToolDefinition[] = [];
	const nameToSkillId = new Map<string, string>();
	for (const id of PLANNER_DISCOVERY_SKILL_IDS) {
		const skill = getSkill(id);
		if (skill === undefined) {
			continue;
		}
		const wireName = sanitizeToolName(skill.id);
		nameToSkillId.set(wireName, skill.id);
		tools.push({
			name:        wireName,
			description: skill.description,
			inputSchema: skill.inputs,
		});
	}
	return { tools, nameToSkillId };
}

// ---------------------------------------------------------------------------
// Subtype hints (Plan 3 consumer)
// ---------------------------------------------------------------------------

const SUBTYPE_HINTS: Readonly<Record<AnalysisSubtype, string>> = Object.freeze({
	review:    'This is a review request -- bias your sections toward surfacing gaps, risks, weak spots, and improvement opportunities.',
	summarize: 'This is a summarize request -- bias toward concise, broad-stroke sections. Prefer fewer sections; avoid exhaustive enumeration.',
	audit:     'This is an audit request -- bias toward exhaustive coverage with explicit verdicts on each axis. Don\'t skip relevant axes; surface problems clearly.',
	explain:   'This is an explain request -- bias toward pedagogical walkthrough. Sections should teach how/why things work, not just list what\'s there.',
	compare:   'This is a compare request -- bias each section toward two-sided framing (X vs Y, before vs after).',
	document:  'This is a document request -- bias toward neutral, complete reference documentation. Sections should read like docs, not opinions.',
	diagnose:  'This is a diagnose request -- bias toward evidence-driven cause analysis. Sections should follow the investigation, not the codebase\'s structure.',
});

// ---------------------------------------------------------------------------
// Seed prompt
// ---------------------------------------------------------------------------

interface BuildSeedInput {
	readonly intent:   string;
	readonly request:  string;
	readonly repoPath: string;
	readonly tier:     ScopeSize;
	readonly subtype:  AnalysisSubtype;
	readonly tools:    readonly ToolDefinition[];
	readonly availableCategories?: readonly AvailableCategory[] | undefined;
}

function buildSeedMessages(input: BuildSeedInput): LLMMessage[] {
	const haveCategories = input.availableCategories !== undefined && input.availableCategories.length > 0;
	const systemLines: string[] = [
		`You plan a ${input.intent} report for a coding assistant.`,
		'',
		'You have access to a curated set of discovery skills that let you',
		'inspect the repo before committing to a section plan. Use them.',
		'',
		'## How to plan',
		'',
		'1. Read the request and the repo path below.',
		'2. Use the discovery skills to learn what is ACTUALLY in this repo --',
		'   list top-level subdirs, describe modules the request points at,',
		'   read README files, grep for features, list git changes when the',
		'   request mentions them.',
		'3. Commit ONLY when you can name each section after a real subsystem',
		'   you have observed (not a generic axis label). When ready, call',
		'   `submit_plan({ intentBrief, actions })` with the final plan.',
		'',
		'## Discovery skills',
		'',
		'You have these skills available. Each one\'s schema is registered with',
		'the provider -- the tool-use API will surface the inputs:',
		'',
		...input.tools.map(t => `- \`${t.name}\` -- ${t.description}`),
		'',
		'## Termination',
		'',
		'When the final plan is ready, emit a SINGLE tool_use for `submit_plan`',
		'with the typed payload. Do NOT combine `submit_plan` with other tool',
		'calls in the same turn -- the substrate rejects mixed batches.',
		'',
		'## Per-action requirements',
		'',
		'Each action in the submitted plan MUST have:',
		'  - `id`              -- kebab-case stable key, deduped across actions',
		'  - `title`           -- short heading naming a SPECIFIC subsystem /',
		'                         module / file group from the repo you\'ve',
		'                         observed via discovery. Generic axis titles',
		'                         like "Testing Framework", "External Dependencies",',
		'                         "Deployment & Build Artifacts" are CODE SMELLS --',
		'                         they signal you didn\'t use discovery enough.',
		'                         If you find yourself wanting to write one,',
		'                         probe more first.',
		'  - `objective`       -- ONE sentence stating WHAT the section answers.',
		'                         Goal, not tool call.',
		'  - `maxBudgetTokens` -- cap for the local writer (default 1500;',
		'                         clamp 400-3000).',
		'  - `reviewCriteria`  -- 3-5 concrete checkable statements (e.g.',
		'                         "names the persistence client(s) used and',
		'                         the table layout"), preferably referencing',
		'                         class names / file paths you observed.',
	];
	// Per plans/planner-cross-category-skills.md P2: surface the optional
	// per-action `requiredCategories` field and its decision rule WHEN the
	// caller advertises cross-category capabilities. Otherwise stay silent
	// so the planner doesn't waste tokens on a field it cannot use.
	if (haveCategories) {
		systemLines.push(
			'  - `requiredCategories` -- OPTIONAL list of OTHER skill categories',
			'                            this section needs. Default to omitting',
			'                            this field. Add a category only when the',
			'                            section\'s objective INHERENTLY requires',
			'                            that capability (e.g. comparing data',
			'                            shapes to a pydantic class definition',
			'                            needs `code-analyzer`; mapping a Java',
			'                            class\'s outputs to downstream CSVs needs',
			'                            `data-analyzer`). See the catalog below.',
		);
	}
	systemLines.push(
		'',
		`## Subtype bias (${input.subtype})`,
		SUBTYPE_HINTS[input.subtype],
	);

	const userLines: string[] = [
		'## Intent',
		input.intent,
		'',
		'## Request',
		input.request.trim(),
		'',
		'## Active repo',
		input.repoPath,
		'',
		'## Scope tier',
		input.tier,
	];
	// Trailing structural reference -- recency-weighted attention rule
	// (memory: prompt-structure feedback).
	if (haveCategories) {
		userLines.push(
			'',
			'## Available cross-category capabilities',
			'Tag actions with `requiredCategories: ["<category>", ...]` drawn',
			'from the list below WHEN the section cannot be answered from',
			'your own category alone:',
			'',
			...input.availableCategories!.map(c => `  - ${c.category}: ${c.capabilityHint}`),
		);
	}
	userLines.push(
		'',
		'Begin your discovery now. Use the skills above; commit via',
		'`submit_plan` when the plan is ready.',
	);

	return [
		{ role: 'system', content: systemLines.join('\n') },
		{ role: 'user',   content: userLines.join('\n') },
	];
}

// ---------------------------------------------------------------------------
// Skill result rendering
// ---------------------------------------------------------------------------

/**
 * Per-tool-result wire budget. Discovery skills like
 * `code.source.repo.describe` return full module listings (30K+
 * entities) that easily run 60-100K chars. With `dispatch-all` letting
 * Anthropic fanout 5+ calls in one turn, the combined payload can blow
 * the 200K-token context window (live repro: 216K tokens > 200K).
 *
 * 12000 chars (~3000 tokens) per call leaves room for ~10 parallel
 * dispatches plus the system + user prompts within budget while still
 * showing the planner enough structure to plan around (top-N module
 * list, first dozen entities, etc. -- everything important fits in
 * the head of a sorted result).
 */
const RENDER_VALUE_MAX_CHARS = 12000;

/**
 * Render a SkillResult as the textual `content` of a ToolResult the
 * cloud planner will read. Kept compact; the planner doesn't need
 * markdown formatting like the per-section flow does. Value JSON is
 * head-truncated to RENDER_VALUE_MAX_CHARS so a batch of large skill
 * results doesn't blow the cloud provider's context window.
 */
function renderSkillResultForLLM(skillName: string, result: SkillResult<unknown>): string {
	const parts: string[] = [];
	parts.push(`[skill:${skillName}] confidence=${result.confidence}`);
	const notes = result.notes ?? [];
	if (notes.length > 0) {
		parts.push('notes:');
		for (const n of notes) {
			parts.push(`  - ${n}`);
		}
	}
	let valueJson: string;
	try {
		valueJson = JSON.stringify(result.value, null, 2);
	} catch {
		valueJson = '<unserializable>';
	}
	if (valueJson.length > RENDER_VALUE_MAX_CHARS) {
		const head = valueJson.slice(0, RENDER_VALUE_MAX_CHARS);
		valueJson = head + `\n... <truncated; ${valueJson.length - RENDER_VALUE_MAX_CHARS} more chars in skill value omitted>`;
	}
	parts.push('value:');
	parts.push(valueJson);
	return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Outcome -> degraded note
// ---------------------------------------------------------------------------

function describeOutcomeForDegraded(outcome: {
	readonly kind: 'no-tools' | 'exhausted' | 'provider-error' | 'dispatched';
	readonly reason?: string;
	readonly err?: Error;
}): string {
	switch (outcome.kind) {
		case 'no-tools':       return 'planner emitted text instead of submit_plan';
		case 'exhausted':      return `planner exhausted turn budget: ${outcome.reason ?? 'unknown'}`;
		case 'provider-error': return `cloud provider error: ${outcome.err?.message ?? 'unknown'}`;
		case 'dispatched':     return 'unexpected dispatched outcome (stopOnFirstDispatch should be off here)';
	}
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

export const _buildSeedMessagesForTest         = buildSeedMessages;
export const _buildPlannerToolCatalogForTest   = buildPlannerToolCatalog;
export const _renderSkillResultForLLMForTest   = renderSkillResultForLLM;
export const _SUBTYPE_HINTS_FOR_TEST           = SUBTYPE_HINTS;
