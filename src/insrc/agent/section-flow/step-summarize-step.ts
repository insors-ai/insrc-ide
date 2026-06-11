/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * summarize-step caller -- runs the local-tier summarize-step writer
 * for one freshly-executed DiscoveryStep, parses the JSON, substitutes
 * callIds for artifactIds in every citation, and verifies the result
 * deterministically. On verification failure, retries the LLM once
 * with a corrective hint listing the failing claims.
 *
 * Returns the verified `CitedStepSummary[]` (one per call). The
 * caller (todo-orchestrator) persists each into the corresponding
 * artifact_vec row via `updateArtifactSummary(artifactId, JSON.stringify(summary))`.
 *
 * On terminal failure (second attempt also has bad citations), this
 * caller does NOT throw -- it returns a SYNTHETIC fallback summary
 * for each call so the orchestrator's pipeline keeps moving. The
 * fallback summary carries `claims: []`, `gapClosures: []`, and a
 * narrative noting the verification failure -- downstream synth /
 * section-review see an empty-but-honest summary instead of dropping
 * the call. This matches the lenient graceful-degrade contract Phase
 * 1 established.
 */

import type { LLMMessage, LLMProvider } from '../../shared/types.js';
import type { RequiredFact } from './fact-gap-types.js';
import type {
	Citation,
	CitedClaim,
	CitedStepSummary,
	GapClosureClaim,
	GapClosureVerdict,
} from './citation-types.js';
import type {
	SummarizeStepCallInput,
	SummarizeStepWriterInput,
} from '../prompts/writers/summarize-step.js';
import {
	verifyCitedSummary,
	type ArtifactRawTextLookup,
	type BadClaim,
} from './citation-verifier.js';
import { getPromptRegistry } from '../prompts/registry.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('section-flow:summarize-step');

// Live run with citations caught 3072 truncating on field-extract,
// peek-of-JSON, and sample-shape outputs -- the cited-claims JSON
// envelope is large when the raw output is rich (27+ field-extract
// citations, multi-line schema descriptions). 8192 covers the
// realistic upper bound for current skill outputs.
const MAX_TOKENS = 8192;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SummarizeStepCall {
	readonly callId:     string;
	readonly skillId:    string;
	readonly context:    string;
	readonly artifactId: string;
	readonly rawText:    string;
}

export interface SummarizeStepInput {
	readonly todoObjective: string;
	readonly stepIntent:    string;
	readonly stepStatus:    'ok' | 'partial' | 'failed';
	readonly calls:         readonly SummarizeStepCall[];
	readonly gapFacts:      readonly RequiredFact[];
	/** Local provider -- summarisation is a local-tier turn. */
	readonly provider:      LLMProvider;
	/**
	 * Custom lookup for the verifier. Defaults to reading via the
	 * artifact-vec table + spill file. Tests inject an in-memory map.
	 */
	readonly artifactLookup?: ArtifactRawTextLookup | undefined;
}

export interface SummarizeStepResult {
	readonly summaries: readonly CitedStepSummary[];
	/** Whether the LLM retried (true when the first attempt had bad citations). */
	readonly retried:   boolean;
	/** When the second attempt also failed, lists why -- otherwise undefined. */
	readonly fallbackReason?: string | undefined;
}

export async function runSummarizeStep(input: SummarizeStepInput): Promise<SummarizeStepResult> {
	const validCallIds = new Set(input.calls.map(c => c.callId));
	const callIdToArtifactId = new Map<string, string>();
	for (const c of input.calls) { callIdToArtifactId.set(c.callId, c.artifactId); }
	const gapIdSet = new Set(input.gapFacts.map(g => g.id));

	const lookup: ArtifactRawTextLookup = input.artifactLookup
		?? (await import('./citation-verifier.js')).defaultArtifactRawTextLookup;

	const first = await callSummariser(input, false, undefined);
	const firstParsed = parse(first, validCallIds, gapIdSet);
	if (firstParsed.ok === false) {
		log.warn({ stepIntent: input.stepIntent, reason: firstParsed.reason },
			'summarize-step: first-attempt parse failed; retrying');
		return retry(input, validCallIds, gapIdSet, callIdToArtifactId, lookup, firstParsed.reason);
	}

	const firstResolved = substituteCallIds(firstParsed.value, callIdToArtifactId);
	const firstVerified = await verifyAll(firstResolved, lookup);
	if (firstVerified.allOk) {
		log.info({ stepIntent: input.stepIntent, callCount: firstResolved.length },
			'summarize-step: first-attempt verified');
		return { summaries: firstResolved, retried: false };
	}

	const firstReason = renderBadClaims(firstVerified.bads);
	log.warn({ stepIntent: input.stepIntent, badCount: firstVerified.bads.length },
		'summarize-step: first-attempt verification failed; retrying');
	return retry(input, validCallIds, gapIdSet, callIdToArtifactId, lookup, firstReason);
}

// ---------------------------------------------------------------------------
// Retry path
// ---------------------------------------------------------------------------

async function retry(
	input:                SummarizeStepInput,
	validCallIds:         ReadonlySet<string>,
	gapIdSet:             ReadonlySet<string>,
	callIdToArtifactId:   ReadonlyMap<string, string>,
	lookup:               ArtifactRawTextLookup,
	firstFailureReason:   string,
): Promise<SummarizeStepResult> {
	const second = await callSummariser(input, true, firstFailureReason);
	const secondParsed = parse(second, validCallIds, gapIdSet);
	if (secondParsed.ok === false) {
		log.warn({ stepIntent: input.stepIntent, reason: secondParsed.reason },
			'summarize-step: retry parse failed; falling back to synthetic empty summaries');
		return synthFallback(input, callIdToArtifactId, `retry parse failed: ${secondParsed.reason}`);
	}
	const secondResolved = substituteCallIds(secondParsed.value, callIdToArtifactId);
	const secondVerified = await verifyAll(secondResolved, lookup);
	if (secondVerified.allOk) {
		log.info({ stepIntent: input.stepIntent, callCount: secondResolved.length },
			'summarize-step: retry verified');
		return { summaries: secondResolved, retried: true };
	}
	log.warn({ stepIntent: input.stepIntent, badCount: secondVerified.bads.length },
		'summarize-step: retry verification failed; falling back to synthetic empty summaries');
	return synthFallback(input, callIdToArtifactId, `retry verification failed: ${renderBadClaims(secondVerified.bads)}`);
}

function synthFallback(
	input:              SummarizeStepInput,
	callIdToArtifactId: ReadonlyMap<string, string>,
	fallbackReason:     string,
): SummarizeStepResult {
	const summaries: CitedStepSummary[] = input.calls.map(c => ({
		callId:      c.callId,
		skillId:     c.skillId,
		artifactId:  callIdToArtifactId.get(c.callId) ?? c.artifactId,
		summary:     `[unverified summary -- citation verification failed; raw text preserved for downstream consumers] ${c.rawText.slice(0, 200).replace(/\s+/g, ' ').trim()}`,
		claims:      [],
		gapClosures: [],
	}));
	return { summaries, retried: true, fallbackReason };
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

async function callSummariser(
	input:              SummarizeStepInput,
	isRetry:            boolean,
	priorFailureReason: string | undefined,
): Promise<string> {
	const writer = getPromptRegistry().get<SummarizeStepWriterInput, readonly LLMMessage[]>('summarize-step');
	const writerCalls: SummarizeStepCallInput[] = input.calls.map(c => ({
		callId:  c.callId,
		skillId: c.skillId,
		context: c.context,
		rawText: c.rawText,
	}));
	const messages = [...writer.build({
		todoObjective:      input.todoObjective,
		stepIntent:         input.stepIntent,
		stepStatus:         input.stepStatus,
		calls:              writerCalls,
		gapFacts:           input.gapFacts,
		isRetry,
		priorFailureReason,
	})];
	const response = await input.provider.complete(messages, {
		maxTokens:       MAX_TOKENS,
		temperature:     0,
		responseFormat:  'json',
		disableThinking: true,
	});
	return response.text;
}

// ---------------------------------------------------------------------------
// Parse + structural validate
// ---------------------------------------------------------------------------

interface ParsedSummary {
	readonly callId:      string;
	readonly summary:     string;
	readonly claims:      readonly RawCitedClaim[];
	readonly gapClosures: readonly RawGapClosureClaim[];
}

interface RawCitedClaim {
	readonly claim:           string;
	readonly evidence:        'cited' | 'confirmed-null';
	readonly citations:       readonly { callId: string; span: string }[];
	readonly countAssertion?: number | undefined;
}

interface RawGapClosureClaim extends RawCitedClaim {
	readonly gapId:   string;
	readonly verdict: GapClosureVerdict;
}

type ParseResult =
	| { readonly ok: true;  readonly value: readonly ParsedSummary[] }
	| { readonly ok: false; readonly reason: string };

export function parse(
	raw:          string,
	validCallIds: ReadonlySet<string>,
	gapIdSet:     ReadonlySet<string>,
): ParseResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripFences(raw));
	} catch (err) {
		return { ok: false, reason: `JSON parse failed: ${(err as Error).message}` };
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { ok: false, reason: 'response must be a JSON object' };
	}
	const summariesRaw = (parsed as Record<string, unknown>)['summaries'];
	if (!Array.isArray(summariesRaw)) {
		return { ok: false, reason: '`summaries` must be an array' };
	}
	const out: ParsedSummary[] = [];
	for (let i = 0; i < summariesRaw.length; i++) {
		const s = coerceSummary(summariesRaw[i], i, validCallIds, gapIdSet);
		if (typeof s === 'string') { return { ok: false, reason: s }; }
		out.push(s);
	}
	return { ok: true, value: out };
}

function coerceSummary(
	raw:          unknown,
	idx:          number,
	validCallIds: ReadonlySet<string>,
	gapIdSet:     ReadonlySet<string>,
): ParsedSummary | string {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		return `summaries[${idx}] must be an object`;
	}
	const obj = raw as Record<string, unknown>;
	const callId = typeof obj['callId'] === 'string' ? (obj['callId'] as string).trim() : '';
	if (callId.length === 0)        { return `summaries[${idx}].callId must be a non-empty string`; }
	if (!validCallIds.has(callId)) { return `summaries[${idx}].callId "${callId}" is not one of the declared callIds`; }
	const summary = typeof obj['summary'] === 'string' ? (obj['summary'] as string).trim() : '';
	if (summary.length === 0)       { return `summaries[${idx}].summary must be a non-empty string`; }

	const claimsRaw = obj['claims'];
	if (!Array.isArray(claimsRaw)) { return `summaries[${idx}].claims must be an array`; }
	const claims: RawCitedClaim[] = [];
	for (let j = 0; j < claimsRaw.length; j++) {
		const c = coerceClaim(claimsRaw[j], `summaries[${idx}].claims[${j}]`, validCallIds);
		if (typeof c === 'string') { return c; }
		claims.push(c);
	}

	const closuresRaw = obj['gapClosures'];
	if (closuresRaw !== undefined && !Array.isArray(closuresRaw)) {
		return `summaries[${idx}].gapClosures must be an array when present`;
	}
	const gapClosures: RawGapClosureClaim[] = [];
	if (Array.isArray(closuresRaw)) {
		for (let j = 0; j < closuresRaw.length; j++) {
			const c = coerceGapClosure(closuresRaw[j], `summaries[${idx}].gapClosures[${j}]`, validCallIds, gapIdSet);
			if (typeof c === 'string') { return c; }
			if (c === null) { continue; } // unknown gapId silently dropped (lenient per Phase 1)
			gapClosures.push(c);
		}
	}

	return { callId, summary, claims, gapClosures };
}

function coerceClaim(
	raw:          unknown,
	path:         string,
	validCallIds: ReadonlySet<string>,
): RawCitedClaim | string {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		return `${path} must be an object`;
	}
	const obj = raw as Record<string, unknown>;
	const claim = typeof obj['claim'] === 'string' ? (obj['claim'] as string).trim() : '';
	if (claim.length === 0) { return `${path}.claim must be a non-empty string`; }
	const evidenceRaw = typeof obj['evidence'] === 'string' ? (obj['evidence'] as string).trim() : '';
	if (evidenceRaw !== 'cited' && evidenceRaw !== 'confirmed-null') {
		return `${path}.evidence must be "cited" or "confirmed-null"`;
	}
	const citationsRaw = obj['citations'];
	if (!Array.isArray(citationsRaw)) { return `${path}.citations must be an array`; }
	const cites: { callId: string; span: string }[] = [];
	for (let k = 0; k < citationsRaw.length; k++) {
		const cit = citationsRaw[k];
		if (cit === null || typeof cit !== 'object' || Array.isArray(cit)) {
			return `${path}.citations[${k}] must be an object`;
		}
		const co = cit as Record<string, unknown>;
		const callId = typeof co['callId'] === 'string' ? (co['callId'] as string).trim() : '';
		if (callId.length === 0)        { return `${path}.citations[${k}].callId must be a non-empty string`; }
		if (!validCallIds.has(callId)) { return `${path}.citations[${k}].callId "${callId}" is not one of the declared callIds`; }
		const span = typeof co['span'] === 'string' ? (co['span'] as string) : '';
		if (span.length === 0)          { return `${path}.citations[${k}].span must be a non-empty string`; }
		cites.push({ callId, span });
	}
	const result: RawCitedClaim = {
		claim,
		evidence:  evidenceRaw,
		citations: cites,
	};
	const countRaw = obj['countAssertion'];
	if (countRaw !== undefined) {
		if (typeof countRaw !== 'number' || !Number.isInteger(countRaw) || countRaw < 0) {
			return `${path}.countAssertion must be a non-negative integer when present`;
		}
		return { ...result, countAssertion: countRaw };
	}
	return result;
}

function coerceGapClosure(
	raw:          unknown,
	path:         string,
	validCallIds: ReadonlySet<string>,
	gapIdSet:     ReadonlySet<string>,
): RawGapClosureClaim | string | null {
	const base = coerceClaim(raw, path, validCallIds);
	if (typeof base === 'string') { return base; }
	const obj = raw as Record<string, unknown>;
	const gapId = typeof obj['gapId'] === 'string' ? (obj['gapId'] as string).trim() : '';
	if (gapId.length === 0) { return `${path}.gapId must be a non-empty string`; }
	if (!gapIdSet.has(gapId)) {
		log.warn({ path, gapId }, 'summarize-step: gap closure references unknown gap-id; dropping');
		return null;
	}
	const verdictRaw = typeof obj['verdict'] === 'string' ? (obj['verdict'] as string).trim() : '';
	if (verdictRaw !== 'closes' && verdictRaw !== 'partially' && verdictRaw !== 'off-topic') {
		return `${path}.verdict must be "closes", "partially", or "off-topic"`;
	}
	return { ...base, gapId, verdict: verdictRaw };
}

function stripFences(text: string): string {
	let out = text.trim();
	if (out.startsWith('```')) {
		out = out.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
	}
	return out.trim();
}

// ---------------------------------------------------------------------------
// Substitute callIds -> artifactIds (model-side -> system-side)
// ---------------------------------------------------------------------------

function substituteCallIds(
	parsed:             readonly ParsedSummary[],
	callIdToArtifactId: ReadonlyMap<string, string>,
): CitedStepSummary[] {
	const out: CitedStepSummary[] = [];
	for (const p of parsed) {
		const artifactId = callIdToArtifactId.get(p.callId)!;
		const claims: CitedClaim[] = p.claims.map(c => toCitedClaim(c, callIdToArtifactId));
		const gapClosures: GapClosureClaim[] = p.gapClosures.map(c => ({
			...toCitedClaim(c, callIdToArtifactId),
			gapId:   c.gapId,
			verdict: c.verdict,
		}));
		out.push({
			callId:     p.callId,
			skillId:    '', // filled in by orchestrator from execRes; not surfaced by the LLM
			artifactId,
			summary:    p.summary,
			claims,
			gapClosures,
		});
	}
	return out;
}

function toCitedClaim(
	raw:                RawCitedClaim,
	callIdToArtifactId: ReadonlyMap<string, string>,
): CitedClaim {
	const citations: Citation[] = raw.citations.map(c => ({
		artifactId: callIdToArtifactId.get(c.callId) ?? c.callId, // unknown callId stays as-is; verifier will flag
		span:       c.span,
	}));
	const base: CitedClaim = {
		claim:     raw.claim,
		evidence:  raw.evidence,
		citations,
	};
	if (raw.countAssertion !== undefined) {
		return { ...base, countAssertion: raw.countAssertion };
	}
	return base;
}

// ---------------------------------------------------------------------------
// Verify all summaries (one verifier call per summary)
// ---------------------------------------------------------------------------

interface VerifyAllResult {
	readonly allOk: boolean;
	readonly bads:  readonly BadClaim[];
}

async function verifyAll(
	summaries: readonly CitedStepSummary[],
	lookup:    ArtifactRawTextLookup,
): Promise<VerifyAllResult> {
	const bads: BadClaim[] = [];
	for (const s of summaries) {
		const r = await verifyCitedSummary(s, lookup);
		if (r.ok === false) {
			for (const b of r.badClaims) { bads.push(b); }
		}
	}
	return { allOk: bads.length === 0, bads };
}

function renderBadClaims(bads: readonly BadClaim[]): string {
	const lines: string[] = [];
	for (let i = 0; i < bads.length && i < 8; i++) {
		const b = bads[i]!;
		const gapTag = b.gapId !== undefined ? ` [gap=${b.gapId}]` : '';
		lines.push(`  - "${b.claimText.slice(0, 100)}"${gapTag}: ${b.reason}`);
	}
	if (bads.length > 8) { lines.push(`  ...and ${bads.length - 8} more`); }
	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _parseForTest             = parse;
export const _stripFencesForTest       = stripFences;
export const _substituteCallIdsForTest = substituteCallIds;
export const _renderBadClaimsForTest   = renderBadClaims;
