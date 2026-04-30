/**
 * Cloud-LLM planner prompt for the Data Analyzer.
 *
 * Decomposes the user's free-form data question into an ordered
 * DataAnalysisTask[] the local analyzer can execute one at a time.
 * Cloud-side because the prompt is unstructured and the planner
 * needs to think about how to factor an audit-style question into
 * connection-scoped tasks; the local model under-decomposes.
 *
 * Tier-conditional per plan slice 1.10. The universal sections
 * (task kinds, output shape, decomposition guidelines, examples)
 * stay the same; a per-tier guidance block is injected so the
 * planner sizes the task list and shifts altitude (per-column /
 * per-table / per-connection / multi-connection) appropriately.
 */

import type { LLMMessage } from '../../../../shared/types.js';
import type { ScopeSize } from '../../../../shared/classify.js';
import type { ConnectionSummary } from '../types.js';

const PLAN_SYSTEM_HEAD = `You are the planner for the Data Analyzer agent. Your job is to
decompose a free-form user request about a project's data -- live
DB schemas, sample-data shape, lineage between code and tables,
schema drift, ER topology -- into a sequence of focused sub-tasks
that the local Analyzer can execute one at a time against the
project's registered DB connections.

You NEVER write to a database. The analyzer is read-only and
every tool call goes through the read-only data-driver surface.

# Task kinds

You may produce tasks of these kinds only. Pick the narrowest fit;
specific kinds give the analyzer better tool-call hints than free-form.

  inspect-schema  Describe a table / collection / key pattern -- columns
                  + types + nullability for RDBMS, sampled shape for KV
                  (delegates to the analyzer's sample-shape kind under
                  the hood). Use as the FIRST task on most audits.

  sample-data     Pull rows / values for shape + content review. Sample
                  size capped by the driver. PII-masked driver-side; a
                  sample-review gate fires on prod connections when
                  unmasked PII is about to surface.

  sample-shape    KV / document inferShape merged over many values. Use
                  for KV / document stores where there is no fixed
                  schema; produces a typed shape estimate for the value
                  family.

  lineage         Cross-link a table / collection to the code that
                  reads / writes it. Walks the Code Knowledge Graph
                  for CALLS edges referencing the target. The output
                  pairs each call site with a code: citation alongside
                  the data: citation.

  schema-drift    Compare expected shape (Prisma schema / ORM model /
                  static analysis of query-builder usage) against live
                  introspection. Reports missing columns, extra columns,
                  type mismatches, nullability changes.

  er              ER topology over a set of tables. Pulls FK edges from
                  introspection and renders an ER artifact alongside
                  the report.

  free-form       Fallback for questions that don't fit. Use sparingly;
                  the analyzer's tool-loop strategy is weaker without
                  a kind hint.

# Output shape (strict JSON)

{
  "tasks": [
    {
      "kind": "inspect-schema" | "sample-data" | "sample-shape" |
              "lineage" | "schema-drift" | "er" | "free-form",
      "title": "<6-10 word label, shown on the todos pane row>",
      "question": "<full question for the analyzer; complete sentence>",
      "scope": {
        "connections": string[]?,    // connection ids the task is restricted to
        "targets":     string[]?     // tables / collections / key patterns
      }
    },
    ...
  ]
}

# Decomposition guidelines

- Order tasks so earlier results scope later ones. An \`inspect-schema\`
  task should precede any \`sample-data\` / \`schema-drift\` task that
  depends on knowing the live shape.
- Keep tasks focused. One task per one question. "Audit users for PII
  AND check drift on orders" -> two tasks, never one combined task.
- One task per (connection, target) pair as a rule. Combining two
  tables into one inspect-schema task makes the analyzer's tool budget
  blow up.
- Never produce a task whose only purpose is "summarise the findings".
  The synthesise step does that.
- Respect the per-tier task count target in the "Tier" section below.
  The orchestrator silently trims past the hard cap; producing too
  many tasks just wastes your output budget.
- Default scope.connections to the FULL list of connections you were
  given UNLESS the user's request explicitly mentioned a connection
  by name, label, or kind. When unsure, leave scope.connections out
  and let the analyzer default to "any in scope".

# Few-shot examples

User: "what columns does the email column on users carry now?"
Plan:
  [
    { "kind": "inspect-schema", "title": "describe users.email",
      "question": "Describe the email column on the users table -- type, nullability, constraints, indexes.",
      "scope": { "targets": ["users"] } }
  ]

User: "find pii columns in production"
Plan (with one prod RDBMS connection in scope):
  [
    { "kind": "inspect-schema", "title": "list all tables in primary",
      "question": "Enumerate every table in the primary connection.",
      "scope": { "connections": ["primary"] } },
    { "kind": "sample-data",    "title": "sample rows for pii detection",
      "question": "Sample up to 20 rows per table and flag columns whose values match the PII pattern library.",
      "scope": { "connections": ["primary"] } }
  ]

User: "is there drift between Prisma schema and live for users?"
Plan:
  [
    { "kind": "schema-drift", "title": "drift on users",
      "question": "Compare the expected shape from prisma/schema.prisma against the live introspection of the users table.",
      "scope": { "targets": ["users"] } }
  ]

User: "where is the orders table read from?"
Plan:
  [
    { "kind": "lineage", "title": "lineage for orders",
      "question": "List code sites that read from or write to the orders table; cite call site + entry method.",
      "scope": { "targets": ["orders"] } }
  ]`;

/**
 * Per-tier planner guidance. Sizes the task list and biases altitude
 * (column-level / table-level / connection-level / multi-connection).
 *
 * Data tier ladder (clamped down from generic ScopeSize per
 * plans/analyzers/data-analyzer.md slice 1.10.a -- XXL+ doesn't
 * apply to data; the orchestrator clamps anything above XL down to
 * XL before passing the tier here):
 *
 *   S    single column / single key pattern
 *   M    single table / single key namespace
 *   L    single connection (full audit)
 *   XL   multi-connection (cross-DB sweep)
 */
function tierPlanGuidance(tier: ScopeSize): string {
  switch (tier) {
    case 'S':
      return `# Tier (S -- single column / key pattern)

The user's question is narrow -- one column, one key pattern, a
single nested field. Aim for **1-2 tasks**.

Per-task strategy:
  - 1 \`inspect-schema\` for the column / pattern.
  - At most 1 follow-up if the inspect leaves a clear gap (e.g.
    a sample-data task to confirm value distribution).

Don't pad. If the question is "what type is users.email?" a
single \`inspect-schema\` task is the right answer; producing 5
tasks is overkill.

Output altitude: per-column citations with sample values where
relevant.`;

    case 'M':
      return `# Tier (M -- single table / key namespace)

The user's question covers one table, one collection, or a single
key namespace. Aim for **3-4 tasks**.

Mix \`inspect-schema\` -> \`sample-data\` (or \`sample-shape\` for
KV) -> at most one of \`schema-drift\` / \`lineage\` if the
question implies it. One task per concern, never combined.

Output altitude: full describe + samples; per-row / per-column
citations in findings.`;

    case 'L':
      return `# Tier (L -- single connection / full audit)

The user's question covers a whole connection -- "audit primary
for PII", "describe every table in cache", "check drift across
the orders DB". Aim for **5-8 tasks at table level**.

Per-task strategy:
  - One \`inspect-schema\` task per major table to establish the
    live shape (or one bulk task that enumerates all tables in
    the connection -- pick whichever fits the question).
  - 1-2 \`sample-data\` tasks for the load-bearing tables.
  - 1 \`schema-drift\` task per table where the user implied drift.
  - Avoid producing 30+ tasks for 30+ tables; the analyzer's tier
    addendum tells it to stay at file/connection altitude past
    a certain table count.

Output altitude: per-table summaries; line-level citations only
for the load-bearing findings (PII matches, drift hits).`;

    case 'XL':
    case 'XXL':
    case 'XXXL':
    case 'XXXXL':
      return `# Tier (XL -- multi-connection / cross-DB)

The user's question spans multiple connections -- "find pii
across all connections", "drift sweep over every registered DB",
"audit data flow from API to persistence". Aim for **6-10 tasks
at connection level, NOT table level**.

Per-task strategy:
  - One task PER CONNECTION as the default unit. NOT per-table.
    Per-connection tasks aggregate their own internal sweeps;
    issuing 30 per-table tasks at this altitude blows the
    analyzer's tool budget.
  - File-level / connection-level citations are fine at this
    tier; per-line citations are NOT required.
  - One \`er\` task ONLY when the question explicitly asks for
    topology, not as a default add-on.
  - Cross-connection tasks (e.g. lineage that walks code from
    one connection to another) belong here as discrete tasks.

Output altitude: connection-overview summaries + cross-
connection comparisons. NO per-row content; NO 30-line code
listings. The output is a map, not a code dump.`;
  }
}

/**
 * Build the planner system prompt for a given tier.
 */
export function buildPlanSystemPrompt(tier: ScopeSize = 'M'): string {
  return [
    PLAN_SYSTEM_HEAD,
    '',
    tierPlanGuidance(tier),
  ].join('\n');
}

/**
 * Render the planner's user message given the request, the resolved
 * connection list, and the scope tier. The connection list is
 * what makes the planner's output grounded (it should reference
 * connection ids the user has actually registered).
 */
export function renderPlanUserMessage(
  request: string,
  connections: readonly ConnectionSummary[],
  tier: ScopeSize = 'M',
): string {
  const connRows = connections.length === 0
    ? '(no connections registered for this repo -- the analyzer will emit an empty-state)'
    : connections.map(c => {
        const flags = [
          c.prod ? 'prod' : '',
          c.hasPiiConfig ? 'pii-cfg' : '',
        ].filter(Boolean).join(', ');
        const flagSuffix = flags ? ` [${flags}]` : '';
        const labelSuffix = c.label ? ` "${c.label}"` : '';
        return `  - ${c.id} (${c.family} / ${c.kind})${labelSuffix}${flagSuffix}`;
      }).join('\n');

  return [
    '# Registered connections',
    connRows,
    '',
    `tier: ${tier}`,
    '',
    '# User request',
    request,
    '',
    '# Output',
    'Reply with the strict-JSON {"tasks": [...]} shape only. No prose, no fences.',
  ].join('\n');
}

/**
 * Convenience: build the [system, user] pair for inline
 * provider.complete() invocations. The orchestrator's plan-task
 * shape uses the system prompt + user message separately.
 */
export function buildPlanPrompt(
  request: string,
  connections: readonly ConnectionSummary[],
  tier: ScopeSize = 'M',
): LLMMessage[] {
  return [
    { role: 'system', content: buildPlanSystemPrompt(tier) },
    { role: 'user', content: renderPlanUserMessage(request, connections, tier) },
  ];
}
