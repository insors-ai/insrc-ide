# Plan: Universal Access Gate

A single, declarative access-control surface for tool calls.

Today every controller that wants per-tool gating (data-analyzer's
connection-approval, code-analyzer's fs-access) hard-codes which tool
input fields matter, owns its own approval Set, and reaches into the
runner via per-controller callbacks (`checkConnectionAccess`,
`checkPathAccess`). Adding a new tool surface or a new controller
duplicates the pattern.

This plan replaces that with:

  1. **Tools declare access requirements** in their registration
     (`access.kind` + `access.extractKey`).
  2. **Sessions carry an AccessStore** of approved (kind, key) tuples.
  3. **The executor** dispatches gates uniformly: read the tool's
     `access`, extract the key, consult the store, fire the gate
     once per session per (kind, key), persist the reply.
  4. **Controllers seed** the store with pre-approvals (typed paths,
     active-repo scopes, ephemeral connections) -- they don't touch
     gate UI or extraction logic.

After the refactor: a new tool annotated with `access` inherits
gating across every controller that uses it. A new controller
inherits the entire access policy by pre-approving its own scopes;
it doesn't see a single gate-related callback.

## Related plans

- [plans/analyzers/code-analyzer.md](./analyzers/code-analyzer.md)
  -- the fs-access gate it carries today moves into this surface
  (Phase 2 of THIS plan covers the migration).
- [plans/analyzers/data-analyzer.md](./analyzers/data-analyzer.md)
  -- the connection-approval gate it carries today moves into this
  surface; the controller's `_approvedConnections` Set goes away.
- [plans/data-driver.md](./data-driver.md) -- the data-driver's
  `db_*` builtin tools gain `access` declarations (Phase 1).

## Status

Pre-implementation. Triggered by data-analyzer Phase 1 testing
(2026-04-30): real run-time observation that controller-side gate
ownership doesn't scale to N tools × M controllers. The next
analyzer (deployment-analyzer) would force replicating the pattern
again; better to land the universal surface first.

## Goals

1. **One declaration site per tool.** A tool's access requirements
   live in its registration -- not in every consumer.
2. **One approval store per session.** Approvals are session-scoped
   (per design §14 across analyzers); the store is the canonical
   record. No per-controller approval Sets.
3. **Uniform gate UX.** Generic copy template, per-kind UI hints,
   consistent action labels. Users see the same affordance regardless
   of which controller issued the call.
4. **Controllers shrink.** Existing controllers lose ~50% of their
   gate-related code; new controllers don't write any.
5. **Cross-cutting tool consumers benefit immediately.** When a generic
   chat agent (or a future controller) invokes a `db_*` tool, the
   gate fires automatically -- today it would silently bypass.

## Non-goals

- **Replacing orchestrator-level flow gates** (plan-size approval,
  mid-flight cancel, present, plan-approval). These aren't "may I
  run this tool" decisions; they're flow-control decisions. Stay
  controller-owned.
- **Persistent (cross-session) approvals.** All approvals are
  session-scoped, matching today's behaviour. Persistent
  trust-store is a future plan.
- **Per-call (one-shot) approvals.** All approvals are session-wide
  for the matched (kind, key). Per-call approval is rare in practice
  and adds API surface; defer until use cases emerge.
- **Multi-key tools.** `extractKey` returns one key per call. Tools
  that touch multiple resources (cross-connection joins) gate per
  primary key today; multi-gate-per-call is a future extension.
- **The legacy `requiresApproval` flag.** Tool-registry's existing
  per-call generic prompt for shell/etc. stays. It coexists with
  this surface (Phase 4 considers folding it in).

## Architecture (text)

```
                       chat user types /data-analyze ...
                                    |
                                    v
                       ┌────────────────────────┐
                       │ DataAnalyzerOrchestrator│
                       │  (controller)           │
                       │                         │
                       │  buildInitialTasks:     │
                       │   - register ephemerals │
                       │   - session.access.     │
                       │     approve('connection',│
                       │     ephemeral_id) for   │
                       │     each one            │
                       └─────────┬───────────────┘
                                 │ runDataAnalyzer(task, opts)
                                 v
                       ┌────────────────────────┐
                       │  DataAnalyzer Runner    │
                       │   (per-task tool loop)  │
                       │                         │
                       │  for each tool_call:    │
                       │   executeTool(call,     │
                       │     { session, ... })   │
                       └─────────┬───────────────┘
                                 │
                                 v
            ┌──────────────────────────────────────────────┐
            │           executeTool(call, ctx)             │
            │  (the universal gate dispatcher)             │
            │                                              │
            │  1. tool = registry.get(call.name)           │
            │  2. policy = tool.access  (may be undefined) │
            │  3. if policy:                               │
            │       key = policy.extractKey(call.input)    │
            │       if !ctx.session.access.isApproved(     │
            │            policy.kind, key):                │
            │         reply = await fireAccessGate(        │
            │           ctx, policy, key)                  │
            │         if reply.action !== 'approve':       │
            │           return DENIED error result         │
            │         ctx.session.access.approve(          │
            │           policy.kind, key)                  │
            │  4. tool.execute(input, deps)                │
            └──────────────────────────────────────────────┘
                                 │
                                 v
            ┌──────────────────────────────────────────────┐
            │            fireAccessGate(...)               │
            │                                              │
            │  - emits a `gate` stream event with:         │
            │      gateId, title, content, format,         │
            │      actions: [{name:'approve', label:...},  │
            │                {name:'deny',    label:...}]  │
            │  - awaits via channel.registerExternalGate   │
            │  - returns the reply                         │
            └──────────────────────────────────────────────┘

   Workbench-side ChatView receives the gate event, renders an
   inline button-row above the chat input. User clicks; workbench
   sends gate.reply over IPC; daemon's registered handler fires;
   executeTool resolves; runner's tool loop continues.
```

## Tool.access shape

Single new optional field on `Tool` (in `daemon/tools/registry.ts`):

```ts
export interface Tool {
  readonly id: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly access?: AccessPolicy | undefined;
  // ... existing fields
  execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult>;
}

export interface AccessPolicy {
  /**
   * Resource kind. Free-form string; convention-driven. Each kind
   * gets its own bucket in the AccessStore + its own gate UX hints.
   *
   * Conventional kinds:
   *   - 'connection'        -- data-driver connection id
   *   - 'fs-path'           -- absolute file path (exact match)
   *   - 'fs-path-prefix'    -- absolute directory path (descendants
   *                            inherit). Approval at this kind matches
   *                            queries at kind='fs-path' if the key
   *                            starts with this prefix.
   *   - 'cloud-resource'    -- structured ARN-like id ('aws:rds:...')
   *   - 'cloud-resource-prefix' -- prefix-match counterpart.
   *   - 'shell-command'     -- parsed shell command name + args
   *   - 'network-host'      -- 'hostname:port' or 'hostname' (exact)
   *
   * Tools register the canonical exact-match kind; the AccessStore
   * checks prefix-kind buckets when an exact lookup misses.
   */
  readonly kind: string;

  /**
   * Extract the access key(s) from the tool's input.
   *
   *   - Returns `undefined` to skip the gate for THIS call (rare;
   *     reserved for inputs that don't yet name a specific
   *     resource).
   *   - Returns a single string for single-resource tools (most
   *     common -- the tool touches one connection / file / cloud
   *     resource per call).
   *   - Returns a string[] for multi-resource tools (e.g. a
   *     hypothetical db_cross_join that joins across two
   *     connections). The dispatcher gates every key
   *     independently; ALL must clear before the call runs.
   *
   * May be sync or async (returning a Promise). The dispatcher
   * awaits the result. Async is needed by tools whose access kind
   * differs from the surface input shape -- e.g. db_file_*
   * receives a connectionId but its access kind is 'fs-path', so
   * extractKey resolves the connection id to the connection's
   * file path via the pool. See "Shared gates across access
   * methods" below.
   *
   * NB: tools that read DAEMON-INTERNAL state (db_list_connections,
   * registry queries, config getters) should not declare an
   * `access` policy at all -- the dispatcher's `if (tool.access)`
   * check short-circuits and the call runs ungated. See Q2 in the
   * Open questions section.
   */
  extractKey(
    input: Record<string, unknown>,
    ctx: ToolExecContext,
  ): string | readonly string[] | undefined
   | Promise<string | readonly string[] | undefined>;

  /**
   * Human-readable description of the access being requested. Used in
   * the gate prompt body. Optional; the dispatcher falls back to
   * `${tool.id} on ${key}` when omitted.
   */
  describe?(input: Record<string, unknown>): string;

  /**
   * Severity hint for the gate UI. 'standard' shows a plain confirm;
   * 'destructive' adds a warning chrome (red border, doubled label).
   * Used for cloud-resource writes (e.g. cloud_aws_rds_stop) and
   * shell-command operations the registry already tags
   * `requiresApproval`. Defaults to 'standard'.
   */
  readonly severity?: 'standard' | 'destructive';
}
```

### Examples

```ts
// db_sql_sample -- gate on the (remote) connection id; user
// approves "primary" once and every subsequent SQL tool against
// that connection bypasses.
access: {
  kind: 'connection',
  extractKey: (input) => typeof input['connectionId'] === 'string' ? input['connectionId'] : undefined,
  describe: (input) => `connection \`${input['connectionId']}\` (sample rows)`,
}

// db_list_connections -- internal configuration read; NO access
// declaration at all. The dispatcher's `if (tool.access)` check
// short-circuits and the call runs ungated. Same convention for
// every internal/discovery tool (registry queries, config getters).

// db_file_describe -- the underlying RESOURCE is a filesystem path,
// not the synthetic ephemeral connection id. Gate kind = 'fs-path'
// (NOT 'connection') so an `fs-path` approval the orchestrator
// pre-seeded for the typed prompt path covers this call -- and a
// `file_read` against the same path shares the same approval. One
// resource = one gate, regardless of which tool reaches it.
//
// extractKey is async because it has to look up the connection's
// path via the pool.
access: {
  kind: 'fs-path',
  extractKey: async (input, ctx) => {
    const cid = input['connectionId'];
    if (typeof cid !== 'string') return undefined;
    if (!ctx.session?.repoPath) return undefined;
    const { acquirePool } = await import('../db/pool-cache.js');
    const pool = await acquirePool(ctx.session.repoPath);
    return pool.list().find(c => c.id === cid)?.path;
  },
  describe: (input) => `read file via connection \`${input['connectionId']}\``,
}

// file_read
access: {
  kind: 'fs-path',
  extractKey: (input) => typeof input['file_path'] === 'string'
    ? require('node:path').resolve(input['file_path'] as string)
    : undefined,
  describe: (input) => `read ${input['file_path']}`,
}

// cloud_aws_rds_stop (destructive)
access: {
  kind: 'cloud-resource',
  extractKey: (input) =>
    typeof input['region'] === 'string' && typeof input['dbInstanceIdentifier'] === 'string'
      ? `aws:rds:${input['region']}:${input['dbInstanceIdentifier']}`
      : undefined,
  describe: (input) => `STOP RDS instance \`${input['dbInstanceIdentifier']}\` in ${input['region']}`,
  severity: 'destructive',
}
```

## Shared gates across access methods

A consent gate represents user approval to access a real-world
resource. Two tools that touch the same resource share the same
gate -- a single approval covers every access method.

Concrete cases:

- **`db_file_*` and `file_*`** both read filesystem paths. They
  share `kind: 'fs-path'`, key = the absolute file path. A
  `file_read` of `/tmp/customers.json` and a `db_file_describe`
  through an ephemeral connection that points at the same path
  share the same approval. The user is asked once; either tool
  can serve subsequent requests.

- **`db_sql_*`** and a (hypothetical) `db_sql_explain_remote`
  both act against an RDBMS connection. Kind = `'connection'`,
  key = the connection id. A user who approves `primary` for
  describe sees no further gate when the same session calls
  sample / explain / etc.

- **`cloud_aws_rds_describe` and `cloud_aws_rds_modify`**
  share kind = `'cloud-resource'`, key = the ARN. Read approves
  describe; modify (severity: 'destructive') always re-fires
  even with a prior approval (see destructive flow below).

Why this matters: gating on the access METHOD (e.g. "approve
the connection id `ephemeral_customers_009ad085`") would ask
the user to approve a synthetic id they don't recognise. Gating
on the underlying RESOURCE ("approve `/tmp/customers.json`")
asks for consent on the thing the user actually thinks about.

The pattern: when the surface input doesn't directly name the
resource (a connection id wrapping a path, an ARN built from
parts), `extractKey` is async and resolves the input through
the pool / registry / config to the canonical resource id. The
kind in this case is the kind of the RESOURCE (`fs-path` for a
file connection), NOT the surface ('connection').

## AccessStore shape

Lives on `Session` (one store per chat session). Plain in-memory state;
session close drops it.

```ts
// shared/access.ts
export interface AccessStore {
  /**
   * True if (kind, key) is approved -- either as an exact match in
   * the kind's bucket, or via a matching prefix in `${kind}-prefix`.
   */
  isApproved(kind: string, key: string): boolean;

  /** Add an exact (kind, key) approval to the store. Idempotent. */
  approve(kind: string, key: string): void;

  /** Add a prefix approval -- all keys starting with `prefix` match. */
  approvePrefix(kind: string, prefix: string): void;

  /**
   * Forget an approval. Mostly for tests; the session itself is
   * disposable so production callers don't need this.
   */
  revoke(kind: string, key: string): void;

  /** Snapshot for "show me what's approved this session" UI. */
  list(): readonly { kind: string; key: string; approvedAt: number; prefix: boolean }[];
}

export class DefaultAccessStore implements AccessStore { ... }
```

The default implementation:
- Two `Map<string, Set<string>>` buckets: exact + prefix.
- `isApproved` checks the exact bucket for `kind`; falls back to the
  prefix bucket for `${kind}-prefix` (or whatever the convention says
  is the prefix-kind for this kind).
- O(N) prefix walk per check; N is small in practice (a session has
  tens of approvals max).

### Wiring on Session

`Session` gains `readonly access: AccessStore = new DefaultAccessStore();`.
Constructed once per session; threaded into `ToolExecContext` so
`executeTool` can read it.

## Executor changes

`agent/tools/executor.ts` -- the central change:

```ts
export async function executeTool(
  call: ToolCall,
  context?: ToolExecContext,
): Promise<ToolResult> {
  const tool = getUnifiedTool(call.name);
  if (!tool) {
    return { toolCallId: call.id, content: `Unknown tool: ${call.name}`, isError: true };
  }

  // NEW: access-gate dispatch -- runs before the tool's execute().
  if (tool.access !== undefined && context?.session !== undefined) {
    const decision = await checkAccess(tool, call.input, context);
    if (!decision.allowed) {
      return {
        toolCallId: call.id,
        content: `[error] ACCESS_DENIED: ${decision.reason}`,
        isError: true,
      };
    }
  }

  const deps = await buildDeps(context);
  const translatedInput = translateAliasInput(call.name, call.input);
  try {
    const result = await tool.execute(translatedInput, deps);
    return unifiedToLegacy(call.id, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { toolCallId: call.id, content: `[error] ${call.name}: ${msg}`, isError: true };
  }
}

async function checkAccess(
  tool: Tool,
  input: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  const policy = tool.access!;
  const key = policy.extractKey(input);
  if (key === undefined) return { allowed: true };  // discovery call

  const store = ctx.session!.access;
  if (store.isApproved(policy.kind, key)) return { allowed: true };

  const reply = await fireAccessGate(ctx, tool, policy, input, key);
  if (reply.action === 'approve') {
    store.approve(policy.kind, key);
    return { allowed: true };
  }
  return { allowed: false, reason: `user denied access to ${policy.kind} \`${key}\`` };
}
```

`fireAccessGate` builds the standard gate event (gateId, title, content,
actions) and awaits via the existing `channel.registerExternalGate`
plumbing. No new IPC surface.

## UX flows

### Approved-on-first-use (the common case)

```
User: /data-analyze find pii in /tmp/customers.json
  -> orchestrator registers ephemeral 'ephemeral_customers_xxx' AND
     session.access.approve('connection', 'ephemeral_customers_xxx')
  -> runner: model calls db_file_describe({connectionId: 'ephemeral_customers_xxx'})
  -> executor: isApproved -> true, skip gate, run.
  -> No UI surface. Silent.
```

### Gate fires once per session per (kind, key)

```
User: /data-analyze inspect the orders table on primary
  -> orchestrator does NOT pre-approve 'primary' (it's a real
     registered connection -- user consent should be explicit)
  -> runner: model calls db_sql_describe({connectionId: 'primary',
     target: 'orders'})
  -> executor: isApproved('connection', 'primary') -> false
  -> fireAccessGate fires:

     ┌──────────────────────────────────────────────────────────┐
     │ Approve connection access                                │
     │                                                          │
     │ The agent wants to use connection `primary`              │
     │ (rdbms / postgres) [PROD, pii-cfg]                       │
     │                                                          │
     │ Operation: connection `primary` (describe table 'orders')│
     │                                                          │
     │ Approval is session-scoped; re-prompts after IDE         │
     │ restart.                                                 │
     │                                                          │
     │  [ Approve for session ]   [ Deny ]                      │
     └──────────────────────────────────────────────────────────┘

  -> User clicks "Approve for session"
  -> session.access.approve('connection', 'primary')
  -> runner continues; subsequent calls against 'primary' bypass.
```

### Destructive ops (cloud writes)

```
runner: model calls cloud_aws_rds_stop({region: 'us-east-1',
  dbInstanceIdentifier: 'prod-billing'})
executor: isApproved('cloud-resource', 'aws:rds:us-east-1:prod-billing') -> false
fireAccessGate fires with severity='destructive':

  ┌──────────────────────────────────────────────────────────┐
  │ ⚠ Destructive operation                                  │
  │                                                          │
  │ The agent wants to STOP RDS instance `prod-billing` in   │
  │ us-east-1.                                               │
  │                                                          │
  │ This action may affect a production database.            │
  │                                                          │
  │  [ Approve once ]   [ Deny ]                             │
  └──────────────────────────────────────────────────────────┘
```

Destructive ops get **per-call approval, not session-wide.** The
dispatcher checks `policy.severity === 'destructive'` and ALWAYS
fires the gate, even if previously approved. (Approving an RDS stop
once shouldn't auto-approve future stops.)

### Prefix approvals

The code-analyzer pre-approves the active repo at session start:

```ts
session.access.approvePrefix('fs-path', '/home/subho/work/insors-extraction/');
```

A subsequent `file_read` call against any path in that tree:

```
executor: isApproved('fs-path', '/home/subho/work/insors-extraction/src/foo.ts')
  -> false in exact bucket
  -> walks 'fs-path-prefix' bucket; '/home/subho/work/insors-extraction/'
     is a prefix match -> true
  -> bypasses gate.
```

Read of `/etc/passwd`:
```
  -> isApproved -> false (no matching prefix)
  -> gate fires asking the user to approve `/etc/passwd` (or by prefix).
```

### "Approve for repo" / "Approve for prefix" gate action

When a gate fires for a path / cloud resource that has natural
hierarchy, the gate offers a "Approve scope" action that adds to the
prefix bucket:

```
  ┌──────────────────────────────────────────────────────────┐
  │ Approve filesystem access                                │
  │                                                          │
  │ The agent wants to read `/var/log/nginx/access.log`.     │
  │                                                          │
  │ This path is outside the active repo                     │
  │ (`/home/subho/work/insors-extraction/`).                 │
  │                                                          │
  │  [ Approve once ]                                        │
  │  [ Approve `/var/log/nginx/` for session ]               │
  │  [ Deny ]                                                │
  └──────────────────────────────────────────────────────────┘
```

The "Approve scope" button calls `session.access.approvePrefix(...)`
with the dirname of the requested path. Future reads under that prefix
bypass the gate.

### Showing the user what's approved

New palette command `Insrc: Show session approvals` opens a
read-only pane listing the session's `AccessStore.list()` output:

```
Session approvals (this session only)
─────────────────────────────────────
connection      primary                                approved 14:32
connection      ephemeral_customers_009ad085           pre-approved
fs-path-prefix  /home/subho/work/insors-extraction/    pre-approved
cloud-resource  aws:rds:us-east-1:dev-billing         approved 14:35
shell-command   git status                             approved 14:33
```

Optional for v1; useful for the "what's the agent allowed to do?"
trust UX. Falls in Phase 5.

## Migration steps

### Phase 1 -- shared infrastructure

1. **`shared/access.ts`** -- declares `AccessStore` interface +
   `DefaultAccessStore`. Tests for prefix-match logic.
2. **`shared/types.ts`** -- adds `AccessPolicy` to the shared types
   (so tools and the executor share the type).
3. **`agent/session.ts`** -- adds `readonly access: AccessStore =
   new DefaultAccessStore();` to the Session class.

Acceptance: a Session has `.access`; no consumer uses it yet.

### Phase 2 -- executor + gate dispatcher

4. **`daemon/tools/registry.ts`** -- `Tool` interface gains
   optional `access?: AccessPolicy` field.
5. **`agent/tools/executor.ts`** -- adds the `checkAccess` step
   between tool lookup and `tool.execute()`. Adds
   `fireAccessGate` helper that builds the gate event + awaits
   via `channel.registerExternalGate`.

Acceptance: `executeTool` runs unchanged for tools without `access`;
fires a generic gate when a tool with `access` is called against an
unapproved key.

### Phase 3 -- annotate built-in tools

6. **db_* tools** in `daemon/tools/builtins/db/index.ts`:
   - **db_sql_***  (describe / sample / explain) → `kind:
     'connection'`, sync extractKey returns
     `input['connectionId']`. Gate is per-(remote) connection.
   - **db_kv_***   (scan / get / sample_shape) → same as
     db_sql_*: `kind: 'connection'`.
   - **db_file_*** (describe / sample / sample_shape) → `kind:
     'fs-path'`, ASYNC extractKey resolves connectionId →
     connection.path via the pool. Shares the gate surface with
     `file_*` tools (same path = same approval; see "Shared gates
     across access methods" above).
   - **db_list_connections** UNANNOTATED -- internal-config read;
     no external access. Same convention for any future tool
     that's purely internal-config.
7. **file_* tools** (`file_read`, `file_write`, `file_delete`,
   `file_move`, `file_copy`, `file_mkdir`, `file_stat`,
   `file_edit`) -- add `access: { kind: 'fs-path', extractKey: ... }`.
8. **search_grep / search_glob** -- add `access` keyed on the
   `path` arg.
9. **shell_exec** -- add `access: { kind: 'shell-command',
   extractKey: ..., severity: 'destructive' }`.
10. **cloud_*_*** tools (~50) -- add `access: { kind:
    'cloud-resource', extractKey, severity: ... }`. Read ops:
    standard severity. Write/delete ops: destructive.

Acceptance: every tool with an externally-visible resource has an
`access` declaration. Generic chat agent invoking any of them gets
a gate (where today it would silently run with whatever scope
the session leaks).

### Phase 4 -- migrate controllers

11. **data-analyzer-orchestrator.ts**:
    - Replace `_approvedConnections` Set with `session.access`.
    - On ephemeral registration: `session.access.approve('connection',
      f.connectionId)`.
    - Drop `checkConnectionAccess` from the runner's opts.
    - Drop `_fireGate` + `ConnectionApprovalRequest` /
      `ConnectionApprovalReply` types from access-gate.ts (the gate
      shape moves into the universal dispatcher's request).
12. **code-analyzer-orchestrator.ts**:
    - Replace per-call `checkPathAccess` with a session-level
      pre-approval at run start:
      `session.access.approvePrefix('fs-path', activeRepoPath + '/');`
    - Drop `approvedDirs` from `K_STATE` (the access store does the
      work).
    - Drop `checkPathAccess` callback from runAnalyzer's opts.
13. **runner.ts** (data-analyzer + code-analyzer) -- remove the
    per-call gate hooks. The runner becomes simpler: each tool call
    goes straight to `executeTool(call, ctx)`; the dispatcher
    handles the gate.

Acceptance: data-analyzer's connection-approval gate UX is
unchanged from the user's perspective. The orchestrator code is
~50% smaller. Code-analyzer's fs-access gate UX is unchanged.

### Phase 5 -- polish

14. Approval pane (`Insrc: Show session approvals`).
15. Per-call destructive flow: dispatcher always fires for
    `severity: 'destructive'`, even on a previously-approved key.
16. Gate action `approve-prefix` for fs-path / cloud-resource gates
    (computes the dirname / namespace as the prefix scope).
17. Audit log: every approval/denial logs `{kind, key, action,
    sessionId}` so post-hoc review is possible.

## UX who-shows-the-gate

Single answer: **the existing chat panel widget**, no new UI.

The dispatcher emits a standard `gate` stream event over the active
chat IPC channel. The workbench's `chatView.ts` already renders gate
events as inline button rows above the chat input
(`registerExternalGate` plumbing predates this plan; see brainstorm /
code-analyzer / fs-access for prior art). All access gates use the
same render path.

What's new is consistency: every access gate shares the same template
(title format, content format, action labels), so users learn the
shape once.

```
title:   `${verbForKind(kind)} ${describeShort(input)}`
         e.g. "Approve connection use", "Approve filesystem access",
         "⚠ Destructive operation"
content: `${tool.access.describe(input)}\n\n
         ${kindHint(kind)}\n\n
         Approval is session-scoped${prefixHint}.`
actions:
  - 'approve' / `Approve <description>` (always present)
  - 'approve-prefix' / `Approve <prefix>` (when policy supports it)
  - 'deny' / 'Deny' (always present)
```

## Risks

1. **Tool-author burden**: every new tool needs an `access`
   declaration. Mitigation: `access` is optional; tools without one
   stay unguarded (today's behaviour). Lint rule (eslint or a
   custom registry-time check) flags tools with destructive verbs
   in their id (`delete`, `stop`, `drop`, `rm`) that lack
   `severity: 'destructive'`.

2. **Prefix-match semantics**: a path-prefix approval that ends in
   `/` matches any path with that prefix; without the trailing
   slash a user could approve `/var/log` and accidentally cover
   `/var/log_archive/`. Documented; the dispatcher's `approvePrefix`
   helper appends `/` when the kind is `fs-path-prefix` and the
   prefix doesn't end in one.

3. **Gate spam at start of an XL data-analyzer run**: 20 connections
   in scope = 20 gates? No -- the data-analyzer's plan task is
   ALWAYS issued before the analyzer; the orchestrator can pre-approve
   any connection that appears in the planner's output via a single
   "approve all of these for the session?" bulk gate. That UX lands
   in Phase 5.

4. **Per-call destructive cost**: every cloud_*_stop / shell rm
   fires a gate. Acceptable -- destructive ops should be
   user-visible. Expected.

5. **Test fixtures use exact path strings**: tests that drive
   `executeTool` need to either (a) seed `session.access` for
   the resources they touch, or (b) use a fake session whose
   `access` is permissive. Phase 1 ships a `PermissiveAccessStore`
   for the test harness.

## Out of scope

- **Persistent / cross-session approvals**. All approvals die with
  the session. A future plan might add a per-repo trust store keyed
  on `(repo, kind, key)` -- not v1.
- **Capability-based access (e.g. only "read this file via Read,
  not Grep")**. Today the kind is the same regardless of which tool
  reaches the resource. Per-tool variation isn't worth the
  combinatorics for v1.
- **Time-limited approvals (e.g. "approve for 5 minutes")**.
  Out-of-scope for v1.
- **Network egress gating per host:port**. The `network-host` kind
  is reserved but we don't currently have tools that ask for
  per-host approval. Lands when the first such tool ships.

## File structure (new + modified)

```
shared/
  access.ts                           # NEW -- AccessStore + DefaultAccessStore
  types.ts                            # +AccessPolicy
agent/
  session.ts                          # +access: AccessStore field
  tools/
    executor.ts                       # +checkAccess + fireAccessGate
  tasks/
    code-analyzer/
      analyzer/runner.ts              # -checkPathAccess opt
    data-analyzer/
      access-gate.ts                  # most of this file deletes;
                                      # gate types come from the
                                      # dispatcher's standard request
      analyzer/runner.ts              # -checkConnectionAccess opt
daemon/
  tools/
    registry.ts                       # +Tool.access? field
    builtins/
      db/index.ts                     # +access on every db_* tool
      file/*.ts                       # +access on every file_* tool
      search/grep.ts, glob.ts          # +access keyed on path
      shell/exec.ts                   # +access (destructive)
      cloud/**/*.ts                   # +access on every cloud_* tool
  controllers/
    data-analyzer-orchestrator.ts     # -approvedConnections, +session.access seeding
    code-analyzer-orchestrator.ts     # -approvedDirs, +session.access seeding
```

## Test scripts

```
scripts/test-access-store-prefix.ts          # prefix-match correctness
scripts/test-access-executor-dispatch.ts     # gate fires on missing approval
scripts/test-access-data-analyzer-flow.ts    # ephemeral pre-approval bypasses
scripts/test-access-cloud-destructive.ts     # destructive always-fires regardless
```

## Sequencing recommendation

```
Phase 1 (foundations)   ──>  Phase 2 (executor)  ──>  Phase 3 (annotate)  ──>  Phase 4 (migrate)  ──>  Phase 5 (polish)
```

Phase 1 + 2 land together as the "infrastructure" commit. Phase 3
splits into multiple commits (one per tool family: db, file, shell,
cloud). Phase 4 splits per controller. Phase 5 lands feature by
feature.

Estimated scope: ~600-800 lines net (mostly the Phase 3 annotations
across many tools). The controller migration in Phase 4 is a net
SHRINK of code.

## Open questions

1. **Should `Tool.access.kind` be a typed enum or a free string?**
   ✅ **Resolved -- free string** (per user direction 2026-04-30).
   Free string keeps the door open for finer subkinds without
   touching the shared `AccessPolicy` type each time
   (e.g. `aws-s3-object`, `aws-rds-instance`, `gcp-bucket`). The
   plan documents the canonical kinds (`connection`, `fs-path`,
   `fs-path-prefix`, `cloud-resource`, `cloud-resource-prefix`,
   `shell-command`, `network-host`) as conventions; tool authors
   may add new ones inline. The AccessStore is kind-agnostic.

2. **Discovery / internal-config calls (e.g. db_list_connections)**
   -- gate or no?
   ✅ **Resolved -- no gate** (per user direction 2026-04-30):
   internal configuration is automatically available to the daemon,
   no access policy required. Tools that read DAEMON-INTERNAL
   STATE (the registered connections list, the tool registry's
   own contents, configuration getters, etc.) declare NO `access`
   field at all -- the dispatcher's `if (tool.access)` check
   short-circuits and the call runs ungated.

   Tools that touch EXTERNAL state (a DB query, a file read, a
   network call, a shell exec) declare `access` with the
   appropriate resource kind. The split is clean:

   - `db_list_connections`   -- internal (lists what's configured).      No `access`.
   - `db_sql_describe`       -- queries the live DB.                     `access: connection`.
   - `db_sql_sample`         -- queries the live DB.                     `access: connection`.
   - `tools_list_drivers`    -- internal registry read.                  No `access`.
   - `file_read`             -- reads filesystem.                        `access: fs-path`.
   - `cloud_aws_rds_list`    -- calls AWS API (external).                `access: cloud-resource`.

   Phase 3 of this plan annotates only resource-touching tools.
   Internal/discovery tools stay ungated by simply omitting
   `access` -- no special "internal" kind needed.

3. **Gate timeout**: today's gate UI doesn't time out. Should the
   dispatcher?
   ✅ **Resolved -- leave as is** (per user direction 2026-04-30).
   The dispatcher inherits whatever the existing gate plumbing does
   (indefinite wait + `chat.cancel` is the escape hatch). No
   timeout machinery added by this plan.

4. **Tools that read MANY resources at once** (e.g. a hypothetical
   `db_cross_join` querying two connections).
   ✅ **Resolved -- gate every key** (per user direction
   2026-04-30): a tool that joins across N resources must have
   all N approved before the call runs. If any aren't approved,
   the dispatcher fires gates for the missing ones (serially in
   v1) and runs the tool only when every key clears.

   API change to support this:

       interface AccessPolicy {
         readonly kind: string;
         /**
          * Returns:
          *   - undefined        -- skip the gate entirely
          *   - string           -- single resource (most common)
          *   - readonly string[] -- multiple resources; ALL must
          *                         clear the gate before the tool
          *                         runs. Order doesn't matter.
          */
         extractKey(input: Record<string, unknown>): string | readonly string[] | undefined;
         describe?(input: Record<string, unknown>): string;
         severity?: 'standard' | 'destructive';
       }

   Dispatcher logic:

       const raw = policy.extractKey(input);
       if (raw === undefined) return { allowed: true };
       const keys = Array.isArray(raw) ? raw : [raw];

       const denials: string[] = [];
       for (const key of keys) {
         if (store.isApproved(policy.kind, key)) continue;
         const reply = await fireAccessGate(ctx, tool, policy, input, key);
         if (reply.action === 'approve') {
           store.approve(policy.kind, key);
         } else {
           denials.push(key);
           // For destructive tools, abort on first deny -- no point
           // approving subsequent keys if the call is going to fail.
           // For non-destructive, keep collecting so the user sees
           // every denial in the trace.
           if (policy.severity === 'destructive') break;
         }
       }
       if (denials.length > 0) {
         return { allowed: false, reason: `denied: ${denials.join(', ')}` };
       }
       return { allowed: true };

   UX in v1: serial. The user sees one gate per missing approval,
   one after the other. Familiar, uses the existing gate widget.

   Phase 5 polish: batched-gate UI for multi-key calls --
   a single "Approve all of these for the session?" prompt with
   a multi-select list. Lands when the first multi-key tool ships
   and gives the UX a real workout.
