/**
 * build-context writer v1 -- Phase 3 of
 * plans/section-flow-architecture-redesign.md.
 *
 * A NEW local-tier turn that runs before the existing shape-resolver.
 * The LLM sees the step's intent, the skill being invoked, the skill's
 * input schema, the current TODO objective, and the artifact TOC, and
 * declares which artifact ids it needs read into context before it can
 * resolve the skill's args.
 *
 * Output schema (strict):
 *
 *   {
 *     "fetch": ["<artifact-id>", "<artifact-id>", ...],
 *     "notes": "<short justification>"
 *   }
 *
 * Rules taught in the prompt:
 *
 *   - `fetch` ids MUST be drawn from the TABLE OF CONTENTS verbatim.
 *     Inventing ids never produces a real artifact -- the orchestrator's
 *     validator catches it and retries once with a corrective hint.
 *   - Empty `fetch: []` is the correct answer when the step has no
 *     artifact dependency (e.g. a fresh `code.source.grep` against the
 *     repo). Shape-resolver still runs.
 *   - `notes` is a 1-2 sentence justification. The orchestrator logs
 *     it for telemetry but does not act on it.
 *
 * Why a separate stage (vs. letting shape-resolver pick artifacts
 * itself): the shape-resolver's job is to produce a `submit_skill_args`
 * tool-use block. Mixing artifact discovery into that turn yields
 * either (a) the resolver hallucinating ids it half-remembers from
 * elsewhere in context, or (b) the resolver missing the right artifact
 * and the call running with stale / wrong args. Splitting the
 * discovery into its own turn keeps each call focused.
 *
 * The orchestrator integration (Phase 3 batch 3.2) calls
 * `runBuildContext(...)` from `step-build-context.ts`, fetches each
 * named artifact via `getArtifactById`, and appends them to the
 * shape-resolver's `priorOutputs`.
 */

import type { LLMMessage } from '../../../shared/types.js';
import type { LocalMemoryView } from '../../working-memory/index.js';
import type { PromptWriter } from '../types.js';

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

export interface BuildContextWriterInput {
	readonly stepIntent:       string;
	readonly skillId:          string;
	readonly skillDescription: string;
	/** JSON-schema text for the skill's input shape (already stringified). */
	readonly skillSchema:      string;
	readonly todoObjective:    string;
	/** Pre-rendered TOC text from `renderToc(buildToc(sessionId))`. */
	readonly toc:              string;
	/**
	 * Optional local-tier memory view. When supplied, the system / currentTodo
	 * / recentSteps blocks render above the step + skill blocks so the model
	 * has the broader investigation state. The TOC inside the view is
	 * deliberately NOT rendered twice -- the writer prefers the explicit
	 * `toc` parameter so callers retain control of TOC budgeting.
	 */
	readonly memory?:          LocalMemoryView | undefined;
	readonly isRetry:          boolean;
	/** When isRetry is true, the orchestrator's reason for the retry. */
	readonly priorFailureReason: string | undefined;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const ROLE = [
	'You are the BUILD-CONTEXT decider for one skill invocation in a',
	'section-flow investigation. You see the step\'s intent, the skill',
	'about to run, its input schema, the active TODO objective, and the',
	'Table of Contents listing every artifact the orchestrator has',
	'spilled so far. You decide WHICH artifacts (by id) need to be read',
	'into the shape-resolver\'s context so it can ground the skill\'s args',
	'in real evidence.',
	'',
	'You emit a SINGLE JSON object with EXACTLY two keys:',
	'',
	'  { "fetch": ["<artifact-id>", ...], "notes": "<why>" }',
	'',
	'No prose outside the JSON. No markdown fences.',
	'',
	'Rules:',
	'',
	'  - `fetch` ids MUST be drawn VERBATIM from the TABLE OF CONTENTS',
	'    block. DO NOT invent ids. DO NOT paraphrase ids. DO NOT split',
	'    one id into multiple entries.',
	'  - Empty `fetch: []` is the right answer when the step has no',
	'    artifact dependency (a fresh search against the repo, a',
	'    standalone listing, the first step of an investigation). The',
	'    shape-resolver runs either way.',
	'  - Each fetched artifact costs context budget downstream. Pick',
	'    only what is materially required to resolve the skill\'s args.',
	'    Two or three is usually enough. Eight is almost always wrong.',
	'  - `notes` is a one-sentence justification (e.g. "need the locate',
	'    artifact for the entityId required by code.entity.summary").',
	'    Keep it concise; the orchestrator logs it for telemetry.',
	'  - Look up the skill\'s INPUT SCHEMA below: every required key in',
	'    the schema is something the shape-resolver will need to ground.',
	'    If a required key is a hex entityId / path / 32-char hash /',
	'    field name list, find the artifact that produced that value',
	'    earlier and fetch it. If you can\'t find one, fetch nothing --',
	'    the resolver will recover or the step will return empty.',
].join('\n');

// ---------------------------------------------------------------------------
// User prompt
// ---------------------------------------------------------------------------

function buildUser(input: BuildContextWriterInput): string {
	const lines: string[] = [];
	if (input.memory !== undefined) {
		if (input.memory.system.trim().length > 0) {
			lines.push('## SYSTEM CONTEXT');
			lines.push(input.memory.system);
			lines.push('');
		}
		if (input.memory.currentTodo.trim().length > 0) {
			lines.push('## CURRENT TODO STATE');
			lines.push(input.memory.currentTodo);
			lines.push('');
		}
		if (input.memory.recentSteps.trim().length > 0) {
			lines.push('## RECENT STEPS');
			lines.push(input.memory.recentSteps);
			lines.push('');
		}
	}

	lines.push('## STEP TO EXECUTE');
	lines.push(input.stepIntent);
	lines.push('');
	lines.push('## SKILL TO INVOKE');
	lines.push(`${input.skillId}: ${input.skillDescription}`);
	lines.push('');
	lines.push('## SKILL INPUT SCHEMA');
	lines.push(input.skillSchema);
	lines.push('');
	lines.push('## CURRENT TODO OBJECTIVE');
	lines.push(input.todoObjective);
	lines.push('');
	lines.push(input.toc);
	lines.push('');
	if (input.isRetry) {
		lines.push('## RETRY CORRECTION');
		lines.push(`Your previous response was rejected: ${input.priorFailureReason ?? 'unknown'}`);
		lines.push('Emit a new JSON object that satisfies every rule. Every id in `fetch` MUST appear verbatim in the TOC above.');
		lines.push('');
	}
	lines.push('## OUTPUT SHAPE');
	lines.push('{ "fetch": ["<artifact-id>", ...], "notes": "<one-sentence justification>" }');
	lines.push('');
	lines.push('## TASK');
	lines.push('Emit the JSON object now. Begin with `{` and end with `}`.');
	return lines.join('\n');
}

export const buildContextWriterV1: PromptWriter<BuildContextWriterInput, readonly LLMMessage[]> = {
	id:      'build-context',
	version: 1,
	tier:    'local',
	summary: 'Phase 3: pick which artifact ids the shape-resolver needs in priorOutputs before resolving skill args.',

	build(input: BuildContextWriterInput): readonly LLMMessage[] {
		return [
			{ role: 'system', content: ROLE },
			{ role: 'user',   content: buildUser(input) },
		];
	},
};

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _buildUserForTest = buildUser;
