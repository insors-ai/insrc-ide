/**
 * Local-LLM final synthesis prompt.
 *
 * Composes the final Markdown report from accepted findings + the
 * citation set + the user's original request. Local LLM by default
 * because the cloud already did the reasoning work in plan + review;
 * the local model just composes prose from inputs it has in hand.
 * Cloud upgrade available via @anthropic / @openai for users who
 * want a cloud-grade write-up.
 *
 * See `design/analyzers/code-analyzer.html` section 6.4.3.
 *
 * Phase 5.C (plans/analyzers/code-analyzer.md §5.4): per-tier output
 * shape. The single PR_kind playbook is split into a universal HEAD +
 * tier-specific guidance + a always-emit "Drill down" footer:
 *
 *   - S / M -> the original markdown shape (one section per finding,
 *     embedded code blocks, prose paragraphs). Output is short enough
 *     for the local model's single-pass window.
 *   - L / XL -> tabular summaries; per-module h2 sections; signature-
 *     level bodies. Denser than S/M because L/XL doc volume is large
 *     enough to hit devstral's `num_predict` ceiling on prose-heavy
 *     paragraphs (F10 hit "Unterminated string in JSON at position
 *     13186" on a verbose 13 KB output). Tables + bullets pack the
 *     same information into ~half the tokens.
 *   - XXL+ -> module map + responsibility table + dependency-edge
 *     list. The structure IS the finding -- no `## Findings` section.
 *     Built for "describe the entire repo" prompts where per-line
 *     citations would drown the reader.
 *
 * Multi-pass content generation (plans/content-generator.md) is the
 * planned long-term fix for L/XL/XXL+ truncation; the prompts here
 * still assume single-pass. When `agent/content-gen/` ships, the
 * orchestrator's queueSynthesise will route L+ tiers through
 * generateMultiPass() with the tier-specific outline + section
 * prompts derived from these guidance blocks.
 */

import type { LLMMessage } from '../../../../shared/types.js';
import type { ScopeSize } from '../../../../shared/classify.js';
import type { AnalysisTask, AnalyzerResult, ForeignCitations } from '../types.js';

// ---------------------------------------------------------------------------
// Universal HEAD: input contract + universal rules. Tier-agnostic.
// ---------------------------------------------------------------------------

const SYNTHESISE_SYSTEM_HEAD = `You are the synthesis writer for the Code Analyzer agent. You compose
the final Markdown report from accepted findings.

# Inputs

- The user's original request.
- The accepted findings, each tagged with its task kind + citations.
- The plan (for ordering hints).
- Any cross-agent findings (data-analyzer or deployment-analyzer
  citations) -- these go in their own subsection.

# Universal rules

- Every claim must trace to a citation. If you can't cite it, drop it.
- Don't hedge with "probably" / "seems to" / "may be" -- if the
  finding's confidence was low, say "the analyzer's evidence here is
  thin" once and move on.
- Don't repeat the user's question back at them.
- Use the path:line citation format the IDE recognises:
  [\`src/auth/token.ts:42-58\`](path:src/auth/token.ts#L42-L58).`;

// ---------------------------------------------------------------------------
// Per-tier guidance. Each block specifies the report's section layout +
// density target. The orchestrator chooses one based on the run's tier.
// ---------------------------------------------------------------------------

const S_M_GUIDANCE = `# Output structure (S / M tier)

# <Title derived from the request>

## Summary
2-4 sentences. The bottom-line answer to the user's question.

## Findings
Group by concern. Each finding is a paragraph (or short bullet list)
that cites at least one entity / file / line range. Prose is fine at
this tier -- the document is short.

(If cross-agent findings exist, end with:)

## Schema findings (data-analyzer)
... using DataCitation rendering ...

## Deployment findings (deployment-analyzer)
... using DeployCitation rendering ...

# Density target: ~2-4 KB. Single-pass.`;

const L_XL_GUIDANCE = `# Output structure (L / XL tier)

# <Title derived from the request>

## Summary
3-5 sentences. The bottom-line answer + the 2-3 highest-impact findings.

## Module overview
A markdown table -- one row per module / package / sub-system covered
by the analysis. Columns: \`Module\`, \`Role\`, \`Key entities\`,
\`Notes\`. The \`Key entities\` cell carries up to 3 path:line
citations.

## Per-module detail
One \`##\` section per module from the table above. Each section is
SIGNATURE-LEVEL (function names + one-line role + path:line citation),
NOT paragraph-level. Use bullet lists, not prose. Example shape:

  - \`functionName(args)\` -- one-line role.
    [\`src/foo.ts:42-58\`](path:src/foo.ts#L42-L58)

If a finding is a cross-cutting concern that doesn't fit one module,
drop it under a final \`## Cross-cutting concerns\` section using the
same bullet format.

(Cross-agent findings still go in dedicated subsections at the end.)

# Density target: ~6-10 KB. AVOID multi-paragraph prose -- L/XL local-
# model runs hit the num_predict ceiling on verbose output. Tables +
# bullets are non-negotiable at this tier; if you find yourself
# writing a third paragraph in a row, replace it with a bullet list.`;

const XXL_GUIDANCE = `# Output structure (XXL / XXXL / XXXXL tier)

# <Title derived from the request>

## Summary
2-4 sentences. The architectural shape -- not findings, not function-
level detail.

## Module map
Markdown table. Columns: \`Module\`, \`Path\`, \`Lines\`,
\`Responsibility\`. One row per top-level module. Citations in this
tier are FILE-LEVEL: \`src/agent/orchestrator.ts\` is fine; line
ranges are not required.

## Responsibility matrix
Markdown table. Columns: \`Concern\` (auth / persistence / routing /
...) and one column per major module showing whether it owns / uses /
exposes that concern.

## Dependency edges
Bullet list of structural dependencies. Format:
  - \`module-A\` -> \`module-B\` -- one-line reason.

(Cross-agent findings still go in dedicated subsections at the end.)

# Density target: ~4-8 KB. NO per-finding paragraphs. NO per-line
# citations. The structure IS the finding -- the reader gets the
# repo shape from the tables, not from prose. If the user wants
# detail, they drill down (a "Drill down" footer below offers them
# scoped child analyses).`;

function tierSynthesiseGuidance(tier: ScopeSize): string {
  switch (tier) {
    case 'S':
    case 'M':
      return S_M_GUIDANCE;
    case 'L':
    case 'XL':
      return L_XL_GUIDANCE;
    case 'XXL':
    case 'XXXL':
    case 'XXXXL':
      return XXL_GUIDANCE;
  }
}

// ---------------------------------------------------------------------------
// Drill-down footer. Always emitted regardless of tier (Phase 5.C).
// Phase 5.D adds the workbench-side drillDown command + Report Pane
// affordances; today the footer renders as plain markdown bullets.
// ---------------------------------------------------------------------------

const DRILL_DOWN_FOOTER_RULE = `# Drill-down footer (REQUIRED, regardless of tier)

End the report with a final section:

## Drill down

3-5 candidate next-step analyses the user could run as scoped child
analyses. Each line is a single bullet describing a focused question
the user might want to ask, paired with the scope it would target.
Format:

- **<one-line candidate question>** -- scope: \`<path | module | entity>\`

Pick candidates that:
  - dig into a sub-system the report mentioned but didn't cover deeply,
  - explore a cross-cutting concern surfaced by the findings,
  - chase a "why" that came up in the analysis but wasn't answered.

Do NOT include candidates that are already fully answered above.`;

// ---------------------------------------------------------------------------
// Output rules. Universal -- enforced regardless of tier.
// ---------------------------------------------------------------------------

const OUTPUT_RULES = `# Output rules

- Token budget ~4000.
- The very first character of your reply MUST be \`#\` (the H1 heading).
  No leading apostrophe, backtick, single-quote, double-quote, or
  whitespace before \`#\`. The Report Pane parses your reply as
  Markdown verbatim; any prefix character breaks the first heading.
- Do NOT wrap the entire reply in a code fence (\`\`\`markdown ...
  \`\`\` or \`\`\` ... \`\`\`). The reply IS markdown -- treating it
  as a code block hides the structure.
- No prose preamble ("Here is the report:", "Sure, here's the
  analysis:"). Start with the H1 heading.`;

/**
 * Compose the tier-aware synthesis system prompt.
 *
 * Tier defaults to `'M'` so legacy callers (and any in-flight runs
 * from before Phase 5.C) get the prior single-cap behaviour without
 * crashing on a missing tier. New code threads the run's
 * `CodeAnalysisState.tier` explicitly.
 */
export function buildSynthesiseSystemPrompt(tier: ScopeSize = 'M'): string {
  return [
    SYNTHESISE_SYSTEM_HEAD,
    tierSynthesiseGuidance(tier),
    DRILL_DOWN_FOOTER_RULE,
    OUTPUT_RULES,
  ].join('\n\n');
}

/**
 * Legacy alias -- defaults to the M tier. Kept exported so callers
 * outside the orchestrator (tests, scripts) keep importing a stable
 * symbol; remove once nothing references it.
 *
 * @deprecated Use `buildSynthesiseSystemPrompt(tier)`.
 */
export const SYNTHESISE_SYSTEM = buildSynthesiseSystemPrompt('M');

/**
 * Build the synthesiser messages. The user block carries the original
 * request, the planned task list (for ordering hints), and the
 * accepted analyzer results in plan order.
 *
 * Caller has already filtered to accepted results -- this prompt does
 * not see retried-or-cancelled items.
 *
 * Phase 5.C: tier threads through to the system prompt so the user
 * block sees a per-tier-shaped instruction.
 *
 * Phase 3.5: when any accepted task carried `foreignCitations` (from
 * a `data:*` / `deploy:*` cross-agent dispatch), they're aggregated
 * and surfaced in the user block under a dedicated section. The
 * system prompt instructs the writer to render them under their own
 * `## Schema findings (data-analyzer)` / `## Deployment findings
 * (deployment-analyzer)` subsections -- never inline with code
 * citations.
 */
export function buildSynthesisPrompt(
  request: string,
  acceptedResults: readonly { task: AnalysisTask; result: AnalyzerResult }[],
  plannedTasks: readonly AnalysisTask[],
  tier: ScopeSize = 'M',
): LLMMessage[] {
  const planSummary = plannedTasks
    .map((t, i) => `  ${i + 1}. [${t.kind}] ${t.question}`)
    .join('\n');

  const findingsBlock = acceptedResults
    .map(({ task, result }, i) => {
      const head = `[${i + 1}] ${task.kind} -- ${task.question} (confidence=${result.confidence})`;
      const body = JSON.stringify(
        {
          answer: result.answer,
          findings: result.findings,
          citations: result.citations,
        },
        null,
        2,
      );
      return `${head}\n${body}`;
    })
    .join('\n\n');

  const aggregatedForeign = aggregateForeignCitations(acceptedResults.map(r => r.result));
  const foreignBlock = renderForeignCitationsBlock(aggregatedForeign);
  const hasForeign = foreignBlock.length > 0;

  const userBody = [
    '# Original request',
    request,
    '',
    `# Run tier: ${tier}`,
    '',
    '# Plan (in original order)',
    planSummary || '(empty)',
    '',
    '# Accepted task results',
    findingsBlock || '(no accepted results)',
    ...(hasForeign ? ['', '# Foreign citations (cross-agent)', foreignBlock] : []),
    '',
    '# Output',
    `Reply with the rendered Markdown report only -- shaped per the ${tier}-tier structure spec in the system prompt. No JSON, no fences around the whole document.${hasForeign ? ' Render each foreign citation bucket under its own dedicated `## Schema findings (data-analyzer)` / `## Deployment findings (deployment-analyzer)` subsection -- NEVER inline with code citations.' : ''} End with the required "## Drill down" footer.`,
  ].join('\n');

  return [
    { role: 'system', content: buildSynthesiseSystemPrompt(tier) },
    { role: 'user', content: userBody },
  ];
}

// ---------------------------------------------------------------------------
// Foreign citation aggregation (Phase 3.5)
// ---------------------------------------------------------------------------

/**
 * Union the foreignCitations across accepted task results. Returns
 * undefined when none of the tasks carried any foreign citations.
 */
function aggregateForeignCitations(
  results: readonly AnalyzerResult[],
): ForeignCitations | undefined {
  const data: Record<string, unknown>[] = [];
  const deploy: Record<string, unknown>[] = [];
  for (const r of results) {
    if (r.foreignCitations?.data) {
      data.push(...r.foreignCitations.data);
    }
    if (r.foreignCitations?.deploy) {
      deploy.push(...r.foreignCitations.deploy);
    }
  }
  if (data.length === 0 && deploy.length === 0) {
    return undefined;
  }
  const out: { -readonly [K in keyof ForeignCitations]: ForeignCitations[K] } = {};
  if (data.length > 0) {
    out.data = data;
  }
  if (deploy.length > 0) {
    out.deploy = deploy;
  }
  return out;
}

function renderForeignCitationsBlock(
  foreign: ForeignCitations | undefined,
): string {
  if (foreign === undefined) {
    return '';
  }
  const sections: string[] = [];
  if (foreign.data && foreign.data.length > 0) {
    sections.push(`## data-analyzer (${foreign.data.length})\n${JSON.stringify(foreign.data, null, 2)}`);
  }
  if (foreign.deploy && foreign.deploy.length > 0) {
    sections.push(`## deployment-analyzer (${foreign.deploy.length})\n${JSON.stringify(foreign.deploy, null, 2)}`);
  }
  return sections.join('\n\n');
}
