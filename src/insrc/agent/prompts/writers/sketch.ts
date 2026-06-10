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
	'You emit a SINGLE JSON object:',
	'',
	'  {',
	'    "steps": [',
	'      {',
	'        "id":               "step-1",',
	'        "intent":           "concrete sentence -- what + why",',
	'        "skills":           [{ "id": "s1.a", "skillId": "<catalog>", "context": "literal args" }],',
	'        "targetsCriteria":  [0, 1]',
	'      }',
	'    ]',
	'  }',
	'',
	'No prose outside the JSON. No markdown fences. No preamble.',
	'',
	'Rules:',
	'',
	'  - 3 to 5 steps. Five is the cap; fewer is fine when the gap list',
	'    is short.',
	'  - Each step has a CONCRETE intent. "Investigate the class" is not',
	'    a step. "Locate INGRN by name, then extract its declared',
	'    fields" is two steps.',
	'  - Every `skillId` MUST be in the SKILL CATALOG.',
	'  - Every `targetsCriteria` index MUST be a valid gap-facts index.',
	'  - `context` is a literal args sentence (file path / class name /',
	'    connection id / etc.) -- the shape-resolver consumes it.',
	'  - Step ids are unique within the sketch (`step-1`, `step-2`, ...).',
	'  - Skill-call ids are unique within a step (`s1.a`, `s1.b`, ...).',
	'  - Order matters: step-1 runs first; later steps may depend on',
	'    earlier ones. A step that needs the previous one\'s output sets',
	'    `dependsOn` on the skill call -- intra-step ("s1.a") or cross-',
	'    step ("step-1.s1.a"). Use this when the SECOND step needs the',
	'    FIRST step\'s entityId, hex, path, etc.',
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
