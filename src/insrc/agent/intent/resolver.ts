/**
 * Intent resolver -- the SOLE entry point for picking an Intent for a
 * user message. Per `plans/intent-classification-consolidation.md`,
 * every chat path (regular, slash-forced, /intent override, resume,
 * re-run) must call this function. No other module classifies intent.
 *
 * Resolution order (first match wins; only the cold path runs an LLM):
 *
 *   1. **Slash-forced** (`opts.slashForced`) -- the chat-handler's
 *      family-direct slashes (`/code-analyze`, `/data-analyze`) and
 *      the intent-slash shortcuts (`/design`, `/plan`, etc.) tell us
 *      the intent up front. We synthesize a high-confidence
 *      `ResolvedIntent { source: 'slash-forced' }` and stamp the tag
 *      so the next turn's fast-path can reuse it.
 *
 *   2. **Explicit override** (`opts.explicitOverride` OR `/intent
 *      <name>` parsed off the raw message). Same treatment as
 *      slash-forced but tagged `source: 'override'`. Prefix parsing
 *      is absorbed here so callers no longer need to call
 *      `parsePrefix` separately.
 *
 *   3. **Tag reuse** -- if `[intent:current]` is set and the message
 *      shape suggests a continuation (short, anaphoric, or starts
 *      with a continuation lead-in), reuse the prior tag with no
 *      LLM call. `source: 'tag'`.
 *
 *   4. **Cold classification** -- run `classifyPrimaryIntent`
 *      against the active session. Compares to the prior tag and
 *      flags `source: 'classified-shifted'` when the LLM picks a
 *      different intent than the prior tag (vs `'classified-fresh'`
 *      when the tag was empty or the LLM confirmed the prior).
 *
 * The tag itself lives in `ContextManager.tags` (eviction-resistant:
 * the body is in-memory + the tag-name appears in the L2 summary
 * after eviction). Future phases hang the memory-augmented context
 * + relationship enum off the cold path; the public surface stays
 * the same.
 *
 * Provider: cloud-small via `resolveClassifierProvider` (same path
 * `classifyPrimaryIntent` already uses; cloud cost is bounded to
 * one call per turn even on the cold path).
 */

import { getLogger } from '../../shared/logger.js';
import { classifyPrimaryIntent } from '../classify/intent.js';
import { parsePrefix } from '../prefix.js';
import { retrieveClassifierMemory, type ClassifierMemory } from './classifier-memory.js';
import type { RelationshipKind } from './relationship.js';
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
	readonly source:
		| 'slash-forced'         // chat-handler family-direct or intent-slash
		| 'override'             // /intent <name> or opts.explicitOverride
		| 'tag'                  // continuation heuristic + prior tag reuse
		| 'classified-fresh'     // cold LLM classify, no prior tag (or LLM confirmed prior)
		| 'classified-shifted';  // cold LLM classify, intent shifted from prior
	readonly previousIntent?:  Intent | undefined;
	readonly confidence:       'high' | 'medium' | 'low';
	/** One-sentence explanation surfaced for telemetry / debug logs. */
	readonly reasoning:        string;
	/** Message text after prefix-stripping (mirrors classifyPrimaryIntent). */
	readonly message:          string;
	/**
	 * Typed relationship to prior session activity. Always present
	 * on the cold path (defaults to `{ kind: 'NEW' }` when memory
	 * was empty); always `undefined` on slash-forced / override /
	 * tag-reuse paths (they short-circuit before memory retrieval
	 * runs).
	 */
	readonly relationship?:    IntentRelationship | undefined;
}

/**
 * Memory-citation backed relationship classification. Distinct from
 * `ResolvedIntent.source`: `source` describes HOW the resolver picked
 * this intent; `relationship` describes how this prompt relates to
 * prior conversation activity. Citations point back to the specific
 * turns / response segments the classifier leaned on.
 */
export interface IntentRelationship {
	readonly kind:        RelationshipKind;
	readonly confidence:  'high' | 'medium' | 'low';
	readonly reasoning:   string;
	readonly citations:   readonly MemoryCitation[];   // 0..N items
}

export interface MemoryCitation {
	readonly kind:        'turn' | 'segment';
	readonly id:          string;     // turnId or segmentId
	readonly excerpt:     string;     // ≤240 chars (turn) / ≤800 chars (segment)
	readonly recencyRank: number;     // 1 = most recent
	readonly relevance:   number;     // 0..1 ANN relevance
}

/**
 * Caller-provided overrides. The chat-handler's slash dispatchers
 * use `slashForced`; programmatic call sites that already know the
 * user wants a specific intent (replays, reruns, /intent <name>
 * pre-parsed by some other layer) use `explicitOverride`.
 *
 * Both bypass the LLM classifier and the continuation heuristic but
 * still flow through `resolveIntent` so the `[intent:current]` tag
 * gets stamped exactly once per turn -- which is what makes the
 * next turn's tag-reuse fast path work.
 */
export interface ResolveIntentOpts {
	/** Slash-forced intent: skip classifier; stamp tag with this id. */
	readonly slashForced?:      Intent | undefined;
	/** Explicit override: skip classifier; stamp tag with this id. */
	readonly explicitOverride?: Intent | undefined;
	/**
	 * Test-only override of the classifier-memory retrieval. Returns
	 * the bundle the cold path would normally retrieve. Production
	 * callers leave unset and pick up `retrieveClassifierMemory` with
	 * the default Ollama-backed embedder.
	 */
	readonly memoryOverride?:   ClassifierMemory | undefined;
}

/**
 * Resolve the intent of an incoming user message. Slash / override
 * paths short-circuit; tag-reuse path is cheap; cold path runs the
 * LLM classifier exactly once.
 *
 * Stamps `[intent:current]` + `[intent:current.timestamp]` on the
 * session's ContextManager so the next call benefits from the result.
 * Records a structured `[intent:last.resolution]` blob for telemetry.
 */
export async function resolveIntent(
	session: Session,
	rawMessage: string,
	opts?: ResolveIntentOpts,
): Promise<ResolvedIntent> {
	const priorId = readIntentTag(session);

	// 1. Slash-forced (chat-handler dispatch). Highest precedence:
	//    we already know the intent, no parsing or LLM needed.
	if (opts?.slashForced !== undefined) {
		const resolved: ResolvedIntent = {
			id:         opts.slashForced,
			source:     'slash-forced',
			confidence: 'high',
			reasoning:  'forced by slash command',
			message:    rawMessage.trim(),
			...(priorId !== undefined ? { previousIntent: priorId } : {}),
		};
		stampIntentTags(session, resolved, priorId);
		log.info(
			{ id: resolved.id, source: resolved.source, previous: priorId },
			'intent resolved (slash-forced)',
		);
		return resolved;
	}

	// 2. Explicit override (programmatic) OR `/intent <name>` parsed
	//    off the raw message. Both produce `source: 'override'`.
	const prefix = parsePrefix(rawMessage);
	const overrideId = opts?.explicitOverride ?? prefix.intentOverride;
	if (overrideId !== undefined) {
		const resolved: ResolvedIntent = {
			id:         overrideId,
			source:     'override',
			confidence: 'high',
			reasoning:  opts?.explicitOverride !== undefined
				? 'explicit override by caller'
				: 'explicit /intent override',
			message:    prefix.message,
			...(priorId !== undefined ? { previousIntent: priorId } : {}),
		};
		stampIntentTags(session, resolved, priorId);
		log.info(
			{ id: resolved.id, source: resolved.source, previous: priorId },
			'intent resolved (override)',
		);
		return resolved;
	}

	// 3. Tag reuse: prior intent + continuation-shaped follow-up.
	//    Operate on the prefix-stripped message so a leading
	//    `@<provider>` doesn't defeat the continuation heuristic.
	if (priorId !== undefined && looksLikeContinuation(prefix.message)) {
		const resolved: ResolvedIntent = {
			id:         priorId,
			source:     'tag',
			confidence: 'high',
			reasoning:  'continuation-shaped follow-up; reusing prior intent tag',
			message:    prefix.message,
		};
		stampIntentTags(session, resolved, priorId);
		log.info({ id: resolved.id, source: resolved.source }, 'intent resolved (tag reuse)');
		return resolved;
	}

	// 4. Cold path: pull memory + call the LLM classifier with it.
	//    classifyPrimaryIntent re-parses prefixes internally; that's
	//    idempotent (running parsePrefix on already-stripped text is a
	//    no-op) so we keep passing the raw message until Phase 7
	//    privatises it.
	const memory: ClassifierMemory = opts?.memoryOverride
		?? await retrieveClassifierMemory(session, prefix.message);

	const classified = await classifyPrimaryIntent(rawMessage, session, memory);
	const newId      = classified.intent;
	const previous   = priorId;

	let source: ResolvedIntent['source'];
	if (previous === undefined)  source = 'classified-fresh';
	else if (previous !== newId) source = 'classified-shifted';
	else                         source = 'classified-fresh';

	const confidence = classified.fallback
		? 'low'
		: classified.confidence >= 0.85 ? 'high'
			: classified.confidence >= 0.6 ? 'medium'
				: 'low';

	const relationship = hydrateRelationshipCitations(classified.relationship, memory);

	const resolved: ResolvedIntent = {
		id:         newId,
		source,
		confidence,
		reasoning:  classified.reasoning || 'LLM classifier',
		message:    classified.message,
		...(previous !== undefined ? { previousIntent: previous } : {}),
		...(relationship !== undefined ? { relationship } : {}),
	};
	stampIntentTags(session, resolved, previous);

	log.info(
		{
			id:         resolved.id,
			source:     resolved.source,
			previous:   resolved.previousIntent,
			confidence: resolved.confidence,
			relationship: relationship?.kind,
			citations:    relationship?.citations.length ?? 0,
		},
		'intent resolved (LLM)',
	);
	return resolved;
}

// ---------------------------------------------------------------------------
// Relationship hydration
// ---------------------------------------------------------------------------

/**
 * Translate the classifier's raw `relationship.citations` keys
 * (e.g. `["t1", "s2"]`) into hydrated MemoryCitation objects using
 * the memory bundle the resolver retrieved earlier in the turn.
 *
 * Citation keys index into `memory.turns` (`t1`, `t2`, ...) and
 * `memory.segments` (`s1`, `s2`, ...) by the same position the
 * classifier prompt rendered them. Keys that don't resolve (LLM
 * hallucinated a key beyond the memory bundle, or off-by-one) are
 * dropped silently per the plan's defensive policy.
 *
 * Confidence is mapped from the LLM's 0..1 to the resolver's
 * 'high' | 'medium' | 'low' tiers (same thresholds as the primary
 * intent confidence above).
 *
 * Returns `undefined` when the classifier emitted no relationship
 * (slash-forced / override / tag-reuse paths bypass this; cold path
 * with empty memory also bypasses, since classifyPrimaryIntent
 * skips the relationship enum when memory is empty).
 */
function hydrateRelationshipCitations(
	raw: { kind: RelationshipKind; confidence: number; reasoning: string; citations: readonly string[] } | undefined,
	memory: ClassifierMemory,
): IntentRelationship | undefined {
	if (raw === undefined) return undefined;

	const citations: MemoryCitation[] = [];
	for (const key of raw.citations) {
		const hydrated = hydrateCitationKey(key, memory);
		if (hydrated !== undefined) citations.push(hydrated);
	}

	const confidence = raw.confidence >= 0.85 ? 'high'
		: raw.confidence >= 0.6 ? 'medium'
			: 'low';

	return {
		kind:        raw.kind,
		confidence,
		reasoning:   raw.reasoning,
		citations,
	};
}

function hydrateCitationKey(key: string, memory: ClassifierMemory): MemoryCitation | undefined {
	const m = key.trim().match(/^([ts])(\d+)$/i);
	if (m === null) return undefined;
	const kind = m[1]!.toLowerCase() === 't' ? 'turn' : 'segment';
	const idx  = parseInt(m[2]!, 10) - 1;
	if (kind === 'turn') {
		const t = memory.turns[idx];
		if (t === undefined) return undefined;
		return {
			kind:        'turn',
			id:          t.turnId,
			excerpt:     t.excerpt,
			recencyRank: t.recencyRank,
			relevance:   t.relevance,
		};
	}
	const s = memory.segments[idx];
	if (s === undefined) return undefined;
	return {
		kind:        'segment',
		id:          s.segmentId,
		excerpt:     s.text,
		recencyRank: s.recencyRank,
		relevance:   s.relevance,
	};
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
