/**
 * Code Analyzer types.
 *
 * Read-only structural / semantic analysis of the active repo via a
 * cloud-orchestrated, locally-executed pipeline. Coexists with the
 * legacy `agent/tasks/code-analysis/types.ts` until Phase 2.6.b deletes
 * the legacy controller; until then the two type sets are independent.
 *
 * See `plans/analyzers/code-analyzer.md` section 1.1 and
 * `design/analyzers/code-analyzer.html` sections 5.1, 7.1, 8 for the
 * authoritative shapes.
 */

// ---------------------------------------------------------------------------
// Concerns / severity / finding -- ported from the legacy code-analysis
// types.ts and extended with the citations field the new pipeline requires.
// ---------------------------------------------------------------------------

export type CodeAnalysisConcern =
  | 'duplicates'          // semantically similar implementations
  | 'consistency'         // diverging patterns that should match
  | 'interface-mismatch'  // same concept with different type signatures
  | 'impact'              // downstream effects of a proposed change
  | 'smells';             // size, coupling, nesting, naming

export type FindingSeverity = 'info' | 'warn' | 'error';

/**
 * A single finding produced by the analyzer. Every claim must trace
 * back to at least one `CodeCitation`; the citations invariant
 * (Phase 1.5) rejects results with empty citation arrays on any
 * finding and retries once before accepting with `confidence: 'low'`.
 */
export interface Finding {
  /** File path relative to repo root. Empty string if cross-file. */
  readonly file: string;
  /** Optional 1-based line number. Prefer `lineRange` on a citation. */
  readonly line?: number | undefined;
  readonly concern: CodeAnalysisConcern;
  readonly severity: FindingSeverity;
  /** One-sentence description of the finding. */
  readonly issue: string;
  /** Optional concrete suggestion / reference to related entities. */
  readonly suggestion?: string | undefined;
  /**
   * Citations grounding the finding. Required and non-empty -- the
   * citations invariant rejects findings with `citations.length === 0`.
   * Also see `AnalyzerResult.citations`, the deduplicated union across
   * all findings in one task result.
   */
  readonly citations: readonly CodeCitation[];
}

// ---------------------------------------------------------------------------
// Per-task contract: one AnalysisTask in, one AnalyzerResult out.
// ---------------------------------------------------------------------------

/**
 * Task kinds the planner emits and the analyzer's per-kind playbook
 * recognises. Each kind narrows the analyzer's tool-call sequencing
 * (vector-first for locate, neighbours-first for trace, etc.) per the
 * system prompt in `~/.insrc/code-analyzer/analyzer.md`.
 *
 * Note: `inspect-schema` lives in the Data Analyzer family, not here.
 */
export type AnalysisKind =
  | 'locate'
  | 'describe'
  | 'trace'
  | 'compare'
  | 'free-form';

/**
 * Direction for trace tasks. Kept narrow here so the planner prompt
 * can enforce the union exactly.
 */
export type TraceDirection = 'callers' | 'callees' | 'both';

/**
 * Origin tag for a task. `plan` items come from the initial planner
 * output; `follow-up` items are spawned by the reviewer's
 * `add-follow-up` decision during the run.
 */
export type TaskOrigin = 'plan' | 'follow-up';

/** Optional scope hints attached to a task. */
export interface AnalysisScope {
  readonly entityIds?: readonly string[] | undefined;
  readonly paths?: readonly string[] | undefined;
  readonly packages?: readonly string[] | undefined;
  /** Trace direction. Only meaningful when `kind === 'trace'`. */
  readonly direction?: TraceDirection | undefined;
  /** Compare targets. Exactly two entityIds when `kind === 'compare'`. */
  readonly targets?: readonly [string, string] | undefined;
}

/**
 * Single unit of work the analyzer receives from the orchestrator.
 * The orchestrator builds this from a `TodoItem` (item.title /
 * item.description / item.meta) before each analyzer.run() call.
 */
export interface AnalysisTask {
  /** Matches the underlying TodoItem.id. The analyzer never invents ids. */
  readonly itemId: string;
  readonly kind: AnalysisKind;
  /** Full question for the analyzer; complete sentence, not a label. */
  readonly question: string;
  readonly scope?: AnalysisScope | undefined;
  /** Reviewer's last `retryHint`, if this is a retry. */
  readonly hint?: string | undefined;
  readonly origin: TaskOrigin;
  /** Number of times this task has been retried. Capped at 2. */
  readonly retryCount: number;
}

/**
 * The seed the planner / reviewer hands to `addItem` -- itemId is
 * assigned by the framework (ULID), origin and retryCount are stamped
 * by the orchestrator.
 */
export type AnalysisTaskSeed = Omit<AnalysisTask, 'itemId' | 'origin' | 'retryCount'>;

/**
 * A single citation grounding a finding or claim in the analyzer's
 * answer prose. Every cited span must have been read in the same task
 * turn that produced the finding (see the analyzer system prompt's
 * "indexes are pointers, not answers" hard rule).
 */
export interface CodeCitation {
  /** When the citation resolves to a graph entity. */
  readonly entityId?: string | undefined;
  readonly path: string;
  readonly lineStart?: number | undefined;
  readonly lineEnd?: number | undefined;
  /** At most ~200 chars; longer snippets are truncated by the parser. */
  readonly snippet?: string | undefined;
}

/** Confidence band the analyzer assigns to the result. */
export type Confidence = 'high' | 'medium' | 'low';

/**
 * Compact trace of a single tool call inside the analyzer's per-task
 * loop. Useful for review-prompt context ("the analyzer didn't widen
 * its search") and for debug logs. The `argsHash` is a SHA256 over a
 * canonical argument JSON so traces don't leak path strings.
 */
export interface ToolCallSummary {
  readonly name: string;
  readonly argsHash: string;
  readonly durationMs: number;
  /** Result count -- entities, lines, neighbours, etc. */
  readonly resultRows: number;
  /** Set when the call returned an error or sentinel. */
  readonly error?: string | undefined;
}

/**
 * Parsed analyzer output for one task.
 *
 * Invariants (enforced by the parser + citations validator):
 *  - `itemId` matches `task.itemId`.
 *  - Every `Finding.citations` array is non-empty.
 *  - `confidence` is one of the three bands.
 *  - `truncated === true` when the analyzer hit its own per-task budget
 *    (8 tool calls / 60 s / 2 MB cumulative fs.read).
 */
export interface AnalyzerResult {
  readonly itemId: string;
  /** Concise prose, 1-3 paragraphs. */
  readonly answer: string;
  readonly findings: readonly Finding[];
  /**
   * Deduplicated union of every citation referenced from any finding
   * in this result. The synthesise step preserves these as clickable
   * links in the rendered report.
   */
  readonly citations: readonly CodeCitation[];
  readonly confidence: Confidence;
  readonly toolCalls: readonly ToolCallSummary[];
  readonly truncated?: boolean | undefined;
  /**
   * Foreign citations from cross-agent dispatches (Phase 3.5). When
   * the analyzer's run-task LLM calls `data:*` or `deploy:*` tools
   * (sibling families' surface) the structured results land here so
   * the synthesise step can render them under their own
   * ## subsection -- never inline with code citations. Shapes are
   * declared by the sibling families; this plan declares them
   * opaque (`Record<string, unknown>`) per design §13.3 until those
   * siblings ship and tighten the type.
   */
  readonly foreignCitations?: ForeignCitations | undefined;
}

/**
 * Cross-agent citation bundle (Phase 3.5). One bucket per sibling
 * family; entries are opaque to the Code Analyzer -- DataCitation /
 * DeployCitation shapes live in the sibling families' own modules.
 */
export interface ForeignCitations {
  readonly data?: readonly Record<string, unknown>[] | undefined;
  readonly deploy?: readonly Record<string, unknown>[] | undefined;
}

// ---------------------------------------------------------------------------
// Per-item meta: stashed onto TodoItem.meta via deps.todos.updateItemMeta.
// ---------------------------------------------------------------------------

/**
 * Wire shape of `TodoItem.meta` for code-analyzer items. The framework
 * treats meta as opaque; this shape is the analyzer's contract with
 * itself + the todos pane row renderer (which surfaces the kind badge,
 * confidence pill, and citation count by reading these fields).
 */
export interface AnalysisItemMeta {
  readonly kind: AnalysisKind;
  readonly scope?: AnalysisScope | undefined;
  readonly origin: TaskOrigin;
  readonly retryCount: number;
  readonly hint?: string | undefined;
  // -- Populated on completion ------------------------------------------------
  readonly answer?: string | undefined;
  readonly findings?: readonly Finding[] | undefined;
  readonly citations?: readonly CodeCitation[] | undefined;
  readonly confidence?: Confidence | undefined;
  readonly toolCalls?: readonly ToolCallSummary[] | undefined;
  readonly truncated?: boolean | undefined;
  // -- Populated on cancellation / failure -----------------------------------
  /** Free-text reason when the orchestrator cancels the item. */
  readonly cancelReason?: 'user-cancelled' | 'cap-hit' | 'reviewer-done' | string | undefined;
  /** Set by the parser when the analyzer's JSON was malformed and
   *  one strict-JSON retry already exhausted. */
  readonly warning?: string | undefined;
  /** Set when both rounds of the writeSectionWithTools → reviewAction
   *  loop returned `verdict: 'needs-work'`. Carries a concatenation of
   *  the reviewer's last work-item actions so the user can inspect why
   *  the section couldn't be drafted (the section body itself is a
   *  degraded marker in this case). */
  readonly failureReason?: string | undefined;
}

// ---------------------------------------------------------------------------
// Reviewer decision shape (cloud LLM, no tools).
// ---------------------------------------------------------------------------

/**
 * Discriminated-union output of the per-task reviewer step. Strict
 * JSON; the parser rejects any extra fields the model adds.
 *
 * - `accept` -- analyzer result is solid; mark item complete.
 * - `retry-with-hint` -- result is on-topic but thin; re-run the same
 *   task with the supplied hint. Per-task retry cap = 2.
 * - `add-follow-up` -- result raised 1-2 questions worth chasing;
 *   spawn new items on the same list with origin = 'follow-up'.
 * - `done` -- the user's original request is fully covered; cancel
 *   remaining pending items and jump to synthesise.
 */
export type ReviewerDecision =
  | { readonly decision: 'accept'; readonly rationale: string }
  | {
      readonly decision: 'retry-with-hint';
      readonly rationale: string;
      readonly retryHint: string;
    }
  | {
      readonly decision: 'add-follow-up';
      readonly rationale: string;
      /** 0..2 follow-up tasks. The orchestrator drops anything past 2. */
      readonly followUps: readonly AnalysisTaskSeed[];
    }
  | { readonly decision: 'done'; readonly rationale: string };

// ---------------------------------------------------------------------------
// Repo summary -- planner input.
// ---------------------------------------------------------------------------

/**
 * Compact summary of the active repo, fed to the planner alongside the
 * user's request. The planner uses it to decompose the request into
 * scope-aware tasks (e.g. "look in src/auth/, not in tests/").
 *
 * Built once at planner-step entry from the daemon's existing repo
 * context; not refreshed per task.
 */
export interface RepoSummary {
  /** Repo name as the indexer knows it. */
  readonly name: string;
  /** Absolute filesystem path of the active repo root. */
  readonly rootPath: string;
  /** Primary language(s) detected by the indexer. Most-common first. */
  readonly primaryLanguages: readonly string[];
  /** Top-level package / module names (e.g. "auth", "db", "indexer"). */
  readonly topLevelPackages: readonly string[];
  /**
   * Number of repos in the transitive DEPENDS_ON closure (including
   * the active repo itself). Helps the planner decide how aggressively
   * to scope cross-repo questions.
   */
  readonly closureSize: number;
  /**
   * Repo snapshot id at planner-step entry. Threaded through to the
   * per-task cache key so a re-index invalidates cached results.
   */
  readonly repoSnapshotId: string;
}

// ---------------------------------------------------------------------------
// Controller state -- persisted via TaskStateStore between turns.
// ---------------------------------------------------------------------------

/**
 * Controller-owned state that the framework's TodoList does not
 * model. Items, comments, follow-ups, transfer history, and inline
 * chat rendering all live in the framework; this state stays small.
 *
 * `approvedDirs` is part of the persisted state on purpose -- a
 * daemon crash mid-run rehydrates the grant so the access gate
 * doesn't re-fire on resume. A new chat session starts with an empty
 * approved set.
 */
export interface CodeAnalysisState {
  /** Original user message; rehydrated into the planner prompt on resume. */
  readonly request: string;
  readonly repoSummary: RepoSummary;
  /**
   * Scope tier (S/M/L/XL/XXL/XXXL/XXXXL) the sizing classifier emitted
   * for this run. Drives planner caps, per-task wall-clock budget, and
   * (Phase 5.B) the per-tier playbook. Stored on state so a rehydrated
   * run after a daemon crash keeps the same caps it started with.
   * Defaults to `'M'` for runs from before Phase 5.A landed.
   */
  readonly tier: import('../../../shared/classify.js').ScopeSize;
  /** Primary TodoList id -- source of truth for plan / progress. */
  readonly listId: string;
  /** Any sub-lists spawned for large follow-up batches. */
  readonly childListIds: readonly string[];
  /** The item in_progress right now, if any. */
  readonly currentItemId?: string | undefined;
  /** Set when the tier-driven hard cap was hit. */
  readonly truncated: boolean;
  /** Set when the user issued a mid-flight cancel. */
  readonly cancelled: boolean;
  /**
   * Absolute paths the user has approved for out-of-repo reads in
   * this chat session. Includes neither the active repo root nor its
   * descendants -- those are implicitly approved.
   */
  readonly approvedDirs: readonly string[];
  /**
   * Final synthesised report text. Mirrored to `list.body` for the
   * framework's view; kept here for resume convenience.
   */
  readonly finalReport?: string | undefined;
  /** URI of the ephemeral AnalysisReportPane tab. Phase 2 sets this. */
  readonly reportUri?: string | undefined;
  readonly presentedAt?: number | undefined;
}
