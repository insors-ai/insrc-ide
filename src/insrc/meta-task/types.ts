/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Meta-task framework wire shapes.
 *
 * Direct TypeScript translation of [`design/meta-tasks.html`](../../../design/meta-tasks.html) §5.
 * Discriminated unions on `kind`; readonly fields throughout; narrow string-literal enums.
 *
 * Every shape that crosses the cloud-LLM boundary lives here. Schema validation against these
 * shapes lives in `schema.ts` -- that's the gate every cloud-LLM response passes through.
 *
 * Design references:
 *   - §5.1 ContextRequest          -> `ContextRequest`
 *   - §5.2 Phase1Ask               -> `Phase1Ask`
 *   - §5.3 Phase1Result            -> `Phase1Result` / `ContextChunk`
 *   - §5.4 Phase2Out               -> `Phase2Out`
 *   - §6   Retry caps              -> `RetryCaps`
 *   - §3   Lifecycle               -> `MetaTaskLifecycleStage`
 *   - §8   Persistence layout      -> `MetaTaskMeta` / `StepDescriptor` / `Plan`
 *   - §9   Worktree mode           -> `WorktreeMode`
 */

import type { EntityKind } from '../shared/types.js';

// ---------------------------------------------------------------------------
// §5.1 ContextRequest -- typed slots the cloud LLM uses to ask the local LLM
// for context. Each slot maps 1:1 to an existing daemon query primitive
// (db/search.ts, db/entities.ts, db/conversations.ts, git, file IO).
// ---------------------------------------------------------------------------

export type ContextRequestEntities = {
	readonly kind:    'entities';
	readonly names?:  readonly string[] | undefined;
	readonly kinds?:  readonly EntityKind[] | undefined;
	readonly repos?:  readonly string[] | undefined;
};

export type ContextRequestFiles = {
	readonly kind:       'files';
	readonly globs:      readonly string[];
	readonly maxBytes?:  number | undefined;
};

export type ContextRequestDeliverable = {
	readonly kind:      'deliverable';
	readonly specId:    string;
	readonly heading?:  string | undefined;
};

export type ContextRequestSemantic = {
	readonly kind:   'semantic';
	readonly query:  string;
	readonly topK?:  number | undefined;
	readonly over?:  readonly ('entities' | 'deliverables')[] | undefined;
};

export type ContextRequestGraph = {
	readonly kind:    'graph';
	readonly op:      'callers' | 'callees' | 'imports' | 'importers' | 'closure';
	readonly targets: readonly string[];
	readonly depth?:  number | undefined;
};

export type ContextRequestGit = {
	readonly kind:         'git';
	readonly paths?:       readonly string[] | undefined;
	readonly since?:       string | undefined;
	readonly maxCommits?:  number | undefined;
};

export type ContextRequestTrace = {
	readonly kind:    'trace';
	readonly specId:  string;
};

export type ContextRequestMemory = {
	readonly kind:    'memory';
	readonly query?:  string | undefined;
};

export type ContextRequest =
	| ContextRequestEntities
	| ContextRequestFiles
	| ContextRequestDeliverable
	| ContextRequestSemantic
	| ContextRequestGraph
	| ContextRequestGit
	| ContextRequestTrace
	| ContextRequestMemory;

export type ContextRequestKind = ContextRequest['kind'];


// ---------------------------------------------------------------------------
// §5.2 Phase1Ask -- the cloud LLM's first response: either "sufficient" or
// a list of typed context requests. Empty `requests` on `context-needed` is
// rejected by the schema validator.
// ---------------------------------------------------------------------------

export type Phase1Ask =
	| { readonly kind: 'sufficient' }
	| { readonly kind:     'context-needed';
	    readonly requests: readonly ContextRequest[];
	    readonly intent?:  string | undefined };


// ---------------------------------------------------------------------------
// §5.3 Phase1Result -- what the local LLM emits after fulfilling the ask.
// `needs-narrowing` is the push-back channel: when a request is too broad
// the local LLM declines to truncate silently and emits a structured hint.
// ---------------------------------------------------------------------------

export type ContextChunkStatus =
	| 'ok'              // fulfilled cleanly within cap
	| 'empty'           // no matches
	| 'partial'         // truncated under cloud-set topK or explicit cap acceptance
	| 'needs-narrowing' // too broad to pick blindly; local LLM declined
	| 'error';          // fetch failed

export interface NarrowingHint {
	/** e.g. "500 files / 5 MB" -- the size of the matched set. */
	readonly matched: number;
	/** Concrete refinements the cloud LLM can apply (e.g. "narrow by dir: src/a, src/b, src/c"). */
	readonly suggestedFilters?: readonly string[] | undefined;
	/** Other ContextRequest kinds that would express this need more precisely. */
	readonly suggestedAlternativeKinds?: readonly ContextRequestKind[] | undefined;
	/** Free-text guidance. */
	readonly note?: string | undefined;
}

export interface ContextChunk {
	/** The originating request, echoed verbatim for traceability. */
	readonly request: ContextRequest;
	readonly status:  ContextChunkStatus;
	/** Payload shape depends on `request.kind`. Producers / consumers
	 *  agree on the shape per-kind; we don't type-narrow it here. */
	readonly payload: unknown;
	/** Local LLM's rationale ("picked top 5 by ANN"). */
	readonly note?: string | undefined;
	/** REQUIRED when `status === 'needs-narrowing'`. Schema enforces. */
	readonly narrowingHint?: NarrowingHint | undefined;
}

export interface Phase1ResultMeta {
	readonly totalBytes:       number;
	readonly elapsedMs:        number;
	/** Requests that fetched with `status: 'error'`. */
	readonly droppedRequests:  number;
}

export interface Phase1Result {
	readonly chunks: readonly ContextChunk[];
	readonly meta:   Phase1ResultMeta;
}


// ---------------------------------------------------------------------------
// §5.4 Phase2Out -- the cloud LLM's terminal output from phase 2. Either a
// finished deliverable, a context-needed escalation, or an abort with a
// declared resolution intent. `reason` required on `context-needed`;
// `resolution` required on `abort`.
// ---------------------------------------------------------------------------

export type AbortResolution = 'user-required' | 'plan-revisable';

export type Phase2Out =
	| { readonly kind: 'deliverable';
	    readonly body: string }
	| { readonly kind:     'context-needed';
	    readonly requests: readonly ContextRequest[];
	    readonly reason:   string;
	    readonly intent?:  string | undefined }
	| { readonly kind:        'abort';
	    readonly reason:      string;
	    readonly resolution:  AbortResolution;
	    readonly hint?:       string | undefined };


// ---------------------------------------------------------------------------
// §6 Retry caps. Two independent counters; caps default to 2 (narrowing) and
// 3 (context-needed). Surfaced as constants so the orchestrator and tests
// reference one source of truth.
// ---------------------------------------------------------------------------

export interface RetryCaps {
	readonly maxNarrowingRetries:     number;
	readonly maxContextNeededRetries: number;
}

export const DEFAULT_RETRY_CAPS: RetryCaps = {
	maxNarrowingRetries:     2,
	maxContextNeededRetries: 3,
};


// ---------------------------------------------------------------------------
// §3 Lifecycle stages -- used to drive the chat card badge + persistence.
// ---------------------------------------------------------------------------

export type MetaTaskLifecycleStage =
	| 'scope'
	| 'plan'
	| 'approve'
	| 'executing'
	| 'revising'
	| 'synthesize'
	| 'done'
	| 'aborted';


// ---------------------------------------------------------------------------
// §9 Worktree mode -- declared per template; routes the orchestrator's
// per-step worktree handling.
// ---------------------------------------------------------------------------

export type WorktreeMode = 'shared' | 'isolated' | 'none';


// ---------------------------------------------------------------------------
// §3 Scope manifest -- output of the scope step. Bounds every subsequent
// fetcher invocation (no slot may reach outside the scope's repo + globs).
// ---------------------------------------------------------------------------

export interface ScopeManifest {
	/** The user-supplied intent string (raw). */
	readonly intent: string;
	/** Absolute path of the source repo (single-repo for v1; matches the
	 *  chat session's bound repo, NOT `repos[0]`). */
	readonly repoPath: string;
	/** Glob patterns the meta-task is allowed to touch. Default `['**']`. */
	readonly inScopeGlobs: readonly string[];
	/** Paths explicitly excluded from in-scope. */
	readonly outOfScopePaths: readonly string[];
	/** Free-text findings from the scope step the planner uses as input. */
	readonly notes?: string | undefined;
}


// ---------------------------------------------------------------------------
// §3 Plan structures. Step descriptors live in the plan; the orchestrator
// executes them in order. Acceptance criteria reuse the handoff shape so
// downstream audit + reporting stay consistent.
// ---------------------------------------------------------------------------

export interface AcceptanceCriterion {
	readonly id:          string;
	readonly description: string;
	readonly kind:        'hard' | 'soft';
}

export interface StepDescriptor {
	/** Short human-readable name, surfaced in the live-step bubble label. */
	readonly name: string;
	/** Free-text intent describing what the step should produce. */
	readonly intent: string;
	readonly acceptance: readonly AcceptanceCriterion[];
	/** Optional override of the template's default cloud provider step binding. */
	readonly providerBinding?: string | undefined;
}

export interface Plan {
	readonly steps: readonly StepDescriptor[];
	/** Revision number, incremented each time the planner rewrites the tail. */
	readonly revision: number;
}


// ---------------------------------------------------------------------------
// §8 Meta-task identity + metadata persisted to disk on creation. Read at
// resume time to rebuild orchestrator state.
// ---------------------------------------------------------------------------

export interface MetaTaskMeta {
	readonly metaTaskId: string;
	readonly templateId: string;
	readonly intent:     string;
	readonly scope:      ScopeManifest;
	readonly worktreeMode: WorktreeMode;
	readonly startedAt:  string;       // ISO-8601
	readonly parentMetaTaskId?: string | undefined;
	/** User-driven plan revisions consumed so far (§7.2 cap). */
	readonly planRevisionCount: number;
}


// ---------------------------------------------------------------------------
// Deliverable catalog -- the phase-1 input the cloud LLM uses to find prior
// step outputs by reference. Carries names + headings only, never bodies.
// ---------------------------------------------------------------------------

export interface DeliverableCatalogEntry {
	/** The id under which the body is retrievable (specId for a referenced
	 *  handoff, or `step-<n>-<slug>` for a step in this meta-task). */
	readonly id: string;
	/** Human-readable label shown in the catalog ("M3 plan" / "spec-c6e..."). */
	readonly label: string;
	/** First-level `#` / `##` headings extracted from the body. */
	readonly headings: readonly string[];
	/** Byte size of the body on disk. */
	readonly bytes: number;
	/** Absolute path of the underlying file (for the fetcher). */
	readonly absPath: string;
}

export type DeliverableCatalog = readonly DeliverableCatalogEntry[];
