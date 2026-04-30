/**
 * Data Analyzer types.
 *
 * Mirrors the shape of agent/tasks/code-analyzer/types.ts but with
 * data-specific concepts: citation kinds branch on RDBMS / KV / file
 * (and optionally code cross-references for lineage findings); the
 * concern enum covers schema-drift / pii-exposure / lineage-gap /
 * consistency / capacity-risk; AnalysisKind covers inspect-schema /
 * sample-data / sample-shape / lineage / schema-drift / er / free-form.
 *
 * See plans/analyzers/data-analyzer.md sections 1.1 (Types) and 5.1
 * (TodoItem meta shape).
 */

// Re-export shared confidence + severity + ToolCallSummary from the
// code-analyzer types to keep one source of truth (these are family-
// agnostic concepts; the code-analyzer happened to define them first).
export type { Confidence, FindingSeverity, ToolCallSummary } from '../code-analyzer/types.js';
import type { Confidence, FindingSeverity, ToolCallSummary } from '../code-analyzer/types.js';

// ---------------------------------------------------------------------------
// Analysis kind
// ---------------------------------------------------------------------------

/**
 * Per-task analysis kind. The orchestrator's plan emits one per task;
 * the runner branches on it to pick the right tool sequence.
 */
export type DataAnalysisKind =
  | 'inspect-schema'   // describe a table / collection / key pattern
  | 'sample-data'      // pull rows / values for shape + content review
  | 'sample-shape'     // KV / document inferShape over many values
  | 'lineage'          // cross-link table to code that reads / writes it
  | 'schema-drift'     // expected (Prisma / ORM / static) vs live shape
  | 'er'               // ER topology over a set of tables
  | 'free-form';       // fallback when none of the above fit

export const DATA_ANALYSIS_KINDS: readonly DataAnalysisKind[] = [
  'inspect-schema', 'sample-data', 'sample-shape', 'lineage',
  'schema-drift', 'er', 'free-form',
] as const;

// ---------------------------------------------------------------------------
// Concern enum
// ---------------------------------------------------------------------------

/** What concern a finding addresses. Reviewed by the cloud reviewer. */
export type DataAnalysisConcern =
  | 'schema-drift'      // expected shape diverges from live shape
  | 'pii-exposure'      // unmasked PII surfaced in a sample
  | 'lineage-gap'       // table referenced in code with no live target / orphan
  | 'consistency'       // shape varies across rows / values that should match
  | 'capacity-risk';    // row count / cardinality / value-size approaching a limit

export const DATA_ANALYSIS_CONCERNS: readonly DataAnalysisConcern[] = [
  'schema-drift', 'pii-exposure', 'lineage-gap', 'consistency', 'capacity-risk',
] as const;

// ---------------------------------------------------------------------------
// Citation kinds
// ---------------------------------------------------------------------------

/**
 * RDBMS citation: connection + (schema / table / column) + an optional
 * sample value snippet. The renderer turns this into a `data-conn:`
 * URI (see workbench/code-analyzer/pathUriOpener pattern) so clicks
 * navigate to the dbDrivers pane focused on the cited target.
 */
export interface RdbmsCitation {
  readonly kind: 'rdbms';
  readonly connectionId: string;
  readonly schema?: string | undefined;
  readonly table: string;
  readonly column?: string | undefined;
  /** Up to 1 KB of inlined sample text; longer values truncated. */
  readonly sampleValue?: string | undefined;
  /** Schema fingerprint at sampling time -- enables cache invalidation. */
  readonly introspectionVersion?: string | undefined;
}

/**
 * KV / document-store citation. `keyPattern` is the canonical pattern
 * (`user:{id}:profile`, `cart:{userId}`, etc.); `fieldPath` points at a
 * specific field within a document for nested shapes.
 */
export interface KvCitation {
  readonly kind: 'kv';
  readonly connectionId: string;
  readonly keyPattern: string;
  readonly fieldPath?: string | undefined;
  readonly sampleValue?: string | undefined;
}

/**
 * File-driver citation (csv / parquet / jsonl / etc.).
 */
export interface FileSourceCitation {
  readonly kind: 'file-source';
  readonly connectionId: string;
  readonly path: string;
  readonly column?: string | undefined;
  readonly sampleValue?: string | undefined;
}

/**
 * Code cross-reference citation. Emitted by lineage findings (where a
 * table / collection is read / written by a specific code site).
 * Shape mirrors the code-analyzer's CodeCitation but with explicit
 * `kind` discriminator so the renderer can dispatch.
 */
export interface CodeRefCitation {
  readonly kind: 'code-ref';
  readonly path: string;
  readonly lineStart?: number | undefined;
  readonly lineEnd?: number | undefined;
  readonly snippet?: string | undefined;
  /** The graph entity id, when known. */
  readonly entityId?: string | undefined;
}

export type DataCitation =
  | RdbmsCitation
  | KvCitation
  | FileSourceCitation
  | CodeRefCitation;

// ---------------------------------------------------------------------------
// Findings + AnalyzerResult
// ---------------------------------------------------------------------------

export interface DataFinding {
  readonly concern: DataAnalysisConcern;
  readonly severity: FindingSeverity;
  readonly issue: string;
  /** Non-empty by invariant (citations validator rejects otherwise). */
  readonly citations: readonly DataCitation[];
}

/**
 * Why a task moved to `blocked` instead of `completed`. Distinguishes
 * gate-denials so the synthesise step can suggest the right re-run
 * (different connection vs. PII-approval).
 */
export type BlockedReason =
  | 'connection-denied'
  | 'pii-gate-denied'
  | 'no-connections';

/**
 * Parsed per-task analyzer output. Invariants enforced by the parser
 * + citations validator:
 *  - `itemId` matches `task.itemId`.
 *  - Every `findings[].citations` array is non-empty (or
 *    `blockedReason` is set).
 *  - `confidence` is one of high / medium / low.
 *  - `truncated === true` when the analyzer hit its own per-task budget.
 */
export interface DataAnalyzerResult {
  readonly itemId: string;
  readonly answer: string;
  readonly findings: readonly DataFinding[];
  readonly citations: readonly DataCitation[];
  readonly confidence: Confidence;
  readonly toolCalls: readonly ToolCallSummary[];
  readonly truncated?: boolean | undefined;
  /** Set when a gate denied this task; analyzer skips the LLM turn. */
  readonly blockedReason?: BlockedReason | undefined;
}

// ---------------------------------------------------------------------------
// Task scope + DataAnalysisTask + per-item meta
// ---------------------------------------------------------------------------

export interface DataAnalysisScope {
  /** Connection ids the task is restricted to (empty = "any"). */
  readonly connections?: readonly string[] | undefined;
  /** Tables / collections / key patterns the task should focus on. */
  readonly targets?: readonly string[] | undefined;
}

export type DataTaskOrigin = 'plan' | 'follow-up';

/**
 * One unit task as emitted by the plan step. Threaded through the
 * orchestrator and into the runner.
 */
export interface DataAnalysisTask {
  readonly itemId: string;
  readonly kind: DataAnalysisKind;
  readonly question: string;
  readonly scope?: DataAnalysisScope | undefined;
  readonly origin: DataTaskOrigin;
  readonly hint?: string | undefined;
}

/**
 * Wire shape of `TodoItem.meta` for data-analyzer items. The framework
 * treats meta as opaque; this shape is the analyzer's contract with
 * itself + the todos pane row renderer.
 */
export interface DataAnalysisItemMeta {
  readonly kind: DataAnalysisKind;
  readonly scope?: DataAnalysisScope | undefined;
  readonly origin: DataTaskOrigin;
  readonly retryCount: number;
  readonly hint?: string | undefined;
  // -- Populated on completion ------------------------------------------------
  readonly answer?: string | undefined;
  readonly findings?: readonly DataFinding[] | undefined;
  readonly citations?: readonly DataCitation[] | undefined;
  readonly confidence?: Confidence | undefined;
  readonly toolCalls?: readonly ToolCallSummary[] | undefined;
  readonly truncated?: boolean | undefined;
  // -- Populated on cancellation / gate denial -------------------------------
  readonly cancelReason?: string | undefined;
  readonly blockedReason?: BlockedReason | undefined;
}

// ---------------------------------------------------------------------------
// Connection summary (for the plan prompt + access gate)
// ---------------------------------------------------------------------------

/**
 * One row of `db:list_connections` output, projected for prompt rendering.
 * Stored in `K_STATE` so the plan / analyzer steps see the same view.
 */
export interface ConnectionSummary {
  readonly id: string;
  /** Driver family: rdbms / kv / file / etc. (mirrors data-driver naming.) */
  readonly family: 'rdbms' | 'kv' | 'file' | 'other';
  /** Driver kind: postgres / mysql / redis / sqlite / parquet / ... */
  readonly kind: string;
  /** User-supplied label or auto-generated ("primary", "cache", ...). */
  readonly label?: string | undefined;
  /** True when the connection is flagged production in db-connections.json. */
  readonly prod: boolean;
  /** True when the connection has at least one PII pattern config. */
  readonly hasPiiConfig: boolean;
}
