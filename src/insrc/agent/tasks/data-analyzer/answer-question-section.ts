/**
 * runAnswerQuestionTask -- per-task drafter backed by the
 * `data.answer-question` L2 skill (P12+P13).
 *
 * Replaces the legacy `runDataDiscoveryPipeline` (multi-cycle gather +
 * writer + claim-grounding-reviewer pingpong) with single-pass L2
 * self-grounding. Mirrors the code-side cutover (`answer-question-
 * section.ts`); the only differences are:
 *
 *   - Data input shape: ConnectionSummary[] instead of repoPath.
 *   - Output adaptation: produces a DataAnalyzerResult-shaped value
 *     so the orchestrator's review LLM + todo renderer + todo meta
 *     update keep working unchanged.
 *   - Concern + severity inference: each L2 section becomes a
 *     DataFinding; concern is inferred from the dispatched skill
 *     family (lineage / pii / drift / quality / ...).
 *   - Stub citations: every grounded section gets at least one
 *     structurally-valid DataCitation derived from the ledger ref,
 *     because the DataFinding invariant requires non-empty citations.
 *     The IDE renderer's data-conn:// click target is best-effort
 *     until a follow-up wires proper typed citations through the L2
 *     ledger (the L2 skill carries the ledger ref + source skill id;
 *     translating those into RdbmsCitation / KvCitation / etc. with
 *     the original target / column metadata is the next refinement).
 */

import { getLogger } from '../../../shared/logger.js';
import { runL2Skill } from '../../../daemon/skills/l2/runtime.js';
import { getL2Skill } from '../../../daemon/skills/l2/registry.js';

import type { Session } from '../../session.js';
import type { LLMProvider } from '../../../shared/types.js';
import type { ProviderAffinity } from '../../../daemon/skills/types.js';
import { resolveDataAnalyzerProvider } from './resolve-provider.js';

import type {
	BlockedReason,
	Confidence,
	ConnectionSummary,
	DataAnalysisConcern,
	DataAnalysisTask,
	DataAnalyzerResult,
	DataCitation,
	DataFinding,
	FindingSeverity,
	ToolCallSummary,
} from './types.js';

const log = getLogger('data-analyzer:answer-question-section');

// ---------------------------------------------------------------------------
// Input / Output -- shape-compatible with the legacy
// `DataDiscoveryPipelineOutcome` so the orchestrator integration point
// doesn't have to move.
// ---------------------------------------------------------------------------

export interface RunAnswerQuestionTaskInput {
	readonly session:        Session;
	readonly task:           DataAnalysisTask;
	readonly connections:    readonly ConnectionSummary[];
	readonly signal?:        AbortSignal | undefined;
	readonly onProgress?:    ((msg: string) => void) | undefined;
}

export interface AnswerQuestionTaskOutcome {
	readonly result:       DataAnalyzerResult;
	readonly truncated:    boolean;
	readonly blockedReason?: BlockedReason | undefined;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const SKILL_ID = 'data.answer-question';

export async function runAnswerQuestionTask(input: RunAnswerQuestionTaskInput): Promise<AnswerQuestionTaskOutcome> {
	// Empty-connections short-circuit. Matches the legacy pipeline's
	// behaviour: no connections registered means there's nothing to
	// analyse; surface as a structured blocked outcome instead of
	// burning LLM cycles on a doomed plan.
	if (input.connections.length === 0) {
		log.info({ itemId: input.task.itemId }, 'answer-question: no connections registered; blocking');
		return {
			result:        makeBlockedResult(input.task, 'no-connections', 'No data connections registered. Add one via the Data pane before running analysis.'),
			truncated:     false,
			blockedReason: 'no-connections',
		};
	}

	const skill = getL2Skill(SKILL_ID);
	if (skill === undefined) {
		log.warn({ skillId: SKILL_ID }, 'L2 skill not registered; failing the task');
		return {
			result:    makeFailedResult(input.task, `L2 skill '${SKILL_ID}' is not registered`),
			truncated: false,
		};
	}

	const cloudProvider = resolveDataAnalyzerProvider(input.session, 'plan');

	// All affinity hits route through the cloud provider. Same pattern
	// as the code-side adapter: the L2 runtime treats providerAffinity
	// at the L2 layer as 'cloud' today; per-sub-skill affinity at the
	// L1 layer is honoured by `runSkill` independently.
	const resolveProvider = (_affinity: ProviderAffinity): LLMProvider => cloudProvider;

	input.onProgress?.(`[${input.task.itemId}] data.answer-question via L2 self-grounding`);

	const run = await runL2Skill(skill as unknown as Parameters<typeof runL2Skill>[0],
		{
			input: {
				question:    input.task.question,
				connections: connectionsToL2Input(input.connections),
				// priorContext intentionally omitted in v1 -- the L2
				// skill accepts it but neither the orchestrator nor the
				// review loop currently produces a useful payload here.
				// Wire later when prior-turn context propagation lands.
			},
			invocationContext: {
				origin:    'data-analyzer-orchestrator',
				itemId:    input.task.itemId,
				taskKind:  input.task.kind,
			},
		},
		{
			session:         input.session,
			resolveProvider,
			...(input.signal !== undefined ? { signal: input.signal } : {}),
		},
	);

	if (run.rejected !== undefined) {
		log.warn({ itemId: input.task.itemId, reason: run.rejected.reason, detail: run.rejected.detail }, 'L2 skill rejected; emitting failed result');
		return {
			result:    makeFailedResult(input.task, `L2 skill rejected: ${run.rejected.reason}: ${run.rejected.detail}`),
			truncated: false,
		};
	}

	const output = run.output;
	const value = output.value as {
		readonly question:     string;
		readonly questionType: string;
		readonly sections:     readonly { readonly title: string; readonly body: string }[];
		readonly dispatched:   readonly { readonly skillId: string; readonly goal: string }[];
	};

	const answer = stitchAnswer(input.task.question, value.sections, output.confidence, output.notes ?? []);

	// One finding per L2 section + one fallback when sections is empty
	// (so the downstream invariant -- findings non-empty when the task
	// ran -- holds).
	const findings = synthesiseFindings(value.sections, value.dispatched, output.evidence);
	const citations = flattenFindingCitations(findings);
	const toolCalls = synthesiseToolCalls(value.dispatched);

	log.info({
		itemId:         input.task.itemId,
		confidence:     output.confidence,
		sectionCount:   value.sections.length,
		dispatchedCount: value.dispatched.length,
		findingCount:   findings.length,
		citationCount:  citations.length,
		questionType:   value.questionType,
	}, 'answer-question task drafted');

	return {
		result: {
			itemId:     input.task.itemId,
			answer,
			findings,
			citations,
			confidence: output.confidence,
			toolCalls,
		},
		truncated: false,
	};
}

// ---------------------------------------------------------------------------
// Input adaptation
// ---------------------------------------------------------------------------

function connectionsToL2Input(connections: readonly ConnectionSummary[]): Array<Record<string, unknown>> {
	return connections.map(c => {
		const out: Record<string, unknown> = { id: c.id, family: c.family };
		if (c.kind !== undefined) out['kind'] = c.kind;
		if (c.label !== undefined) out['label'] = c.label;
		// ConnectionSummary doesn't carry `path` directly; the L2 input
		// schema declares it optional so omission is fine.
		return out;
	});
}

// ---------------------------------------------------------------------------
// Output adaptation: L2 sections -> DataAnalyzerResult
// ---------------------------------------------------------------------------

function stitchAnswer(
	question: string,
	sections: readonly { title: string; body: string }[],
	confidence: Confidence,
	notes: readonly string[],
): string {
	if (sections.length === 0) {
		const lines: string[] = [`*No grounded findings for: ${question}*`];
		if (notes.length > 0) {
			lines.push('');
			lines.push('**Notes:**');
			for (const n of notes) lines.push(`- ${n}`);
		}
		return lines.join('\n');
	}

	const lines: string[] = [];
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

interface EvidenceShape {
	readonly claim:     string;
	readonly citations: readonly string[];
}

function synthesiseFindings(
	sections: readonly { title: string; body: string }[],
	dispatched: readonly { skillId: string; goal: string }[],
	evidence: readonly EvidenceShape[],
): readonly DataFinding[] {
	if (sections.length === 0) {
		return [{
			concern:   'consistency',
			severity:  'info',
			issue:     'No grounded sections produced by the L2 self-grounding pass.',
			citations: [{ kind: 'file-source', connectionId: 'l2-ledger', path: 'no-evidence' }],
		}];
	}

	// Pick a coarse concern from the dispatched-skill mix. If multiple
	// families dispatched, the first non-'consistency' wins so the
	// report's "primary concern" axis lands on the most informative
	// signal.
	const primaryConcern = pickPrimaryConcern(dispatched);

	const findings: DataFinding[] = [];
	for (let i = 0; i < sections.length; i++) {
		const section = sections[i]!;
		const refs = evidence[i]?.citations ?? [];
		// Stub citations: at least one valid DataCitation per finding
		// is required by the invariant. We derive a FileSourceCitation
		// referencing the ledger ref so the structural shape is well-
		// formed. A future refinement can introspect the source skill
		// id and produce a typed citation (Rdbms / KV / file-source /
		// code-ref) from the original L1 args.
		const stubCitations: DataCitation[] = refs.length > 0
			? refs.map(r => ({
				kind:         'file-source',
				connectionId: 'l2-ledger',
				path:         r,
			} satisfies DataCitation))
			: [{
				kind:         'file-source',
				connectionId: 'l2-ledger',
				path:         `section-${i + 1}-no-direct-ledger-ref`,
			} satisfies DataCitation];
		findings.push({
			concern:   section.title.startsWith('Gap:') ? 'consistency' : primaryConcern,
			severity:  'info',
			issue:     section.body.length > 280 ? section.body.slice(0, 277) + '...' : section.body,
			citations: stubCitations,
		});
	}
	return findings;
}

function pickPrimaryConcern(dispatched: readonly { skillId: string }[]): DataAnalysisConcern {
	for (const d of dispatched) {
		const c = familyToConcern(d.skillId);
		if (c !== 'consistency') return c;
	}
	return 'consistency';
}

function familyToConcern(skillId: string): DataAnalysisConcern {
	if (skillId.startsWith('data.lineage.'))       return 'lineage-gap';
	if (skillId.startsWith('data.pii.'))           return 'pii-exposure';
	if (skillId.startsWith('data.drift.'))         return 'schema-drift';
	if (skillId.startsWith('data.cardinality.'))   return 'capacity-risk';
	return 'consistency';
}

function flattenFindingCitations(findings: readonly DataFinding[]): readonly DataCitation[] {
	const seen = new Set<string>();
	const out: DataCitation[] = [];
	for (const f of findings) {
		for (const c of f.citations) {
			const key = citationKey(c);
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(c);
		}
	}
	return out;
}

function citationKey(c: DataCitation): string {
	switch (c.kind) {
		case 'rdbms':       return `rdbms:${c.connectionId}:${c.schema ?? ''}:${c.table}:${c.column ?? ''}`;
		case 'kv':          return `kv:${c.connectionId}:${c.keyPattern}:${c.fieldPath ?? ''}`;
		case 'file-source': return `file:${c.connectionId}:${c.path}:${c.column ?? ''}`;
		case 'code-ref':    return `code:${c.path}:${c.lineStart ?? ''}:${c.lineEnd ?? ''}`;
	}
}

function synthesiseToolCalls(dispatched: readonly { skillId: string; goal: string }[]): readonly ToolCallSummary[] {
	return dispatched.map(d => ({
		name:       d.skillId,
		argsHash:   '',
		durationMs: 0,
		resultRows: 0,
	}));
}

// ---------------------------------------------------------------------------
// Failure / blocked result constructors
// ---------------------------------------------------------------------------

function makeBlockedResult(task: DataAnalysisTask, reason: BlockedReason, answerText: string): DataAnalyzerResult {
	return {
		itemId:       task.itemId,
		answer:       answerText,
		findings:     [],
		citations:    [],
		confidence:   'low' satisfies Confidence,
		toolCalls:    [],
		blockedReason: reason,
	};
}

function makeFailedResult(task: DataAnalysisTask, errorMessage: string): DataAnalyzerResult {
	const severity: FindingSeverity = 'error';
	return {
		itemId:     task.itemId,
		answer:     `Analysis failed: ${errorMessage}`,
		findings:   [{
			concern:   'consistency',
			severity,
			issue:     errorMessage,
			citations: [{ kind: 'file-source', connectionId: 'l2-ledger', path: 'analysis-failure' }],
		}],
		citations:  [],
		confidence: 'low' satisfies Confidence,
		toolCalls:  [],
	};
}
