/**
 * Classifier memory retrieval -- Phase 3 of
 * plans/intent-classification-consolidation.md.
 *
 * Pulls a compact memory bundle for the intent classifier's cold
 * path: top-3 most-relevant prior TURNS in the current session
 * (by ANN over `turn_vec`, then re-sorted by recency) plus top-3
 * most-relevant SEGMENTS of prior assistant responses (by ANN over
 * `response_segment_vec`). Whole responses never reach the prompt;
 * only the matched segment excerpts do.
 *
 * Why two sources:
 *   - turn hits give the classifier "what was the user asking about
 *     1-2 turns ago?" -- the recency-sorted view supports
 *     FOLLOWUP / CONTINUATION classifications.
 *   - segment hits give the classifier "what specific paragraph in
 *     a past assistant response is the user now drilling into?" --
 *     this is what supports DRILL_DOWN and citation refs back to
 *     the segments the LLM actually leaned on.
 *
 * Failure modes (each degrades silently to empty memory):
 *   - `embedQuery` fails (Ollama down): we get an empty vector
 *     back; both ANN searches short-circuit; classifier runs without
 *     memory.
 *   - Lance query fails: caller catches; classifier runs without
 *     memory.
 *   - LMDB hydrate misses a turnId (race with delete): drop that
 *     hit, keep the others.
 *
 * Every successful call writes one summary log line so the daemon
 * log can correlate the retrieval with the downstream classifier
 * LLM call (via the next `llmCallId` in the log stream).
 */

import { getLogger } from '../../shared/logger.js';
import { embedQuery } from '../../indexer/embedder.js';
import { searchTurnVecsBySession }   from '../../db/lance/turn-vec.js';
import { queryResponseSegmentVec }   from '../../db/lance/response-segment-vec.js';
import { getTurnsForSession }        from '../../db/conversations.js';
import type { Session } from '../session.js';

const log = getLogger('classifier-memory');

const DEFAULT_TURNS_K       = 6;     // pull more than we keep -- we re-sort by recency
const DEFAULT_SEGMENTS_K    = 6;
const FINAL_TURNS_KEEP      = 3;
const FINAL_SEGMENTS_KEEP   = 3;
const TURN_EXCERPT_MAX_CHARS    = 240;
const SEGMENT_EXCERPT_MAX_CHARS = 800;

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export interface TurnMemoryHit {
	readonly turnId:      string;
	readonly role:        'user' | 'assistant';
	readonly excerpt:     string;
	readonly timestamp:   number;
	readonly recencyRank: number;     // 1 = most recent
	readonly relevance:   number;     // 0..1 (1 = identical vector)
}

export interface SegmentMemoryHit {
	readonly segmentId:   string;     // ${turnId}:${segmentIdx}
	readonly turnId:      string;
	readonly segmentIdx:  number;     // segment ordinal inside its source turn
	readonly text:        string;
	readonly timestamp:   number;
	readonly recencyRank: number;
	readonly relevance:   number;
}

export interface ClassifierMemory {
	readonly turns:    readonly TurnMemoryHit[];
	readonly segments: readonly SegmentMemoryHit[];
}

export interface RetrieveClassifierMemoryOpts {
	readonly turnsK?:    number;
	readonly segmentsK?: number;
	/**
	 * Override the embed function. Defaults to the Ollama-backed
	 * `embedQuery` from `indexer/embedder.ts`. Tests inject a
	 * deterministic fake to exercise the rest of the pipeline
	 * without a live Ollama. Production callers leave it unset.
	 */
	readonly embed?:     (text: string) => Promise<number[]>;
}

const EMPTY_MEMORY: ClassifierMemory = { turns: [], segments: [] };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function retrieveClassifierMemory(
	session: Session,
	message: string,
	opts?: RetrieveClassifierMemoryOpts,
): Promise<ClassifierMemory> {
	const sessionId = session.id ?? '';
	if (sessionId === '' || message.trim().length === 0) return EMPTY_MEMORY;

	const turnsK    = opts?.turnsK    ?? DEFAULT_TURNS_K;
	const segmentsK = opts?.segmentsK ?? DEFAULT_SEGMENTS_K;
	const embedFn   = opts?.embed     ?? embedQuery;

	const embedStart = Date.now();
	const queryVec = await embedFn(message).catch(err => {
		log.debug({ sessionId, err: String(err) }, 'embed function threw -- treating as empty vector');
		return [] as number[];
	});
	const embedMs = Date.now() - embedStart;
	if (queryVec.length === 0) {
		log.debug({ sessionId, embedMs }, 'classifier memory: embed returned empty -- skipping ANN');
		return EMPTY_MEMORY;
	}

	const lanceStart = Date.now();
	const [turnHitsRaw, segmentHits] = await Promise.all([
		searchTurnVecsBySession(queryVec, { sessionId, limit: turnsK }).catch(err => {
			log.debug({ sessionId, err: String(err) }, 'turn-vec search failed (continuing with empty turn memory)');
			return [] as Awaited<ReturnType<typeof searchTurnVecsBySession>>;
		}),
		queryResponseSegmentVec(queryVec, { sessionId, k: segmentsK }).catch(err => {
			log.debug({ sessionId, err: String(err) }, 'segment-vec search failed (continuing with empty segment memory)');
			return [] as Awaited<ReturnType<typeof queryResponseSegmentVec>>;
		}),
	]);
	const lanceMs = Date.now() - lanceStart;

	const turns    = await hydrateTurnHits(sessionId, turnHitsRaw);
	const segments = projectSegmentHits(segmentHits);

	log.info(
		{
			sessionId,
			turns:    turns.length,
			segments: segments.length,
			embedMs,
			lanceMs,
		},
		'classifier memory retrieved',
	);
	return { turns, segments };
}

// ---------------------------------------------------------------------------
// Hydration + projection
// ---------------------------------------------------------------------------

/**
 * Hydrate Lance turn hits with text from LMDB. We pulled `turnsK`
 * hits from ANN; here we (a) load the session's full turn list from
 * LMDB, (b) emit one TurnMemoryHit per (matched) USER message and
 * one per assistant message, (c) re-sort by recency descending,
 * (d) keep the top FINAL_TURNS_KEEP. Hits whose turn row is missing
 * (race with delete) are dropped silently.
 */
async function hydrateTurnHits(
	sessionId: string,
	hits: Awaited<ReturnType<typeof searchTurnVecsBySession>>,
): Promise<readonly TurnMemoryHit[]> {
	if (hits.length === 0) return [];

	let turns;
	try {
		// `_db` parameter is unused -- the daemon's storage layer
		// indirects through getGraphStore() internally.
		turns = await getTurnsForSession(null as never, sessionId);
	} catch (err) {
		log.debug({ sessionId, err: String(err) }, 'getTurnsForSession failed; dropping turn memory');
		return [];
	}

	// Map by id (`${sessionId}:${idx}`) for O(1) lookup.
	const byId = new Map<string, typeof turns[number]>();
	for (const t of turns) byId.set(`${t.sessionId}:${t.idx}`, t);

	// Project hits into role-tagged excerpts. A single turn row holds
	// BOTH the user message and the assistant reply, so each hit can
	// surface either depending on which side the user's current
	// message resembles. We pick the side with the longest text-overlap
	// proxy: just emit ONE entry per hit, defaulting to the user side
	// (which is what most FOLLOWUP / CONTINUATION classifications hinge
	// on -- "did the user re-ask the same thing").
	type IntermediateHit = TurnMemoryHit & { __recencySort: number };
	const intermediate: IntermediateHit[] = [];
	for (const h of hits) {
		const t = byId.get(h.id);
		if (t === undefined) continue;
		const ts = parseTimestamp(t.createdAt);
		const userText = t.user.trim();
		if (userText.length > 0) {
			intermediate.push({
				turnId:      h.id,
				role:        'user',
				excerpt:     trimAtSentence(userText, TURN_EXCERPT_MAX_CHARS),
				timestamp:   ts,
				recencyRank: 0,                    // re-stamped below
				relevance:   distanceToRelevance(h.distance),
				__recencySort: ts,
			});
		}
		const assistantText = t.assistant.trim();
		if (assistantText.length > 0) {
			intermediate.push({
				turnId:      h.id,
				role:        'assistant',
				excerpt:     trimAtSentence(assistantText, TURN_EXCERPT_MAX_CHARS),
				timestamp:   ts,
				recencyRank: 0,
				relevance:   distanceToRelevance(h.distance),
				__recencySort: ts,
			});
		}
	}

	intermediate.sort((a, b) => b.__recencySort - a.__recencySort);
	const top = intermediate.slice(0, FINAL_TURNS_KEEP);
	return top.map((h, i) => ({
		turnId:      h.turnId,
		role:        h.role,
		excerpt:     h.excerpt,
		timestamp:   h.timestamp,
		recencyRank: i + 1,
		relevance:   h.relevance,
	}));
}

function projectSegmentHits(
	hits: Awaited<ReturnType<typeof queryResponseSegmentVec>>,
): readonly SegmentMemoryHit[] {
	if (hits.length === 0) return [];
	// Hits arrive sorted by ANN distance ascending (best first). We
	// keep that order for relevance ranking but ALSO assign a recency
	// rank -- consumers (Phase 4 prompt builder) tag segment lines
	// with `[sN]` keys derived from their array index, which is
	// effectively the relevance order.
	const top = hits.slice(0, FINAL_SEGMENTS_KEEP);
	// Sort by recency for the recencyRank stamp without disturbing
	// the relevance order of the returned array.
	const byRecencyDesc = [...top].sort((a, b) => Number(b.timestamp - a.timestamp));
	const recencyRankOf = new Map<string, number>();
	byRecencyDesc.forEach((h, i) => recencyRankOf.set(h.id, i + 1));

	return top.map(h => ({
		segmentId:   h.id,
		turnId:      h.turnId,
		segmentIdx:  h.segmentIdx,
		text:        trimAtSentence(h.text, SEGMENT_EXCERPT_MAX_CHARS),
		timestamp:   Number(h.timestamp),
		recencyRank: recencyRankOf.get(h.id) ?? 1,
		relevance:   distanceToRelevance(h.distance),
	}));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map Lance L2 distance to a 0..1 relevance score for prompt
 * display. Lance returns squared L2 by default. We use a simple
 * `1 / (1 + distance)` mapping -- monotone in distance, bounded in
 * [0, 1], 1.0 for identical vectors. Not a calibrated similarity;
 * just a stable ordering signal the LLM can read.
 */
function distanceToRelevance(distance: number): number {
	if (!Number.isFinite(distance) || distance < 0) return 0;
	const r = 1 / (1 + distance);
	return Math.max(0, Math.min(1, r));
}

function trimAtSentence(text: string, maxChars: number): string {
	const t = text.trim();
	if (t.length <= maxChars) return t;
	const slice = t.slice(0, maxChars);
	// Walk back to the most recent sentence-ending punctuation so the
	// excerpt doesn't trail off mid-word. Fall back to the hard cap
	// if no punctuation is present.
	const lastTerminator = Math.max(
		slice.lastIndexOf('. '),
		slice.lastIndexOf('! '),
		slice.lastIndexOf('? '),
		slice.lastIndexOf('.\n'),
		slice.lastIndexOf('!\n'),
		slice.lastIndexOf('?\n'),
	);
	if (lastTerminator > maxChars * 0.6) {
		return `${slice.slice(0, lastTerminator + 1).trim()}...`;
	}
	return `${slice.trim()}...`;
}

function parseTimestamp(createdAt?: string): number {
	if (createdAt === undefined || createdAt.length === 0) return 0;
	const t = Date.parse(createdAt);
	return Number.isNaN(t) ? 0 : t;
}
