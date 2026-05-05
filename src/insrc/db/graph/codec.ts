/**
 * Typed msgpack encoders / decoders for every record stored in the
 * LMDB graph layer.
 *
 * Phase 1.3 of plans/storage-migration-lmdb-lance.md. This module
 * defines the *wire format* for each LMDB sub-DB's value (the *key*
 * codec is in `keys.ts`).
 *
 * Why msgpack:
 *   - 5-10x faster than JSON.parse / JSON.stringify
 *   - Compact binary representation; bigint / Buffer / Date
 *     supported natively
 *   - Same library that lmdb-js uses internally for its default
 *     codec, so we get well-tested round-trip behaviour
 *
 * "Row" types in this file are the LMDB-resident shapes. They differ
 * from the daemon's domain types (`shared/types.ts`) in subtle ways
 * (u32 repoId vs string repo path, etc.); the translation layer
 * between domain and row types lives in Phase 2.x's
 * `db/graph/entities.ts` etc.
 *
 * All encoders return `Buffer`; all decoders accept `Buffer` and
 * return the typed row.
 */

import { Packr, Unpackr } from 'msgpackr';

import type { RelationKind } from './keys.js';
import type { EntityKind, Language } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Shared codec instance
// ---------------------------------------------------------------------------

// Packr/Unpackr default configuration is fine for our shapes:
//   - bigint64: false (we use bigints in keys, but values use number/string;
//                      if we need bigint values later we toggle this on)
//   - structuredClone: false (we don't store cyclic objects)
//   - mapsAsObjects: true   (default; we don't use Map values)
const packr = new Packr({ useRecords: false });
const unpackr = new Unpackr({ useRecords: false });

function encode<T>(row: T): Buffer {
	return packr.pack(row);
}

function decode<T>(buf: Buffer): T {
	return unpackr.unpack(buf) as T;
}

// ---------------------------------------------------------------------------
// Repo row -- value of `repo` sub-DB (key: u32 BE repoId)
// ---------------------------------------------------------------------------

export type RepoStatus = 'pending' | 'indexing' | 'ready' | 'error';

export interface RepoRow {
	id:           number;       // u32, also encoded in the key
	path:         string;       // absolute filesystem path
	name:         string;       // display name
	addedAt:      number;       // unix ms
	lastIndexed:  number;       // unix ms; 0 if never indexed
	status:       RepoStatus;
	errorMsg:     string;       // empty string if no error
}

export const encodeRepoRow = (r: RepoRow): Buffer => encode(r);
export const decodeRepoRow = (b: Buffer): RepoRow => decode(b);

// ---------------------------------------------------------------------------
// Entity row -- value of `entity` sub-DB (key: u64 BE entity_id)
// ---------------------------------------------------------------------------

export interface EntityRow {
	// Identity (also encoded in name_index)
	repoId:    number;          // u32
	kind:      EntityKind;
	name:      string;          // fully-qualified

	// Provenance
	filePath:  string;          // repo-relative
	startLine: number;
	endLine:   number;
	language:  Language;
	rootPath:  string;          // repo root, for closure resolution

	// Body / signature
	body:      string;
	signature: string;          // empty for entities without one
	summary:   string;          // empty until LLM-generated

	// Flags
	isExported: boolean;
	isAsync:    boolean;
	isAbstract: boolean;
	artifact:   boolean;

	// Bookkeeping
	contentHash:    string;
	embeddingModel: string;     // empty until embedded
	indexedAt:      number;     // unix ms
}

export type { Language };

export const encodeEntityRow = (r: EntityRow): Buffer => encode(r);
export const decodeEntityRow = (b: Buffer): EntityRow => decode(b);

// ---------------------------------------------------------------------------
// Edge properties -- value of `out_edge` sub-DB (key: (u64 from, u8 kind, u64 to))
// ---------------------------------------------------------------------------

/**
 * Most edges have empty payload. CALLS, READS, WRITES, IMPORTS carry
 * structured props. The encoder is per-kind; callers know which
 * shape to expect for which kind.
 */

export interface CallsEdgeProps  { siteCount: number }
export interface ReadsEdgeProps  { columns: string[] }
export interface WritesEdgeProps { columns: string[] }
export interface ImportsEdgeProps { rawTo: string }
export type EdgeProps =
	| CallsEdgeProps
	| ReadsEdgeProps
	| WritesEdgeProps
	| ImportsEdgeProps
	| Record<string, never>;

export const encodeEdgeProps = (p: EdgeProps): Buffer =>
	Object.keys(p).length === 0 ? Buffer.alloc(0) : encode(p);

/**
 * Decode an edge value to the kind-specific props. Empty buffers
 * return `{}` (the empty-payload sentinel).
 */
export function decodeEdgeProps<T extends EdgeProps>(b: Buffer): T {
	if (b.length === 0) return {} as T;
	return decode<T>(b);
}

// Convenience typed decoders -- callers know the kind, the wire shape
// is the same; these are sugar.
export const decodeCallsEdge   = (b: Buffer): CallsEdgeProps   => decodeEdgeProps<CallsEdgeProps>(b);
export const decodeReadsEdge   = (b: Buffer): ReadsEdgeProps   => decodeEdgeProps<ReadsEdgeProps>(b);
export const decodeWritesEdge  = (b: Buffer): WritesEdgeProps  => decodeEdgeProps<WritesEdgeProps>(b);
export const decodeImportsEdge = (b: Buffer): ImportsEdgeProps => decodeEdgeProps<ImportsEdgeProps>(b);

// ---------------------------------------------------------------------------
// Unresolved relation -- value of `unresolved` sub-DB (key: u64 BE unresolved_id)
// ---------------------------------------------------------------------------

export interface UnresolvedRow {
	id:           bigint;       // u64; also encoded in the key
	repoId:       number;       // u32
	fromEntity:   bigint;       // u64 entity_id of the source
	fromFile:     string;       // repo-relative path of the source
	kind:         RelationKind; // CALLS / IMPORTS / INHERITS / etc.
	rawTo:        string;       // unresolved target (raw import specifier or symbol name)
	meta:         Record<string, unknown>;
	attemptedAt:  number;       // unix ms; 0 if never attempted
}

export const encodeUnresolvedRow = (r: UnresolvedRow): Buffer => encode(r);
export const decodeUnresolvedRow = (b: Buffer): UnresolvedRow => decode(b);

// ---------------------------------------------------------------------------
// Plan + plan_step rows
// ---------------------------------------------------------------------------

export type PlanStatus = 'active' | 'completed' | 'abandoned';

export interface PlanRow {
	id:        string;          // utf8; also encoded in the key
	repoPath:  string;
	title:     string;
	status:    PlanStatus;
	createdAt: number;          // unix ms
	updatedAt: number;          // unix ms
}

export const encodePlanRow = (r: PlanRow): Buffer => encode(r);
export const decodePlanRow = (b: Buffer): PlanRow => decode(b);

export type PlanStepStatus     = 'pending' | 'in_progress' | 'completed' | 'blocked';
export type PlanStepComplexity = 'trivial' | 'small' | 'medium' | 'large';

export interface PlanStepRow {
	id:          string;
	planId:      string;        // also encoded in the key
	idx:         number;        // also encoded in the key
	title:       string;
	description: string;
	checkpoint:  boolean;
	status:      PlanStepStatus;
	complexity:  PlanStepComplexity;
	fileHint:    string;
	notes:       string;
	createdAt:   number;
	updatedAt:   number;
	startedAt:   number;        // 0 if not started
	doneAt:      number;        // 0 if not done
}

export const encodePlanStepRow = (r: PlanStepRow): Buffer => encode(r);
export const decodePlanStepRow = (b: Buffer): PlanStepRow => decode(b);

// ---------------------------------------------------------------------------
// Conversation rows
// ---------------------------------------------------------------------------

export type SessionStatus = 'active' | 'archived' | 'expired';
export type SessionTier   = 'hot' | 'warm' | 'cold' | 'archive';

export interface SessionRow {
	id:             string;       // utf8; also encoded in the key
	repo:           string;
	summary:        string;
	seenEntities:   string[];     // entity-id strings
	createdAt:      number;
	expiresAt:      number;       // 0 if no TTL
	agent:          string;
	category:       string;
	status:         SessionStatus;
	lastActivityAt: number;
	tier:           SessionTier;
}

export const encodeSessionRow = (r: SessionRow): Buffer => encode(r);
export const decodeSessionRow = (b: Buffer): SessionRow => decode(b);

export type TurnType   = 'turn' | 'directive' | 'summary' | 'merged';
export type TurnFormat = 'text' | 'markdown' | 'tool';

export interface TurnRow {
	id:          string;
	sessionId:   string;          // also encoded in the key
	idx:         number;          // also encoded in the key
	userText:    string;
	assistant:   string;
	entities:    string[];
	createdAt:   number;
	repo:        string;
	type:        TurnType;
	tier:        SessionTier;
	compactedAt: number;          // 0 if not compacted
	sourceIds:   string[];
	format:      TurnFormat;
}

export const encodeTurnRow = (r: TurnRow): Buffer => encode(r);
export const decodeTurnRow = (b: Buffer): TurnRow => decode(b);

// ---------------------------------------------------------------------------
// Todo rows
// ---------------------------------------------------------------------------

export type TodoListStatus = 'active' | 'completed' | 'archived';
export type TodoItemStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

export interface TodoListRow {
	id:           string;
	sessionId:    string;
	parentListId: string;         // empty if top-level
	title:        string;
	description:  string;
	status:       TodoListStatus;
	owner:        string;
	source:       string;
	transfers:    string[];
	body:         string;
	createdAt:    number;
	updatedAt:    number;
}

export const encodeTodoListRow = (r: TodoListRow): Buffer => encode(r);
export const decodeTodoListRow = (b: Buffer): TodoListRow => decode(b);

export interface TodoItemRow {
	id:            string;
	listId:        string;          // also encoded in key
	title:         string;
	description:   string;
	status:        TodoItemStatus;
	orderKey:      string;          // also encoded in key
	createdAt:     number;
	updatedAt:     number;
	completedAt:   number;          // 0 if not completed
	blockedReason: string;
	tags:          string[];
	meta:          Record<string, unknown>;
}

export const encodeTodoItemRow = (r: TodoItemRow): Buffer => encode(r);
export const decodeTodoItemRow = (b: Buffer): TodoItemRow => decode(b);

export interface TodoCommentRow {
	id:                string;
	itemId:            string;          // also encoded in key
	author:            string;
	body:              string;
	createdAt:         number;
	editedAt:          number;          // 0 if not edited
	agentAcknowledged: boolean;
}

export const encodeTodoCommentRow = (r: TodoCommentRow): Buffer => encode(r);
export const decodeTodoCommentRow = (b: Buffer): TodoCommentRow => decode(b);

// ---------------------------------------------------------------------------
// Config entry row
// ---------------------------------------------------------------------------

export type ConfigCategory = 'template' | 'feedback' | 'convention';

export interface ConfigEntryRow {
	id:          string;          // also encoded in key
	scope:       string;          // serialized scope tuple
	namespace:   string;
	category:    ConfigCategory;
	language:    string;
	name:        string;
	filePath:    string;
	body:        string;
	tags:        string[];
	updatedAt:   number;
	contentHash: string;
}

export const encodeConfigEntryRow = (r: ConfigEntryRow): Buffer => encode(r);
export const decodeConfigEntryRow = (b: Buffer): ConfigEntryRow => decode(b);
