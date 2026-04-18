/**
 * Code analysis -- internal-focused quality / consistency / impact review.
 *
 * Distinct from research (external sources, free-form investigation).
 * Runs a two-pass pipeline: local model drafts the report, Claude
 * reviews the draft against the same code context and refines.
 */

export type CodeAnalysisConcern =
  | 'duplicates'          // semantically similar implementations
  | 'consistency'         // diverging patterns that should match
  | 'interface-mismatch'  // same concept with different type signatures
  | 'impact'              // downstream effects of a proposed change
  | 'smells';             // size, coupling, nesting, naming

export type FindingSeverity = 'info' | 'warn' | 'error';

export interface CodeAnalysisInput {
  /** Free-form target: question, file path, entity ID, or change description. */
  target: string;
  /** Concerns to check. Defaults to all except 'impact'. */
  concerns?: CodeAnalysisConcern[] | undefined;
  /** Search scope. Controls how much code context is pulled. */
  scope?: 'file' | 'module' | 'repo' | undefined;
}

export interface Finding {
  /** File path relative to repo root. Empty string if cross-file. */
  file: string;
  /** Optional 1-based line number. */
  line?: number | undefined;
  concern: CodeAnalysisConcern;
  severity: FindingSeverity;
  /** One-sentence description of the issue. */
  issue: string;
  /** Optional concrete suggestion / reference to related entities. */
  suggestion?: string | undefined;
}

export interface CodeAnalysisResult {
  findings: Finding[];
  /** Rendered markdown report (title + summary + grouped findings). */
  report: string;
  /** How the analysis was produced. */
  meta: {
    provider: 'local' | 'local+claude';
    reviewed: boolean;
    entityCount: number;
    concernsChecked: CodeAnalysisConcern[];
  };
}
