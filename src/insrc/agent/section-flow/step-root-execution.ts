/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Per-root execution + review + followup loop (planner-section-
 * task-separation P3.b).
 *
 * Iterates over the reviewable roots (Q3 Option B: direct children of
 * the top-level composition) sequentially per the "no parallel LLM
 * calls" rule. For each root:
 *
 *   1. Execute leaves via the caller-supplied `executeLeaf` callback
 *      (walk DFS, accumulate per-leaf outputs).
 *   2. Run the per-root review LLM call. The verdict is one of:
 *
 *        accept        -> record finding, advance to next root.
 *        followup      -> execute the reviewer's suggested follow-up
 *                         leaves (advisory; up to 3 cycles per Q6),
 *                         re-review with hint mutation allowed.
 *        revise-major  -> ESCALATE to the TODO orchestrator. The
 *                         orchestrator re-opens the section task
 *                         tree (Q3 / Q6 escape hatch). This loop
 *                         returns immediately with
 *                         `reopenRequested: true`.
 *
 *   3. On followup-cycle cap hit, force-accept with
 *      `exhausted: true` -- the orchestrator surfaces the
 *      `review-exhausted` annotation downstream so the section
 *      review (Q5) and final report review (Q7) can detect
 *      under-evidenced sections.
 *
 * Leaf execution is intentionally opaque to this module -- the
 * caller passes an `executeLeaf` callback that handles skill
 * routing, input resolution, output stringification, etc. P3.d
 * wires the real executor; tests inject a scripted mock.
 */

import type { LLMMessage, LLMProvider } from '../../shared/types.js';
import type { PlannedNode, PlannedTree } from '../content-gen/plan-tree.js';
import type { CatalogSkill } from '../content-gen/plan-tree-runner.js';
import type { PerRootFinding, RootVerdict, WorkingMemoryFindings } from '../working-memory/types.js';
import type { MemoryShapeBundle } from '../working-memory/index.js';
import type { TodoSpec } from './types.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('section-flow:root-execution');

// ---------------------------------------------------------------------------
// Constants (Q6 cycle caps)
// ---------------------------------------------------------------------------

/**
 * Maximum followup cycles per reviewable root (Q6 sub-Q6c). After
 * cap, force-accept with `exhausted: true`.
 */
const FOLLOWUP_CYCLE_CAP = 3;

/**
 * Hard ceiling on suggested-leaf count the reviewer can emit per
 * followup cycle. Q6 sub-Q6a: small extensions, NOT fresh task graphs.
 */
const MAX_FOLLOWUP_LEAVES = 3;

const MAX_REVIEW_TOKENS = 1024;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LeafExecutionInput {
	readonly leaf: PlannedNode;
	/**
	 * Outputs of the nodes the leaf's inputs reference. Keys match
	 * `leaf.inputs[<argName>].nodeId`. Values are whatever the prior
	 * leaf execution produced. The orchestrator resolves these per
	 * the visibility rules; this module doesn't.
	 */
	readonly priorOutputs: Readonly<Record<string, string>>;
}

export type ExecuteLeaf = (input: LeafExecutionInput) => Promise<string>;

export interface PerRootExecutorInput {
	readonly todo:       TodoSpec;
	readonly tree:       PlannedTree;
	readonly memory:     MemoryShapeBundle;
	readonly executeLeaf: ExecuteLeaf;
	readonly provider:    LLMProvider;
	/**
	 * Skill catalog used to validate reviewer-emitted `suggested_leaves`.
	 * Leaves whose `skill` is not in the catalog are dropped (logged warn).
	 * Optional for test ergonomics; production wires this through from
	 * `runSectionFlow` so the reviewer can't smuggle unregistered ids into
	 * the followup execution path (mirror of the section-planner GAP A fix).
	 */
	readonly catalog?:    readonly CatalogSkill[] | undefined;
}

export interface PerRootExecutorResult {
	readonly findings:        WorkingMemoryFindings;
	readonly reopenRequested: boolean;
	readonly reopenReason?:   string | undefined;
}

/**
 * Execute every reviewable root sequentially. Stops at the first
 * revise-major escalation (reopen requested) so the orchestrator can
 * re-plan the section task tree. On clean completion all roots have
 * findings.
 */
export async function executeReviewableRoots(
	input: PerRootExecutorInput,
): Promise<PerRootExecutorResult> {
	const root = input.tree.root;
	if (root.kind !== 'composition' || root.children === undefined || root.children.length === 0) {
		// Defensive: section planner's degenerate-shape check should
		// already have rejected this. Surface as a synthetic escalation
		// rather than throwing -- the orchestrator handles it the same
		// way as a real revise-major.
		return {
			findings:        { perRoot: [] },
			reopenRequested: true,
			reopenReason:    'top-level node is not a composition with children',
		};
	}

	const reviewableRoots = root.children;
	const perRoot: PerRootFinding[] = [];
	const compositionOutputs: Record<string, string> = {};
	const catalogIds: ReadonlySet<string> | undefined =
		input.catalog !== undefined && input.catalog.length > 0
			? new Set(input.catalog.map(c => c.id))
			: undefined;

	for (const reviewableRoot of reviewableRoots) {
		const result = await executeOneReviewableRoot({
			todo:         input.todo,
			memory:       input.memory,
			rootNode:     reviewableRoot,
			compositionOutputs,
			executeLeaf:  input.executeLeaf,
			provider:     input.provider,
			catalogIds,
		});

		if (result.escalate !== undefined) {
			perRoot.push(result.finding);
			return {
				findings:        { perRoot },
				reopenRequested: true,
				reopenReason:    result.escalate,
			};
		}

		perRoot.push(result.finding);
		compositionOutputs[reviewableRoot.id] = result.compositionOutput;
	}

	return {
		findings:        { perRoot },
		reopenRequested: false,
	};
}

// ---------------------------------------------------------------------------
// Per-root inner loop
// ---------------------------------------------------------------------------

interface OneRootInput {
	readonly todo:       TodoSpec;
	readonly memory:     MemoryShapeBundle;
	readonly rootNode:   PlannedNode;
	readonly compositionOutputs: Readonly<Record<string, string>>;
	readonly executeLeaf: ExecuteLeaf;
	readonly provider:    LLMProvider;
	readonly catalogIds?: ReadonlySet<string> | undefined;
}

interface OneRootResult {
	readonly finding:           PerRootFinding;
	readonly compositionOutput: string;
	/** When set, the orchestrator should re-open the section tree (revise-major). */
	readonly escalate?:         string | undefined;
}

async function executeOneReviewableRoot(input: OneRootInput): Promise<OneRootResult> {
	const log_ = log.child({ todoId: input.todo.id, rootId: input.rootNode.id });
	log_.info('executing reviewable root');

	// Initial leaf walk + review.
	const initial = await executeLeavesDfs(input.rootNode, input.compositionOutputs, input.executeLeaf);
	let aggregateOutput = initial.aggregate;
	let allOutputs = { ...input.compositionOutputs, ...initial.outputs };

	let review = await reviewRoot({
		todo:             input.todo,
		memory:           input.memory,
		rootNode:         input.rootNode,
		aggregateOutput,
		cyclesConsumed:   0,
		priorHints:       [],
		provider:         input.provider,
		catalogIds:       input.catalogIds,
	});
	let cyclesConsumed = 0;
	let lastHints: string[] = [];

	while (review.verdict === 'followup' && cyclesConsumed < FOLLOWUP_CYCLE_CAP) {
		const hint = review.followupHint ?? '(no hint)';
		lastHints = [...lastHints, hint];
		const suggested = (review.followupLeaves ?? []).slice(0, MAX_FOLLOWUP_LEAVES);
		log_.info({ cycle: cyclesConsumed + 1, suggestedCount: suggested.length, hint }, 'followup cycle starting');

		if (suggested.length === 0) {
			// Reviewer wants followup but didn't say what -- count the
			// cycle, drop a synthetic finding entry so the trace shows
			// it, but don't execute anything.
			log_.warn('reviewer requested followup with zero suggested leaves; counting cycle as no-op');
		} else {
			const cycleResult = await executeFollowupLeaves({
				leaves:       suggested,
				rootId:       input.rootNode.id,
				cycleIndex:   cyclesConsumed + 1,
				priorOutputs: allOutputs,
				executeLeaf:  input.executeLeaf,
			});
			// Followup outputs augment the root's aggregate output.
			aggregateOutput = `${aggregateOutput}\n\n## Followup cycle ${cyclesConsumed + 1}\n\n${cycleResult.aggregate}`;
			allOutputs = { ...allOutputs, ...cycleResult.outputs };
		}

		cyclesConsumed += 1;

		review = await reviewRoot({
			todo:           input.todo,
			memory:         input.memory,
			rootNode:       input.rootNode,
			aggregateOutput,
			cyclesConsumed,
			priorHints:     lastHints,
			provider:       input.provider,
			catalogIds:     input.catalogIds,
		});
	}

	// After the while loop, review.verdict is one of:
	//   accept       -- clean accept (while loop's exit condition).
	//   followup     -- followup-cycle cap was reached without an
	//                   accept; force-accept with `exhausted: true`.
	//   revise-major -- per-root review wants the section task tree
	//                   re-opened; escalate to the orchestrator.
	const reasoning = review.reasoning ?? '';

	if (review.verdict === 'revise-major') {
		const escalationReason = reasoning.length > 0
			? reasoning
			: 'revise-major requested by per-root review';
		log_.warn({ escalationReason, cyclesConsumed }, 'per-root review escalated revise-major');
		return {
			finding: {
				rootId:         input.rootNode.id,
				verdict:        'force-accept',
				cyclesConsumed,
				exhausted:      true,
				content:        `[revise-major escalated: ${escalationReason}]`,
			},
			compositionOutput: aggregateOutput,
			escalate:          escalationReason,
		};
	}

	const exhausted = review.verdict === 'followup';
	const verdict: RootVerdict = exhausted ? 'force-accept' : 'accept';

	log_.info({ verdict, cyclesConsumed, exhausted }, 'reviewable root complete');

	return {
		finding: {
			rootId:         input.rootNode.id,
			verdict,
			cyclesConsumed,
			exhausted,
			content:        composeFindingContent(aggregateOutput, reasoning),
		},
		compositionOutput: aggregateOutput,
	};
}

// ---------------------------------------------------------------------------
// Leaf execution
// ---------------------------------------------------------------------------

interface LeavesExecutionResult {
	readonly aggregate: string;
	readonly outputs:   Record<string, string>;
}

async function executeLeavesDfs(
	node: PlannedNode,
	priorOutputs: Readonly<Record<string, string>>,
	executeLeaf: ExecuteLeaf,
): Promise<LeavesExecutionResult> {
	const outputs: Record<string, string> = {};
	const parts: string[] = [];

	async function walk(n: PlannedNode): Promise<void> {
		if (n.kind === 'leaf') {
			const allInputs = { ...priorOutputs, ...outputs };
			const out = await executeLeaf({ leaf: n, priorOutputs: allInputs });
			outputs[n.id] = out;
			parts.push(`### ${n.id}\n${out}`);
			return;
		}
		if (n.children !== undefined) {
			for (const child of n.children) {
				await walk(child);
			}
		}
	}

	await walk(node);

	return {
		aggregate: parts.join('\n\n'),
		outputs,
	};
}

interface FollowupExecutionInput {
	readonly leaves:       readonly PlannedNode[];
	readonly rootId:       string;
	readonly cycleIndex:   number;
	readonly priorOutputs: Readonly<Record<string, string>>;
	readonly executeLeaf:  ExecuteLeaf;
}

async function executeFollowupLeaves(input: FollowupExecutionInput): Promise<LeavesExecutionResult> {
	const outputs: Record<string, string> = {};
	const parts: string[] = [];
	for (const leaf of input.leaves) {
		if (leaf.kind !== 'leaf') {
			// Reviewer suggested a non-leaf node. Skip with a warning;
			// Q6 sub-Q6a explicitly says followups are SMALL EXTENSIONS.
			log.warn({ leafId: leaf.id }, 'followup suggested non-leaf node; skipping');
			continue;
		}
		const allInputs = { ...input.priorOutputs, ...outputs };
		const out = await input.executeLeaf({ leaf, priorOutputs: allInputs });
		const tagged = `${input.rootId}.followup-${input.cycleIndex}.${leaf.id}`;
		outputs[tagged] = out;
		parts.push(`### ${tagged}\n${out}`);
	}
	return { aggregate: parts.join('\n\n'), outputs };
}

// ---------------------------------------------------------------------------
// Review LLM call
// ---------------------------------------------------------------------------

interface ReviewInput {
	readonly todo:            TodoSpec;
	readonly memory:          MemoryShapeBundle;
	readonly rootNode:        PlannedNode;
	readonly aggregateOutput: string;
	readonly cyclesConsumed:  number;
	readonly priorHints:      readonly string[];
	readonly provider:        LLMProvider;
	readonly catalogIds?:     ReadonlySet<string> | undefined;
}

interface ReviewParsed {
	readonly verdict:        'accept' | 'followup' | 'revise-major';
	readonly reasoning?:     string | undefined;
	readonly followupHint?:  string | undefined;
	readonly followupLeaves?: readonly PlannedNode[] | undefined;
}

const REVIEW_ROLE = [
	'You are the PER-ROOT REVIEWER for one reviewable root in a section',
	'task tree. You see the root\'s aggregate output, the TODO objective,',
	'and the working-memory bundle. You decide one of three verdicts:',
	'',
	'  accept       -- evidence is sufficient; orchestrator advances to',
	'                  the next reviewable root.',
	'  followup     -- evidence is INCOMPLETE; emit a small followup',
	'                  extension (1-3 leaves) that closes the specific',
	'                  gap. The orchestrator will execute it and re-',
	'                  review. Cap is 3 followup cycles; after that the',
	'                  orchestrator force-accepts with a',
	'                  `review-exhausted` annotation.',
	'  revise-major -- structural failure that section regeneration',
	'                  cannot fix. ESCALATES to the TODO orchestrator,',
	'                  which re-opens the section task tree.',
	'',
	'You emit a SINGLE JSON object. No prose, no markdown fences.',
].join('\n');

async function reviewRoot(input: ReviewInput): Promise<ReviewParsed> {
	const messages: LLMMessage[] = [
		{ role: 'system', content: REVIEW_ROLE },
		{ role: 'user',   content: buildReviewUser(input) },
	];
	const response = await input.provider.complete(messages, {
		maxTokens:       MAX_REVIEW_TOKENS,
		temperature:     0,
		responseFormat:  'json',
		disableThinking: true,
	});
	return parseReview(response.text, input.catalogIds);
}

function buildReviewUser(input: ReviewInput): string {
	const hintsBlock = input.priorHints.length === 0
		? '(none; this is the initial review)'
		: input.priorHints.map((h, i) => `  cycle ${i + 1}: ${h}`).join('\n');

	const lines: string[] = [
		'## TODO OBJECTIVE',
		input.todo.objective,
		'',
		'## REVIEWABLE ROOT',
		`id:         ${input.rootNode.id}`,
		`title:      ${input.rootNode.title}`,
		`objective:  ${input.rootNode.objective}`,
		`emit:       ${input.rootNode.emit}`,
		'',
		'## PRIOR FOLLOWUP HINTS (you may evolve these; cap is 3 followup cycles)',
		hintsBlock,
		'',
		`## CYCLES CONSUMED: ${input.cyclesConsumed} / ${FOLLOWUP_CYCLE_CAP}`,
		'',
		'## AGGREGATE OUTPUT (all leaves of this root, plus prior followups)',
		input.aggregateOutput.length > 0 ? input.aggregateOutput : '(empty)',
		'',
		'## OUTPUT SHAPE (emit EXACTLY this object; verdict MUST be one of the three)',
		'',
		'{',
		'  "verdict":   "accept" | "followup" | "revise-major",',
		'  "reasoning": "<one sentence>",',
		'  "followup":  { "hint": "<what gap to close>", "suggested_leaves": [<PlannedNode leaves, optional>] }',
		'}',
		'',
		'## RULES',
		`  - "followup.suggested_leaves" hard cap: ${MAX_FOLLOWUP_LEAVES} leaves; each MUST be {id, title, objective, kind: "leaf", skill, inputs, emit: "intermediate"}.`,
		'  - Use "revise-major" ONLY when section regeneration alone can\'t fix the issue (e.g. wrong investigation direction, contradiction with another root).',
		'  - Hint mutation allowed across cycles -- a later cycle may correct an earlier hint.',
	];
	if (input.catalogIds !== undefined && input.catalogIds.size > 0) {
		lines.push('  - Every `suggested_leaves[].skill` MUST be an id from the SKILL CATALOG section below. Leaves with unknown ids are silently dropped.');
	}
	if (input.catalogIds !== undefined && input.catalogIds.size > 0) {
		lines.push('');
		lines.push(`## SKILL CATALOG (${input.catalogIds.size} skills available)`);
		for (const id of input.catalogIds) {
			lines.push(`- \`${id}\``);
		}
	}
	lines.push('');
	lines.push('## TASK');
	lines.push('Emit the JSON verdict now. Begin with "{" and end with "}".');
	return lines.join('\n');
}

function parseReview(raw: string, catalogIds?: ReadonlySet<string> | undefined): ReviewParsed {
	let text = raw.trim();
	if (text.startsWith('```')) {
		text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		// On parse failure default to force-accept (safer than retry-storms).
		log.warn({ preview: raw.slice(0, 200) }, 'per-root review: JSON parse failed; defaulting to accept');
		return { verdict: 'accept', reasoning: 'review parse failure -> accept' };
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { verdict: 'accept', reasoning: 'review shape invalid -> accept' };
	}
	const obj = parsed as Record<string, unknown>;
	const verdictRaw = obj['verdict'];
	const verdict: ReviewParsed['verdict'] = verdictRaw === 'followup' || verdictRaw === 'revise-major' ? verdictRaw : 'accept';
	const reasoning = typeof obj['reasoning'] === 'string' ? obj['reasoning'] : undefined;

	let followupHint: string | undefined;
	let followupLeaves: PlannedNode[] | undefined;
	const followupBlob = obj['followup'];
	if (followupBlob !== null && typeof followupBlob === 'object' && !Array.isArray(followupBlob)) {
		const f = followupBlob as Record<string, unknown>;
		if (typeof f['hint'] === 'string') {
			followupHint = f['hint'];
		}
		const sl = f['suggested_leaves'];
		if (Array.isArray(sl)) {
			followupLeaves = sl
				.filter((node): node is Record<string, unknown> => node !== null && typeof node === 'object' && !Array.isArray(node))
				.map(node => coerceLeaf(node, catalogIds))
				.filter((node): node is PlannedNode => node !== null);
		}
	}

	return {
		verdict,
		...(reasoning      !== undefined ? { reasoning }                       : {}),
		...(followupHint   !== undefined ? { followupHint }                    : {}),
		...(followupLeaves !== undefined ? { followupLeaves }                  : {}),
	};
}

/**
 * Best-effort coercion of a JSON object into a PlannedNode leaf. Does
 * NOT run the full validatePlannedTree path -- followups are advisory
 * per Q6 sub-Q6a, and we already cap them at 3 leaves. Returns null on
 * shape mismatch.
 */
function coerceLeaf(raw: Record<string, unknown>, catalogIds?: ReadonlySet<string> | undefined): PlannedNode | null {
	if (raw['kind'] !== 'leaf') {
		return null;
	}
	const id        = typeof raw['id']        === 'string' ? (raw['id']        as string).trim() : '';
	const title     = typeof raw['title']     === 'string' ? (raw['title']     as string).trim() : '';
	const objective = typeof raw['objective'] === 'string' ? (raw['objective'] as string).trim() : '';
	const skill     = typeof raw['skill']     === 'string' ? (raw['skill']     as string).trim() : '';
	if (id === '' || title === '' || objective === '' || skill === '') {
		return null;
	}
	// GAP B fix: drop reviewer-suggested followup leaves whose `skill` is
	// not in the catalog. Mirror of the section-planner enforcement; here
	// we drop silently (logged warn) rather than reject the whole verdict,
	// because the orchestrator can still proceed without the dropped leaf.
	if (catalogIds !== undefined && catalogIds.size > 0 && !catalogIds.has(skill)) {
		log.warn({ leafId: id, skill }, 'root review: dropping suggested_leaf with unknown skill id');
		return null;
	}
	const inputsRaw = raw['inputs'];
	const inputs = (inputsRaw !== null && typeof inputsRaw === 'object' && !Array.isArray(inputsRaw))
		? (inputsRaw as Record<string, never>)
		: {};
	return {
		id, title, objective,
		kind:   'leaf',
		skill,
		inputs,
		emit:   'intermediate',
	};
}

// ---------------------------------------------------------------------------
// Finding rendering
// ---------------------------------------------------------------------------

function composeFindingContent(aggregateOutput: string, reasoning: string): string {
	if (aggregateOutput.length === 0 && reasoning.length === 0) {
		return '(empty)';
	}
	const parts: string[] = [];
	if (reasoning.length > 0) {
		parts.push(`Reviewer reasoning: ${reasoning}`);
	}
	if (aggregateOutput.length > 0) {
		parts.push(aggregateOutput);
	}
	return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _parseReviewForTest             = parseReview;
export const _coerceLeafForTest              = coerceLeaf;
export const _executeLeavesDfsForTest        = executeLeavesDfs;
export const _executeFollowupLeavesForTest   = executeFollowupLeaves;
export const _composeFindingContentForTest   = composeFindingContent;
export const FOLLOWUP_CYCLE_CAP_VALUE        = FOLLOWUP_CYCLE_CAP;
export const MAX_FOLLOWUP_LEAVES_VALUE       = MAX_FOLLOWUP_LEAVES;
