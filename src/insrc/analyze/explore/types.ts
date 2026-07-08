/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Exploration types -- the vocabulary the decomposer emits and the
 * executor dispatches on.
 *
 * plans/exploration-based-context-build.md. An `Exploration` is a
 * typed unit with a purpose, a technique (`type`), params, and an
 * expected output schema. The decomposer picks from a fixed catalog;
 * the executor runs each one; the synthesizer composes the bundle
 * from bounded exploration outputs.
 *
 * V1 catalog focuses on structural-map (Phase 1 in the plan). Docs
 * + adherence + capability + convention explorations land in later
 * phases; their type tags are declared here so the executor can
 * refuse un-implemented types with a clear error rather than
 * silently mishandling them.
 */

// ---------------------------------------------------------------------------
// The fixed catalog of exploration types
// ---------------------------------------------------------------------------

/**
 * Every exploration type the framework knows about. Grouped by
 * category for readability. See plans/exploration-based-context-build.md
 * Section 4 for the design intent per type.
 */
export type ExplorationType =
	// --- structural resolvers (deterministic) ---
	| 'concept.resolve'
	| 'module.profile'
	| 'symbol.locate'
	| 'class.hierarchy'
	| 'import.graph'
	| 'test.locate'
	| 'usage.example'
	| 'capability.reuse-check'
	// --- doc-side (mostly deterministic; some narrow LLM) ---
	| 'doc.mention'
	| 'doc.decision.trace'
	| 'doc.constraint.enumerate'
	// --- convention detection ---
	| 'convention.detect'
	| 'config.trace'
	| 'data-model.trace'
	// --- fallback ---
	| 'freeform.probe';

/**
 * Which answer-type recipes the decomposer picks from.
 * plans/exploration-based-context-build.md Section 5.1 lists the
 * per-type exploration ordering. V1 only implements
 * 'structural-map'; the other tags exist so the decomposer's
 * output schema is stable across phases.
 */
export type AnswerType =
	| 'structural-map'
	| 'adherence-check'
	| 'decision-trace'
	| 'capability-discovery'
	| 'how-does-it-work'
	| 'prose-retrieval'
	| 'data-inventory'
	| 'infra-inventory';

// ---------------------------------------------------------------------------
// Exploration + plan shape
// ---------------------------------------------------------------------------

export interface Exploration {
	/** Stable id within the plan (`e1`, `e2`, ...). Used by later
	 *  explorations to reference earlier outputs via dependsOn. */
	readonly id:       string;
	readonly type:     ExplorationType;
	/** 1-line human-readable rationale from the decomposer. Preserved
	 *  through the exploration output so the synthesizer + a future
	 *  UI can render why each probe fired. */
	readonly purpose:  string;
	/** Type-specific params. Shape is validated by the executor per
	 *  exploration type at dispatch time. */
	readonly params:   Readonly<Record<string, unknown>>;
	/** Ids of earlier explorations whose outputs this reads. Empty
	 *  when the exploration is standalone. */
	readonly dependsOn?: readonly string[];
}

export interface ExplorationPlan {
	readonly answerType:    AnswerType;
	readonly explorations:  readonly Exploration[];
	/** 1-2 sentence guidance to the synthesizer. E.g. "Center the
	 *  bundle on the resolved module; treat imported dependencies
	 *  as context, not focus." */
	readonly synthesisHint: string;
}

// ---------------------------------------------------------------------------
// Per-exploration output payloads
// ---------------------------------------------------------------------------

/**
 * Every runner returns a typed structured payload -- never
 * free-form prose. The synthesizer reads these + composes the
 * bundle. Bundle citations must trace back to a field in some
 * exploration output (lint-enforced downstream).
 */

/** A single ranked hit from concept.resolve. */
export interface ConceptHit {
	/** Path shape:
	 *   - `dir:/abs/path/to/dir`  for directory / module matches
	 *   - `file:/abs/path/to/file` for file matches
	 *   - `entity:<entityId>`     for entity matches (function, class, ...)
	 */
	readonly kind:          'dir' | 'file' | 'entity';
	/** For `dir` / `file`, the absolute path. For `entity`, the
	 *  entity's containing file. */
	readonly path:          string;
	/** For entity hits, the entity's SHA-32 id. */
	readonly entityId?:     string;
	readonly name:          string;
	/** Composite match score in [0, 1]. Higher = better match. */
	readonly score:         number;
	/** Score breakdown, for debugging + synthesizer explainability. */
	readonly diagnostics:   {
		readonly tokenMatch?:      number;   // token-level path/name match
		readonly pathDepth?:       number;   // shallower paths score higher
		readonly graphInDegree?:   number;   // popular modules score higher
		readonly vectorSimilarity?: number;  // vector fallback
	};
}

export interface ConceptResolveOutput {
	readonly type:  'concept.resolve';
	readonly query: string;
	/** Ranked by score desc. Cap ~20. */
	readonly hits:  readonly ConceptHit[];
}

/** Compact profile of a module (directory-level) or a file. */
export interface ModuleProfile {
	readonly path:          string;
	/** kind='file' when the profile targets a single source file
	 *  rather than a directory. */
	readonly kind:          'dir' | 'file';
	readonly subdirs:       readonly string[];
	readonly filesInDir:    readonly {
		readonly file:      string;
		readonly language:  string;
		readonly bytes:     number;
		readonly kind:      string;
	}[];
	/** Names exported via `__all__` (Python), `export` (TS), etc.
	 *  Extracted from index / init files' entity list. */
	readonly exports:       readonly string[];
	/** Files with recognisable entry-point signatures (main handlers,
	 *  service registrations, HTTP routes, __init__.py, etc.). */
	readonly entrypoints:   readonly string[];
	/** Total entity count under this path (functions + classes +
	 *  methods + types + variables), non-artefact. */
	readonly entityCount:   number;
	/** Rough size in bytes across code files. */
	readonly totalBytes:    number;
}

export interface ModuleProfileOutput {
	readonly type:    'module.profile';
	readonly profile: ModuleProfile;
}

/** Symbol.locate hit -- one entity that matches the name lookup. */
export interface SymbolHit {
	readonly entityId:  string;
	readonly name:      string;
	readonly kind:      string;
	readonly file:      string;
	readonly startLine: number;
	readonly endLine:   number;
	readonly signature?: string;
}

export interface SymbolLocateOutput {
	readonly type:  'symbol.locate';
	readonly names: readonly string[];
	readonly hits:  readonly SymbolHit[];
}

/** Import-graph summary for a module or file. */
export interface ImportGraphSummary {
	readonly target:      string;
	/** Top-K importers (files that import from `target`), ranked by
	 *  edge count. */
	readonly topImporters:   readonly { file: string; edges: number }[];
	/** Top-K importees (files `target` imports from). */
	readonly topImportees:   readonly { file: string; edges: number }[];
	readonly totalInDegree:  number;
	readonly totalOutDegree: number;
}

export interface ImportGraphOutput {
	readonly type:    'import.graph';
	readonly summary: ImportGraphSummary;
}

// ---------------------------------------------------------------------------
// Doc-side exploration output payloads (Phase 2)
// ---------------------------------------------------------------------------

/** One retrieved section from doc.mention. */
export interface DocMentionHit {
	readonly entityId:  string;
	readonly file:      string;
	readonly heading:   string;
	readonly kind:      'document' | 'section' | 'config';
	readonly score:     number;
	readonly preview?:  string;
}

export interface DocMentionOutput {
	readonly type:    'doc.mention';
	readonly subject: string;
	readonly hits:    readonly DocMentionHit[];
}

/** One decision recorded in a doc + its citation. Preserves
 *  wording verbatim -- see prompts/analyze/docs.decision-trace.system.md. */
export interface DocDecisionRecord {
	readonly decision:       string;
	readonly sourceEntityId: string;
	readonly file:           string;
	readonly heading:        string;
	readonly rationale:      string;
}

export interface DocDecisionTraceOutput {
	readonly type:                  'doc.decision.trace';
	readonly topic:                 string;
	readonly decisions:             readonly DocDecisionRecord[];
	readonly notFoundNote:          string;
	readonly retrievedSectionCount: number;
}

/** One constraint stated in a doc + its citation. Preserves MUST /
 *  SHALL / HARD RULE language verbatim. */
export interface DocConstraintRecord {
	readonly constraint:     string;
	readonly kind:           'must' | 'should' | 'may' | 'hard-rule' | 'forbidden' | 'invariant';
	readonly sourceEntityId: string;
	readonly file:           string;
	readonly heading:        string;
	readonly rationale:      string;
}

export interface DocConstraintEnumerateOutput {
	readonly type:                  'doc.constraint.enumerate';
	readonly subject:               string;
	readonly constraints:           readonly DocConstraintRecord[];
	readonly notFoundNote:          string;
	readonly retrievedSectionCount: number;
}

/** Placeholder for the not-yet-implemented types. Executor writes
 *  this + an errorCode when a decomposer emits an unsupported
 *  exploration in Phase 1. Downstream (synthesizer) renders it as
 *  a diagnostic + continues. */
export interface UnsupportedExplorationOutput {
	readonly type:      'unsupported';
	readonly requested: ExplorationType;
	readonly reason:    string;
}

export interface FailedExplorationOutput {
	readonly type:      'failed';
	readonly requested: ExplorationType;
	readonly errorCode: string;
	readonly message:   string;
}

export type ExplorationOutput =
	| ConceptResolveOutput
	| ModuleProfileOutput
	| SymbolLocateOutput
	| ImportGraphOutput
	| DocMentionOutput
	| DocDecisionTraceOutput
	| DocConstraintEnumerateOutput
	| UnsupportedExplorationOutput
	| FailedExplorationOutput;

// ---------------------------------------------------------------------------
// Execution shape
// ---------------------------------------------------------------------------

/**
 * The executor runs each exploration + returns a keyed result map.
 * Order is preserved (mirrors ExplorationPlan.explorations) so the
 * synthesizer can iterate deterministically.
 */
export interface ExecutedExploration {
	readonly exploration: Exploration;
	readonly output:      ExplorationOutput;
	readonly cached:      boolean;
	readonly elapsedMs:   number;
}

export interface ExecutedPlan {
	readonly plan:        ExplorationPlan;
	readonly results:     readonly ExecutedExploration[];
	readonly totalMs:     number;
	readonly totalCached: number;
}

// ---------------------------------------------------------------------------
// Runner interface
// ---------------------------------------------------------------------------

/**
 * Per-type runner. Each runner:
 *   - reads its params (already validated by the executor at dispatch)
 *   - reads any dependent outputs via `readDep`
 *   - returns a typed ExplorationOutput
 *
 * Runners MUST NOT throw for tool-side failures. Wrap errors in a
 * `FailedExplorationOutput` so downstream stages see a structured
 * failure rather than an exception. Runtime crashes (assertion
 * failures, LMDB txn errors) still throw as usual.
 */
export interface ExplorationRunnerContext {
	readonly runId:       string;
	readonly repoPath:    string;
	readonly closureRepos: readonly string[];
	/** Read a prior exploration's output by id. Returns undefined
	 *  when the id doesn't resolve (should not happen if the
	 *  decomposer emitted a valid dependsOn). */
	readonly readDep: (id: string) => ExplorationOutput | undefined;
}

export type ExplorationRunner = (
	exp: Exploration,
	ctx: ExplorationRunnerContext,
) => Promise<ExplorationOutput>;
