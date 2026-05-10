/**
 * Intent resolver -- Phase 1 of plans/conversation-flow-refinement.md.
 *
 * Resolves the intent of an incoming user message using a tiered
 * strategy:
 *
 *   1. **Tag reuse** -- if `[intent:current]` is set and the message
 *      shape suggests a continuation of the prior turn (short, anaphoric
 *      ("show me X", "what about Y"), or invoking nouns from the prior
 *      facts cache), reuse the tag without an LLM call.
 *
 *   2. **Fresh classification** -- otherwise run the generic
 *      `classifyPrimaryIntent` against the active session. Compares
 *      to the prior tag (if any) and flags a shift via `source:
 *      'classified-shifted'`. This is what callers use to decide
 *      whether to mine cross-intent correlation in the question
 *      enhancer (Phase 5).
 *
 * The tag itself lives in `ContextManager.tags` (eviction-resistant:
 * the body is in-memory + the tag-name appears in the L2 summary
 * after eviction). Phase 1 only reads + writes it; the broader
 * conversation-flow plan extends the tag-set in subsequent phases.
 *
 * Provider: cloud-small via `resolveClassifierProvider` (same path
 * `classifyPrimaryIntent` already uses; cloud cost is bounded to
 * one call per turn even on the cold path).
 */

import { getLogger } from '../../shared/logger.js';
import { classifyPrimaryIntent } from '../classify/intent.js';
import type { Session } from '../session.js';
import type { Intent } from '../../shared/types.js';

const log = getLogger('intent-resolver');

// ---------------------------------------------------------------------------
// Tag identifiers (single source of truth so other modules can read the
// same slot). Co-located here because the resolver owns the
// write-side; future phases (priorContext mining, enhancer) read.
// ---------------------------------------------------------------------------

export const INTENT_TAG_CURRENT       = '[intent:current]';
export const INTENT_TAG_TIMESTAMP     = '[intent:current.timestamp]';
export const INTENT_TAG_LAST_RESOLVED = '[intent:last.resolution]';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ResolvedIntent {
	readonly id:               Intent;
	readonly source:           'tag' | 'classified-fresh' | 'classified-shifted';
	readonly previousIntent?:  Intent | undefined;
	readonly confidence:       'high' | 'medium' | 'low';
	/** One-sentence explanation surfaced for telemetry / debug logs. */
	readonly reasoning:        string;
	/** Message text after prefix-stripping (mirrors classifyPrimaryIntent). */
	readonly message:          string;
}

/**
 * Resolve the intent of an incoming user message. Cheap path uses
 * the [intent:current] tag + a "looks like a continuation" heuristic;
 * cold path falls through to the LLM.
 *
 * Stamps `[intent:current]` + `[intent:current.timestamp]` on the
 * session's ContextManager so the next call benefits from the result.
 * Records a structured `[intent:last.resolution]` blob for telemetry.
 */
export async function resolveIntent(
	session: Session,
	rawMessage: string,
): Promise<ResolvedIntent> {
	const ctx     = session.contextManager;
	const priorId = readIntentTag(session);

	// Fast path: prior intent + continuation-shaped follow-up.
	if (priorId !== undefined && looksLikeContinuation(rawMessage)) {
		const resolved: ResolvedIntent = {
			id:              priorId,
			source:          'tag',
			confidence:      'high',
			reasoning:       'continuation-shaped follow-up; reusing prior intent tag',
			message:         rawMessage.trim(),
		};
		stampIntentTags(session, resolved, priorId);
		log.info({ id: resolved.id, source: resolved.source }, 'intent resolved (tag reuse)');
		return resolved;
	}

	// Cold path: call the LLM classifier.
	const classified = await classifyPrimaryIntent(rawMessage, session);
	const newId      = classified.intent;
	const previous   = priorId;

	let source: ResolvedIntent['source'];
	if (previous === undefined)            source = 'classified-fresh';
	else if (previous !== newId)           source = 'classified-shifted';
	else                                   source = 'classified-fresh';

	const confidence = classified.fallback
		? 'low'
		: classified.confidence >= 0.85 ? 'high'
			: classified.confidence >= 0.6 ? 'medium'
				: 'low';

	const resolved: ResolvedIntent = {
		id:              newId,
		source,
		confidence,
		reasoning:       classified.reasoning || 'LLM classifier',
		message:         classified.message,
		...(previous !== undefined ? { previousIntent: previous } : {}),
	};
	void ctx; // ContextManager mutation lives in stampIntentTags below
	stampIntentTags(session, resolved, previous);

	log.info(
		{
			id:        resolved.id,
			source:    resolved.source,
			previous:  resolved.previousIntent,
			confidence: resolved.confidence,
		},
		'intent resolved (LLM)',
	);
	return resolved;
}

// ---------------------------------------------------------------------------
// Tag read / write
// ---------------------------------------------------------------------------

function readIntentTag(session: Session): Intent | undefined {
	const v = session.contextManager.getTag(INTENT_TAG_CURRENT);
	return v.length > 0 ? (v as Intent) : undefined;
}

function stampIntentTags(
	session: Session,
	resolved: ResolvedIntent,
	previousId: Intent | undefined,
): void {
	const ctx = session.contextManager;
	ctx.setTag(INTENT_TAG_CURRENT,   resolved.id);
	ctx.setTag(INTENT_TAG_TIMESTAMP, String(Date.now()));
	const summary = JSON.stringify({
		id:               resolved.id,
		source:           resolved.source,
		confidence:       resolved.confidence,
		previousIntent:   previousId ?? null,
		ts:               Date.now(),
	});
	ctx.setTag(INTENT_TAG_LAST_RESOLVED, summary);
}

// ---------------------------------------------------------------------------
// Continuation heuristic
// ---------------------------------------------------------------------------

const CONTINUATION_LEAD = /^(?:now|then|next|also|and|so|what about|how about|tell me about|show me|describe|drill into|what does|why does|why is|why|how|where|which)\b/i;

const ANAPHORIC_TOKEN = /\b(?:it|its|that|this|those|these|the same|same|previous|last(?:\s+one)?|above|before|earlier|prior|here)\b/i;

const SHORT_LENGTH_LIMIT = 120;

/**
 * True when a message looks like a follow-up to the prior turn -- the
 * sort of brief, anaphoric phrasing the user types after reading the
 * prior report ("now show me HDFS Core", "what about the orders
 * table", "drill into that"). False for self-contained requests
 * ("describe the YARN package and its callers"), command-shaped
 * inputs (`/code-analyze ...`), or anything long enough that it's
 * obviously a fresh ask.
 *
 * Signals (any one fires):
 *   - starts with `/` (slash command -- never a continuation in this
 *     sense; the dispatcher handles command parsing separately)
 *   - >  SHORT_LENGTH_LIMIT chars and not anaphoric
 *   - contains an anaphoric token AND <= SHORT_LENGTH_LIMIT chars
 *   - starts with a continuation lead-in token AND <= SHORT_LENGTH_LIMIT chars
 *
 * This is a heuristic. False positives (treating a fresh ask as a
 * continuation) are bounded: the wrong intent gets reused, but the
 * downstream pipeline still runs and produces a real result -- the
 * user just sees "interpreted as code-analysis" or similar in the
 * telemetry. False negatives (treating a continuation as fresh) cost
 * one extra LLM classifier call. Either way, the chat flow still
 * works.
 */
export function looksLikeContinuation(rawMessage: string): boolean {
	const text = rawMessage.trim();
	if (text.startsWith('/')) return false;
	if (text.length === 0)    return false;

	const isShort       = text.length <= SHORT_LENGTH_LIMIT;
	const hasAnaphora   = ANAPHORIC_TOKEN.test(text);
	const hasLeadIn     = CONTINUATION_LEAD.test(text);

	if (hasAnaphora && isShort) return true;
	if (hasLeadIn   && isShort) return true;
	return false;
}
