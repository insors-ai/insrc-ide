/**
 * reviewDataClaimsGrounding -- per-claim evidence-grounding pass for
 * the data analyzer (Phase E of plans/analyzers/data-analyzer-parity.md).
 *
 * Mirrors agent/tasks/code-analyzer/claim-grounding-reviewer.ts. One
 * cloud LLM call per task. The reviewer sees:
 *   - the task's answer prose (markdown)
 *   - the evidence ledger's facts (concatenated, numbered)
 * and returns per-claim `evidenceMatch` scores.
 *
 * Caller policy:
 *   - any claim with score `low` -> verdict: 'redraft'
 *   - notes carry the un-grounded claims for the redraft prompt
 *   - provider errors / schema violations -> soft-accept (this is a
 *     safety net, not a hard gate; flakiness must not block the
 *     report)
 *
 * Bakes in DA-A1 from plans/analyzers/data-analyzer-parity.md: the
 * reviewer system prompt explicitly tells the LLM to score claims of
 * the form "X was not found / no Y / missing Z" as `low` when X / Y /
 * Z don't appear verbatim in the evidence -- catching writer-side
 * fabricated "not found" footnotes.
 */

import type { LLMProvider, LLMMessage } from '../../../shared/types.js';
import { getLogger } from '../../../shared/logger.js';
import type { DataAnalysisTask, DataEvidenceEntry } from './types.js';

const log = getLogger('data-analyzer:claim-grounding');

const MAX_ATTEMPTS = 2;
const DEFAULT_MAX_TOKENS = 1200;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DataClaimGroundingScore = 'high' | 'medium' | 'low';

export interface DataClaimGroundingItem {
	readonly text:           string;
	readonly evidenceMatch:  DataClaimGroundingScore;
}

export interface DataClaimGroundingResponse {
	readonly claims:  readonly DataClaimGroundingItem[];
	readonly verdict: 'accept' | 'redraft';
	readonly notes:   readonly string[];
}

export interface DataClaimGroundingInput {
	readonly task:       DataAnalysisTask;
	readonly prose:      string;
	readonly evidence:   readonly DataEvidenceEntry[];
	readonly maxTokens?: number | undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function reviewDataClaimsGrounding(
	input:         DataClaimGroundingInput,
	cloudProvider: LLMProvider,
): Promise<DataClaimGroundingResponse> {
	const messages = buildClaimGroundingMessages(input);

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			const response = await cloudProvider.complete(messages, {
				maxTokens:      input.maxTokens ?? DEFAULT_MAX_TOKENS,
				temperature:    0,
				responseFormat: { schema: DATA_CLAIM_GROUNDING_SCHEMA },
			});
			const parsed = parseJsonStrict(response.text);
			if (parsed === null) {
				if (attempt === MAX_ATTEMPTS) break;
				continue;
			}
			const validated = validateClaimGrounding(parsed);
			if (typeof validated === 'string') {
				log.info(
					{ itemId: input.task.itemId, attempt, reason: validated },
					'reviewDataClaimsGrounding: schema violation; retrying',
				);
				if (attempt === MAX_ATTEMPTS) break;
				continue;
			}
			// Caller policy: low scores escalate to redraft.
			const lowClaims = validated.claims.filter(c => c.evidenceMatch === 'low');
			const verdict: 'accept' | 'redraft' = lowClaims.length > 0 ? 'redraft' : 'accept';
			const notes: string[] = [...validated.notes];
			if (verdict === 'redraft') {
				notes.unshift(
					`Claim-grounding review flagged ${lowClaims.length} claim(s) without sufficient evidence backing. Rewrite to either (a) anchor each flagged claim to a citation in the ledger, or (b) remove it.`,
				);
				for (let i = 0; i < Math.min(lowClaims.length, 4); i++) {
					notes.push(`  - un-grounded claim: "${lowClaims[i]!.text}"`);
				}
				if (lowClaims.length > 4) {
					notes.push(`  - ...and ${lowClaims.length - 4} more`);
				}
			}
			return { claims: validated.claims, verdict, notes };
		} catch (err) {
			log.warn(
				{ itemId: input.task.itemId, attempt, err: (err as Error).message },
				'reviewDataClaimsGrounding: provider error',
			);
			if (attempt === MAX_ATTEMPTS) break;
		}
	}

	log.warn(
		{ itemId: input.task.itemId },
		'reviewDataClaimsGrounding: all attempts failed -- soft-accepting',
	);
	return { claims: [], verdict: 'accept', notes: ['claim-grounding-degraded; soft-accepted'] };
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

function buildClaimGroundingMessages(input: DataClaimGroundingInput): LLMMessage[] {
	const system = [
		'You are reviewing whether each factual claim in a data-analysis prose',
		'response is anchored to the evidence ledger that produced it.',
		'',
		'For each distinct factual claim in the prose, output an item with:',
		'  - text: the claim verbatim (1-2 sentences, trimmed)',
		'  - evidenceMatch: high | medium | low',
		'      high   = claim is directly supported by an evidence fact (or its',
		'               numeric facts)',
		'      medium = claim is plausibly implied by the evidence but not',
		'               literally stated',
		'      low    = claim has NO anchor in the evidence facts -- treat as',
		'               un-grounded',
		'',
		'DA-A1 hard rule (data-analyzer-parity.md Phase E):',
		'  Claims of the form "X was not found", "no Y", "missing Z", or any',
		'  other NEGATION naming a specific identifier MUST score `low` unless',
		'  that identifier (X / Y / Z) appears VERBATIM in at least one evidence',
		'  fact. The writer is forbidden from fabricating "not found" footnotes;',
		'  this review catches violations.',
		'',
		'Be willing to score `low`. The downstream redraft is cheap; an un-',
		'flagged hallucinated claim is expensive (it ships in the report).',
		'',
		'Output STRICT JSON matching the response schema. No fences, no prose.',
	].join('\n');

	const userLines: string[] = [];
	userLines.push('## Task under review');
	userLines.push(`question: ${input.task.question}`);
	userLines.push(`kind:     ${input.task.kind}`);
	userLines.push('');
	userLines.push('## Prose (markdown)');
	userLines.push('```markdown');
	userLines.push(input.prose);
	userLines.push('```');
	userLines.push('');
	userLines.push('## Evidence ledger facts');
	if (input.evidence.length === 0) {
		userLines.push('_(empty -- any factual claim in the prose is un-grounded)_');
	} else {
		let globalIdx = 1;
		let any = false;
		for (const e of input.evidence) {
			for (const f of e.facts) {
				userLines.push(`  ${globalIdx}. ${f}`);
				globalIdx++;
				any = true;
			}
			if (e.numericFacts !== undefined) {
				for (const nf of e.numericFacts) {
					userLines.push(`  ${globalIdx}. ${nf.name} = ${nf.value}${nf.unit ? ' ' + nf.unit : ''}`);
					globalIdx++;
					any = true;
				}
			}
		}
		if (!any) {
			userLines.push('_(evidence entries present but contained no facts)_');
		}
	}
	userLines.push('');
	userLines.push('## Response schema');
	userLines.push('```json');
	userLines.push(JSON.stringify(DATA_CLAIM_GROUNDING_SCHEMA, null, 2));
	userLines.push('```');

	return [
		{ role: 'system', content: system },
		{ role: 'user',   content: userLines.join('\n') },
	];
}

// ---------------------------------------------------------------------------
// Response schema + validator
// ---------------------------------------------------------------------------

const DATA_CLAIM_GROUNDING_SCHEMA: Record<string, unknown> = {
	type: 'object',
	required: ['claims', 'notes'],
	additionalProperties: false,
	properties: {
		claims: {
			type:     'array',
			maxItems: 24,
			items: {
				type: 'object',
				required: ['text', 'evidenceMatch'],
				additionalProperties: false,
				properties: {
					text:          { type: 'string', minLength: 1, maxLength: 400 },
					evidenceMatch: { type: 'string', enum: ['high', 'medium', 'low'] },
				},
			},
		},
		notes: {
			type:     'array',
			maxItems: 6,
			items:    { type: 'string', minLength: 1, maxLength: 240 },
		},
	},
};

interface ValidatedGrounding {
	readonly claims: readonly DataClaimGroundingItem[];
	readonly notes:  readonly string[];
}

function validateClaimGrounding(raw: unknown): ValidatedGrounding | string {
	if (typeof raw !== 'object' || raw === null) return 'response is not an object';
	const o = raw as Record<string, unknown>;
	const claimsRaw = o['claims'];
	const notesRaw  = o['notes'];
	if (!Array.isArray(claimsRaw)) return 'claims field is missing or not an array';
	if (!Array.isArray(notesRaw))  return 'notes field is missing or not an array';
	const claims: DataClaimGroundingItem[] = [];
	for (const c of claimsRaw) {
		if (typeof c !== 'object' || c === null) continue;
		const co = c as Record<string, unknown>;
		const text = co['text'];
		const match = co['evidenceMatch'];
		if (typeof text !== 'string' || text.length === 0) continue;
		if (match !== 'high' && match !== 'medium' && match !== 'low') continue;
		claims.push({ text: text.slice(0, 400), evidenceMatch: match });
	}
	const notes: string[] = notesRaw
		.filter((n: unknown): n is string => typeof n === 'string' && n.length > 0)
		.slice(0, 6);
	return { claims, notes };
}

function parseJsonStrict(raw: string): unknown {
	let s = raw.trim();
	if (s.startsWith('```')) {
		s = s.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
	}
	try { return JSON.parse(s); } catch { return null; }
}

// Test exports.
export const _validateClaimGroundingForTest = validateClaimGrounding;
export const _parseJsonStrictForTest        = parseJsonStrict;
