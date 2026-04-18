# Tools -- Unified Capability System

> Supersedes `plans/research/delegate-tasks.md` (deleted). That plan
> treated "delegate tasks" as a separate concept from LLM tools; in
> practice they are the same thing from two different callers. This
> plan unifies them.

## Problem

Today we have two parallel registries for executable capabilities:

- **LLM tools** at [src/insrc/agent/tools/registry.ts](../src/insrc/agent/tools/registry.ts) /
  [executor.ts](../src/insrc/agent/tools/executor.ts). Invoked by the LLM via the
  tool-call protocol (Read, Grep, Glob, Bash, WebSearch, WebFetch, ...). Schema
  is JSON Schema so the model can emit structured calls. Approval is
  implicit through risk classification in `tools/validator.ts`.
- **Delegates** at [src/insrc/daemon/delegates/registry.ts](../src/insrc/daemon/delegates/registry.ts) /
  `delegates/*.ts`. Invoked by controllers via `kind: 'delegate'` tasks.
  Input is untyped. Approval is explicit via `requiresApproval` +
  `buildApprovalGate` hooks.

The boundary leaks:

1. **Same capability, two registrations.** `WebSearch` exists as a tool
   (with a stubbed-out `[WebSearch] No BRAVE_API_KEY configured...`
   fallback) and as `web-search` / `web-search:brave` / `web-search:claude`
   delegates. The tool version punts to the delegate version at runtime.
2. **Approval UX diverges.** Tools rely on permission-mode + risk
   heuristics; delegates use a proper gate with Approve / Skip / Edit.
   The LLM path has no way to surface an Edit action today.
3. **New surfaces (git actions, jira actions, file actions) need to be
   callable from both paths.** Writing them twice is wasteful and risks
   drift.

## Proposal: One `Tool` interface, two entry paths

A single `Tool` (= "capability") is registered once and exposed to both
callers. Same schema, same execution, same approval flow.

```typescript
interface Tool {
  /** Unique ID. Namespacing convention: 'domain:action' for sub-handlers. */
  id: string;

  /** Human-readable description -- surfaced to both LLM and user-facing gate. */
  description: string;

  /**
   * JSON Schema for the input. Used to:
   *  - generate the LLM tool-call schema,
   *  - validate controller-supplied input before execute(),
   *  - show an "Edit" form in the approval gate.
   */
  inputSchema: JSONSchema;

  /** When true, a gate fires before execute(). Can be a predicate over input. */
  requiresApproval?: boolean | ((input: unknown) => boolean);

  /** Build the approval gate content from the input (query preview, risk, etc.). */
  buildApprovalGate?(input: unknown): { title: string; content: string; actions: GateAction[] };

  /** Apply user's edit feedback to input before re-gating. Defaults to { ...input, query: feedback }. */
  applyEdit?(input: unknown, feedback: string): unknown;

  /** Do the work. */
  execute(input: unknown, deps: ToolDeps): Promise<ToolResult>;
}

interface ToolDeps {
  session: Session;
  channel: Channel;
  send: (msg: IpcStreamMessage) => void;
  requestId: number;
  /** Signal set when the caller is cancelled. */
  signal: AbortSignal;
}

interface ToolResult {
  output: string;
  format: TaskFormat;     // 'text' | 'markdown' | 'code' | ...
  success: boolean;
  error?: string;
  /** Structured data some callers care about (e.g. web search result array). */
  data?: unknown;
}
```

### Entry path A: LLM tool-call

Tool-loop already shapes the LLM's call into `{ name, input }`. Adapter:

1. Look up tool by `name` -> `id`.
2. Validate `input` against `inputSchema`. Reject malformed calls with a
   helpful error string so the model can self-correct.
3. If `requiresApproval` is truthy for this input, fire the approval gate
   through the session channel (same mechanism delegates use today).
4. Run `execute()`. Stream progress via `send`.
5. Return `output` (stringified if `data` was structured) to the
   tool-loop as the tool result.

### Entry path B: Controller task

Replace `kind: 'delegate'` with `kind: 'tool'` (keep `'delegate'` as an
alias for one release to avoid breaking the brainstorm / research
controllers mid-migration).

```typescript
// Task
{
  kind: 'tool',
  toolId: 'web-search',
  toolInput: { query: '...' },
  description: 'Web search: ...',
  stateKey: K.FINDINGS,
}
```

Execution goes through the same registry + approval + execute pipeline
as path A. The only difference from path A is that the caller is a
controller, not the LLM.

## What moves where

| Current home | Moves to |
|--------------|----------|
| `agent/tools/registry.ts` (LLM tool defs) | `daemon/tools/registry.ts` (unified) |
| `agent/tools/executor.ts` (builtin* handlers) | `daemon/tools/builtins/*.ts` (one file per tool) |
| `daemon/delegates/registry.ts` | Deleted. `executeDelegate` becomes a thin compat shim that calls `executeTool`. |
| `daemon/delegates/web-search.ts` | `daemon/tools/builtins/web-search.ts` |
| `agent/tools/validator.ts` (permission / risk) | Pushed into `Tool.requiresApproval` predicates. Risk ladder becomes a helper that tools opt into. |

The move from `agent/tools/` to `daemon/tools/` is deliberate: tools need
daemon-only capabilities (session, channel, stream) to support
approval + progress. The LLM path stays in `agent/` but imports the
registry from `daemon/tools/`.

## New system-action tools (post-migration)

Once the unified registry is live, the delegates the old plan called
out (git, jira, file) get implemented **once** and are automatically
available to both LLMs and controllers:

| Tool ID | Purpose | Approval | Notes |
|---------|---------|----------|-------|
| `git:status` | `git status --porcelain` | No | Read-only |
| `git:log` | `git log` with filters | No | Read-only |
| `git:diff` | `git diff` / `git show` | No | Read-only |
| `git:stage` | Stage paths | Yes | Mutates index |
| `git:commit` | Create commit | Yes (shows diff + message in gate) | Blocks on detached HEAD, blocks push |
| `git:branch` | Create / switch branch | Yes | |
| `jira:search` | JQL query | No | Requires `JIRA_URL` + token |
| `jira:create` | Create issue | Yes | |
| `jira:comment` | Add comment | Yes | |
| `jira:transition` | Move state | Yes | |
| `file:write` | Write file contents | Yes (diff preview in gate) | Replaces ad-hoc `Write` in the tool-loop. |
| `file:edit` | Range-based edit | Yes | Replaces `Edit`. |
| `file:delete` | Remove file | Yes | |
| `shell:exec` | Arbitrary command | Yes (risk-tier-aware) | Replaces `Bash`; risk inferred from command. |

All existing LLM tools (Read, Grep, Glob, Bash, WebSearch, WebFetch,
ListDirectory, graph_search, graph_query, MultiEdit, ...) become
entries in the same registry with `requiresApproval` as appropriate.

## Migration stages

1. **Types + skeleton** (`daemon/tools/types.ts`, `daemon/tools/registry.ts`,
   `daemon/tools/executor.ts`). No migration yet -- just the new
   interfaces.
2. **Dual-write**. For each existing tool / delegate, register a `Tool`
   entry alongside the legacy registration. Both paths keep working.
3. **Fold registries**. Rewrite `executeDelegate` and the LLM tool
   executor to look up in the unified registry. Legacy interfaces become
   thin shims.
4. **Controllers migrate**. Replace `kind: 'delegate'` with `kind: 'tool'`
   in research / pair / delegate controllers. The old kind stays as an
   alias for one release.
5. **New tools land**. git / jira / file / shell system-action tools
   get implemented as first-class `Tool`s.
6. **Remove shims**. Drop `daemon/delegates/` entirely, drop the legacy
   LLM tool interfaces, drop `kind: 'delegate'`.

Each stage is independently committable; 2 and 3 are the longest.

## Approval UX unification

The three-action gate (Approve / Skip / Edit) from the new web-search
flow becomes the default for every mutating tool. Controllers already
render this via `channel.registerExternalGate`; the LLM tool-loop will
re-use the same mechanism by exposing `deps.channel` to each tool's
execute().

Consequence: the LLM can trigger a Bash call, the user sees the diff +
command, approves or edits, and the tool-loop continues -- the same
flow a brainstorm / pair agent gets today.

## Compatibility promise

- Tool IDs stay stable. `WebSearch` (tool) and `web-search` (delegate)
  both resolve to the same underlying Tool during migration; the tool
  side eventually consolidates on `web-search` with `WebSearch` as an
  alias for one release.
- Controller task format stays stable: a `kind: 'delegate'` task with
  `delegateTo: 'web-search'` continues to work until stage 6.
- External callers of the daemon RPC are unaffected -- tools are an
  internal concept.

## Verification per stage

| Stage | How we know it works |
|-------|----------------------|
| 1 | Compile clean, no runtime callers. |
| 2 | Each legacy callsite + the unified registry produces the same output. Spot-check one tool + one delegate end-to-end. |
| 3 | Legacy shims pass through. All existing flows (research web search, pair debug, brainstorm convergence) work unchanged. |
| 4 | Controllers emit `kind: 'tool'` tasks; `kind: 'delegate'` still accepted by the orchestrator. |
| 5 | Each new tool has a smoke test hitting both entry paths. |
| 6 | `grep -rn "kind: 'delegate'"` is empty. `daemon/delegates/` is gone. |

## Open questions

- **Where does risk classification live?** Today `tools/validator.ts`
  has a risk ladder (low/medium/high) feeding permission mode. In the
  unified model, should risk be a field on `Tool`, a predicate the tool
  provides, or a cross-cutting policy enforced by the executor? Leaning
  predicate -- each tool knows its own risk best, but the executor
  consults a global policy for auto-accept.
- **Schema validation strategy.** JSON Schema via `ajv` is the obvious
  pick but adds ~60 KB. Alternative: a hand-rolled schema checker for
  the small surface we actually use. Leaning `ajv` for the LLM-facing
  clarity it gives.
- **MCP tools.** MCP currently registers external tools into the LLM
  tool-loop. Post-migration, each MCP server's tools become dynamic
  entries in the unified registry. No change for existing MCP users.
