/**
 * LMDB-backed conversation persistence (sessions + turns).
 *
 * Phase 2.6 of plans/storage-migration-lmdb-lance.md. Public surface
 * preserved verbatim from the prior DuckDB-backed implementation so
 * callers (`daemon/index.ts`, `daemon/chat-sessions.ts`,
 * `db/compaction.ts`, `cli/commands/conversation.ts`) don't change in
 * this phase. The `db: DbClient` parameter is retained but unused.
 *
 * Storage:
 *   - `conversation_session` sub-DB: utf8 session_id -> msgpack(SessionRow)
 *   - `conversation_turn` sub-DB: (utf8 session_id, \0, u32 idx BE) -> msgpack(TurnRow)
 *   - `conversation_turn_by_repo` sub-DB: (utf8 repo, \0, utf8 turn_id) -> empty (dupsort)
 *
 * Embedding storage is **deferred to Phase 3.3** -- this module's
 * vector-related ops are stubbed:
 *   - `saveTurn` / `addCompactedTurns` accept `vector: number[]` but
 *     do not persist it (the field is dropped at the LMDB row
 *     boundary; Phase 3.3 routes it to LanceDB keyed by turn_id).
 *   - `searchTurnsByRepo` and `seedFromPrior` return [] until Phase
 *     3.3 wires the Lance ANN read path.
 *   - All read paths return `vector: []` on the deserialized record.
 *   - The 30-day TTL + 20-per-repo cap behaviour of `pruneConversations`
 *     is preserved (it doesn't depend on vectors).
 */

import {
	getGraphStore,
	withWriteTxn,
	type GraphStore,
} from './graph/store.js';
import {
	encodeConversationTurnKey,
	encodeConversationTurnPrefix,
	encodeConvTurnByRepoKey,
	encodeConvTurnByRepoPrefix,
	prefixSuccessor,
} from './graph/keys.js';
import {
	encodeSessionRow,
	decodeSessionRow,
	encodeTurnRow,
	decodeTurnRow,
	type SessionRow,
	type SessionStatus as RowSessionStatus,
	type SessionTier as RowSessionTier,
	type TurnRow,
	type TurnFormat,
	type TurnType,
} from './graph/codec.js';

type DbClient = unknown;

// ---------------------------------------------------------------------------
// Public types -- preserved from the prior DuckDB-backed implementation
// ---------------------------------------------------------------------------

export type ConversationEntryType = 'turn' | 'directive' | 'summary' | 'merged';
export type ConversationTier = 'hot' | 'warm' | 'cold' | 'archive';
export type SessionStatus = 'active' | 'paused' | 'completed' | 'discarded';

export interface SessionRecord {
	id: string;
	repo: string;
	summary: string;
	seenEntities: string[];
	createdAt: string;
	expiresAt: string;
	agent: string;
	category: string;
	status: SessionStatus;
	lastActivityAt: string;
	vector: number[];
}

export interface TurnRecord {
	sessionId: string;
	idx: number;
	user: string;
	assistant: string;
	entities: string[];
	vector: number[];
	repo: string;
	type?: ConversationEntryType | undefined;
	tier?: ConversationTier | undefined;
	compactedAt?: string | undefined;
	sourceIds?: string[] | undefined;
	createdAt?: string | undefined;
	format?: string | undefined;
}

export interface ConversationStats {
	totalTurns: number;
	byType: Record<string, number>;
	byTier: Record<string, number>;
	byRepo: Record<string, number>;
	sessions: number;
}

export interface SessionSummary {
	id: string;
	repo: string;
	summary: string;
	createdAt: string;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

const TURN_TYPES: ReadonlyArray<TurnType> = ['turn', 'directive', 'summary', 'merged'];
const TIERS: ReadonlyArray<RowSessionTier> = ['hot', 'warm', 'cold', 'archive'];

function turnIdFor(sessionId: string, idx: number): string {
	return `${sessionId}:${idx}`;
}

function parseTurnId(id: string): { sessionId: string; idx: number } | null {
	const colon = id.lastIndexOf(':');
	if (colon < 0) return null;
	const idx = Number.parseInt(id.slice(colon + 1), 10);
	if (!Number.isFinite(idx)) return null;
	return { sessionId: id.slice(0, colon), idx };
}

function rowToSessionRecord(row: SessionRow): SessionRecord {
	return {
		id:             row.id,
		repo:           row.repo,
		summary:        row.summary,
		seenEntities:   row.seenEntities,
		createdAt:      formatTs(row.createdAt),
		expiresAt:      row.expiresAt > 0 ? formatTs(row.expiresAt) : '',
		agent:          row.agent || 'chat',
		category:       row.category,
		status:         coerceStatus(row.status),
		lastActivityAt: formatTs(row.lastActivityAt) || formatTs(row.createdAt),
		// Embedding lives in LanceDB; Phase 3.3 wires the read path
		vector:         [],
	};
}

function rowToTurnRecord(row: TurnRow): TurnRecord {
	return {
		sessionId:   row.sessionId,
		idx:         row.idx,
		user:        row.userText,
		assistant:   row.assistant,
		entities:    row.entities,
		// Embedding lives in LanceDB; Phase 3.3 wires the read path
		vector:      [],
		repo:        row.repo,
		type:        row.type,
		tier:        row.tier,
		compactedAt: row.compactedAt > 0 ? formatTs(row.compactedAt) : '',
		sourceIds:   row.sourceIds,
		createdAt:   formatTs(row.createdAt),
		format:      row.format,
	};
}

function coerceStatus(s: RowSessionStatus): SessionStatus {
	// Codec SessionStatus is 'active' | 'archived' | 'expired'; the
	// public SessionStatus is 'active' | 'paused' | 'completed' |
	// 'discarded'. Map between them defensively (the daemon's chat
	// flow always writes one of the public values; codec's "archived"
	// / "expired" are LMDB-side states we may emit later in the
	// pruning path).
	switch (s) {
		case 'active':   return 'active';
		case 'archived': return 'completed';
		case 'expired':  return 'discarded';
		default:         return s as unknown as SessionStatus;
	}
}

function publicToRowStatus(s: SessionStatus): RowSessionStatus {
	switch (s) {
		case 'active':    return 'active';
		case 'paused':    return 'active'; // closest LMDB-side encoding
		case 'completed': return 'archived';
		case 'discarded': return 'expired';
		default:          return 'active';
	}
}

function coerceTurnType(s: string | undefined): TurnType {
	if (s === undefined) return 'turn';
	if ((TURN_TYPES as readonly string[]).includes(s)) return s as TurnType;
	return 'turn';
}

function coerceTier(s: string | undefined): RowSessionTier {
	if (s === undefined) return 'hot';
	if ((TIERS as readonly string[]).includes(s)) return s as RowSessionTier;
	return 'hot';
}

function coerceFormat(s: string | undefined): TurnFormat {
	if (s === 'markdown' || s === 'tool') return s;
	return 'text';
}

function formatTs(ms: number): string {
	if (ms === 0) return '';
	return new Date(ms).toISOString();
}

function parseTs(s: string | undefined): number {
	if (s === undefined || s === '') return 0;
	const n = Date.parse(s);
	return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Turn writes
// ---------------------------------------------------------------------------

export async function saveTurn(_db: DbClient, turn: TurnRecord): Promise<void> {
	const id = turnIdFor(turn.sessionId, turn.idx);
	const now = Date.now();
	await withWriteTxn(s => {
		const row: TurnRow = {
			id,
			sessionId:   turn.sessionId,
			idx:         turn.idx,
			userText:    turn.user,
			assistant:   turn.assistant,
			entities:    turn.entities,
			createdAt:   parseTs(turn.createdAt) || now,
			repo:        turn.repo,
			type:        coerceTurnType(turn.type),
			tier:        coerceTier(turn.tier),
			compactedAt: parseTs(turn.compactedAt),
			sourceIds:   turn.sourceIds ?? [],
			format:      coerceFormat(turn.format),
		};
		writeTurnInTxn(s, row);
		bumpSessionActivityInTxn(s, turn.sessionId, now);
	});
}

export async function addCompactedTurns(_db: DbClient, turns: TurnRecord[]): Promise<void> {
	if (turns.length === 0) return;
	const now = Date.now();
	await withWriteTxn(s => {
		for (const t of turns) {
			const id = turnIdFor(t.sessionId, t.idx);
			const row: TurnRow = {
				id,
				sessionId:   t.sessionId,
				idx:         t.idx,
				userText:    t.user,
				assistant:   t.assistant,
				entities:    t.entities,
				createdAt:   now,
				repo:        t.repo,
				type:        coerceTurnType(t.type ?? 'merged'),
				tier:        coerceTier(t.tier ?? 'cold'),
				compactedAt: now,
				sourceIds:   t.sourceIds ?? [],
				format:      coerceFormat(t.format),
			};
			writeTurnInTxn(s, row);
		}
	});
}

function writeTurnInTxn(s: GraphStore, row: TurnRow): void {
	const key = encodeConversationTurnKey(row.sessionId, row.idx);
	s.conversationTurn.put(key, encodeTurnRow(row));
	if (row.repo !== '') {
		const idxKey = encodeConvTurnByRepoKey(row.repo, row.id);
		s.conversationTurnByRepo.put(idxKey, Buffer.alloc(0));
	}
}

// ---------------------------------------------------------------------------
// Session writes
// ---------------------------------------------------------------------------

export async function closeSession(
	_db: DbClient,
	session: { id: string; repo: string; summary: string; seenEntities: string[] },
	_summaryVector: number[],
): Promise<void> {
	const now = Date.now();
	const expiresAt = now + 30 * 86_400_000;
	await withWriteTxn(s => {
		const buf = s.conversationSession.get(session.id);
		if (buf !== undefined) {
			const cur = decodeSessionRow(buf as Buffer);
			const next: SessionRow = {
				...cur,
				summary:        session.summary,
				seenEntities:   session.seenEntities,
				expiresAt,
				status:         'archived',
				lastActivityAt: now,
			};
			s.conversationSession.put(session.id, encodeSessionRow(next));
			return;
		}
		const fresh: SessionRow = {
			id:             session.id,
			repo:           session.repo,
			summary:        session.summary,
			seenEntities:   session.seenEntities,
			createdAt:      now,
			expiresAt,
			agent:          'chat',
			category:       '',
			status:         'archived',
			lastActivityAt: now,
			tier:           'hot',
		};
		s.conversationSession.put(session.id, encodeSessionRow(fresh));
	});
}

export async function saveSession(
	_db: DbClient,
	session: {
		id: string;
		repo: string;
		summary: string;
		agent?: string;
		category?: string;
		status?: SessionStatus;
	},
	_vector?: number[] | undefined,
): Promise<void> {
	const now = Date.now();
	const expiresAt = now + 30 * 86_400_000;
	await withWriteTxn(s => {
		const buf = s.conversationSession.get(session.id);
		if (buf !== undefined) {
			const cur = decodeSessionRow(buf as Buffer);
			const next: SessionRow = {
				...cur,
				summary:        session.summary,
				lastActivityAt: now,
				...(session.agent    !== undefined ? { agent:    session.agent }    : {}),
				...(session.category !== undefined ? { category: session.category } : {}),
				...(session.status   !== undefined ? { status:   publicToRowStatus(session.status) } : {}),
			};
			s.conversationSession.put(session.id, encodeSessionRow(next));
			return;
		}
		const fresh: SessionRow = {
			id:             session.id,
			repo:           session.repo,
			summary:        session.summary,
			seenEntities:   [],
			createdAt:      now,
			expiresAt,
			agent:          session.agent ?? 'chat',
			category:       session.category ?? '',
			status:         publicToRowStatus(session.status ?? 'active'),
			lastActivityAt: now,
			tier:           'hot',
		};
		s.conversationSession.put(session.id, encodeSessionRow(fresh));
	});
}

export async function setSessionAgent(
	_db: DbClient,
	id: string,
	agent: string,
	category?: string,
): Promise<void> {
	const now = Date.now();
	await withWriteTxn(s => {
		const buf = s.conversationSession.get(id);
		if (buf === undefined) return;
		const cur = decodeSessionRow(buf as Buffer);
		const next: SessionRow = {
			...cur,
			agent,
			lastActivityAt: now,
			...(category !== undefined ? { category } : {}),
		};
		s.conversationSession.put(id, encodeSessionRow(next));
	});
}

export async function setSessionStatus(
	_db: DbClient,
	id: string,
	status: SessionStatus,
): Promise<void> {
	const now = Date.now();
	await withWriteTxn(s => {
		const buf = s.conversationSession.get(id);
		if (buf === undefined) return;
		const cur = decodeSessionRow(buf as Buffer);
		const next: SessionRow = { ...cur, status: publicToRowStatus(status), lastActivityAt: now };
		s.conversationSession.put(id, encodeSessionRow(next));
	});
}

export async function bumpSessionActivity(_db: DbClient, id: string): Promise<void> {
	const now = Date.now();
	await withWriteTxn(s => bumpSessionActivityInTxn(s, id, now));
}

function bumpSessionActivityInTxn(s: GraphStore, id: string, now: number): void {
	const buf = s.conversationSession.get(id);
	if (buf === undefined) return; // no session row yet -- legacy turn
	const cur = decodeSessionRow(buf as Buffer);
	const next: SessionRow = { ...cur, lastActivityAt: now };
	s.conversationSession.put(id, encodeSessionRow(next));
}

// ---------------------------------------------------------------------------
// Deletes
// ---------------------------------------------------------------------------

export async function deleteSession(
	_db: DbClient,
	sessionId: string,
): Promise<{ sessionRows: number; turnRows: number }> {
	const store = await getGraphStore();
	let sessionRows = 0;
	let turnRows = 0;
	await withWriteTxn(s => {
		if (s.conversationSession.get(sessionId) !== undefined) {
			s.conversationSession.remove(sessionId);
			sessionRows = 1;
		}
		turnRows = deleteTurnsForSessionInTxn(s, sessionId);
	});
	void store;
	return { sessionRows, turnRows };
}

export async function deleteTurnsForSession(_db: DbClient, sessionId: string): Promise<void> {
	await withWriteTxn(s => deleteTurnsForSessionInTxn(s, sessionId));
}

function deleteTurnsForSessionInTxn(s: GraphStore, sessionId: string): number {
	const prefix = encodeConversationTurnPrefix(sessionId);
	const succ = prefixSuccessor(prefix);
	let count = 0;
	const turnsToRemove: { key: Buffer; row: TurnRow }[] = [];
	for (const { key, value } of s.conversationTurn.getRange({ start: prefix, end: succ })) {
		turnsToRemove.push({ key: key as Buffer, row: decodeTurnRow(value as Buffer) });
	}
	for (const { key, row } of turnsToRemove) {
		s.conversationTurn.remove(key);
		if (row.repo !== '') {
			s.conversationTurnByRepo.remove(
				encodeConvTurnByRepoKey(row.repo, row.id),
				Buffer.alloc(0),
			);
		}
		count++;
	}
	return count;
}

export async function deleteSessionRecord(_db: DbClient, sessionId: string): Promise<void> {
	await withWriteTxn(s => {
		s.conversationSession.remove(sessionId);
	});
}

export async function deleteSessionsForRepo(_db: DbClient, repo: string): Promise<void> {
	const store = await getGraphStore();
	const ids: string[] = [];
	for (const { key, value } of store.conversationSession.getRange()) {
		const row = decodeSessionRow(value as Buffer);
		if (row.repo === repo) ids.push(key as string);
	}
	if (ids.length === 0) return;
	// Cascade: each session brings its turns + by_repo index entries
	// with it (Phase 2.10 cascade rules -- previously this was a session-
	// row-only delete, leaving orphan turns).
	await withWriteTxn(s => {
		for (const id of ids) {
			deleteTurnsForSessionInTxn(s, id);
			s.conversationSession.remove(id);
		}
	});
}

export async function deleteTurnsForRepo(_db: DbClient, repo: string): Promise<void> {
	const store = await getGraphStore();
	// Use the by-repo dupsort index for O(matches)
	const turnIds: string[] = [];
	const idxKey = encodeConvTurnByRepoPrefix(repo);
	const succ = prefixSuccessor(idxKey);
	for (const { key } of store.conversationTurnByRepo.getRange({ start: idxKey, end: succ })) {
		// key shape: (utf8 repo, \0, utf8 turn_id)
		const k = key as Buffer;
		// find first \0 separator
		const sep = k.indexOf(0);
		if (sep < 0) continue;
		const turnId = k.subarray(sep + 1).toString('utf8');
		turnIds.push(turnId);
	}
	if (turnIds.length === 0) return;
	await deleteTurnsByIds(_db, turnIds);
}

export async function deleteTurnsByIds(_db: DbClient, ids: string[]): Promise<void> {
	if (ids.length === 0) return;
	await withWriteTxn(s => {
		for (const id of ids) {
			const parsed = parseTurnId(id);
			if (parsed === null) continue;
			const key = encodeConversationTurnKey(parsed.sessionId, parsed.idx);
			const buf = s.conversationTurn.get(key);
			if (buf === undefined) continue;
			const row = decodeTurnRow(buf as Buffer);
			s.conversationTurn.remove(key);
			if (row.repo !== '') {
				s.conversationTurnByRepo.remove(
					encodeConvTurnByRepoKey(row.repo, id),
					Buffer.alloc(0),
				);
			}
		}
	});
}

// ---------------------------------------------------------------------------
// Pruning -- expired + per-repo cap
// ---------------------------------------------------------------------------

const PER_REPO_CAP = 20;

export async function pruneConversations(
	_db: DbClient,
): Promise<{ expired: number; capped: number }> {
	const store = await getGraphStore();
	const now = Date.now();

	// Pass 1: collect expired session ids
	const expiredIds: string[] = [];
	// Pass 2: group surviving sessions by repo for the cap
	const byRepo = new Map<string, { id: string; createdAt: number }[]>();
	for (const { key, value } of store.conversationSession.getRange()) {
		const row = decodeSessionRow(value as Buffer);
		if (row.expiresAt > 0 && row.expiresAt < now) {
			expiredIds.push(key as string);
			continue;
		}
		const list = byRepo.get(row.repo);
		if (list === undefined) {
			byRepo.set(row.repo, [{ id: row.id, createdAt: row.createdAt }]);
		} else {
			list.push({ id: row.id, createdAt: row.createdAt });
		}
	}

	// Per-repo cap: drop oldest beyond PER_REPO_CAP
	const cappedIds: string[] = [];
	for (const list of byRepo.values()) {
		if (list.length <= PER_REPO_CAP) continue;
		list.sort((a, b) => b.createdAt - a.createdAt);
		for (const overflow of list.slice(PER_REPO_CAP)) {
			cappedIds.push(overflow.id);
		}
	}

	if (expiredIds.length === 0 && cappedIds.length === 0) {
		return { expired: 0, capped: 0 };
	}
	await withWriteTxn(s => {
		for (const id of expiredIds) s.conversationSession.remove(id);
		for (const id of cappedIds)  s.conversationSession.remove(id);
	});
	return { expired: expiredIds.length, capped: cappedIds.length };
}

// ---------------------------------------------------------------------------
// Vector search -- stubbed until Phase 3.3
// ---------------------------------------------------------------------------

export async function searchTurnsByRepo(
	_db: DbClient,
	_repo: string,
	_queryVector: number[],
	_limit = 20,
): Promise<TurnRecord[]> {
	// Phase 3.3 wires LanceDB ANN. Until then, vector search returns
	// no matches (callers fall back to most-recent / per-session).
	return [];
}

export async function seedFromPrior(
	_db: DbClient,
	_repo: string,
	_queryVector: number[],
	_limit = 3,
): Promise<SessionRecord[]> {
	// Phase 3.3 wires LanceDB ANN.
	return [];
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getAllTurnsForRepo(_db: DbClient, repo: string): Promise<TurnRecord[]> {
	const store = await getGraphStore();
	const out: TurnRecord[] = [];
	const prefix = encodeConvTurnByRepoPrefix(repo);
	const succ = prefixSuccessor(prefix);
	for (const { key } of store.conversationTurnByRepo.getRange({ start: prefix, end: succ })) {
		const k = key as Buffer;
		const sep = k.indexOf(0);
		if (sep < 0) continue;
		const turnId = k.subarray(sep + 1).toString('utf8');
		const parsed = parseTurnId(turnId);
		if (parsed === null) continue;
		const buf = store.conversationTurn.get(encodeConversationTurnKey(parsed.sessionId, parsed.idx));
		if (buf === undefined) continue;
		out.push(rowToTurnRecord(decodeTurnRow(buf as Buffer)));
	}
	return out;
}

export async function getAllTurns(_db: DbClient): Promise<TurnRecord[]> {
	const store = await getGraphStore();
	const out: TurnRecord[] = [];
	for (const { value } of store.conversationTurn.getRange()) {
		out.push(rowToTurnRecord(decodeTurnRow(value as Buffer)));
	}
	return out;
}

export async function getConversationStats(
	_db: DbClient,
	repo?: string,
): Promise<ConversationStats> {
	const turns = repo !== undefined ? await getAllTurnsForRepo(_db, repo) : await getAllTurns(_db);
	const byType: Record<string, number> = {};
	const byTier: Record<string, number> = {};
	const byRepo: Record<string, number> = {};
	for (const t of turns) {
		const type = t.type ?? 'turn';
		const tier = t.tier ?? 'hot';
		byType[type] = (byType[type] ?? 0) + 1;
		byTier[tier] = (byTier[tier] ?? 0) + 1;
		byRepo[t.repo] = (byRepo[t.repo] ?? 0) + 1;
	}
	const store = await getGraphStore();
	let sessions = 0;
	for (const { value } of store.conversationSession.getRange()) {
		const row = decodeSessionRow(value as Buffer);
		if (repo !== undefined && row.repo !== repo) continue;
		sessions++;
	}
	return { totalTurns: turns.length, byType, byTier, byRepo, sessions };
}

export async function getSessionById(
	_db: DbClient,
	sessionId: string,
): Promise<SessionRecord | null> {
	const store = await getGraphStore();
	const buf = store.conversationSession.get(sessionId);
	if (buf === undefined) return null;
	return rowToSessionRecord(decodeSessionRow(buf as Buffer));
}

export async function getTurnsForSession(
	_db: DbClient,
	sessionId: string,
): Promise<TurnRecord[]> {
	const store = await getGraphStore();
	const out: TurnRecord[] = [];
	const prefix = encodeConversationTurnPrefix(sessionId);
	const succ = prefixSuccessor(prefix);
	for (const { value } of store.conversationTurn.getRange({ start: prefix, end: succ })) {
		const row = decodeTurnRow(value as Buffer);
		if (row.type !== 'turn') continue; // matches prior DuckDB query filter
		out.push(rowToTurnRecord(row));
	}
	return out;
}

export async function listSessions(
	_db: DbClient,
	repo?: string | undefined,
): Promise<SessionSummary[]> {
	const store = await getGraphStore();
	const rows: { id: string; repo: string; summary: string; createdAt: number }[] = [];
	for (const { value } of store.conversationSession.getRange()) {
		const row = decodeSessionRow(value as Buffer);
		if (repo !== undefined && row.repo !== repo) continue;
		rows.push({ id: row.id, repo: row.repo, summary: row.summary, createdAt: row.createdAt });
	}
	rows.sort((a, b) => b.createdAt - a.createdAt);
	return rows.map(r => ({
		id:        r.id,
		repo:      r.repo,
		summary:   r.summary,
		createdAt: formatTs(r.createdAt),
	}));
}

export async function listSessionRecords(
	_db: DbClient,
	opts?: { repo?: string; statuses?: SessionStatus[] },
): Promise<SessionRecord[]> {
	const store = await getGraphStore();
	const out: SessionRecord[] = [];
	const wantStatuses = opts?.statuses && opts.statuses.length > 0
		? new Set(opts.statuses.map(publicToRowStatus))
		: null;
	for (const { value } of store.conversationSession.getRange()) {
		const row = decodeSessionRow(value as Buffer);
		if (opts?.repo !== undefined && row.repo !== opts.repo) continue;
		if (wantStatuses !== null && !wantStatuses.has(row.status)) continue;
		out.push(rowToSessionRecord(row));
	}
	out.sort((a, b) => {
		const at = a.lastActivityAt || a.createdAt;
		const bt = b.lastActivityAt || b.createdAt;
		return bt.localeCompare(at);
	});
	return out;
}

/**
 * Reset module-level table caches. No-op on the LMDB substrate (no
 * caching; identity is the env singleton). Kept for back-compat with
 * daemon test harnesses that called the Lance / DuckDB version.
 */
export function resetTableCaches(): void {
	// intentionally empty
}
