# Plan: Skills Core

A central, daemon-side registry for **skills** -- typed, composable units of
analyzer capability that sit one layer above raw tools and one layer below
end-to-end agents. This plan establishes the substrate; per-family build-outs
(data, code, deploy, test) live in sibling plans that import from here.

## Why a separate layer?

The current daemon has two persistence surfaces for capability:

- **Tool registry** ([daemon/tools/registry.ts](../../src/insrc/daemon/tools/registry.ts)) -- raw read/write
  primitives (`db_sql_describe`, `code_locate`, `git_status`, ...). One tool
  ≈ one daemon function. No LLM call inside; no composition.
- **Cross-agent surface** ([daemon/cross-agent/](../../src/insrc/daemon/cross-agent/)) -- aliases that let
  one analyzer invoke another's tools with a depth cap. Wrapper layer over
  tools, no separate semantics.

Everything above that lives inside individual analyzer runners (e.g.
`agent/tasks/data-analyzer/analyzer/runner.ts`'s 8-call tool loop, the
code-analyzer's inline tool-loop, the test agent's scenario planner). They
re-implement the same primitives -- "describe a column", "extract a class's
field list", "render a finding to markdown" -- inside their own bounded loops,
in their own prompts, with their own confidence semantics. The 2026-04-30
hallucinated-class incident in the data-analyzer was directly caused by this:
the analyzer needed `code.class.extract-fields` semantics but had to fake them
out of its tool-loop, and there was no boundary the runner could check
against.

A **skill** layer fixes this:

```
agent (multi-turn, session-aware, gated)
  -> skill (typed I/O, declared tool/skill deps, calibrated confidence)
       -> tool (one daemon function call) | sub-skill | LLM call
```

Skills are the unit of cross-agent reuse. Test agent wants to validate a
fixture? It calls `data.profile.numeric` from the registry. Designer wants to
explain a data flow? It calls `data.lineage.read-write-callsites`. Code
analyzer wants to ground a "this column is exposed via this DTO" claim? It
calls `data.mapping.json-vs-class`. None of those callers need to know how
data-analyzer's runner is built.

## Related plans

- [plans/analyzers/data-analyzer.md](./data-analyzer.md) -- existing
  data-analyzer; first migration target. Orchestrator stays; per-task
  runner becomes a skill composer.
- [plans/analyzers/code-analyzer.md](./code-analyzer.md) -- sibling family;
  exposes its first batch of skills (class.extract-fields, lineage,
  trace-callers) for the data-analyzer to consume.
- [plans/analyzers/data-analyzer-skills.md](./data-analyzer-skills.md) --
  the data-analyzer-side family build-out built on this substrate.
- [plans/tools.md](../tools.md) -- shipped; the tool registry this skill
  registry layers on top of (skills consume tools, never replace them).
- [plans/access-gate.md](../access-gate.md) -- shipped; skill invocations
  inherit Session.access checking via the tools they call. Skills do not
  add a parallel access surface.

## Status

Substrate + RPC + soft-budget + audit ring buffer all shipped (commits
`0f0c80917df`, `61222a86c2b`, `726b77fa149`, plus the audit slice in
this commit). Remaining work: test harness (8.1 / 8.2), migration
tooling (6.2 -- deferred until v2 of any skill ships).

| Phase | Slice | State | Notes |
|---|---|---|---|
| 0.1 | Skill type + JsonSchema contract | done | hand-rolled Draft-07 subset in [daemon/skills/json-schema.ts](../../src/insrc/daemon/skills/json-schema.ts); avoids an Ajv dep |
| 0.2 | Registry data structures | done | byId / byIdAndVersion / byFamily / byOwner indices |
| 1.1 | `registerSkill` + `getSkill` + `listByFamily` | done | mirrors `daemon/tools/registry.ts` shape; strict registration with cycle + cross-owner checks |
| 1.2 | Settings / category gate | done | `enabledSkillFamilies` in tools/config.ts; defaults to `ALL_SKILL_FAMILIES` |
| 1.3 | Skill-id naming validator | done | dotted-form, lowercase, max 64 chars, single-version per id |
| 2.1 | `runSkill(id, input, deps)` typed helper | done | the agent-to-agent path |
| 2.2 | `invoke_skill` meta-tool | done | shipped as `skill_invoke` (underscore-prefix puts it in the `skill` tool category); one tool exposes all skills via the closed-list pattern |
| 2.3 | `skill.invoke` RPC | done | shipped in [daemon/skills-rpc.ts](../../src/insrc/daemon/skills-rpc.ts) as `skill.list` / `skill.feasibility` / `skill.invoke`; `skill.audit` deferred to 7.2 |
| 3.1 | Composition + depth cap | done | `_skillDepth` mirrors `_crossAgentDepth`; cap = 4 |
| 3.2 | Cross-owner invocation accounting | done | second increment when owner mismatch; `shared` callees exempt |
| 4.1 | Precondition declaration syntax | done | min-sample-size / required-tools / connection-family / connection-property / cross-owner-allowed |
| 4.2 | `assertFeasible(id, ctx)` | done | walks preconditions; returns Feasibility |
| 4.3 | Calibrated confidence helpers | done | clamps on tool-error ratio, sub-skill 'low', invalid output |
| 5.1 | Provider affinity + step resolver | done | `local` / `cloud` / `auto` per skill; resolved via `SkillRunnerDeps.resolveProvider` |
| 5.2 | Skill-level token / time budgets | done | `softBudgetMs` checked after execute() (success + execute-threw paths); over-budget skills emit `skill-over-budget` telemetry + caller-visible note. Telemetry-only -- no hard timeout per the no-walltime-caps lesson |
| 6.1 | Versioning policy | done | hard-coded version: 1; lookup-by-version supported |
| 6.2 | Deprecation + migration helper | pending | optional v1; tooling lands when v2 of any skill ships |
| 7.1 | Telemetry: per-skill duration / success / confidence | done | structured `SkillEvent`s emitted to `module: 'skills'` log lines AND the session's bounded ring buffer (see 7.2) |
| 7.2 | Audit log entry per `runSkill` | done | per-session 1000-entry ring buffer in [daemon/skills/audit.ts](../../src/insrc/daemon/skills/audit.ts); read via `skill.audit` RPC with optional `limit` / `skillId` / `kind` filters |
| 8.1 | Test harness | pending | `runSkillIsolated()` + scripted SkillDeps |
| 8.2 | Skill smoke-test contract | pending | each skill ships with a fixture |
| 9.1 | First migration target | done | `data.lineage.read-write-callsites` shipped in [daemon/skills/built-ins/data-lineage.ts](../../src/insrc/daemon/skills/built-ins/data-lineage.ts) |

## Goals (short)

1. **One registry, all skills.** Any analyzer or agent in the daemon can
   discover, type-check, and invoke any registered skill via a single API.
2. **Composition with bounded depth.** Skills can call sub-skills. Cross-
   owner skill calls increment a depth counter; depth ≥ 2 fails closed.
3. **Calibrated confidence.** Skill outputs carry a confidence value derived
   from preconditions + tool-call success ratio, not from the LLM's
   self-report. (Direct lever against the hallucinated-class failure mode.)
4. **Typed I/O at the boundary.** Inputs are JsonSchema-validated before
   `execute()` runs; outputs are JsonSchema-validated before they leave.
   Type drift inside the skill never leaks to callers.
5. **Substrate first, skills second.** This plan ships only the registry and
   one proof-of-substrate migration. The seven data-analyzer skill families
   build on it in [data-analyzer-skills.md](./data-analyzer-skills.md).

## Non-goals (in this plan)

- **No skill content.** This plan does not ship any of the seven
  data-analyzer skill families. One migration target (`data.lineage.read-
  write-callsites`) ships only as proof that the substrate works end-to-end.
- **No replacement of the tool registry.** Tools stay where they are. Skills
  consume tools.
- **No replacement of the agent framework.** Agents (pair, delegate, designer,
  data-analyzer orchestrator) stay where they are. Skills are not agents --
  they are stateless capability units. An agent's pipeline can compose
  skills, but a skill cannot host an agent's gate-and-resume state machine.
- **No new permission surface.** Skills inherit the universal access gate
  through the tools they call. A skill that calls a tool with an `access`
  policy fires the same UI prompt the tool always would.
- **No LLM-routed skill picker.** The `invoke_skill` meta-tool exposes every
  enabled skill id as a closed list; the model picks. We do not build an
  LLM-driven skill recommender on top of the registry.
- **No skill marketplace / external-package skills.** Every skill ships
  bundled with the daemon binary, registered at startup. Future plans may
  revisit; not this one.

## Naming conventions

**Skill ids: dotted, lowercase, three or four segments.**

- Two segments minimum: `<family>.<verb-or-noun>`. Three or four when the
  domain warrants it (e.g. `data.profile.numeric`, `code.class.extract-fields`).
- Lowercase, ASCII, hyphens between words inside a segment, dots between
  segments. No underscores, no colons.
- Why dots and not underscores? Tool ids use underscores (Anthropic API
  regex compatibility, see [plans/access-gate.md](../access-gate.md)).
  Keeping skills on dots gives a free at-a-glance "is this a tool or a
  skill?" disambiguator in logs / prompts / audit trails.
- Why not `code:locate` / `data:profile:numeric`? The colon form was
  retired across the codebase on 2026-04-30 for the same Anthropic regex
  reason; we don't reintroduce it.
- The `invoke_skill` meta-tool exposes ids in the model's tool-list as
  literal strings (the LLM picks an id from the closed list and passes it
  as an argument). Anthropic's tool-name regex doesn't apply because the
  skill id is an *argument* to a tool, not a tool name itself.

**Family names** are short kebab-case identifiers, not free text:

```
'source-introspection' | 'source-sampling' | 'comparison-diff'
| 'code-binding' | 'quality-profile' | 'synthesis' | 'meta'
| 'lineage' | 'sensitivity' | 'timeseries'
```

(Per-family build-out plans declare new family identifiers; the validator in
0.2 keeps the set finite.)

**Owner names** mirror analyzer family ids:

```
'data-analyzer' | 'code-analyzer' | 'deploy-analyzer'
| 'test-agent' | 'shared'
```

`shared` denotes a skill not owned by any single analyzer (e.g. generic
synthesis renderers, json-schema validators). Cross-owner depth accounting
treats `shared` as a third class -- invocations into `shared` from any
analyzer don't add a depth increment.

## Phase 1 -- the contract

### 1.1 The Skill type

```ts
// daemon/skills/types.ts

export interface Skill<I = unknown, O = unknown> {
  /** Canonical id. Dotted, lowercase, validated at registration. */
  readonly id: string;
  /** Human-readable name for the skill picker / palette. */
  readonly name: string;
  /** One-line description; appears in the LLM prompt's skill list. */
  readonly description: string;

  /** Categorical bucket for settings gating + telemetry. */
  readonly family: SkillFamily;
  /** Analyzer family that owns the skill. Drives cross-owner depth accounting. */
  readonly owner: SkillOwner;
  /** Schema version. Hard-coded to 1 in v1; lookup-by-version supported. */
  readonly version: number;

  /** JsonSchema for the skill's input. Validated before execute(). */
  readonly inputs: JsonSchema;
  /** JsonSchema for the skill's output's payload. Validated after execute(). */
  readonly outputs: JsonSchema;

  /**
   * Tool ids this skill calls directly. Used for feasibility checks
   * (does this daemon have these tools registered?) and audit/telemetry.
   * Atomic skills typically declare 1-3; composite skills declare a wider
   * set transitively reachable through their sub-skills + their own calls.
   */
  readonly toolDeps: readonly string[];

  /**
   * Sub-skill ids invoked via runSkill(). Composite skills only;
   * undefined for atomic skills. Used for depth-cap accounting and a
   * cycle check at registration time (DAG validation).
   */
  readonly skillDeps?: readonly string[];

  /** Provider affinity for any LLM call inside execute(). */
  readonly providerAffinity: 'local' | 'cloud' | 'auto';

  /** Preconditions that must hold for the skill to run. */
  readonly preconditions?: readonly Precondition[];

  /**
   * Soft per-call wall-clock budget. NOT a hard timeout; the runner uses
   * it for telemetry + the meta.feasibility-check rollup. Hard timeouts
   * stay where they belong (tool-call level + agent-level wall-clock).
   * Mirrors the no-walltime-caps lesson from the code-analyzer rollout.
   */
  readonly softBudgetMs?: number;

  /** The skill's body. Receives validated input + a deps bundle. */
  execute(input: I, deps: SkillDeps): Promise<SkillResult<O>>;
}

export interface SkillResult<O> {
  /** The skill's typed output. */
  readonly value: O;
  /** Calibrated confidence (post-precondition, post-tool-error-trace). */
  readonly confidence: 'high' | 'medium' | 'low';
  /** Notes attached to the calibration; surfaced to callers + logs. */
  readonly notes?: readonly string[];
  /** Aggregated tool-call summary; exposed for caller-side reporting. */
  readonly toolCalls: readonly SkillToolCallSummary[];
  /** True iff the skill exited via the wall-clock or budget cap. */
  readonly truncated?: boolean;
}
```

### 1.2 Preconditions

```ts
export type Precondition =
  | { kind: 'min-sample-size'; n: number; reason: string }
  | { kind: 'required-tools'; tools: readonly string[]; reason: string }
  | { kind: 'connection-family'; families: readonly DriverFamily[]; reason: string }
  | { kind: 'connection-property'; property: string; reason: string }
  | { kind: 'cross-owner-allowed'; reason: string };

export type Feasibility =
  | { ok: true }
  | { ok: false; reasons: readonly { precondition: Precondition; detail: string }[] };
```

`assertFeasible` walks the list, calls a per-kind checker against the runtime
context (tool registry, session, connection roster), and returns either `{ok}`
or a structured rejection with one entry per failed precondition. The
data-analyzer's `meta.feasibility-check` skill (Phase 7 of
[data-analyzer-skills.md](./data-analyzer-skills.md)) is just a public-API
wrapper around this primitive.

### 1.3 SkillDeps

```ts
export interface SkillDeps {
  readonly session: Session;
  /** Invoke another skill. Tracks depth + cross-owner counter. */
  runSkill: <I, O>(id: string, input: I, opts?: RunSkillOpts) => Promise<SkillResult<O>>;
  /** Invoke a tool directly. Wraps the executor + the access gate. */
  runTool: (call: ToolCall) => Promise<ToolResult>;
  /** Resolve the LLM provider for this skill's affinity. */
  resolveProvider: () => LLMProvider;
  /** Telemetry hook. Skill execute() calls it with structured events. */
  emit: (event: SkillEvent) => void;
  /** Cancellation. */
  signal?: AbortSignal;
}
```

`runSkill` and `runTool` are the only handles a skill has into the wider
daemon. No direct DB, no direct keychain, no direct fs. This is on purpose:
it makes every skill testable with a scripted `SkillDeps` (Phase 8.1) and it
keeps the access-gate / audit-log boundaries enforced through the existing
tool dispatcher.

## Phase 2 -- the registry

### 2.1 Data structures

```ts
// daemon/skills/registry.ts

const byId       = new Map<string, Skill>();
const byFamily   = new Map<SkillFamily, Skill[]>();
const byOwner    = new Map<SkillOwner, Skill[]>();
```

Skills are keyed by id+version. v1 hard-codes version=1; future versions live
under the same id with a different version number. `getSkill('x.y.z')` returns
the highest-version registered; `getSkill('x.y.z', 1)` returns v1 specifically.

### 2.2 Registration

```ts
export function registerSkill(skill: Skill): void;
```

Registration is strict and runs at daemon startup, like tool registration.
Failures throw (these are programmer errors, not user-facing): id format
violations, family validator misses, sub-skill cycle detection, sub-skill
not-yet-registered (registration order is enforced as a dependency-aware
topo-sort in 2.3).

### 2.3 Topological registration

```ts
// daemon/skills/index.ts

export function registerAllSkills(): void {
  // Phase 1: atomic skills (no skillDeps).
  registerDataSourceSkills();
  registerDataSamplingSkills();
  registerCodeBindingAtomics();
  registerSynthesisAtomics();
  registerMetaAtomics();

  // Phase 2: composite skills. Their atomic deps are now registered.
  registerComparisonSkills();
  registerQualitySkills();
  registerCompositeSynthesis();
  registerCompositeMeta();
}
```

The registry's startup integrity check walks every `skillDeps` reference and
asserts each dep is already registered. Composite-skill registration runs
strictly after atomic-skill registration. Cross-family deps are allowed (a
quality skill can depend on a source skill); cross-owner deps add the depth-
accounting marker covered in Phase 3.2.

### 2.4 Settings / category gate

Mirrors the tool-category gate in [daemon/tools/config.ts](../../src/insrc/daemon/tools/config.ts):

```ts
interface ToolSettings {
  // ...existing fields...
  enabledSkillFamilies: readonly SkillFamily[];
}
```

`getSkill()` honours the gate at lookup time, returning `undefined` for skills
in disabled families. `enabledSkillFamilies` defaults to **all** known families
to avoid the silent-blackout failure mode the cross-agent code/data tools hit
on 2026-04-30 (where the registry registered them but the default-enabled
list omitted them, so every cross-agent call failed with `Unknown tool`).

The IDE pushes settings via the existing `tools.settings` RPC; this plan adds
no new RPC, just an extra field on the existing payload.

## Phase 3 -- invocation

### 3.1 Typed agent-to-agent

```ts
// daemon/skills/invoke.ts

export async function runSkill<I, O>(
  id: string,
  input: I,
  deps: SkillDeps,
  opts?: RunSkillOpts,
): Promise<SkillResult<O>>;
```

The full pipeline:

1. Look up via `getSkill()`. Fail fast if missing or family-gated.
2. Validate `input` against `skill.inputs`. Reject with a typed
   `SkillInvocationError` on mismatch.
3. Bump depth: `_skillDepth = (deps._skillDepth ?? 0) + 1`. Cross-owner
   bump (3.2) adds a second increment.
4. Run `assertFeasible(id, ctx)`. If `ok: false`, short-circuit with
   `confidence: 'low'` + the rejection reasons in `notes`. Don't `execute()`.
5. Run `skill.execute(input, deps)`. Catch errors -> `confidence: 'low'`
   plus an error note; never throw.
6. Validate the result's payload against `skill.outputs`. Reject as a
   "registry contract violation" with an audit entry; the caller sees
   `confidence: 'low'` plus the validator detail.
7. Apply the calibrated-confidence floor: if any tool call in the trace
   failed AND no alternative succeeded, clamp to `low`. (Same lever as the
   data-analyzer's runner-side downgrade introduced 2026-05-01.)
8. Return.

### 3.2 Cross-owner depth accounting

`runSkill` accepts a `RunSkillOpts.callerOwner`. When `skill.owner` differs
from `callerOwner` AND `skill.owner !== 'shared'`, the depth counter
increments by 2 instead of 1. Default depth cap is 4: that allows a
data-analyzer skill to call a code-analyzer skill that calls a shared skill,
but stops the chain before a four-deep cross-family bounce.

### 3.3 LLM-exposed meta-tool

```ts
// daemon/tools/builtins/skills/invoke-skill.ts

const invokeSkillTool: Tool = {
  id: 'invoke_skill',
  description: 'Invoke a registered skill by id. Returns the skill\'s typed result.',
  inputSchema: {
    type: 'object',
    properties: {
      skillId: { type: 'string' },
      args:    { type: 'object' },
    },
    required: ['skillId', 'args'],
  },
  execute: async (input, deps) => { /* validate + runSkill */ },
};
```

Analyzers that want LLM-driven skill dispatch advertise this **single** tool
in their tool list. The closed list of skill ids the model is allowed to
pick from is rendered into the analyzer's system prompt -- not as separate
tool definitions. This costs ~80-200 tokens for a list of 30-50 skills,
versus ~3000+ tokens if every skill became its own tool with input/output
schemas. The cost difference is decisive.

### 3.4 RPC surface

```ts
'skill.invoke'         // run a skill by id, return SkillResult
'skill.list'           // list all enabled skills with name/family/description
'skill.feasibility'    // check feasibility without executing
'skill.audit'          // recent SkillEvent stream for the active session
```

Keep these tightly scoped. The workbench / CLI uses them for "right-click ->
profile this column" affordances; tooling like a skill-explorer pane lives in
a follow-up.

## Phase 4 -- composition + depth

### 4.1 The depth counter

`SkillDeps` carries `_skillDepth: number`. `runSkill` increments on entry,
decrements on return. The cap is 4 (rationale in 3.2). On cap-exceed the
runner returns `confidence: 'low'` with a `cross_skill_depth_exceeded` note
and skips `execute()`.

### 4.2 Cycle detection at registration

A composite skill that lists itself (transitively) in `skillDeps` is a
program error and throws at registration. The registry runs a DFS cycle
check after the topo-sort completes.

### 4.3 Sub-skill failure semantics

A sub-skill returning `confidence: 'low'` does **not** abort the parent.
Composite skills are responsible for deciding whether they can produce a
useful answer with low-confidence inputs. The pattern is:

```ts
const profile = await deps.runSkill('data.profile.numeric', input);
if (profile.confidence === 'low') {
  return {
    value: { ... },
    confidence: 'low',
    notes: ['underlying profile.numeric returned low confidence'],
    toolCalls: profile.toolCalls,
  };
}
```

The composite's confidence is at most the minimum confidence across all its
sub-skill returns. The registry enforces this floor in step 7 of `runSkill`
(3.1) so an inattentive composite can't claim higher confidence than its
inputs justify.

## Phase 5 -- preconditions in detail

### 5.1 `min-sample-size`

```ts
{ kind: 'min-sample-size', n: 50, reason: 'normality test needs n >= 50 for stable Shapiro-Wilk' }
```

The runtime context exposes the available sample size for the active scope
(e.g. via the connection's known row count for SQL, or by a probe call for
KV / file). Failing this precondition does **not** block the skill; it
clamps the result to `confidence: 'low'` and emits a note. (Skills that
genuinely cannot run with too-small samples should hard-fail in their own
`execute()` instead.)

### 5.2 `required-tools`

```ts
{ kind: 'required-tools', tools: ['db_sql_aggregate'], reason: 'numeric percentiles via SQL aggregation' }
```

Walks the tool registry; if any tool is missing or family-gated off, fail
the precondition. This is the precondition that would have saved the
hallucinated-class run if it had existed -- `code.class.extract-fields`
declares `required-tools: ['code_locate', 'code_describe']`, the runner
sees `code` is family-disabled, fails closed instead of letting the LLM
free-form the answer.

### 5.3 `connection-family`

```ts
{ kind: 'connection-family', families: ['postgres', 'mysql', 'sqlite', ...], reason: 'SQL-only skill' }
```

For data-analyzer skills that don't generalise across driver families. The
checker reads from `Session.connectionRegistry`.

### 5.4 `cross-owner-allowed`

```ts
{ kind: 'cross-owner-allowed', reason: 'consumes code-analyzer skills under depth cap' }
```

Marker precondition. Lets a skill explicitly opt into cross-owner sub-skill
calls. Skills without this marker that call cross-owner sub-skills are
rejected at registration time.

## Phase 6 -- provider affinity

### 6.1 The three values

- `local`: pin to the local Ollama provider. Use for deterministic
  post-processing skills, tool-loop skills where token cost dominates.
- `cloud`: pin to the active cloud provider. Use for judgment / synthesis
  / classifier skills.
- `auto`: defer to the agent's per-step resolver. Use when the calling
  agent's owner intends to override per-skill via the Model Providers
  pane.

### 6.2 Resolver integration

`SkillDeps.resolveProvider()` consults:

1. Skill-level affinity (the field above), unless `auto`.
2. The active session's per-step resolver, keyed on
   `(skill.owner, skill.id)`.
3. The active provider default.

Skills don't pass a provider through their public API. The runner picks one
when `execute()` calls `deps.resolveProvider()`. This is the same indirection
the analyzer-side step resolver uses today.

## Phase 7 -- versioning

### 7.1 v1 policy

Every skill ships with `version: 1`. The registry supports lookup by
explicit version (`getSkill('id', 1)`) but no migration tooling lands in v1.
Internal consumers always use the no-version form, which returns the highest-
version registration. External consumers (the meta-tool, the RPC surface)
optionally accept a version pin.

### 7.2 Future v2 mechanics (out of scope for this plan, sketched here)

When a skill needs a breaking change, register the new version under the
same id with `version: 2`. Both versions stay live for one daemon release.
A separate slice plan ships the migration helper:

```ts
// future plan only
export function migrateSkillCallers(oldId: string, oldVersion: number, transformer: ...): void;
```

We don't ship this in v1 because we don't have a v2 yet. Adding a non-breaking
change requires only a new field on `SkillResult` (additive); breaking changes
that touch input shapes are what triggers v2.

## Phase 8 -- testing harness

### 8.1 `runSkillIsolated`

```ts
// scripts/test-skill-harness.ts (developer-facing CLI)

await runSkillIsolated('data.profile.numeric', sampleInput, {
  fakeTools: { db_sql_aggregate: () => mockAggregateResult },
  fakeProvider: scriptedLLM(['{"value": ...}']),
});
```

A test driver that constructs a synthetic `SkillDeps` from fixtures. Any
skill should be runnable end-to-end without daemon startup, real DBs, or
real LLMs. Mirrors the `agent/framework/test-channel.ts` pattern.

### 8.2 The smoke-test contract

Every skill ships a co-located fixture in `daemon/skills/<family>/__fixtures__/<id>.json`:

```json
{
  "input": { ... },
  "expectedOutputShape": "matches outputs schema",
  "expectedConfidenceFloor": "medium"
}
```

The smoke-test suite walks every registered skill, runs it through
`runSkillIsolated` with the fixture, asserts the output validates and the
confidence is at least the expected floor. CI gate.

## Phase 9 -- first migration target

Picked for substrate-validation, not for user impact: the data-analyzer's
existing `data_lineage` cross-agent tool (shipped in
[data-analyzer.md](./data-analyzer.md) Phase 3.1) becomes the first
registered skill, `data.lineage.read-write-callsites`.

The migration ships as one PR:

1. Skill registration with `inputs/outputs/preconditions/toolDeps`.
2. The skill's `execute()` body lifts the existing tool's body verbatim.
3. The shipping `data_lineage` tool stays registered as a thin wrapper that
   calls `runSkill('data.lineage.read-write-callsites', ...)` -- backward
   compat for analyzer prompts that name the tool directly.
4. The data-analyzer's analyzer-system prompt drops `data_lineage` from its
   tool inventory and gains `invoke_skill` plus a closed list of skill ids;
   today that list is `['data.lineage.read-write-callsites']` only. Each
   subsequent migration in [data-analyzer-skills.md](./data-analyzer-skills.md)
   adds entries.
5. The `data_lineage` tool's body becomes a one-line `runSkill` call. The
   tool-vs-skill duplication exists for one phase; it goes away in
   data-analyzer-skills.md Phase 4 when the analyzer fully cuts over to
   `invoke_skill`.

End-to-end test: a `/data-analyze` run that previously called `data_lineage`
must produce identical output (modulo tool-call trace formatting) under the
skill substrate. CI gate.

## Telemetry + audit

### Telemetry events

```ts
type SkillEvent =
  | { kind: 'skill-start';        skillId: string; inputDigest: string; depth: number }
  | { kind: 'skill-feasibility';  skillId: string; ok: boolean; reasons?: string[] }
  | { kind: 'skill-tool-call';    skillId: string; toolId: string; durationMs: number; error?: string }
  | { kind: 'skill-sub-skill';    parentId: string; childId: string; depth: number }
  | { kind: 'skill-end';          skillId: string; confidence: Confidence; durationMs: number }
  | { kind: 'skill-error';        skillId: string; error: string };
```

Logged at `module: 'skills'` in the daemon log, structured. The audit log
keeps a per-session window of these events for the workbench's skill-trace
panel (a sibling concern to the access-audit panel; not landed in this plan).

### Audit endpoint

`skill.audit` RPC (3.4) returns the last N events for the active session.
The workbench uses it to render a "what skills did this run touch?"
inspector. v1 is read-only; revoking individual skill grants is a future
plan when there's user-facing demand.

## Lessons baked in from prior incidents

1. **Default-enabled list and registry must agree.** The cross-agent tools
   were registered but unreachable on 2026-04-30 because `code` was missing
   from `enabledCategories`. The skill registry's settings layer (2.4) ships
   with **all** known families enabled by default, and the registration-time
   integrity check warns if any family in `byFamily.keys()` is missing from
   the default `enabledSkillFamilies` list.
2. **Confidence floors are enforced server-side, not LLM-self-reported.**
   Skill confidence is calibrated by the registry from preconditions + tool
   error trace. The skill body's `execute()` can claim its own confidence,
   but the registry clamps it down -- never up. (Mirrors the
   `downgradeForToolErrors` lever introduced 2026-05-01 in the
   data-analyzer's runner.)
3. **No wall-clock caps inside skills.** Per the no-walltime-caps lesson,
   `softBudgetMs` is telemetry-only; the only hard cap is the agent-level
   wall-clock that wraps the entire run.
4. **Tool-error gate inheritance.** Skills inherit the tool-error gate
   automatically because they call tools through `deps.runTool` (and
   transitively through their sub-skill calls). When a tool errors, the
   user gets the same Continue/Abort gate the data-analyzer runner shipped
   2026-05-01. No skill-specific gate code is needed.

## Open questions

1. Should `SkillResult` carry a structured `evidence` field separate from
   `toolCalls`? Argument for: callers want a typed list of "which sub-
   skills + which tool calls grounded which parts of the output" for
   user-facing citations. Argument against: this is per-skill semantics
   and forcing it into the result shape is over-prescriptive. **Default:
   skip in v1; revisit if a synthesis skill needs it.**
2. Should `runSkill` emit a stream event the workbench can render as a
   live progress pill (mirroring `liveStep` for LLM tasks)? **Default:
   yes, behind a `streamProgress: true` opt-in flag in `RunSkillOpts`.
   The data-analyzer-skills plan flips it on for top-level skill calls.**
3. Should skills be able to declare per-call cache keys (the way the
   data-analyzer's per-task cache works)? **Default: no skill-side cache
   in v1.** The agent layer handles caching where it makes sense (the
   data-analyzer orchestrator's per-task cache stays). Skill-side cache
   adds invalidation complexity that should land only when one of the
   per-family build-out plans demands it.
