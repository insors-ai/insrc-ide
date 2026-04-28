/**
 * Cloud-LLM planner prompt.
 *
 * Decomposes the user's free-form request into an ordered
 * AnalysisTask[] the local analyzer can execute one at a time.
 * Cloud-side because the prompt is unstructured and the planner
 * needs to think about how to decompose; the local model would
 * over- or under-decompose.
 *
 * Phase 5.B: the system prompt is now tier-conditional. The
 * universal sections (task kinds, output shape, decomposition
 * guidelines, examples) stay the same; a per-tier guidance block
 * is injected so the planner sizes the task list and shifts the
 * analytical altitude (per-entity / module-level / structural)
 * appropriately. See `design/analyzers/code-analyzer.html` section
 * 6.4.1 + plans/analyzers/code-analyzer.md Phase 5.
 */

import type { LLMMessage } from '../../../../shared/types.js';
import type { RepoSummary } from '../types.js';
import type { ScopeSize } from '../../../../shared/classify.js';

const PLAN_SYSTEM_HEAD = `You are the planner for the Code Analyzer agent. Your job is to decompose
a free-form user request about a codebase into a sequence of focused
sub-tasks that the local Analyzer can execute one at a time.

# Task kinds

You may produce tasks of these kinds only. Pick the narrowest fit;
specific kinds give the analyzer better tool-call hints than free-form.

  locate     Find code entities matching a name, description, or
             functional intent. Use this when the question references
             something that doesn't already have a specific entity id.
             Output: list of (entityId, path, lineRange).

  describe   Summarise the structure / interface / purpose / public
             surface of a known entity (function / class / module /
             package). Use after a locate when the user wants the
             shape of what was found.

  trace      Walk callers, callees, or data dependencies of an entity.
             Use for "where is X used", "what does X depend on",
             "follow this value through the pipeline". Direction matters:
             scope.direction = 'callers' | 'callees' | 'both'.

  compare    Diff two entities -- two implementations of the same idea,
             two versions of the same file, two parallel auth flows.
             scope.targets must list exactly two entities.

  free-form  Fallback for questions that don't fit. Use sparingly; the
             analyzer's tool-loop strategy is weaker without a kind hint.

# Output shape (strict JSON)

{
  "tasks": [
    {
      "kind": "locate" | "describe" | "trace" | "compare" | "free-form",
      "title": "<6-10 word label, shown on the todos pane row>",
      "question": "<full question for the analyzer; complete sentence>",
      "scope": {
        "entityIds":  string[]?,    // for describe / trace / compare
        "paths":      string[]?,    // narrow to a sub-tree
        "packages":   string[]?,    // narrow to specific packages
        "direction":  "callers" | "callees" | "both"?,   // trace only
        "targets":    [string, string]?                  // compare only
      }
    },
    ...
  ]
}

# Decomposition guidelines

- Order tasks so earlier results scope later ones. A locate task must
  precede any describe/trace task that depends on its output -- when
  the entityId isn't known yet, leave entityIds empty and let the
  follow-up reviewer fill it in.
- Keep tasks focused. One task per one question. Splitting "describe
  X and Y" into two describe tasks is correct; combining is wrong.
- Avoid asking the analyzer to make subjective judgements (taste,
  quality, "is this idiomatic"). Stick to factual questions about
  what's in the code.
- Never produce a task whose only purpose is "summarise the findings".
  The synthesise step does that.
- Respect the per-tier task count target in the "Tier" section
  below. The orchestrator will silently trim anything past the hard
  cap; producing too many tasks just wastes your output budget.

# Few-shot examples

User: "where is UserService.refresh called from?"
Plan:
  [
    { "kind": "locate", "title": "find UserService.refresh",
      "question": "Find the entity for the method UserService.refresh." },
    { "kind": "trace", "title": "callers of UserService.refresh",
      "question": "List all callers of UserService.refresh, up to 2 hops.",
      "scope": { "direction": "callers" } }
  ]

User: "summarise the auth flow and call out gaps"
Plan:
  [
    { "kind": "locate", "title": "auth entry points",
      "question": "Find HTTP / RPC entry points that handle authentication." },
    { "kind": "describe", "title": "describe each auth handler",
      "question": "For each auth handler found, describe its inputs, outputs, and side-effects." },
    { "kind": "trace", "title": "auth handler callees",
      "question": "Trace the callees of each auth handler down to the session-store layer.",
      "scope": { "direction": "callees" } },
    { "kind": "free-form", "title": "session-revocation gaps",
      "question": "Are there any code paths that bypass session revocation?" }
  ]

User: "compare the v1 and v2 token verifier"
Plan:
  [
    { "kind": "locate", "title": "find v1 token verifier",
      "question": "Find the v1 token verifier implementation." },
    { "kind": "locate", "title": "find v2 token verifier",
      "question": "Find the v2 token verifier implementation." },
    { "kind": "compare", "title": "v1 vs v2 verifier",
      "question": "Compare the two verifier implementations -- signature, body, callers.",
      "scope": { "targets": [<v1-id>, <v2-id>] } }
  ]`;

/**
 * Per-tier planner guidance. Injected into the system prompt between
 * the universal sections and the few-shot examples. The text shifts
 * the analytical altitude AND the task-count budget; the orchestrator
 * enforces the hard cap separately (Phase 5.A `capsForTier`).
 *
 * Tier ladder reminder:
 *   S      one focused question (single function / handful of lines)
 *   M      a small group (single file / tight cluster of entities)
 *   L      one module / sub-tree (~10-50 entities)
 *   XL     multiple modules; cross-cutting comparisons
 *   XXL+   sub-system / repo-wide audit; structural output
 */
function tierPlanGuidance(tier: ScopeSize): string {
  switch (tier) {
    case 'S':
      return `# Tier (S -- focused / single-entity)

The user's question is narrow -- one function, one handler, a handful
of lines. Aim for **1-3 tasks**:
  - 1 \`locate\` to pin down the entity (skip if the question already
    names a unique symbol with one obvious match).
  - 1 \`describe\` OR 1 \`trace\` (rarely both) on the located entity.
  - At most 1 follow-up if the first two left a clear gap.

Don't pad. If the question is "what does foo() do?" a single
\`describe\` is the right answer; producing 5 tasks is overkill.

Output altitude: per-line citations, full bodies when load-bearing.`;

    case 'M':
      return `# Tier (M -- small cluster / single-file)

The user's question covers a small group of related entities -- one
file, one handler with its callees, "how does X work" where X is a
specific area of code. Aim for **5-8 tasks**.

Drill into individual entities. Mix \`locate\` -> \`describe\` ->
\`trace\` so each task has tight scope. The legacy default cap of 16
soft / 24 hard applies if the planner truly needs more, but most M
prompts fit in 8.

Output altitude: per-line citations, full bodies when load-bearing.`;

    case 'L':
      return `# Tier (L -- one module / sub-tree)

The user's question covers a whole module or sub-tree -- "describe
the auth module", "summarise the agent framework", "walk through
the indexer pipeline". Aim for **5-12 tasks at module-level**.

Per-task strategy:
  - One \`describe\` task per logical sub-module covering its
    public surface (exported types, principal functions, entry
    points). Don't drill into individual function bodies unless
    they're the load-bearing piece.
  - 1-2 \`trace\` tasks for the cross-component call patterns the
    user actually cares about.
  - Avoid \`locate\` tasks at this tier; the planner usually knows
    enough about the sub-tree to scope subsequent tasks via
    \`scope.paths\`.

Output altitude: signature-level citations preferred over body
dumps. Cite the public surface; full bodies only for the
load-bearing N functions.`;

    case 'XL':
      return `# Tier (XL -- multi-module / cross-cutting)

The user's question spans multiple modules -- "compare brainstorm
and designer agents", "trace requests from API entry to DB",
"audit the analyzer's interaction with the framework". Aim for
**10-16 tasks**.

Per-task strategy:
  - 1 \`describe\` task per major sub-tree to establish the
    module-level shape.
  - Explicit \`compare\` tasks where the question implies a
    cross-module diff (signature / surface / call-graph).
  - \`trace\` tasks for cross-component call patterns; prefer
    direction='both' for the cross-cutting case.

Output altitude: same as L (signatures, public surfaces);
selective per-line citations only on load-bearing differences.`;

    case 'XXL':
    case 'XXXL':
    case 'XXXXL':
      return `# Tier (XXL+ -- sub-system / architectural)

The user's question is a sub-system or repo-wide audit -- "audit
error handling across the codebase", "give me an architectural
overview of insrc", "what's the dependency structure". Aim for
**3-6 broad tasks**.

Per-task strategy:
  - Each task is scoped to a major sub-system the planner INFERS
    from the repo signals (top-level packages + the user prompt).
    Use \`scope.paths\` to bound each task to a sub-tree.
  - Default kind is \`describe\` with \`scope.paths\` pointing at
    a sub-system. The output is a structural map of that
    sub-system -- responsibilities, public surface, principal
    types, dependency edges (in / out).
  - Rare \`trace\` tasks ONLY for cross-subsystem dependency edges
    that ARE the question.
  - NEVER \`locate\` at this tier; you're not finding entities,
    you're mapping responsibilities.

Output altitude: structural prose + module-edge lists. Per-line
code citations are NOT required at this tier -- file-level
citations (path only, no lineStart/lineEnd) are valid. Don't
paste any code body.`;
  }
}

/**
 * Build the planner system prompt for a given tier. Splits the
 * universal head from the per-tier guidance so the orchestrator can
 * use either form at its different call sites:
 *   - `buildPlanSystemPrompt(tier)` directly when the framework's
 *     LLM-task needs `systemPrompt: string` (Task.systemPrompt field).
 *   - `buildPlanPrompt(request, repo, tier)` for the `[system, user]`
 *     pair when invoking provider.complete() inline.
 */
export function buildPlanSystemPrompt(tier: ScopeSize = 'M'): string {
  return [
    PLAN_SYSTEM_HEAD,
    '',
    tierPlanGuidance(tier),
  ].join('\n');
}

/**
 * Tier-agnostic head -- exported for backwards-compat callers that
 * don't yet pass a tier. Prefer `buildPlanSystemPrompt(tier)` so the
 * planner sizes the task list for the request.
 *
 * @deprecated Use `buildPlanSystemPrompt('M')` (or the actual tier).
 */
export const PLAN_SYSTEM = PLAN_SYSTEM_HEAD;

/**
 * Build the planner messages. Returns a system + user pair the
 * provider's complete() can consume directly. The system prompt
 * varies by tier; the user message stays universal.
 */
export function buildPlanPrompt(
  request: string,
  repoSummary: RepoSummary,
  tier: ScopeSize = 'M',
): LLMMessage[] {
  const userBody = [
    '# Active repo',
    `name: ${repoSummary.name}`,
    `root: ${repoSummary.rootPath}`,
    `primary languages: ${repoSummary.primaryLanguages.join(', ') || '(unknown)'}`,
    `top-level packages: ${repoSummary.topLevelPackages.join(', ') || '(none)'}`,
    `dependency closure size: ${repoSummary.closureSize}`,
    `tier: ${tier}`,
    '',
    '# User request',
    request,
    '',
    '# Output',
    'Reply with the strict-JSON {"tasks": [...]} shape only. No prose, no fences.',
  ].join('\n');

  return [
    { role: 'system', content: buildPlanSystemPrompt(tier) },
    { role: 'user', content: userBody },
  ];
}
