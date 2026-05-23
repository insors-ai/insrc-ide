/**
 * Phase 11.B of plans/code-analyzer-hallucination-mitigation.md.
 *
 * Reviewer pass that scores how well each factual claim in the
 * section's prose is backed by an EvidenceEntry from the gather
 * phase. Catches Category C hallucinations -- authoritative-sounding
 * "color" claims the writer adds as filler that have no anchor in
 * the evidence ledger.
 *
 * Mechanism: a single cloud call per section. The cloud sees:
 *   - the section prose
 *   - the EvidenceEntry array's facts (concatenated as a numbered
 *     "evidence facts" block)
 * It returns:
 *   - extracted claims with a per-claim evidenceMatch score
 *   - any claim scoring 'low' indicates an un-grounded statement
 *
 * Caller policy (discovery-flow):
 *   - any 'low' score AND the existing prose-review verdict was
 *     'accept' -> override to 'redraft' with the offending claims as
 *     `notes` for the redraft prompt.
 *   - 'medium' scores are not overrides (some claims are implied
 *     rather than literally stated).
 */

import type { LLMProvider, LLMMessage } from '../../../shared/types.js';
import type { PlannedAction } from '../../content-gen/plan-actions.js';
import { loadFlowPrompt } from './prompts/loader.js';
import type { EvidenceEntry } from './summarize-result.js';
import { getLogger } from '../../../shared/logger.js';

// Local JSON parser -- mirrors `discovery-plan-actions.ts`'s helper.
// Kept private to avoid coupling the two modules through an internal
// export.
function parseJsonStrict(raw: string): unknown {
	let s = raw.trim();
	if (s.startsWith('```')) {
		s = s.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
	}
	try { return JSON.parse(s); } catch { return null; }
}

const log = getLogger('code-analyzer:claim-grounding');

const MAX_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ClaimGroundingScore = 'high' | 'medium' | 'low';

export interface ClaimGroundingItem {
	readonly text:           string;
	readonly evidenceMatch:  ClaimGroundingScore;
}

export interface ClaimGroundingResponse {
	readonly claims:    readonly ClaimGroundingItem[];
	readonly verdict:   'accept' | 'redraft';
	readonly notes:     readonly string[];
}

export interface ClaimGroundingInput {
	readonly section:        PlannedAction;
	readonly prose:          string;
	readonly evidence:       readonly EvidenceEntry[];
	readonly analyzerLabel?: string | undefined;
	readonly maxTokens?:     number | undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the claim-grounding pass. Soft-accepts on provider error or
 * schema violation -- this reviewer is a safety net, not a hard
 * gate; flakiness must not block the report.
 */
export async function reviewClaimsGrounding(
	input:         ClaimGroundingInput,
	cloudProvider: LLMProvider,
): Promise<ClaimGroundingResponse> {
	const messages = buildClaimGroundingMessages(input);

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			const response = await cloudProvider.complete(messages, {
				maxTokens:      input.maxTokens ?? 1200,
				temperature:    0,
				responseFormat: { schema: CLAIM_GROUNDING_SCHEMA as Record<string, unknown> },
			});
			const parsed = parseJsonStrict(response.text);
			if (parsed === null) {
				if (attempt === MAX_ATTEMPTS) break;
				continue;
			}
			const validated = validateClaimGrounding(parsed);
			if (typeof validated === 'string') {
				log.info(
					{ analyzer: input.analyzerLabel, attempt, reason: validated },
					'reviewClaimsGrounding: schema violation; retrying',
				);
				if (attempt === MAX_ATTEMPTS) break;
				continue;
			}
			// Caller policy enforced here: low scores escalate to redraft.
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
				{ analyzer: input.analyzerLabel, attempt, err: (err as Error).message },
				'reviewClaimsGrounding: provider error',
			);
			if (attempt === MAX_ATTEMPTS) break;
		}
	}

	log.warn(
		{ analyzer: input.analyzerLabel, sectionId: input.section.id },
		'reviewClaimsGrounding: all attempts failed -- soft-accepting',
	);
	return { claims: [], verdict: 'accept', notes: ['claim-grounding-degraded; soft-accepted'] };
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

function buildClaimGroundingMessages(input: ClaimGroundingInput): LLMMessage[] {
	const system = loadFlowPrompt('claim-grounding', {});

	const userLines: string[] = [];
	userLines.push('## Section under review');
	userLines.push(`title:     ${input.section.title}`);
	userLines.push(`objective: ${input.section.objective}`);
	userLines.push('');
	userLines.push('## Section prose (markdown)');
	userLines.push('```markdown');
	userLines.push(input.prose);
	userLines.push('```');
	userLines.push('');
	userLines.push('## Evidence ledger facts');
	if (input.evidence.length === 0) {
		userLines.push('_(empty -- any factual claim in the prose is un-grounded)_');
	} else {
		let globalIdx = 1;
		for (const e of input.evidence) {
			for (const f of e.facts) {
				userLines.push(`  ${globalIdx}. ${f}`);
				globalIdx++;
			}
		}
		if (globalIdx === 1) {
			userLines.push('_(evidence entries present but contained no facts)_');
		}
	}
	userLines.push('');
	userLines.push('Respond with strict JSON matching the schema. No markdown fences.');
	return [
		{ role: 'system', content: system },
		{ role: 'user',   content: userLines.join('\n') },
	];
}

// ---------------------------------------------------------------------------
// Response schema + validator
// ---------------------------------------------------------------------------

const CLAIM_GROUNDING_SCHEMA = {
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
					text: { type: 'string', minLength: 1, maxLength: 400 },
					evidenceMatch: { type: 'string', enum: ['high', 'medium', 'low'] },
				},
			},
		},
		notes: {
			type:     'array',
			maxItems: 6,
			items: { type: 'string', minLength: 1, maxLength: 240 },
		},
	},
} as const;

interface RawClaimGrounding {
	readonly claims: readonly { readonly text: string; readonly evidenceMatch: ClaimGroundingScore }[];
	readonly notes:  readonly string[];
}

function validateClaimGrounding(value: unknown): RawClaimGrounding | string {
	if (typeof value !== 'object' || value === null) return 'not an object';
	const v = value as Record<string, unknown>;
	if (!Array.isArray(v.claims)) return 'claims is not an array';
	if (!Array.isArray(v.notes)) return 'notes is not an array';
	const claims: { text: string; evidenceMatch: ClaimGroundingScore }[] = [];
	for (let i = 0; i < v.claims.length; i++) {
		const c = v.claims[i];
		if (typeof c !== 'object' || c === null) return `claims[${i}] not an object`;
		const cr = c as Record<string, unknown>;
		if (typeof cr.text !== 'string' || cr.text.length === 0) return `claims[${i}].text invalid`;
		if (cr.evidenceMatch !== 'high' && cr.evidenceMatch !== 'medium' && cr.evidenceMatch !== 'low') {
			return `claims[${i}].evidenceMatch invalid`;
		}
		claims.push({ text: cr.text, evidenceMatch: cr.evidenceMatch });
	}
	const notes: string[] = [];
	for (let i = 0; i < v.notes.length; i++) {
		const n = v.notes[i];
		if (typeof n !== 'string' || n.length === 0) return `notes[${i}] invalid`;
		notes.push(n);
	}
	return { claims, notes };
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

export const _buildClaimGroundingMessagesForTest = buildClaimGroundingMessages;
export const _validateClaimGroundingForTest      = validateClaimGrounding;
