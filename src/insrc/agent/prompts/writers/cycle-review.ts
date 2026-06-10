/**
 * cycle-review writer v2 -- Stage 3 of the section-flow per-TODO loop.
 *
 * Phase 1 batch 3b of plans/section-flow-architecture-redesign.md
 * unregistered + deleted the v1 writer (the only remaining consumer
 * had migrated). The reviewer now sees RAW per-skill-call outputs
 * (truncated) instead of the pre-summarised `EvidenceEntry { facts,
 * citations }` block the deleted `summarizeResult` cloud call used
 * to emit, AND it emits the goal-aware summaries itself in
 * `stepSummaries` -- one cloud round-trip per cycle instead of
 * N + 1.
 *
 * Output schema (top-level keys exactly four):
 *
 *   {
 *     "keep":           ["step-1", ...],   // ids from THIS cycle
 *     "new_steps":      [...],             // empty array = terminate
 *     "scratchpad":     "...",             // optional <=300 chars
 *     "stepSummaries":  {
 *       "<stepId>": {
 *         "<callId>": "<claim>. <closure marker>"
 *       }
 *     }
 *   }
 *
 * Closure marker vocabulary (taught in the prompt + extracted
 * mechanically via regex in `step-cycle-review.ts`):
 *
 *     CLOSES <gap-id> fully
 *     PARTIALLY supports <gap-id>
 *     OFF-TOPIC
 *
 * `<gap-id>` is the literal `id` field of a gap fact (NOT the
 * numeric index). A summary may chain markers separated by `;` when
 * a call touches more than one gap. Empty / failed calls get a
 * sentence describing the attempt + `OFF-TOPIC`.
 */

import type { LLMMessage } from '../../../shared/types.js';
import type { CatalogSkill } from '../../content-gen/plan-tree-runner.js';
import type {
	CycleMemory,
	DiscoveryStep,
	StepOutput,
} from '../../content-gen/discovery-plan.js';
import type { RequiredFact } from '../../section-flow/fact-gap-types.js';
import type { TodoSpec } from '../../section-flow/types.js';
import { summarizeCycleMemory } from '../../section-flow/cycle-memory.js';
import type { PromptWriter } from '../types.js';

export interface CycleReviewWriterInput {
	readonly todo:               TodoSpec;
	readonly gapFacts:           readonly RequiredFact[];
	readonly stepsThisCycle:     readonly DiscoveryStep[];
	readonly cycleOutputs:       readonly StepOutput[];
	readonly cycleMemory:        CycleMemory;
	readonly cycle:              1 | 2 | 3;
	readonly catalog:            readonly CatalogSkill[];
	readonly isRetry:            boolean;
	readonly priorFailureReason: string | undefined;
}

/**
 * Cap on per-call raw-output rendering in the prompt. The reviewer
 * doesn't need the full structured payload (that's on disk for the
 * `requestArtifactIds` enhancer flow); it needs enough context to
 * judge relevance + write a 1-2 sentence claim. ~1 KB per call gives
 * the model a paragraph of working text, keeps the cycle-prompt
 * bounded even when N=6 calls per step happens.
 */
const RAW_OUTPUT_CHARS_PER_CALL = 1024;

const REVIEW_ROLE = [
	'You are the CYCLE REVIEWER for one cycle of one TODO of an',
	'investigation report. You see the gap-facts list the cycle is',
	'targeting, the per-skill-call RAW outputs this cycle produced, and',
	'prior-cycle context. You decide four things:',
	'',
	'  - `keep`            -- WHICH of this cycle\'s outputs are on-topic',
	'                         + useful (promote to the retained ledger).',
	'  - `new_steps`       -- WHAT remains uncovered (empty array = done).',
	'  - `scratchpad`?     -- OPTIONAL <=300 char carry-forward note.',
	'  - `stepSummaries`   -- PER-SKILL-CALL goal-aware summary that the',
	'                         orchestrator persists on the artifact so',
	'                         downstream stages read a short claim instead',
	'                         of the raw bytes.',
	'',
	'Each summary is a SHORT (1-2 sentence) claim grounded in the actual',
	'call output, ending with a closure marker drawn from this fixed',
	'vocabulary so the orchestrator can scan it mechanically:',
	'',
	'    CLOSES <gap-id> fully',
	'    PARTIALLY supports <gap-id>',
	'    OFF-TOPIC',
	'',
	'`<gap-id>` is the literal `id` of one of the gap facts shown below',
	'(NOT the numeric index, NOT a paraphrase). A call may chain multiple',
	'markers separated by `;` if it touches more than one gap. Skill calls',
	'that returned empty / failed get a single sentence describing what',
	'was attempted and the marker `OFF-TOPIC`.',
	'',
	'You emit a SINGLE JSON object with EXACTLY these top-level keys:',
	'{ "keep": [...], "new_steps": [...], "scratchpad"?: "...",',
	'  "stepSummaries": { "<stepId>": { "<callId>": "<summary>" } } }.',
	'No prose, no markdown fences, no preamble.',
].join('\n');

function renderGapFacts(gapFactList: readonly RequiredFact[]): string {
	if (gapFactList.length === 0) { return '(no gap facts)'; }
	const lines: string[] = [];
	for (let i = 0; i < gapFactList.length; i++) {
		const f = gapFactList[i]!;
		lines.push(`[${i}] ${f.id} (${f.status})`);
		lines.push(`    fact: ${f.fact}`);
		lines.push(`    why:  ${f.why}`);
	}
	return lines.join('\n');
}

function renderRawOutput(raw: string): string {
	const trimmed = raw.trim();
	if (trimmed.length === 0) { return '(empty)'; }
	if (trimmed.length <= RAW_OUTPUT_CHARS_PER_CALL) { return trimmed; }
	return `${trimmed.slice(0, RAW_OUTPUT_CHARS_PER_CALL)}...[truncated ${trimmed.length - RAW_OUTPUT_CHARS_PER_CALL} chars]`;
}

function renderCycleOutputs(
	outputs:        readonly StepOutput[],
	stepsThisCycle: readonly DiscoveryStep[],
): string {
	if (outputs.length === 0) { return '(no outputs)'; }
	const stepsById = new Map(stepsThisCycle.map(s => [s.id, s] as const));
	const lines: string[] = [];
	for (const out of outputs) {
		const step = stepsById.get(out.stepId);
		const intent = step !== undefined ? step.intent : '(no step definition)';
		lines.push(`### ${out.stepId} (status: ${out.status}) -- ${intent}`);
		if (step === undefined || step.skills.length === 0) {
			lines.push('  skill calls: (none)');
			lines.push('');
			continue;
		}
		// Render each declared skill call inline so the LLM sees the
		// canonical (callId, skillId, context) tuple and the raw output
		// together. The (stepId, callId) tuples teach the model the
		// valid keys for the `stepSummaries` field.
		for (const sk of step.skills) {
			const ctx = sk.context.replace(/\s+/g, ' ').trim().slice(0, 100);
			const raw = out.rawOutputs[sk.id] ?? '';
			lines.push(`  - ${sk.id} (\`${sk.skillId}\`) -- ${ctx}`);
			lines.push('    output:');
			const rendered = renderRawOutput(raw);
			for (const ln of rendered.split('\n')) {
				lines.push(`      ${ln}`);
			}
		}
		lines.push('');
	}
	return lines.join('\n').trimEnd();
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

function buildReviewUser(input: CycleReviewWriterInput): string {
	const factsBlock     = renderGapFacts(input.gapFacts);
	const outputsBlock   = renderCycleOutputs(input.cycleOutputs, input.stepsThisCycle);
	const cycleMemBlock  = summarizeCycleMemory(input.cycleMemory);
	const catalogBlock   = renderCatalogSummary(input.catalog);
	const retryAddendum  = input.isRetry
		? [
			'',
			'## RETRY CORRECTION',
			`Your previous response was rejected: ${input.priorFailureReason ?? 'unknown'}`,
			'Emit a new JSON object that satisfies every rule below.',
			'',
		].join('\n')
		: '';

	// Example (stepId, callId, gapId) drawn from THIS cycle so the LLM
	// sees a concrete tuple in the shape block, not a generic placeholder.
	const exampleStep = input.stepsThisCycle[0];
	const exampleCall = exampleStep?.skills[0];
	const exampleStepId = exampleStep?.id ?? 'step-1';
	const exampleCallId = exampleCall?.id ?? 's1.a';
	const exampleGapId  = input.gapFacts[0]?.id ?? 'gap-x';

	const lines: string[] = [
		'## TODO OBJECTIVE',
		input.todo.objective,
		'',
		'## GAP FACTS (coverage targets; both id AND index are stable)',
		factsBlock,
		'',
		`## CYCLE: ${input.cycle}`,
		'',
		'## THIS CYCLE\'S RAW SKILL OUTPUTS',
		outputsBlock,
	];
	if (cycleMemBlock.length > 0) {
		lines.push('');
		lines.push('## PRIOR CYCLE CONTEXT');
		lines.push('');
		lines.push(cycleMemBlock);
	}
	lines.push('');
	lines.push('## OUTPUT SHAPE');
	lines.push('');
	lines.push('{');
	lines.push('  "keep": ["step-1", "step-3"],                  // ids from THIS CYCLE\'S step outputs');
	lines.push('  "new_steps": [                                 // empty array = terminate');
	lines.push('    {');
	lines.push('      "id": "step-N",');
	lines.push('      "intent": "concrete sentence -- which gap fact + why prior attempt missed",');
	lines.push('      "skills": [');
	lines.push('        { "id": "sN.a", "skillId": "<catalog id>", "context": "literal args" }');
	lines.push('      ],');
	lines.push('      "targetsCriteria": [0, 1]                   // indices into GAP FACTS');
	lines.push('    }');
	lines.push('  ],');
	lines.push('  "scratchpad": "optional <=300 char carry-forward note",');
	lines.push('  "stepSummaries": {');
	lines.push(`    "${exampleStepId}": {`);
	lines.push(`      "${exampleCallId}": "<concrete observation>. CLOSES ${exampleGapId} fully"`);
	lines.push('    }');
	lines.push('  }');
	lines.push('}');
	lines.push('');
	lines.push('## RULES');
	lines.push('  - `keep` ids MUST be from THIS CYCLE\'S step outputs only (see above).');
	lines.push('  - `new_steps` items follow the discovery-plan-expansion rules:');
	lines.push('      * each step has a concrete intent sentence');
	lines.push('      * each PlannedSkillCall.skillId MUST be in the SKILL CATALOG');
	lines.push('      * each step.targetsCriteria is a non-empty array of valid fact indices (0..' + String(Math.max(0, input.gapFacts.length - 1)) + ')');
	lines.push('      * context for each skill call carries the literal args (file path / class name / connection id / etc.)');
	lines.push('  - Emit `new_steps: []` to terminate the cycle loop when every gap fact is now covered (or the remaining gaps are unrecoverable with available skills).');
	if (input.cycle > 1) {
		lines.push('  - DO NOT re-emit a step whose (skillId, context) matches an already-attempted step in PRIOR CYCLE CONTEXT with failed/open coverage. Try a different angle (different args, different skill, decomposed sub-fact).');
	}
	lines.push('  - `scratchpad` is optional. Use it for qualitative judgements the mechanical coverage map can\'t capture (e.g. "the class file uses non-standard import paths -- flag for writer").');
	lines.push('  - `stepSummaries` is REQUIRED and complete:');
	lines.push('      * Outer keys: every stepId from THIS CYCLE\'S step outputs.');
	lines.push('      * Inner keys: every callId declared under that step\'s `skill calls` block.');
	lines.push('      * Values: 1-2 sentence claim-shaped summary ending in a closure marker.');
	lines.push('      * Closure marker vocabulary (case-insensitive, anywhere in the sentence):');
	lines.push('          - `CLOSES <gap-id> fully`');
	lines.push('          - `PARTIALLY supports <gap-id>`');
	lines.push('          - `OFF-TOPIC`');
	lines.push('      * `<gap-id>` MUST be the literal `id` field of a gap fact shown above.');
	lines.push('      * Chain markers with `;` if a call covers >1 gap (e.g. "...; PARTIALLY supports gap-x; CLOSES gap-y fully").');
	lines.push('      * Empty / failed calls get a sentence describing what was attempted + `OFF-TOPIC`.');
	lines.push('  - DO NOT invent gap ids. DO NOT paraphrase the marker keyword (`CLOSES` / `PARTIALLY supports` / `OFF-TOPIC`).');
	lines.push('  - DO NOT add fields beyond the four documented in OUTPUT SHAPE.');
	lines.push(retryAddendum);
	lines.push('');
	lines.push('## SUMMARY WORKED EXAMPLES');
	lines.push('');
	lines.push('Suppose the gap facts include `ingrn-fields` and `grn-json-shape`,');
	lines.push('and step-1 / call s1.a ran `code.class.extract-fields(class=INGRN)`:');
	lines.push('');
	lines.push('  GOOD: "INGRN exposes 21 fields including vendor_id, buyer_id, items[]. CLOSES ingrn-fields fully"');
	lines.push('  GOOD: "Located INGRN at insors/grn.py:40; field list not extracted yet. PARTIALLY supports ingrn-fields"');
	lines.push('  GOOD (multi-gap): "INGRN imports GRNItem dataclass. PARTIALLY supports ingrn-fields; PARTIALLY supports grn-json-shape"');
	lines.push('  GOOD (empty/failed): "extract-fields returned empty; class lookup failed. OFF-TOPIC"');
	lines.push('');
	lines.push('  BAD: "Found fields"                                  -- not concrete, no marker');
	lines.push('  BAD: "INGRN has 21 fields. Closes the ingrn gap"     -- paraphrased marker; use CLOSES <id> fully');
	lines.push('  BAD: "INGRN has 21 fields. CLOSES gap-0 fully"       -- used numeric index; use the id `ingrn-fields`');
	lines.push('');
	lines.push(catalogBlock);
	lines.push('');
	lines.push('## TASK');
	lines.push('Emit the JSON object now. Begin with "{" and end with "}".');
	return lines.join('\n');
}

export const cycleReviewWriterV2: PromptWriter<CycleReviewWriterInput, readonly LLMMessage[]> = {
	id:      'cycle-review',
	version: 2,
	tier:    'cloud',
	summary: 'Stage 3: judge raw outputs + emit per-skill-call goal-aware summaries with closure markers.',

	build(input: CycleReviewWriterInput): readonly LLMMessage[] {
		return [
			{ role: 'system', content: REVIEW_ROLE },
			{ role: 'user',   content: buildReviewUser(input) },
		];
	},
};

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _renderCycleOutputsForTest = renderCycleOutputs;
export const _renderGapFactsForTest     = renderGapFacts;
export const _renderRawOutputForTest    = renderRawOutput;
