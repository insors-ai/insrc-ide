/**
 * decide-next-step writer v1 -- Phase 4 of
 * plans/section-flow-architecture-redesign.md.
 *
 * The cloud-tier turn at the heart of the dynamic orchestrator loop.
 * Runs ONCE per iteration. Sees:
 *
 *   - The TODO objective + remaining gap facts.
 *   - The original sketch (default trajectory; not a hard contract).
 *   - The artifact TOC (every prior artifact's claim-shaped summary).
 *   - The raw output of the most-recently-executed step (awaiting
 *     its summary).
 *
 * Emits a structured decision AND the summary for the most-recent
 * step (consolidating today's separate `stepSummaries` from cycle-
 * review v2):
 *
 *   {
 *     "action":                 "execute-step" | "replan-sketch" | "terminate",
 *     "reasoning":              "<concise justification>",
 *     "lastStepArtifactSummary": {
 *        "<callId>": "<claim-shaped summary>. <closure marker>"
 *     },
 *     // action: 'execute-step'
 *     "step":      { id, intent, skills, targetsCriteria },
 *     // action: 'terminate'
 *     "verdict":   "covered" | "unrecoverable"
 *   }
 *
 * `lastStepArtifactSummary` is REQUIRED on every turn except the very
 * first (when there's no prior step to summarise). The orchestrator
 * writes each entry into the prior artifact's metadata via
 * `updateArtifactSummary` -- same path Phase 1 batch 3a established.
 * Missing-or-malformed summaries degrade to the structural fallback.
 *
 * Closure marker vocabulary in each `lastStepArtifactSummary` value
 * matches Phase 1 batch 3a:
 *
 *     CLOSES <gap-id> fully
 *     PARTIALLY supports <gap-id>
 *     OFF-TOPIC
 *
 * `<gap-id>` MUST be the literal `id` field of a gap fact (NOT the
 * numeric index). Chain markers with `;` when a call touches more
 * than one gap.
 *
 * Why we keep one prompt for both decision + summary: a separate
 * summariser turn was the failure mode the redesign explicitly
 * targets -- per-step round-trips that drove cost without improving
 * correctness because the summariser had less context than the
 * decider it was feeding. Folding them lets the same LLM read the
 * raw output ONCE and emit (a) the decision (b) the summary (c) the
 * justification in one structured response.
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
	readonly memory?:   CloudMemoryView | undefined;
	readonly isRetry:   boolean;
	readonly priorFailureReason: string | undefined;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const ROLE = [
	'You are the DECIDE-NEXT-STEP orchestrator for one TODO of an',
	'investigation report. You see the TODO objective, the remaining gap',
	'facts, the original sketch (a default trajectory), the artifact TOC',
	'(every persisted artifact\'s claim-shaped summary), and -- when not',
	'the first turn -- the RAW output of the most-recently-executed step',
	'awaiting its summary.',
	'',
	'You decide ONE of three things, and ALSO emit the summary for the',
	'most-recent step so the orchestrator can persist it into the',
	'artifact metadata:',
	'',
	'You emit a SINGLE JSON object with EXACTLY these top-level keys',
	'(extras are rejected):',
	'',
	'  {',
	'    "action":                  "execute-step" | "replan-sketch" | "terminate",',
	'    "reasoning":               "<one or two sentences>",',
	'    "lastStepArtifactSummary": { "<callId>": "<summary>. <closure marker>" },',
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
	'  - `lastStepArtifactSummary` is REQUIRED whenever a `last step`',
	'    block is shown. Outer keys are the callIds from that block.',
	'    Each value is a 1-2 sentence claim ending in a closure marker.',
	'    Closure marker vocabulary (case-insensitive, anywhere in the',
	'    sentence):',
	'',
	'        CLOSES <gap-id> fully',
	'        PARTIALLY supports <gap-id>',
	'        OFF-TOPIC',
	'',
	'    `<gap-id>` MUST be the literal `id` field of a gap fact',
	'    (NOT the numeric index). Chain markers with `;` if a call',
	'    covers >1 gap. Empty / failed calls get a sentence describing',
	'    the attempt + `OFF-TOPIC`.',
	'  - `step` (when action=execute-step) follows the discovery-plan',
	'    rules: concrete intent (>=5 chars), unique id, every skillId in',
	'    the SKILL CATALOG, targetsCriteria a non-empty array of valid',
	'    gap-fact indices.',
	'  - `verdict` (when action=terminate) is `covered` ONLY when every',
	'    gap fact has at least one `CLOSES ... fully` marker against it',
	'    in the TOC. Otherwise `unrecoverable`.',
	'  - On the FIRST turn (no last step block) emit',
	'    `lastStepArtifactSummary: {}` and pick the sketch\'s first step.',
	'  - DO NOT invent gap ids. DO NOT paraphrase the marker keyword',
	'    (`CLOSES` / `PARTIALLY supports` / `OFF-TOPIC`). DO NOT add',
	'    fields beyond those documented above.',
].join('\n');

// ---------------------------------------------------------------------------
// User prompt
// ---------------------------------------------------------------------------

const LAST_STEP_RAW_CHARS_PER_CALL = 1024;

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
export const _renderLastStepForTest  = renderLastStep;
export const _buildUserForTest       = buildUser;
