/**
 * decide-next-step writer v2 -- Phase 4 (citation-contract update).
 *
 * The cloud-tier turn at the heart of the dynamic orchestrator loop.
 * Runs ONCE per iteration. Sees:
 *
 *   - The TODO objective + remaining gap facts.
 *   - The original sketch (default trajectory; not a hard contract).
 *   - The artifact TOC (entries authored by the local-tier summarise-
 *     step writer; every TOC entry's claims have been substring-
 *     verified by the citation verifier).
 *   - The raw output of the most-recently-executed step (for ground-
 *     truth visibility; the cited summary is also visible via TOC).
 *
 * Emits a structured decision ONLY -- the cloud no longer authors
 * summaries. Summary authoring moved to the local-tier `summarize-step`
 * writer (citation contract).
 *
 *   {
 *     "action":     "execute-step" | "replan-sketch" | "terminate",
 *     "reasoning":  "<concise justification>",
 *     // action: 'execute-step'
 *     "step":       { id, intent, skills, targetsCriteria },
 *     // action: 'terminate'
 *     "verdict":    "covered" | "unrecoverable"
 *   }
 *
 * Why this changed: live runs showed the cloud labelling sample-shape
 * output as "the class definition" because it was optimising the
 * summary for the TODO goal. Moving summary authoring to a narrow
 * local-tier turn that MUST cite verbatim spans -- and a deterministic
 * verifier that substring-checks each claim -- eliminates motivated-
 * reasoning at the summary layer. The cloud's job shrinks to strategic
 * planning; grounded extraction is the local tier's job.
 */

import type { LLMMessage } from '../../../shared/types.js';
import type { CatalogSkill } from '../../content-gen/plan-tree-runner.js';
import type { DiscoveryStep } from '../../content-gen/discovery-plan.js';
import type { CloudMemoryView } from '../../working-memory/index.js';
import type { RequiredFact } from '../../section-flow/fact-gap-types.js';
import type { TodoSpec } from '../../section-flow/types.js';
import { renderFactGaps } from '../composers/fact-gaps.js';
import type { PromptWriter } from '../types.js';

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

/**
 * Per-call output of the most-recently-executed step. Keys are the
 * step's `PlannedSkillCall.id` (e.g. `s1.a`); values are the raw
 * stringified `SkillResult.value`. Empty calls present with `''`.
 */
export interface DecideLastStepRawOutputs {
	readonly stepId:     string;
	readonly stepIntent: string;
	readonly skills: readonly {
		readonly callId:  string;
		readonly skillId: string;
		readonly context: string;
		readonly rawText: string;
	}[];
}

export interface DecideNextStepWriterInput {
	readonly todo:     TodoSpec;
	readonly gapFacts: readonly RequiredFact[];
	/** The original 3-5 step sketch from `runSketch`. Reference-only -- not a contract. */
	readonly sketch:   readonly DiscoveryStep[];
	readonly catalog:  readonly CatalogSkill[];
	/** Rendered TOC (via `renderToc(buildToc(sessionId))`). */
	readonly toc:      string;
	/**
	 * Output of the most-recently-executed step. `undefined` on the
	 * very first turn (no step has run yet). When present, the
	 * decider MUST emit `lastStepArtifactSummary` for every entry in
	 * `skills`.
	 */
	readonly lastStep:  DecideLastStepRawOutputs | undefined;
	/**
	 * Flat record of EVERY step that has executed so far for this TODO
	 * (across replan-sketches too) -- skillIds + outcome. Surfaced in
	 * the prompt as PRIOR ATTEMPTS so the model can see "we already
	 * tried `shared.compare.fields-vs-shape` twice and both returned
	 * empty" without having to infer it from `lastStep` alone. Live
	 * test caught the model re-picking the same failing skill 5+
	 * times because each decide turn only saw the most-recent step's
	 * raw output. Empty / undefined when no step has run yet.
	 */
	readonly priorAttempts?: readonly DecidePriorAttempt[] | undefined;
	readonly memory?:   CloudMemoryView | undefined;
	readonly isRetry:   boolean;
	readonly priorFailureReason: string | undefined;
}

/**
 * One executed step's summary for the PRIOR ATTEMPTS block of the
 * decide-next-step prompt. Renders one line per step listing its
 * skill ids and outcome -- enough for the model to see "we already
 * tried this and got nothing" without bloating the prompt.
 */
export interface DecidePriorAttempt {
	readonly stepId:   string;
	readonly intent:   string;
	readonly skillIds: readonly string[];
	/**
	 * Step-level status from `StepOutput.status`:
	 *   - `ok`      : every skill call produced non-empty output
	 *   - `partial` : at least one call non-empty, at least one empty
	 *   - `failed`  : every call returned empty
	 */
	readonly status:   'ok' | 'partial' | 'failed';
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const ROLE = [
	'You are the DECIDE-NEXT-STEP orchestrator for one TODO of an',
	'investigation report. You see the TODO objective, the remaining gap',
	'facts, the original sketch (a default trajectory), the artifact TOC',
	'(every persisted artifact\'s claim-shaped summary -- already cited',
	'and verified by a separate local-tier turn), and -- when not the',
	'first turn -- the RAW output of the most-recently-executed step',
	'(for ground-truth visibility into what the last step produced).',
	'',
	'You decide ONE of three things. You do NOT author summaries -- the',
	'summarise-step writer authors cited summaries for each artifact,',
	'and the verifier substring-matches them against the raw output.',
	'',
	'You emit a SINGLE JSON object with EXACTLY these top-level keys',
	'(extras are rejected):',
	'',
	'  {',
	'    "action":                  "execute-step" | "replan-sketch" | "terminate",',
	'    "reasoning":               "<one or two sentences>",',
	'    // when action="execute-step":',
	'    "step": {',
	'      "id":              "step-N",',
	'      "intent":          "<concrete sentence -- what + why>",',
	'      "skills": [',
	'        {',
	'          "id":      "sN.a",                    // unique within this step',
	'          "skillId": "<catalog id>",            // MUST be in the SKILL CATALOG',
	'          "context": "<literal args sentence>"  // e.g. "class=INGRN" or "path=/repo/foo.json"',
	'        }',
	'      ],',
	'      "targetsCriteria": [0, 1]                  // indices into GAP FACTS',
	'    },',
	'    // when action="terminate":',
	'    "verdict":  "covered" | "unrecoverable"',
	'  }',
	'',
	'No prose outside the JSON. No markdown fences. No preamble.',
	'',
	'Rules:',
	'',
	'  - `action`:',
	'      * `execute-step`   : the loop continues with `step` as the',
	'                            next discovery step. Default to the',
	'                            sketch\'s next entry UNLESS the last',
	'                            output materially changes the picture.',
	'      * `replan-sketch`  : the sketch is no longer the right',
	'                            trajectory. The orchestrator regenerates',
	'                            it (cloud call). Use sparingly -- once',
	'                            per TODO is typical.',
	'      * `terminate`      : every gap fact has at least one CLOSES',
	'                            marker in the TOC, OR coverage is',
	'                            unrecoverable with available skills.',
	'  - `step` (when action=execute-step) follows the discovery-plan',
	'    rules: concrete intent (>=5 chars), unique id, every skillId in',
	'    the SKILL CATALOG, targetsCriteria a non-empty array of valid',
	'    gap-fact indices.',
	'  - `verdict` (when action=terminate) is `covered` ONLY when every',
	'    gap fact has at least one `CLOSES ... fully` marker against it',
	'    in the TOC (the TOC entries you see were already cited and',
	'    verified -- you can trust their closure verdicts). Otherwise',
	'    `unrecoverable`.',
	'  - DO NOT add fields beyond those documented above.',
].join('\n');

// ---------------------------------------------------------------------------
// User prompt
// ---------------------------------------------------------------------------

// Live test surfaced this cap as too tight: an INGRN class with 21
// fields + types + validators easily exceeds 1024 chars, so the
// decide-next-step LLM saw a truncated `extract-fields` output and
// emitted "CLOSES ingrn-fields fully" against an incomplete picture.
// Section-review correctly caught it via revise-major but at the cost
// of a recycle + L2. 4096 is enough for the per-call output of every
// skill in the current catalog without bloating the prompt budget --
// each iteration's lastStep contains at most 1-2 calls, so the worst-
// case bump is ~8KB on the cloud-tier prompt.
const LAST_STEP_RAW_CHARS_PER_CALL = 4096;

function renderSketch(sketch: readonly DiscoveryStep[]): string {
	if (sketch.length === 0) { return '(no sketch)'; }
	const lines: string[] = [`## SKETCH (default trajectory; reference only -- not a hard contract)`];
	for (const s of sketch) {
		lines.push(`- ${s.id}: ${s.intent}`);
		for (const sk of s.skills) {
			lines.push(`    - ${sk.id} (\`${sk.skillId}\`) -- ${sk.context}`);
		}
		lines.push(`    targetsCriteria: ${JSON.stringify(s.targetsCriteria)}`);
	}
	return lines.join('\n');
}

/**
 * Render the PRIOR ATTEMPTS block -- one line per executed step
 * listing its skill ids and step-level status. Empty (and the block
 * is omitted entirely) when no step has run yet.
 *
 * The renderer collapses repeated skill ids so a single skill that
 * failed N times shows as `<skillId> x N (all failed)` rather than
 * N separate lines. Lets the model see "this skill is a dead end"
 * at a glance without the prompt ballooning when the loop is stuck
 * on an alternating-progress pattern.
 */
function renderPriorAttempts(attempts: readonly DecidePriorAttempt[]): string {
	if (attempts.length === 0) { return ''; }
	const lines: string[] = [
		'## PRIOR ATTEMPTS (steps already executed for this TODO; use this to AVOID re-picking skills that already returned empty)',
	];
	for (const a of attempts) {
		const skillTally = new Map<string, number>();
		for (const id of a.skillIds) {
			skillTally.set(id, (skillTally.get(id) ?? 0) + 1);
		}
		const skillSummary = [...skillTally.entries()]
			.map(([id, n]) => n > 1 ? `\`${id}\` x ${n}` : `\`${id}\``)
			.join(', ');
		lines.push(`- ${a.stepId} [${a.status}] -- ${a.intent.slice(0, 100)}`);
		lines.push(`    skills: ${skillSummary}`);
	}
	lines.push('');
	lines.push('Rules drawn from PRIOR ATTEMPTS:');
	lines.push('  - If a skill failed at status `failed` in 2+ prior steps, do NOT pick it again');
	lines.push('    unless you can supply MATERIALLY different context (new args, new file path,');
	lines.push('    new entityId). Repeating a failing skill with the same context will fail again.');
	lines.push('  - If every plausible skill in the catalog has already been tried and failed,');
	lines.push('    emit `terminate verdict=unrecoverable` with reasoning that names the dead-end.');
	return lines.join('\n');
}

function renderCatalogSummary(catalog: readonly CatalogSkill[]): string {
	if (catalog.length === 0) { return '## SKILL CATALOG (empty)'; }
	const lines: string[] = [`## SKILL CATALOG (${catalog.length} skills available)`];
	for (const s of catalog) {
		const desc = s.description.replace(/\s+/g, ' ').trim().slice(0, 120);
		lines.push(`- \`${s.id}\` -- ${desc}`);
	}
	return lines.join('\n');
}

function renderLastStep(last: DecideLastStepRawOutputs): string {
	const lines: string[] = [
		`## LAST STEP OUTPUT (awaiting summary; emit \`lastStepArtifactSummary\` for every callId here)`,
		`### ${last.stepId} -- ${last.stepIntent}`,
	];
	for (const call of last.skills) {
		lines.push(`  - ${call.callId} (\`${call.skillId}\`) -- ${call.context}`);
		lines.push('    output:');
		const raw = call.rawText.trim();
		if (raw.length === 0) {
			lines.push('      (empty)');
		} else if (raw.length <= LAST_STEP_RAW_CHARS_PER_CALL) {
			for (const ln of raw.split('\n')) { lines.push(`      ${ln}`); }
		} else {
			for (const ln of raw.slice(0, LAST_STEP_RAW_CHARS_PER_CALL).split('\n')) { lines.push(`      ${ln}`); }
			lines.push(`      ...[truncated ${raw.length - LAST_STEP_RAW_CHARS_PER_CALL} chars]`);
		}
	}
	return lines.join('\n');
}

function buildUser(input: DecideNextStepWriterInput): string {
	const lines: string[] = [];
	if (input.memory !== undefined) {
		if (input.memory.system.trim().length > 0) {
			lines.push('## SYSTEM CONTEXT');
			lines.push(input.memory.system);
			lines.push('');
		}
		if (input.memory.summary.trim().length > 0) {
			lines.push('## INVESTIGATION SUMMARY');
			lines.push(input.memory.summary);
			lines.push('');
		}
		if (input.memory.factLedger.trim().length > 0) {
			lines.push('## FACT LEDGER (current coverage)');
			lines.push(input.memory.factLedger);
			lines.push('');
		}
	}

	lines.push('## TODO OBJECTIVE');
	lines.push(input.todo.objective);
	lines.push('');
	lines.push('## GAP FACTS (coverage targets; both id AND index are stable)');
	lines.push(renderFactGaps(input.gapFacts));
	lines.push('');
	lines.push(renderSketch(input.sketch));
	lines.push('');
	lines.push(input.toc);
	lines.push('');
	if (input.priorAttempts !== undefined && input.priorAttempts.length > 0) {
		lines.push(renderPriorAttempts(input.priorAttempts));
		lines.push('');
	}
	if (input.lastStep !== undefined) {
		lines.push(renderLastStep(input.lastStep));
		lines.push('');
	} else {
		lines.push('## LAST STEP OUTPUT');
		lines.push('(first turn -- no step has run yet; emit `lastStepArtifactSummary: {}` and pick the sketch\'s first step)');
		lines.push('');
	}
	if (input.isRetry) {
		lines.push('## RETRY CORRECTION');
		lines.push(`Your previous response was rejected: ${input.priorFailureReason ?? 'unknown'}`);
		lines.push('Emit a new JSON object that satisfies every rule above.');
		lines.push('');
	}
	lines.push(renderCatalogSummary(input.catalog));
	lines.push('');
	lines.push('## TASK');
	lines.push('Emit the JSON decision now. Begin with `{` and end with `}`.');
	return lines.join('\n');
}

export const decideNextStepWriterV1: PromptWriter<DecideNextStepWriterInput, readonly LLMMessage[]> = {
	id:      'decide-next-step',
	version: 1,
	tier:    'cloud',
	summary: 'Phase 4: pick the next step (or terminate / replan) and emit the prior step\'s goal-aware summary in one turn.',

	build(input: DecideNextStepWriterInput): readonly LLMMessage[] {
		return [
			{ role: 'system', content: ROLE },
			{ role: 'user',   content: buildUser(input) },
		];
	},
};

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _renderSketchForTest    = renderSketch;
export const _renderLastStepForTest      = renderLastStep;
export const _renderPriorAttemptsForTest = renderPriorAttempts;
export const _buildUserForTest       = buildUser;
