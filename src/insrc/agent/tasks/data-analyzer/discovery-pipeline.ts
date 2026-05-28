/**
 * runDataDiscoveryPipeline -- Phase F of
 * plans/analyzers/data-analyzer-parity.md.
 *
 * Wires Phase C.2 (discovery-flow) + Phase E (writer + claim-grounding)
 * into a single per-task pipeline that produces a
 * `DataAnalyzerResult`. The orchestrator's `runNextAnalyzerTask` and
 * the cross-agent flow-2 entry point both invoke this directly --
 * it is the only data-analyzer per-task pipeline.
 *
 * Pipeline:
 *
 *   1. runDataDiscoveryFlow(task, connections)
 *        -> { retainedSteps, retainedEvidence, cyclesRun, perCycleSummary }
 *
 *   2. writeFromDataEvidence(task, retainedEvidence)
 *        -> { markdown, citationsUsed, empty }
 *
 *   3. reviewDataClaimsGrounding(task, prose, retainedEvidence)
 *        -> { claims, verdict, notes }
 *
 *   4. If verdict === 'redraft':
 *        - one writer redraft attempt with claim-grounding notes
 *        - structural checks: validateDataCitationCoverage,
 *          validateParagraphCitationDedup
 *        - DA-B1 guard: redraftRegressionGuard
 *        - keep the original if the redraft regresses; otherwise
 *          ship the redraft.
 *
 *   5. Adapt → DataAnalyzerResult so the existing review / synthesise
 *      pipeline downstream consumes the result unchanged.
 */

import type { Session } from '../../session.js';
import { getLogger } from '../../../shared/logger.js';
import { resolveDataAnalyzerProvider } from './resolve-provider.js';
import { runDataDiscoveryFlow, type DataDiscoveryFlowResult } from './discovery-flow.js';
import {
	writeFromDataEvidence,
	validateDataCitationCoverage,
	validateParagraphCitationDedup,
	redraftRegressionGuard,
	formatDataCitationCoverageNotes,
	formatParagraphDedupNotes,
	type WriteFromDataEvidenceOutput,
} from './write-from-evidence.js';
import { reviewDataClaimsGrounding, type DataClaimGroundingResponse } from './claim-grounding-reviewer.js';
import type { DataSessionDefaults } from './tool-call-guard.js';
import type {
	BlockedReason,
	Confidence,
	ConnectionSummary,
	DataAnalysisTask,
	DataAnalyzerResult,
	DataCitation,
	DataEvidenceEntry,
	DataFinding,
	DataAnalysisConcern,
	FindingSeverity,
	ToolCallSummary,
} from './types.js';

const log = getLogger('data-analyzer:discovery-pipeline');

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface RunDataDiscoveryPipelineInput {
	readonly session:        Session;
	readonly task:           DataAnalysisTask;
	readonly connections:    readonly ConnectionSummary[];
	readonly sessionDefaults?: DataSessionDefaults | undefined;
	readonly maxCycles?:     number | undefined;
	readonly signal?:        AbortSignal | undefined;
	readonly onProgress?:    ((msg: string) => void) | undefined;
}

export interface DataDiscoveryPipelineOutcome {
	readonly result:   DataAnalyzerResult;
	readonly truncated: boolean;
	/** Set when the discovery flow was skipped for a known reason. */
	readonly blockedReason?: BlockedReason | undefined;
	/** Surfaced for orchestrator logging / structural-check visibility. */
	readonly meta: {
		readonly cyclesRun:          number;
		readonly retainedStepCount:  number;
		readonly retainedEvidence:   number;
		readonly proseRedraftFired:  boolean;
		readonly proseRedraftKept:   boolean;
		readonly groundingVerdict:   'accept' | 'redraft';
		readonly coverageOk:         boolean;
		readonly paragraphDedupOk:   boolean;
	};
}

/**
 * Run the full discovery → writer → claim-grounding pipeline for
 * one task. Never throws; degrades to a low-confidence result on any
 * unexpected error so the orchestrator's downstream pipeline keeps
 * shipping.
 */
export async function runDataDiscoveryPipeline(
	input: RunDataDiscoveryPipelineInput,
): Promise<DataDiscoveryPipelineOutcome> {
	const t0 = Date.now();
	const localProvider = resolveDataAnalyzerProvider(input.session, 'analyzer');
	const cloudProvider = resolveDataAnalyzerProvider(input.session, 'plan');

	// Empty-connections short-circuit: no connections means the flow
	// has nothing to analyse. Surface as a structured blocked outcome
	// instead of burning LLM calls on a doomed plan.
	if (input.connections.length === 0) {
		log.info({ itemId: input.task.itemId }, 'discovery-pipeline: no connections registered; blocking');
		return {
			result: makeBlockedResult(input.task, 'no-connections', 'No data connections registered. Add one via the Data pane before running analysis.'),
			truncated: false,
			blockedReason: 'no-connections',
			meta: emptyMeta(),
		};
	}

	try {
		// 1. Discovery (multi-cycle).
		input.onProgress?.(`[${input.task.itemId}] discovery: planning + executing cycles`);
		const discovery: DataDiscoveryFlowResult = await runDataDiscoveryFlow({
			localProvider,
			cloudProvider,
			session:     input.session,
			task:        input.task,
			connections: input.connections,
			...(input.sessionDefaults !== undefined ? { sessionDefaults: input.sessionDefaults } : {}),
			...(input.maxCycles !== undefined ? { maxCycles: input.maxCycles } : {}),
			...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {}),
		});

		// 2. Writer.
		input.onProgress?.(`[${input.task.itemId}] writing prose from ${discovery.retainedEvidence.length} evidence entries`);
		const written: WriteFromDataEvidenceOutput = await writeFromDataEvidence({
			provider: cloudProvider,
			task:     input.task,
			evidence: discovery.retainedEvidence,
		});

		// 3. Claim-grounding review.
		const grounding: DataClaimGroundingResponse = await reviewDataClaimsGrounding(
			{
				task:     input.task,
				prose:    written.markdown,
				evidence: discovery.retainedEvidence,
			},
			cloudProvider,
		);

		// 4. Structural checks + optional redraft.
		const coverage = validateDataCitationCoverage(written.markdown);
		const dedup    = validateParagraphCitationDedup(written.markdown);
		const structuralFail = !coverage.ok || !dedup.ok;
		const redraftRequested = grounding.verdict === 'redraft' || structuralFail;

		let finalMarkdown      = written.markdown;
		let finalCitationsUsed = written.citationsUsed;
		let proseRedraftFired  = false;
		let proseRedraftKept   = false;

		if (redraftRequested && !written.empty) {
			input.onProgress?.(`[${input.task.itemId}] redraft requested (grounding: ${grounding.verdict}; coverage: ${coverage.ok ? 'ok' : 'fail'}; dedup: ${dedup.ok ? 'ok' : 'fail'})`);
			proseRedraftFired = true;
			const redraftNotes = [
				...(grounding.verdict === 'redraft' ? grounding.notes : []),
				...formatDataCitationCoverageNotes(coverage),
				...formatParagraphDedupNotes(dedup),
			];
			const redraftTaskHint = [
				input.task.hint ?? '',
				'',
				'REDRAFT requested. Reviewer notes:',
				...redraftNotes.map(n => `- ${n}`),
			].filter(line => line.length > 0).join('\n');
			const redrafted = await writeFromDataEvidence({
				provider: cloudProvider,
				task:     { ...input.task, hint: redraftTaskHint },
				evidence: discovery.retainedEvidence,
			});

			// DA-B1 regression guard.
			const guard = redraftRegressionGuard({
				originalTextLen:       written.markdown.length,
				originalCitationCount: written.citationsUsed.length,
				redraftTextLen:        redrafted.markdown.length,
				redraftCitationCount:  redrafted.citationsUsed.length,
			});

			// Also guard against redrafts that fix one check by breaking
			// another -- mirrors the code-side's redraftRegressed logic.
			const redraftCoverage = validateDataCitationCoverage(redrafted.markdown);
			const redraftDedup    = validateParagraphCitationDedup(redrafted.markdown);
			const breaksCoverage  = coverage.ok && !redraftCoverage.ok;
			const breaksDedup     = dedup.ok    && !redraftDedup.ok;
			const breaksChecks    = breaksCoverage || breaksDedup;

			if (guard.regressed) {
				log.warn(
					{
						itemId:        input.task.itemId,
						originalScore: guard.originalScore,
						redraftScore:  guard.redraftScore,
						ratio:         guard.ratio,
					},
					'discovery-pipeline: redraft regressed (DA-B1) -- keeping original',
				);
			} else if (breaksChecks) {
				log.warn(
					{ itemId: input.task.itemId, breaksCoverage, breaksDedup },
					'discovery-pipeline: redraft broke a check the original passed -- keeping original',
				);
			} else {
				finalMarkdown      = redrafted.markdown;
				finalCitationsUsed = redrafted.citationsUsed;
				proseRedraftKept   = true;
			}
		}

		// 5. Adapt to DataAnalyzerResult.
		const findings = synthesiseFindings(discovery.retainedEvidence, grounding);
		const aggregatedCitations = flattenEvidenceCitations(discovery.retainedEvidence);
		const confidence = aggregateConfidence(discovery.retainedEvidence, grounding);
		const toolCalls = synthesiseToolCalls(discovery);

		const truncated = false;  // discovery-flow doesn't expose truncation today; reserve for future
		const meta = {
			cyclesRun:         discovery.cyclesRun,
			retainedStepCount: discovery.retainedSteps.length,
			retainedEvidence:  discovery.retainedEvidence.length,
			proseRedraftFired,
			proseRedraftKept,
			groundingVerdict:  grounding.verdict,
			coverageOk:        coverage.ok,
			paragraphDedupOk:  dedup.ok,
		} as const;

		log.info(
			{
				itemId:           input.task.itemId,
				...meta,
				citationsUsed:    finalCitationsUsed.length,
				findings:         findings.length,
				confidence,
				durationMs:       Date.now() - t0,
			},
			'discovery-pipeline: complete',
		);

		const result: DataAnalyzerResult = {
			itemId:     input.task.itemId,
			answer:     finalMarkdown,
			findings,
			citations:  aggregatedCitations,
			confidence,
			toolCalls,
			...(truncated ? { truncated } : {}),
		};

		return {
			result,
			truncated,
			meta,
		};
	} catch (err) {
		const message = (err as Error).message ?? String(err);
		log.warn({ err: message, itemId: input.task.itemId }, 'discovery-pipeline: failed; degrading to low-confidence result');
		return {
			result: makeFailedResult(input.task, message),
			truncated: false,
			meta: emptyMeta(),
		};
	}
}

// ---------------------------------------------------------------------------
// Adapters: discovery output -> DataAnalyzerResult fields
// ---------------------------------------------------------------------------

/**
 * Synthesise per-task findings from retained evidence + claim-grounding.
 * One finding per evidence entry; the finding's `issue` is the first
 * fact, severity inferred from skill family + grounding verdict.
 * Citations are the entry's citations directly.
 *
 * Findings are required (downstream consumers expect non-empty when
 * the task ran). When evidence is empty, returns a single
 * informational placeholder so the shape stays well-formed.
 */
export function synthesiseFindings(
	evidence: readonly DataEvidenceEntry[],
	grounding: DataClaimGroundingResponse,
): readonly DataFinding[] {
	if (evidence.length === 0) {
		return [{
			concern:    'consistency',
			severity:   'info',
			issue:      'No evidence collected during discovery; report cannot characterise this task.',
			citations:  [],
		}];
	}

	const groundingDowngrade = grounding.verdict === 'redraft' ? 1 : 0;
	const findings: DataFinding[] = [];
	for (const e of evidence) {
		if (e.citations.length === 0) continue;  // findings invariant: non-empty citations
		const issue = e.facts.length > 0 ? e.facts[0]! : `evidence from ${e.skillId}`;
		findings.push({
			concern:   familyToConcern(e.skillId),
			severity:  combineSeverity(e.confidence, groundingDowngrade),
			issue,
			citations: e.citations,
		});
	}
	return findings;
}

/**
 * Aggregate confidence from per-evidence confidence + claim-grounding
 * verdict. Clamps DOWN on any low signal: 'low' anywhere makes the
 * aggregate low; redraft verdict caps at medium.
 */
export function aggregateConfidence(
	evidence: readonly DataEvidenceEntry[],
	grounding: DataClaimGroundingResponse,
): Confidence {
	if (evidence.length === 0) return 'low';
	const hasLow    = evidence.some(e => e.confidence === 'low');
	const hasMedium = evidence.some(e => e.confidence === 'medium');
	let base: Confidence;
	if (hasLow) base = 'low';
	else if (hasMedium) base = 'medium';
	else base = 'high';
	if (grounding.verdict === 'redraft') {
		// Cap at medium when claim-grounding flagged un-grounded claims.
		return base === 'high' ? 'medium' : base;
	}
	return base;
}

/**
 * Flatten + dedup all DataCitations across the retained evidence.
 * Used as the top-level `DataAnalyzerResult.citations` array (the
 * synthesise step renders these as part of the per-task report).
 *
 * Dedup key derived from the citation kind + identifier fields --
 * not just JSON.stringify, since `sampleValue` can drift across
 * skill calls for the same target.
 */
export function flattenEvidenceCitations(evidence: readonly DataEvidenceEntry[]): readonly DataCitation[] {
	const seen = new Set<string>();
	const out: DataCitation[] = [];
	for (const e of evidence) {
		for (const c of e.citations) {
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

/**
 * Synthesise per-task toolCall summaries from the discovery flow's
 * retained step outputs. Used as the `DataAnalyzerResult.toolCalls`
 * field; the downstream synthesise step does not introspect this
 * deeply (it's mostly for diagnostics + cache fingerprinting).
 */
export function synthesiseToolCalls(discovery: DataDiscoveryFlowResult): readonly ToolCallSummary[] {
	const out: ToolCallSummary[] = [];
	for (const step of discovery.retainedSteps) {
		for (const sid of step.calledSkillIds) {
			out.push({
				name:       sid,
				argsHash:   '',           // discovery-flow doesn't surface arg hashes today
				durationMs: 0,            // per-skill timing not surfaced from execute-step
				resultRows: 0,
			});
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Severity / concern inference
// ---------------------------------------------------------------------------

/**
 * Coarse mapping from skill-id family to DataAnalysisConcern. The
 * synthesise step uses concern as a coarse organising axis when
 * rendering the final report; precision isn't critical, defaults
 * are 'consistency' for everything we can't pigeonhole.
 *
 * Mirrors the code-side `familyToConcern` helper in skills-pipeline.ts
 * (the data-analyzer version of this same mapping). Kept here so the
 * pipeline doesn't depend on the legacy skills-pipeline module.
 */
function familyToConcern(skillId: string): DataAnalysisConcern {
	if (skillId.startsWith('data.lineage.'))       return 'lineage-gap';
	if (skillId.startsWith('data.pii.'))           return 'pii-exposure';
	if (skillId.startsWith('data.drift.'))         return 'schema-drift';
	if (skillId.startsWith('data.quality.'))       return 'consistency';
	if (skillId.startsWith('data.cardinality.'))   return 'capacity-risk';
	if (skillId.startsWith('data.dependency.'))    return 'consistency';
	if (skillId.startsWith('data.distribution.'))  return 'consistency';
	return 'consistency';
}

function combineSeverity(confidence: Confidence, groundingDowngrade: number): FindingSeverity {
	// Severity scaling: high confidence + no grounding flag -> warn
	// (worth surfacing). Medium / low confidence or any grounding
	// downgrade -> info (observational). We never auto-emit `error`
	// here without explicit signal; promotions happen via the
	// reviewer.
	if (confidence === 'high' && groundingDowngrade === 0) return 'warn';
	return 'info';
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
		confidence:   'low',
		toolCalls:    [],
		blockedReason: reason,
	};
}

function makeFailedResult(task: DataAnalysisTask, errorMessage: string): DataAnalyzerResult {
	return {
		itemId:    task.itemId,
		answer:    `Analysis failed: ${errorMessage}`,
		findings:  [{
			concern:   'consistency',
			severity:  'warn',
			issue:     `Discovery pipeline threw: ${errorMessage.slice(0, 200)}`,
			citations: [],
		}],
		citations:  [],
		confidence: 'low',
		toolCalls:  [],
	};
}

function emptyMeta(): DataDiscoveryPipelineOutcome['meta'] {
	return {
		cyclesRun:         0,
		retainedStepCount: 0,
		retainedEvidence:  0,
		proseRedraftFired: false,
		proseRedraftKept:  false,
		groundingVerdict:  'accept',
		coverageOk:        true,
		paragraphDedupOk:  true,
	};
}

// Test exports.
export const _familyToConcernForTest    = familyToConcern;
export const _combineSeverityForTest    = combineSeverity;
export const _citationKeyForTest        = citationKey;
