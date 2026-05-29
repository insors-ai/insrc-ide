/**
 * Memory + Context substrate -- core type contracts.
 *
 * P0 of plans/skills/substrate-implementation-status.md. These types
 * are the eventual target shape for the substrate; the P0 implementation
 * supports the narrow subset documented in plans/memory-context-
 * substrate.md (D1-D15 + D5a).
 *
 * Out of scope in P0 (declared but not consumed): byEmbedding queries,
 * context providers (D5a), async indexer DAG (D15), feedback bus (D8),
 * user-assertion classifier (D6). Each lands in P2-P5.
 *
 * The types are intentionally illustrative -- skill / agent authors
 * declare the substrate-facing fields on their own Skill objects and
 * the substrate consumes them at registration + execution time.
 */

// ---------------------------------------------------------------------------
// Owner identity (substrate D1)
// ---------------------------------------------------------------------------

/**
 * Every memory entry is owned; every context assembly is for an owner.
 * Naming convention: `<kind>:<id>` where `kind` distinguishes the class
 * of consumer (skills / agents / classifiers / orchestrators / indexers).
 *
 * Examples:
 *   - 'skill:code.class.extract-fields'
 *   - 'agent:pair'
 *   - 'classifier:intent'
 *   - 'orchestrator:data-analyzer'
 *   - 'indexer:core'
 */
export type OwnerId = string;

// ---------------------------------------------------------------------------
// Memory entries (substrate D4 trichotomy)
// ---------------------------------------------------------------------------

/**
 * Trichotomy of memory-entry authority. Drives conflict resolution
 * per substrate D4:
 *   - constraint: external authority (usually user); wins conflicts.
 *   - fact: derived from external truth; recomputable.
 *   - hint: statistical / pattern-based; soft signal.
 */
export type EntryKind = 'fact' | 'hint' | 'constraint';

/**
 * Where a memory entry came from. Tagged union -- substrate inspects
 * `kind` for distillation + telemetry; consumers may use the variant
 * payload for provenance display.
 */
export type EntrySource =
	| { readonly kind: 'bootstrap';     readonly trigger: BootstrapTrigger }
	| { readonly kind: 'cold-execute';  readonly ownerId: OwnerId; readonly at: number }
	| { readonly kind: 'observation';   readonly ledgerRef: LedgerRef; readonly executionRef: ExecutionRef; readonly tier: 'system-constraint' | 'pattern' | 'incidental' }
	| { readonly kind: 'feedback';      readonly eventId: string }
	| { readonly kind: 'user-asserted'; readonly turnId: string; readonly classifierDecisionRef?: MemoryEntryRef }
	| { readonly kind: 'provider';      readonly providerId: string }
	| { readonly kind: 'test';          readonly note?: string };

/**
 * Append-time stable handle to a memory entry. In P0 + P1 this resolves
 * to a file path on disk; consumers should treat it as opaque.
 */
export type MemoryEntryRef = string;

/**
 * The canonical view of a memory entry returned by reads.
 *
 * In storage (per substrate doc §"File format"), this is laid out as
 *   { _meta: <metadata block>, value: <typed payload> }
 * The MemoryEntry type flattens that for consumers.
 */
export interface MemoryEntry<T = unknown> {
	readonly key:         string;
	readonly value:       T;
	readonly kind:        EntryKind;
	readonly source:      EntrySource;
	readonly confidence:  number;                   // 0..1
	readonly writtenAt:   number;                   // unix ms
	readonly expiresAt?:  number;                   // unix ms; absent = no TTL
	readonly supersedes?: readonly MemoryEntryRef[];
	readonly supersededBy?: MemoryEntryRef;
}

/**
 * Caller-side metadata for `put`. The substrate stamps `writtenAt`
 * itself; `expiresAt` is derived from `ttlMs` when provided.
 */
export interface WriteMeta {
	readonly kind:        EntryKind;
	readonly source:      EntrySource;
	readonly confidence:  number;
	readonly ttlMs?:      number;
	readonly supersedes?: readonly MemoryEntryRef[];
}

// ---------------------------------------------------------------------------
// Query modes (substrate "Retrieval design")
// ---------------------------------------------------------------------------

export type EntryPredicate = (entry: MemoryEntry<unknown>) => boolean;

export type ContextQuery =
	| { readonly kind: 'byKey';       readonly key: string }
	| { readonly kind: 'prefix';      readonly prefix: string; readonly ascending?: boolean }
	| { readonly kind: 'byEmbedding'; readonly embedding: Float32Array; readonly topK: number }
	| { readonly kind: 'filter';      readonly predicate: EntryPredicate };

export interface ScanOpts {
	readonly limit?:             number;
	readonly ascending?:         boolean;
	readonly includeSuperseded?: boolean;
}

export interface AnnOpts {
	readonly topK:               number;
	readonly minSimilarity?:     number;
	readonly includeSuperseded?: boolean;
}

// ---------------------------------------------------------------------------
// Memory store API (substrate "Memory store")
// ---------------------------------------------------------------------------

export interface MemoryStore {
	/**
	 * Open a typed view of one (owner, namespace) pair. Substrate maintains
	 * one MemoryNamespace instance per (workspace, owner, namespace).
	 */
	scope(owner: OwnerId, namespace: string): MemoryNamespace;
}

export interface MemoryNamespace {
	/** Single-key read. O(1) -- opens the entry file by path. */
	get<T = unknown>(key: string): Promise<MemoryEntry<T> | undefined>;

	/**
	 * Atomic single-key write. Substrate applies conflict resolution
	 * (D4) before writing: read current entry, apply the namespace's
	 * merge policy (or the default), write the result via temp+rename.
	 */
	put<T = unknown>(key: string, value: T, meta: WriteMeta): Promise<MemoryEntryRef>;

	/** Single-key delete. Idempotent. */
	delete(key: string): Promise<void>;

	/**
	 * Prefix scan. Yields entries whose key starts with `prefix` in
	 * lexicographic order (ascending by default). Substrate filters out
	 * `supersededBy` entries unless `opts.includeSuperseded` is true.
	 */
	scan<T = unknown>(prefix: string, opts?: ScanOpts): AsyncIterable<MemoryEntry<T>>;

	/**
	 * Filter scan. Substrate walks every non-superseded entry in the
	 * namespace, applies `predicate`, yields matches.
	 *
	 * Expensive on large namespaces; prefer combining with prefix
	 * narrowing where possible.
	 */
	filter<T = unknown>(predicate: EntryPredicate, opts?: ScanOpts): AsyncIterable<MemoryEntry<T>>;

	/**
	 * Embedding-backed lookup. In P0+P1 always returns empty -- Lance
	 * integration lands in P2.
	 */
	searchByEmbedding<T = unknown>(queryEmbedding: Float32Array, opts: AnnOpts): Promise<readonly MemoryEntry<T>[]>;
}

// ---------------------------------------------------------------------------
// Working-state ledger (substrate "Working state ledger")
// ---------------------------------------------------------------------------

/** Stable handle to a working-state ledger entry within one execution. */
export type LedgerRef = string;

/** Stable handle to an execution. */
export type ExecutionRef = string;

/** Where a ledger entry came from (within one execution). */
export type LedgerSource =
	| { readonly kind: 'sub-call';  readonly skillId: string; readonly callRef: string }
	| { readonly kind: 'tool';      readonly toolId: string;  readonly callRef?: string }
	| { readonly kind: 'llm';       readonly provider: string; readonly callId: string }
	| { readonly kind: 'observation' }
	| { readonly kind: 'internal';  readonly note?: string };

/** An append-only entry in the working-state ledger. */
export interface LedgerEntry<T = unknown> {
	readonly ref:        LedgerRef;
	readonly source:     LedgerSource;
	readonly payload:    T;
	/** Factual claims this entry supports; used by self-grounding (A1). */
	readonly claims:     readonly string[];
	readonly confidence: number;
	readonly at:         number;
}

/**
 * Pin target -- when the substrate distills working state into memory
 * on a successful skill return, pinned entries land at the named
 * (owner, namespace, key) per D3's autoDistill policy.
 */
export interface DistillTarget {
	readonly owner:     OwnerId;
	readonly namespace: string;
	readonly key:       string;
	readonly kind:      EntryKind;
	readonly ttlMs?:    number;
}

export type LedgerFilter = (entry: LedgerEntry<unknown>) => boolean;

export interface WorkingStateLedger {
	/**
	 * Append a ledger entry. Returns the stable ref.
	 *
	 * Throws if the working-state size cap (D12) is hit. Substrate
	 * publishes a soft-warn telemetry event before that.
	 */
	append<T = unknown>(entry: Omit<LedgerEntry<T>, 'ref' | 'at'>): LedgerRef;

	/** List entries matching an optional filter. Insertion order. */
	list(filter?: LedgerFilter): readonly LedgerEntry<unknown>[];

	/** Lookup by ref. */
	get(ref: LedgerRef): LedgerEntry<unknown> | undefined;

	/**
	 * Mark an entry for distillation to memory on successful return.
	 * Substrate applies D3's autoDistill policy at distill time;
	 * pinning is the consumer's signal that the entry SHOULD persist.
	 */
	pin(ref: LedgerRef, target: DistillTarget): void;

	/** Internal: list of pins captured so far. Used by the distill engine. */
	pins(): readonly { readonly ref: LedgerRef; readonly target: DistillTarget }[];

	/** Current size -- used by consumers + D12 size-cap enforcement. */
	size(): { readonly entries: number; readonly bytes: number };
}

// ---------------------------------------------------------------------------
// Lifecycle: bootstrap triggers + context-builder spec (substrate D15)
// ---------------------------------------------------------------------------

export type BootstrapTriggerKind =
	| 'repo-add'
	| 'reindex'
	| 'connection-add'
	| 'refresh'
	| 'manual'
	| 'schema-bump';

export interface BootstrapTrigger {
	readonly kind:         BootstrapTriggerKind;
	readonly workspaceId:  string;
	readonly connectionId?: string;
	readonly repoPath?:    string;
}

/**
 * P0+P1 dispatch context-builders synchronously at registration.
 * P3 introduces the DAG runner + topo-sort + parallel-within-level.
 */
export interface BuilderInput {
	readonly trigger:     BootstrapTrigger;
	readonly triggerKind: BootstrapTriggerKind;
	readonly workspaceId: string;
}

export interface BuilderDeps {
	readonly memory: MemoryStore;
	readonly signal: AbortSignal;
}

export interface BuilderResult {
	readonly entriesWritten: number;
	readonly notes:          readonly string[];
}

export interface ContextBuilderSpec {
	readonly id:        string;
	readonly ownerId:   OwnerId;
	readonly triggers:  readonly BootstrapTriggerKind[];
	readonly dependsOn: readonly string[];
	build(input: BuilderInput, deps: BuilderDeps): Promise<BuilderResult>;
}

// ---------------------------------------------------------------------------
// Indexing policy + namespace spec (substrate D3 + "Indexing framework")
// ---------------------------------------------------------------------------

export type IndexingPolicy =
	| { readonly kind: 'never' }
	| { readonly kind: 'always' }
	| { readonly kind: 'on-flag' }
	| { readonly kind: 'derived'; readonly from: (entry: MemoryEntry<unknown>) => string };

export type AutoDistillMode = 'on-pin' | 'always-on-success' | 'never';

export interface NamespaceSpec {
	readonly namespace:   string;
	readonly valueType:   string;
	readonly autoDistill: AutoDistillMode;
	readonly indexing:    IndexingPolicy;
	/** Default TTL applied to entries without an explicit `ttlMs`. */
	readonly ttl?:        string;
}

// ---------------------------------------------------------------------------
// Context slots + assembled context (substrate "Context assembler")
// ---------------------------------------------------------------------------

export interface AssembleRequest {
	readonly owner:       OwnerId;
	readonly task:        unknown;
	readonly session:     unknown;
	readonly budget:      ContextBudget;
	readonly slots:       readonly ContextSlotRequest[];
}

export interface ContextSlotRequest {
	readonly name:      string;
	readonly fromOwner: OwnerId;
	readonly namespace: string;
	readonly query:     ContextQuery | ((req: AssembleRequest) => ContextQuery);
	readonly limit?:    number;
	readonly required?: boolean;
}

export interface ContextBudget {
	readonly maxTokens?:  number;
	readonly maxEntries?: number;
}

export interface ContextBudgetSnapshot {
	readonly tokensUsed?:  number;
	readonly entriesUsed?: number;
}

export interface AssembledContext {
	readonly slots:      ReadonlyMap<string, readonly MemoryEntry<unknown>[]>;
	readonly task:       unknown;
	readonly session:    unknown;
	readonly budgetUsed: ContextBudgetSnapshot;
	readonly notes:      readonly string[];
}

// ---------------------------------------------------------------------------
// Feedback events (substrate D8)
// ---------------------------------------------------------------------------

export type FeedbackKind = 'accepted' | 'refined' | 'rejected' | 'user-correction';

export interface FeedbackEvent {
	readonly id:           string;
	readonly kind:         FeedbackKind;
	readonly targetOwner:  OwnerId;
	readonly executionRef?: ExecutionRef;
	readonly memoryRefs:   readonly MemoryEntryRef[];
	readonly payload:      unknown;
	readonly source:       OwnerId;
	readonly at:           number;
}

// ---------------------------------------------------------------------------
// Assertion routing (substrate D14)
// ---------------------------------------------------------------------------

export interface AssertionInterest {
	readonly subjectPattern: string;
	readonly description:    string;
	readonly priority?:      number;
}

// ---------------------------------------------------------------------------
// Substrate-facing skill extension (consumed by lifecycle runner)
// ---------------------------------------------------------------------------

/**
 * Optional substrate-facing fields a Skill can declare. All optional --
 * a skill that opts out works as it does today.
 *
 * Skill authors declare these alongside the existing Skill<I, O> fields
 * (id, name, family, owner, execute, etc.). The substrate consumes them
 * at registration (memorySchema, contextBuilders, assertionInterests),
 * before execution (contextSlots), and after execution (distillation).
 */
export interface SubstrateSkillExtension {
	readonly ownerId?:            OwnerId;
	readonly schemaVersion?:      number;
	readonly interestedTriggers?: readonly BootstrapTriggerKind[];
	readonly contextSlots?:       readonly ContextSlotRequest[];
	readonly memorySchema?:       readonly NamespaceSpec[];
	readonly contextBuilders?:    readonly ContextBuilderSpec[];
	readonly assertionInterests?: readonly AssertionInterest[];
	applyFeedback?(events: readonly FeedbackEvent[], deps: FeedbackHandlerDeps): Promise<void>;
}

export interface FeedbackHandlerDeps {
	readonly memory: MemoryStore;
	readonly signal: AbortSignal;
}

// ---------------------------------------------------------------------------
// Context providers (substrate D5a -- P4)
// ---------------------------------------------------------------------------

/**
 * Read-only external source for context. Distinct from memory:
 *   - Providers don't accept writes / feedback / distillation.
 *   - One slot, one source -- consumer picks memory OR a provider.
 *   - Entries from a provider carry `source.kind: 'provider:<id>'`
 *     so consumers + grounding-review know not to "correct" them.
 *
 * Providers are referenced by `provider:<id>` in a slot's `fromOwner`.
 * The assembler routes the slot to the registered provider instead of
 * the memory store. Providers must answer cheaply -- assembly is
 * synchronous and blocks execution.
 *
 * Day-one providers (substrate doc §D5a):
 *   - 'user-config'    -- ~/.insrc/config.json
 *   - 'code-kg'        -- LMDB+Lance code knowledge graph
 *   - 'active-session' -- in-process session state
 */
export interface ContextProvider {
	readonly id:            string;
	readonly schemaVersion: number;
	read(slot: ContextSlotRequest, deps: ProviderDeps): Promise<readonly MemoryEntry<unknown>[]>;
}

/**
 * Dependencies a provider may consult. All optional -- a provider that
 * only reads disk doesn't need any of these. Adding a new dep here is
 * the right way to give a new provider what it needs; providers should
 * NOT reach for module-global state.
 */
export interface ProviderDeps {
	readonly signal:  AbortSignal;
	/** Active session (where applicable -- provider:active-session reads it). */
	readonly session?: unknown;
}

/**
 * Prefix used in `ContextSlotRequest.fromOwner` to route to the
 * provider registry instead of memory. Exported so consumers don't
 * have to hard-code the string.
 */
export const PROVIDER_OWNER_PREFIX = 'provider:';

/**
 * Helper: check whether a slot targets a provider rather than memory.
 * The assembler uses this to pick the routing path.
 */
export function isProviderOwner(owner: OwnerId): boolean {
	return owner.startsWith(PROVIDER_OWNER_PREFIX);
}

/** Pull the provider id out of `provider:<id>`. Throws on a non-provider owner. */
export function providerIdOf(owner: OwnerId): string {
	if (!isProviderOwner(owner)) {
		throw new SubstrateError(`not a provider owner: '${owner}'`, 'NOT_PROVIDER_OWNER');
	}
	return owner.slice(PROVIDER_OWNER_PREFIX.length);
}

// ---------------------------------------------------------------------------
// Indexing (substrate "Indexing framework" -- P2)
// ---------------------------------------------------------------------------

/**
 * Text embedder. The substrate uses the local Ollama embed model in
 * production; tests inject deterministic fakes. The substrate never
 * calls an embedder in parallel -- per the user's "no parallel LLM
 * calls" rule, indexing is serial.
 */
export interface Embedder {
	embed(text: string): Promise<Float32Array>;
}

/**
 * Indexer hook. Called by the memory-store wrapper after a successful
 * put / delete. Implementations look up the namespace's IndexingPolicy
 * and (if eligible) embed + write a Lance row.
 *
 * Per substrate doc §"Indexing framework", failures are fire-and-
 * forget: the file-side write is canonical, the index is a best-effort
 * accelerator. The wrapper logs + swallows errors so a flaky embedder
 * never breaks a memory write.
 */
export interface Indexer {
	onPut<T>(owner: OwnerId, namespace: string, entry: MemoryEntry<T>): Promise<void>;
	onDelete(owner: OwnerId, namespace: string, key: string): Promise<void>;
	/**
	 * Resolve a vector search: query the Lance index for the (owner,
	 * namespace) scope and read back the file entries for each hit.
	 * Returns entries in distance order. Stale / missing rows (file
	 * deleted out from under us) are skipped silently.
	 */
	search<T>(owner: OwnerId, namespace: string, queryEmbedding: Float32Array, opts: AnnOpts): Promise<readonly MemoryEntry<T>[]>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SubstrateError extends Error {
	override readonly name = 'SubstrateError';
	constructor(message: string, public readonly code: string) {
		super(message);
	}
}

/**
 * Thrown by the working-state ledger when an append would exceed the
 * hard cap (D12). Consumers can catch and distill-and-return-early.
 */
export class WorkingStateHardCapError extends SubstrateError {
	constructor(public readonly entries: number, public readonly bytes: number, public readonly cap: WorkingStateCap) {
		super(
			`Working-state hard cap exceeded (entries=${entries}, bytes=${bytes}, cap=${cap.maxEntries}/${cap.maxBytes})`,
			'WORKING_STATE_HARD_CAP',
		);
	}
}

export interface WorkingStateCap {
	readonly maxEntries: number;
	readonly maxBytes:   number;
}

export const DEFAULT_WORKING_STATE_SOFT_WARN: WorkingStateCap = {
	maxEntries: 1_000,
	maxBytes:   50 * 1024 * 1024,
};

export const DEFAULT_WORKING_STATE_HARD_CAP: WorkingStateCap = {
	maxEntries: 10_000,
	maxBytes:   500 * 1024 * 1024,
};

