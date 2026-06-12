/**
 * sketch writer v1 -- Phase 4 of
 * plans/section-flow-architecture-redesign.md.
 *
 * A cloud-tier turn that runs ONCE per TODO, right after the
 * fact-gap analysis lands. The cloud emits a 3-5 step sketch -- a
 * default trajectory the dynamic loop follows when nothing
 * surprises it. The decide-next-step turn (Phase 4 sibling) picks
 * the next sketch entry by default; deviation requires explicit
 * justification.
 *
 * Why a sketch:
 *
 *   - The decide-next-step turn alone would re-derive a plan from
 *     scratch every iteration. That's expensive (N+ cloud calls
 *     for a 5-step run) AND noisy (the model's day-one ordering
 *     can drift between turns even when no new evidence has landed).
 *   - The sketch gives the loop a default direction. Deviation
 *     happens when the last step's raw output materially changes
 *     the picture (e.g. "locate-by-name returned not-found, switch
 *     to grep").
 *
 * Output schema (matches the planner Stage 1 we already have,
 * minus `cycle`):
 *
 *   {
 *     "steps": [
 *       {
 *         "id":               "step-1",
 *         "intent":           "concrete sentence -- what + why",
 *         "skills":           [{ "id": "s1.a", "skillId": "<catalog>", "context": "literal args" }],
 *         "targetsCriteria":  [0, 1]
 *       },
 *       ...
 *     ]
 *   }
 *
 * Caller validates against the existing skill catalog + gap-fact
 * index set (same validator as discovery-plan-expansion). Step ids
 * unique within the sketch; skillIds in the catalog; targetsCriteria
 * non-empty and within range.
 *
 * Cap of 5 steps. The sketch is meant to be a default trajectory,
 * not a complete plan -- the loop can extend it via
 * `decide-next-step.action = 'execute-step'` emitting a step that
 * wasn't in the sketch.
 */

import type { LLMMessage } from '../../../shared/types.js';
import type { CatalogSkill } from '../../content-gen/plan-tree-runner.js';
import type { CloudMemoryView } from '../../working-memory/index.js';
import type { RequiredFact } from '../../section-flow/fact-gap-types.js';
import type { TodoSpec } from '../../section-flow/types.js';
import { renderFactGaps } from '../composers/fact-gaps.js';
import type { PromptWriter } from '../types.js';

export interface SketchWriterInput {
	readonly todo:                TodoSpec;
	readonly gapFacts:            readonly RequiredFact[];
	readonly catalog:             readonly CatalogSkill[];
	/** Optional cloud-tier memory view. When present, system + summary + recent + factLedger blocks render above the gap-facts list. */
	readonly memory?:             CloudMemoryView | undefined;
	readonly isRetry:             boolean;
	readonly priorFailureReason:  string | undefined;
}

const ROLE = [
	'You are the SKETCH PLANNER for one TODO of an investigation report.',
	'You see the TODO\'s objective and the fact-gap list it needs to',
	'close, and you emit a default trajectory of 3-5 discovery steps the',
	'orchestrator follows when nothing surprises it.',
	'',
	'You emit a SINGLE JSON object. A step is either a LEAF or a',
	'BRANCH:',
	'',
	'  LEAF -- runs skills directly. Use when the step has ONE atomic',
	'  objective ("locate INGRN by name", "extract its field list").',
	'',
	'    {',
	'      "id":               "step-1",',
	'      "intent":           "ONE atomic sub-objective",',
	'      "skills":           [{ "id": "s1.a", "skillId": "<catalog>", "context": "literal args" }],',
	'      "targetsCriteria":  [0]',
	'    }',
	'',
	'  BRANCH -- decomposes into sub-leaves. Use when the natural',
	'  objective is COMPOUND ("extract A + B + C + D"). The branch',
	'  intent is the compound goal; each child is a single atomic',
	'  sub-objective with its own skill calls. The orchestrator walks',
	'  leaves and grounds each in narrow citations -- which is the',
	'  whole reason for the decomposition.',
	'',
	'    {',
	'      "id":               "step-1",',
	'      "intent":           "extract the full INGRN class definition (compound)",',
	'      "children": [',
	'        { "id": "step-1.1", "intent": "locate INGRN entity", ',
	'          "skills":[{"id":"s1.1.a","skillId":"<catalog>","context":"..."}],',
	'          "targetsCriteria":[0] },',
	'        { "id": "step-1.2", "intent": "extract its field list",',
	'          "skills":[{"id":"s1.2.a","skillId":"<catalog>","context":"..."}],',
	'          "targetsCriteria":[1] },',
	'        { "id": "step-1.3", "intent": "extract its validators",',
	'          "skills":[{"id":"s1.3.a","skillId":"<catalog>","context":"..."}],',
	'          "targetsCriteria":[2] }',
	'      ],',
	'      "targetsCriteria":  [0, 1, 2]    // UNION of children\'s',
	'    }',
	'',
	'A step has EITHER `skills` (leaf) OR `children` (branch) -- never',
	'both. Validator rejects both-or-neither.',
	'',
	'WHY decomposition matters (citation discipline):',
	'',
	'  - The orchestrator runs ONE summarize-step pass per LEAF, using',
	'    that leaf\'s narrow intent + raw skill output. Citations stay',
	'    focused; the model can quote verbatim spans cleanly.',
	'  - When a leaf bundles 4-5 sub-objectives, the summarize-step',
	'    pass has to cite for ALL of them at once -- which has empirically',
	'    surfaced as the dominant cause of citation-invent failures and',
	'    synthetic-fallback cascades. Branch decomposition fixes this.',
	'',
	'Decomposition heuristics (when to BRANCH):',
	'',
	'  - The intent contains "and", "plus", "including", "with all" --',
	'    these usually signal compound objectives. Split them.',
	'  - The intent names 3+ distinct artifacts, classes, files, or',
	'    field-lists -- one child per artifact.',
	'  - The intent asks the model to do 2+ verbs (e.g. "locate AND',
	'    extract", "search AND sample"). Each verb is usually one child.',
	'',
	'  When to STAY LEAF:',
	'',
	'  - The intent is a single verb on a single target.',
	'  - The skills naturally chain (skill B uses skill A\'s output) and',
	'    the chain is the atomic unit. Keep them in one leaf with',
	'    `dependsOn`.',
	'',
	'No prose outside the JSON. No markdown fences. No preamble.',
	'',
	'General rules (both leaf and branch):',
	'',
	'  - 3 to 5 top-level steps. Five is the cap; fewer is fine when the',
	'    gap list is short. A branch counts as ONE top-level step even',
	'    when it contains multiple children.',
	'  - Branches contain 2 to 6 children. A single-child branch is',
	'    pointless -- emit a leaf instead.',
	'  - Each LEAF intent is ONE atomic sub-objective. "Investigate the',
	'    class" is not a leaf intent -- decompose.',
	'  - Every `skillId` MUST be in the SKILL CATALOG.',
	'  - Every `targetsCriteria` index MUST be a valid gap-facts index.',
	'    At a branch level it is the UNION of children\'s.',
	'  - `context` is a literal args sentence (file path / class name /',
	'    connection id / etc.) -- the shape-resolver consumes it.',
	'  - Step ids are unique within the sketch (`step-1`, `step-2`, ...).',
	'    Children ids use dot-notation (`step-1.1`, `step-1.2`, ...).',
	'  - Skill-call ids are unique within their leaf (`s1.a`, `s1.b`,',
	'    `s1.1.a`, `s1.2.a`, ...).',
	'  - Order matters: top-level steps run in order; within a branch,',
	'    children run in order. A leaf can `dependsOn` an earlier sibling',
	'    or earlier top-level step\'s skill call.',
	'  - The sketch is a DEFAULT trajectory, not a contract. The',
	'    orchestrator may deviate if a step\'s raw output materially',
	'    changes the picture.',
].join('\n');

function renderCatalogSummary(catalog: readonly CatalogSkill[]): string {
	if (catalog.length === 0) { return '## SKILL CATALOG (empty)'; }
	const lines: string[] = [`## SKILL CATALOG (${catalog.length} skills available)`];
	for (const s of catalog) {
		const desc = s.description.replace(/\s+/g, ' ').trim().slice(0, 120);
		lines.push(`- \`${s.id}\` -- ${desc}`);
	}
	return lines.join('\n');
}

function buildUser(input: SketchWriterInput): string {
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
		if (input.memory.recent.trim().length > 0) {
			lines.push('## RECENT FINDINGS');
			lines.push(input.memory.recent);
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
	lines.push('## GAP FACTS (coverage targets; indices stable for targetsCriteria)');
	lines.push(renderFactGaps(input.gapFacts));
	lines.push('');
	if (input.isRetry) {
		lines.push('## RETRY CORRECTION');
		lines.push(`Your previous response was rejected: ${input.priorFailureReason ?? 'unknown'}`);
		lines.push('Emit a new JSON object that satisfies every rule. Stay between 3 and 5 steps; every skillId in the SKILL CATALOG; every targetsCriteria index in range.');
		lines.push('');
	}
	lines.push(renderCatalogSummary(input.catalog));
	lines.push('');
	lines.push('## TASK');
	lines.push('Emit the JSON object now. Begin with `{` and end with `}`.');
	return lines.join('\n');
}

export const sketchWriterV1: PromptWriter<SketchWriterInput, readonly LLMMessage[]> = {
	id:      'sketch',
	version: 1,
	tier:    'cloud',
	summary: 'Phase 4: emit a 3-5 step default trajectory the dynamic decide-next-step loop follows by default.',

	build(input: SketchWriterInput): readonly LLMMessage[] {
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
