/**
 * runAnswerQuestionAction -- per-PlannedAction drafter backed by the
 * `data.answer-question` L2 skill.
 *
 * This is the ACTUAL user-visible cutover for /data-analyze. P13
 * mistakenly replaced the per-DataAnalysisTask path
 * (`runDataDiscoveryPipeline` -> `runAnswerQuestionTask`) which is used
 * by a different entry point; the user-facing report generation goes
 * through the orchestrator's per-PlannedAction loop
 * (`planActions` -> for each action: `expandThenReview` -> stitch).
 * That loop is what this adapter replaces.
 *
 * Mirrors `agent/tasks/code-analyzer/answer-question-section.ts` --
 * same input/output shape (PlannedAction -> markdown + counts +
 * confidence), same L2-skill-call pattern, same stitch logic. The
 * only difference is which L2 skill it invokes
 * (`data.answer-question` vs `code.answer-question`) and the input
 * shape (connections roster instead of repo path).
 *
 * The L2 skill does its own classify + select-scope + dispatch +
 * draft + ground; this adapter does NOT pre-gather evidence via a
 * skills-pipeline call (the old per-action flow did, then handed the
 * evidence to expandThenReview). That pre-gather step collapses into
 * the L2 skill's internal dispatch.
 */

import { getLogger } from '../../../shared/logger.js';
import { runL2Skill } from '../../../daemon/skills/l2/runtime.js';
import { getL2Skill } from '../../../daemon/skills/l2/registry.js';

import type { Session } from '../../session.js';
import type { LLMProvider } from '../../../shared/types.js';
import type { ProviderAffinity, SkillOwner } from '../../../daemon/skills/types.js';
import type { PlannedAction } from '../../content-gen/plan-actions.js';
import type { CategoryResource } from '../../content-gen/category-materializer.js';
import type { ConnectionSummary } from './types.js';

const log = getLogger('data-analyzer:answer-question-action');

// ---------------------------------------------------------------------------
// Input / Output
// ---------------------------------------------------------------------------

export interface AnswerQuestionActionInput {
	readonly session:         Session;
	readonly action:          PlannedAction;
	readonly request:         string;
	readonly connections:     readonly ConnectionSummary[];
	readonly cloudProvider:   LLMProvider;
	readonly analyzerLabel?:  string | undefined;
	readonly onProgress?:     ((msg: string) => void) | undefined;
	/**
	 * Cross-category capabilities the planner tagged onto this action
	 * (excluding self). Threaded into the L2 skill's invocationContext
	 * so it can widen the classify-question / select-scope candidate
	 * pool to include code-owned skills. Empty means single-category.
	 * See plans/planner-cross-category-skills.md P4.
	 */
	readonly requiredCategories?:    readonly SkillOwner[] | undefined;
	/**
	 * Concrete resource handles (repoPaths / connections) for each
	 * `requiredCategories` entry, produced by the orchestrator's
	 * materializer hook (P3). The L2 skill reads these to populate
	 * cross-owner skill inputs at dispatch time (P5).
	 */
	readonly crossCategoryResources?: readonly CategoryResource[] | undefined;
}

export interface AnswerQuestionActionResult {
	readonly markdown:       string;
	readonly sectionCount:   number;
	readonly groundedCount:  number;
	readonly droppedCount:   number;
	readonly confidence:     'high' | 'medium' | 'low';
	readonly dispatched:     readonly { skillId: string; goal: string }[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const SKILL_ID = 'data.answer-question';

/**
 * Compose the question the L2 skill answers for this PlannedAction.
 * Mirrors the code-side adapter's `buildQuestion`: stitches title +
 * objective + reviewCriteria + the broader user request so the L2
 * skill's classify-question step sees a well-shaped question, not
 * just an opaque title.
 */
function buildQuestion(action: PlannedAction, request: string): string {
	const parts: string[] = [];
	parts.push(`Section: ${action.title}`);
	if (action.objective.length > 0) {
		parts.push(`Objective: ${action.objective}`);
	}
	if (action.reviewCriteria.length > 0) {
		parts.push('Review criteria:');
		for (const c of action.reviewCriteria) {
			parts.push(`  - ${c}`);
		}
	}
	if (request.length > 0) {
		parts.push('');
		parts.push(`User request (broader context): ${request}`);
	}
	return parts.join('\n');
}

/**
 * Stitch the L2 skill's sub-sections into one section markdown blob.
 * Each sub-section becomes a level-3 heading; an empty list (skill
 * returned no grounded sections) produces a "no findings" stub the
 * orchestrator surfaces verbatim.
 */
function stitchMarkdown(
	action:     PlannedAction,
	sections:   readonly { title: string; body: string }[],
	confidence: 'high' | 'medium' | 'low',
	notes:      readonly string[],
): string {
	const lines: string[] = [];

	if (sections.length === 0) {
		lines.push(`*No grounded findings for ${action.title}.*`);
		if (notes.length > 0) {
			lines.push('');
			lines.push('**Notes from the analyzer:**');
			for (const n of notes) lines.push(`- ${n}`);
		}
		return lines.join('\n');
	}

	for (const s of sections) {
		lines.push(`### ${s.title}`);
		lines.push('');
		lines.push(s.body);
		lines.push('');
	}

	if (confidence !== 'high' && notes.length > 0) {
		lines.push('---');
		lines.push('');
		lines.push(`*Analyzer confidence: ${confidence}.*`);
		for (const n of notes) lines.push(`- ${n}`);
	}

	return lines.join('\n').trimEnd();
}

function connectionsToL2Input(connections: readonly ConnectionSummary[]): Array<Record<string, unknown>> {
	return connections.map(c => {
		const out: Record<string, unknown> = { id: c.id, family: c.family };
		if (c.kind !== undefined) out['kind'] = c.kind;
		if (c.label !== undefined) out['label'] = c.label;
		return out;
	});
}

function countDropped(notes: readonly string[]): number {
	for (const n of notes) {
		const m = /(\d+)\s+section\(s\)\s+dropped/.exec(n);
		if (m !== null) return Number(m[1]);
	}
	return 0;
}

export async function runAnswerQuestionAction(input: AnswerQuestionActionInput): Promise<AnswerQuestionActionResult> {
	const skill = getL2Skill(SKILL_ID);
	if (skill === undefined) {
		throw new Error(`runAnswerQuestionAction: L2 skill '${SKILL_ID}' is not registered`);
	}

	// Empty-connections early-exit. Same defensive guard as the per-
	// task adapter -- no point burning LLM cycles when the L2 skill
	// has nothing to dispatch against.
	if (input.connections.length === 0) {
		log.info({ actionId: input.action.id }, 'no connections registered; skipping action');
		return {
			markdown: stitchMarkdown(input.action, [],
				'low',
				['No data connections registered. Add one via the Data pane before running analysis.']),
			sectionCount:  0,
			groundedCount: 0,
			droppedCount:  0,
			confidence:    'low',
			dispatched:    [],
		};
	}

	const question = buildQuestion(input.action, input.request);

	input.onProgress?.(`  [${input.action.id}] data.answer-question`);

	// All affinity sites route to the supplied cloud provider. Matches
	// the code-side adapter's pattern.
	const resolveProvider = (_affinity: ProviderAffinity): LLMProvider => input.cloudProvider;

	const run = await runL2Skill(skill as unknown as Parameters<typeof runL2Skill>[0],
		{
			input: {
				question,
				connections: connectionsToL2Input(input.connections),
				// priorContext intentionally omitted in v1.
			},
			invocationContext: {
				origin:        'data-analyzer-orchestrator',
				sectionId:     input.action.id,
				analyzerLabel: input.analyzerLabel ?? 'data-analyzer',
				// Cross-category fields (P4): the L2 skill reads these
				// to widen its candidate pool (P5) and to populate
				// cross-owner skill inputs at dispatch time.
				...(input.requiredCategories !== undefined && input.requiredCategories.length > 0
					? { requiredCategories: input.requiredCategories }
					: {}),
				...(input.crossCategoryResources !== undefined && input.crossCategoryResources.length > 0
					? { crossCategoryResources: input.crossCategoryResources }
					: {}),
			},
		},
		{
			session:         input.session,
			resolveProvider,
		},
	);

	if (run.rejected !== undefined) {
		log.warn({ actionId: input.action.id, reason: run.rejected.reason, detail: run.rejected.detail }, 'L2 skill rejected; emitting fallback section');
		return {
			markdown: stitchMarkdown(input.action, [],
				'low',
				[`L2 skill rejected: ${run.rejected.reason}: ${run.rejected.detail}`]),
			sectionCount:  0,
			groundedCount: 0,
			droppedCount:  0,
			confidence:    'low',
			dispatched:    [],
		};
	}

	const output = run.output;
	const value = output.value as {
		readonly question:     string;
		readonly questionType: string;
		readonly sections:     readonly { readonly title: string; readonly body: string }[];
		readonly dispatched:   readonly { readonly skillId: string; readonly goal: string }[];
	};

	const notes = output.notes ?? [];
	const droppedCount = countDropped(notes);

	const markdown = stitchMarkdown(input.action,
		value.sections,
		output.confidence,
		notes);

	log.info({
		actionId:         input.action.id,
		confidence:       output.confidence,
		sectionCount:     value.sections.length,
		droppedCount,
		dispatchedCount:  value.dispatched.length,
		questionType:     value.questionType,
	}, 'answer-question action drafted');

	return {
		markdown,
		sectionCount:  value.sections.length,
		groundedCount: value.sections.length,
		droppedCount,
		confidence:    output.confidence,
		dispatched:    value.dispatched,
	};
}
