/**
 * System prompts for the two-pass code-analysis pipeline.
 *
 * Both passes emit strict JSON -- the local draft is parsed and handed
 * back to Claude as prior context, and Claude's output is the final
 * source of truth when available.
 */

import type { CodeAnalysisConcern } from './types.js';

const CONCERN_DESCRIPTIONS: Record<CodeAnalysisConcern, string> = {
  duplicates:
    '"duplicates": semantically similar implementations scattered across files that could be consolidated.',
  consistency:
    '"consistency": patterns / conventions that diverge across the codebase (naming, error handling, async style, etc.).',
  'interface-mismatch':
    '"interface-mismatch": the same concept exposed with different type signatures or parameter orders.',
  impact:
    '"impact": downstream entities that would be affected by the proposed change. List callers, dependents, tests that reference the target.',
  smells:
    '"smells": size, coupling, nesting, naming, dead code, unclear separation of concerns.',
};

const FINDING_SHAPE = `{
  "file": "<path relative to repo root, or empty string if cross-file>",
  "line": <1-based line number or null>,
  "concern": "<duplicates|consistency|interface-mismatch|impact|smells>",
  "severity": "<info|warn|error>",
  "issue": "<one sentence describing the problem>",
  "suggestion": "<optional concrete fix or reference>"
}`;

function concernBlock(concerns: CodeAnalysisConcern[]): string {
  return concerns.map(c => '- ' + CONCERN_DESCRIPTIONS[c]).join('\n');
}

/** Local model draft prompt. Must emit strict JSON. */
export function buildLocalDraftPrompt(concerns: CodeAnalysisConcern[]): string {
  return `You are a code-quality analyst. You review an internal codebase (NOT external sources) and produce a structured findings report.

Focus exclusively on these concerns for this run:
${concernBlock(concerns)}

You are given the user's target / question and a context block with the most relevant code entities (names, files, bodies, relations). Ground every finding in the provided context -- do NOT invent files, line numbers, or entities that are not in the context.

Output ONLY valid JSON -- no markdown fences, no commentary. Shape:

{
  "summary": "<2-3 sentence assessment>",
  "findings": [
    ${FINDING_SHAPE}
  ]
}

Rules:
- Severity: "error" = broken / incorrect; "warn" = diverges from repo norms; "info" = worth noting, not actionable now.
- If the context has no evidence for a concern, do not emit findings for it.
- Prefer 3-10 high-signal findings over an exhaustive list.
- When multiple instances share the same issue (e.g. 5 files with the same duplication), emit ONE finding that names the files in the "suggestion" field.`;
}

/** Claude review prompt: refine the local draft using the same context. */
export function buildClaudeReviewPrompt(concerns: CodeAnalysisConcern[]): string {
  return `You are reviewing a code-quality analyst's draft report. You have the same target + code context the drafting model saw, plus the draft itself.

Your job:
1. Validate each finding against the context. Drop any finding whose evidence you cannot locate in the provided code.
2. Strengthen the "issue" and "suggestion" fields -- make them specific, actionable, grounded in file/line references.
3. Add any important findings the draft missed, within the requested concerns.
4. Adjust severities that feel inflated or understated.
5. Deduplicate overlapping findings.

Concerns in scope for this run:
${concernBlock(concerns)}

Output ONLY valid JSON in this shape -- no markdown fences, no commentary:

{
  "summary": "<2-3 sentence final assessment>",
  "findings": [
    ${FINDING_SHAPE}
  ]
}

Do not introduce findings that aren't supported by the code context. If the draft is largely correct, return it with minor edits rather than rewriting.`;
}
