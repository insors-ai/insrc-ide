/**
 * Per-section drafter backed by the `code.answer-question` L2 skill.
 *
 * Phase 6 of [plans/code-analyzer-migration.md](../../../../plans/code-analyzer-migration.md):
 *   - The legacy writer + grounding-review pingpong (write-from-evidence
 *     + claim-grounding-reviewer + meta-narrative-detector +
 *     discovery-flow's multi-cycle gather loop) is replaced by a single
 *     `runL2Skill('code.answer-question', ...)` call per `PlannedAction`.
 *   - The L2 skill plans its own discovery (classify-question +
 *     select-scope), dispatches L1 sub-calls, drafts a section-shaped
 *     answer, and self-grounds every citation against its working-state
 *     ledger (A1). meta-narrative + claim-grounding-reviewer are dropped
 *     -- the runtime's `validateGrounding` covers the same surface.
 *
 * The clean cutover: this module replaced `discovery-flow.ts` outright.
 * The legacy file + its writer / reviewer / cycle helpers were deleted
 * in the same commit. No feature flag.
 *
 * Single-pass note: the legacy flow ran up to 3 cycles of gather-then-
 * write. The L2 skill is single-pass classify -> select -> dispatch ->
 * draft -> ground. If section quality regresses materially on large
 * modules, multi-cycle reflect is a follow-up (the L2 framework
 * supports it via `deps.callL2` / repeated `callL1` in a fresh body).
 */

import { getLogger } from '../../../shared/logger.js';
import { runL2Skill } from '../../../daemon/skills/l2/runtime.js';
import { getL2Skill } from '../../../daemon/skills/l2/registry.js';

import type { Session } from '../../session.js';
import type { LLMProvider } from '../../../shared/types.js';
import type { ScopeSize } from '../../../shared/classify.js';
import type { ProviderAffinity } from '../../../daemon/skills/types.js';
import type { PlannedAction } from '../../content-gen/plan-actions.js';

const log = getLogger('code-analyzer:answer-question-section');

// ---------------------------------------------------------------------------
// Input / Output -- shape-compatible with the legacy `DiscoveryFlowResult`
// so the orchestrator integration point doesn't move.
// ---------------------------------------------------------------------------

export interface AnswerQuestionSectionInput {
	readonly localProvider:    LLMProvider;
	readonly cloudProvider:    LLMProvider;
	readonly session:          Session;
	readonly action:           PlannedAction;
	readonly request:          string;
	readonly tier:             ScopeSize;
	readonly repoSummary?:     string | undefined;
	readonly analyzerLabel?:   string | undefined;
	readonly onProgress?:      ((msg: string) => void) | undefined;
	/** Active indexed-repo root. Required -- the L2 skill needs it. */
	readonly repoPath:         string;
}

export interface AnswerQuestionSectionResult {
	readonly markdown:           string;
	readonly sectionCount:       number;
	readonly groundedCount:      number;
	readonly droppedCount:       number;
	readonly confidence:         'high' | 'medium' | 'low';
	readonly dispatched:         readonly { skillId: string; goal: string }[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const SKILL_ID = 'code.answer-question';

/**
 * Map a `ScopeSize` (`S` / `M` / `L` / `XL` / `XXL` / `XXXL` / `XXXXL`)
 * to the `code.answer-question` skill's input enum (`S` / `M` / `L` /
 * `XL`). XXL+ tiers clamp to `XL`. The classify-question + select-scope
 * skills also honour `XL` as the widest tier today.
 */
function clampTier(t: ScopeSize): 'S' | 'M' | 'L' | 'XL' {
	switch (t) {
		case 'S':  return 'S';
		case 'M':  return 'M';
		case 'L':  return 'L';
		default:   return 'XL';
	}
}

/**
 * Build the question the L2 skill will answer for this section. The
 * planner gives us `title` + `objective` per action; the user's
 * verbatim `request` provides the broader context. We compose them so
 * the L2 skill's classify-question step sees a well-shaped question
 * (not just the section title).
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
 * returned no grounded sections) produces a short "no findings" stub.
 */
function stitchMarkdown(
	action:   PlannedAction,
	sections: readonly { title: string; body: string }[],
	confidence: 'high' | 'medium' | 'low',
	notes:    readonly string[],
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

export async function runAnswerQuestionSection(input: AnswerQuestionSectionInput): Promise<AnswerQuestionSectionResult> {
	const skill = getL2Skill(SKILL_ID);
	if (skill === undefined) {
		throw new Error(`runAnswerQuestionSection: L2 skill '${SKILL_ID}' is not registered`);
	}

	const question = buildQuestion(input.action, input.request);
	const tier     = clampTier(input.tier);

	input.onProgress?.(`  [${input.action.id}] code.answer-question (tier=${tier})`);

	// The L2 runtime drives the LLM via its own L2LlmAccess. Per
	// CLAUDE.md, classify / select / draft are cloud-affinity work --
	// route every affinity to the cloud provider passed in. (The
	// per-skill `providerAffinity` field at L2 is treated as a hint by
	// the runtime; today the runtime always asks for 'cloud'.)
	const resolveProvider = (_affinity: ProviderAffinity): LLMProvider => input.cloudProvider;

	const run = await runL2Skill(skill as unknown as Parameters<typeof runL2Skill>[0],
		{
			input: {
				question,
				activeRepoPath: input.repoPath,
				scopeTier:      tier,
			},
			invocationContext: {
				origin:        'code-analyzer-orchestrator',
				sectionId:     input.action.id,
				analyzerLabel: input.analyzerLabel ?? 'code-analyzer',
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
	}, 'answer-question section drafted');

	return {
		markdown,
		sectionCount:  value.sections.length,
		groundedCount: value.sections.length,
		droppedCount,
		confidence:    output.confidence,
		dispatched:    value.dispatched,
	};
}

function countDropped(notes: readonly string[]): number {
	for (const n of notes) {
		const m = /(\d+)\s+section\(s\)\s+dropped/.exec(n);
		if (m !== null) return Number(m[1]);
	}
	return 0;
}
