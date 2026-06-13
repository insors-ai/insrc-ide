# Plan: External Coding Agent Integration

Implementation plan for the design at [`design/external-agent-integration.md`](../design/external-agent-integration.md).

Repositions insrc as an SDLC orchestrator + context engine that hands coding work off to external agents (Claude Code, Codex). insrc owns spec assembly, citation-grounded context, MCP exposure of its knowledge graph + memory, and permission gating. External agents do the actual editing / commands / debugging.

## Status

Pre-implementation. Triggered by run #6 audit (2026-06-12) showing that even with citation contract + nesting, the dominant remaining failures stem from insrc trying to do what dedicated coding agents already do well. Plan written 2026-06-13 immediately after the design doc.

## Related plans + design

- **Design**: [`design/external-agent-integration.md`](../design/external-agent-integration.md) — full architecture, interface contracts, and rationale.
- [`plans/access-gate.md`](./access-gate.md) — universal access gate; the gating subsystem here (`insrc.gate.*` IPC, IDE modal pipeline) extends that surface to PreToolUse hooks fired from external-agent subprocesses.
- [`plans/section-flow-architecture-redesign.md`](./section-flow-architecture-redesign.md) (and follow-ups) — section-flow is the spec-assembly engine for handoff specs. No new orchestration loop; we add a spec-emission step at the end and a new template registry.
- [`plans/intent-classification-consolidation.md`](./intent-classification-consolidation.md) — intent metadata gains `outputType` (report / spec-then-handoff / spec-only); single funnel rule unchanged.

## Goals

1. Ship an MCP server exposing ~12 insrc tools so external agents (Claude Code, Codex) can query the knowledge graph + memory + cross-repo closure + active spec context **at execution time**. Discovery is the agent's responsibility, not insrc's. See design §4.0 — the MCP surface is for the external agent, not for insrc's own local LLM.
2. Ship the handoff pipeline: section-flow assembles a **scope-and-criteria spec** (not pre-fetched content) → daemon spawns external agent → agent discovers what it needs via MCP → audit pass on deliverable → user accepts diff.
3. Ship three gating modes (pre-flight permissions, in-flight PreToolUse hooks, audit-time diff review) wired into VS Code's native UI.
4. Make insrc-the-VS-Code-extension a thin frontend; daemon owns subprocess lifecycle so VS Code crashes don't lose in-flight handoffs.
5. Migrate Pair / Delegate agents from in-process execution to scope-assembly-then-handoff, with a transitional opt-in setting so existing users aren't broken. Their step machines stay; the in-process `apply` loop retires.
6. End-to-end CLI-testable in ~1 week (Phase 2a), VS Code-integrated in ~2 weeks (Phase 2c), both agents + full gating in ~1 month (Phase 4).

## Non-goals

- A new orchestration loop. Reuse section-flow.
- Replacing insrc's local LLM tier — it stays for intent classification, memory recall, scope/template selection, acceptance-criteria emission, and audit-time review. It does **not** do source-code or data discovery (the new role split, design §4.0).
- Embedding a coding agent inside insrc. External agents do the coding work; insrc orchestrates.
- Pre-fetching entity/file content into the spec. The agent fetches what it needs at execution time via the MCP surface (design §4.0 "two surfaces, two audiences").
- Exposing `insrc_entity_*` / `insrc_repo_*` / `insrc_search_*` to the local LLM. Those live on the external-agent-only MCP surface; the local LLM's internal IPC surface is strictly narrower (design §4.5).
- Cross-language support beyond what tree-sitter parsers + skill catalog already cover.
- Persistent agent processes — one external-agent subprocess per handoff, period (see design §6.4).
- Real-time collaborative editing UX. Handoff is a fire-and-review cycle, not a co-editing session.

## Architecture summary

```
VS Code extension (UI layer)
   ↕  IPC over ~/.insrc/daemon.sock
insrc daemon (persistent state + orchestration + MCP server registry)
   │
   └── spawns per handoff:
       ├── Claude Code / Codex subprocess
       └── insrc-mcp-server subprocess (auto-launched by agent via stdio)
           ↓ on PreToolUse / PermissionRequest:
           └── insrc-permission-hook → daemon → IPC → extension modal
```

Persistent state in daemon (LMDB graph + LanceDB vectors + spill + session history + cited artifacts + MCP tool registry). Ephemeral per handoff (subprocess, MCP server, worktree, session token, hook configs).

**Two tool surfaces, two audiences** (design §4.0):
- **MCP surface** (`insrc_*` snake-case, ~12 tools across 4 families: entity, artifact+memory, repo, spec) — exposed to the external agent via stdio MCP / HTTP / CLI. Tools the agent has natively (filesystem, lexical grep) are excluded.
- **Local LLM internal IPC surface** (~8 IPCs: intent resolve, memory recall, session writes, handoff spawn/return, citation verify, section-review, gating evaluate) — internal to insrc's process tree, NOT exposed via MCP. The local LLM never calls `insrc_entity_*` / `insrc_repo_*` / `insrc_search_*` — discovery is the external agent's job.

This split is enforceable structurally: there's no IPC the local LLM can call to invoke entity/repo/search tools, and the MCP server doesn't honor calls from inside the daemon's own session.

Three gating modes layered by spec risk tag: pre-flight permission block (Mode A) → PreToolUse hook callbacks (Mode B) → audit-time sandbox-to-tree diff review (Mode C).

## Phase 0: Safety-net audit infrastructure hardening (prerequisite)

**Goal**: harden the citation verifier, section-review, and compose-time review pipeline. These are the components that become Phase 6's audit loop for external-agent deliverables. They already work on local-LLM output and will be reused unchanged on handoff returns.

**Background**: the 2026-06-13 retest (Phase 0 of this plan, original framing) confirmed that further prompt-patching against local-LLM extraction failures (method-local-vars, DuckDB-shape leakage, compound JSON-sampling steps) is sunk cost. Those failure modes live inside steps that disappear once discovery moves to the external agent. **The Pydantic Field-kwargs rule already shipped (`b4b8c6e7...`) stays in place** — it doubles as guidance for any future template-builder that asks the local LLM to summarize Pydantic models for the spec — but no further prompt-patches.

**Scope** (audit-infrastructure work, not LLM-prompt work):

- **Decouple section-review from section-flow's TODO loop**: today section-review is invoked twice (per-TODO and compose-time). Refactor so it can also be invoked as a standalone library function `reviewSection({markdown, citedArtifacts}) → Verdict`. Phase 6 calls this on external-agent deliverables.
- **Citation verifier as standalone library**: same. Extract `verifyCitations({deliverable, allowedArtifacts}) → {verdict, unsupported, unverified}`. Phase 6 reuses unchanged.
- **Add compose-time review test coverage**: the Phase 0 retest showed the compose-time pass rejecting 5 of 9 TODO sections for L2-fallback contamination and elision. Pin those cases as regression fixtures so the audit behaviour can't silently regress.
- **Make `replan-sketch` observable**: the retest showed cloud orchestrator firing `replan-sketch` when a leaf skill was unfit. Wire this into the structured trace (Phase 5 observability) so we can measure how often handoff-spec assembly needs to replan.
- **Revert force-cloud commit** (`feb05771...`-era) is still in scope — it landed in the Phase 0 retest already. Confirm it stays reverted.

**Explicitly NOT in scope**:
- Method-local-variable rule for summarize-step. Source-code field extraction moves to the external agent; the rule is moot under the new design.
- DuckDB-shape-vs-JSON-shape rule. Same reason — data-shape inference moves to the external agent.
- Cloud default model swap. No longer strategic if cloud is rarely invoked from insrc itself.

**Deliverables**:
- 1-2 commits extracting `reviewSection` and `verifyCitations` into reusable libraries
- 1 commit adding regression fixtures for compose-time review
- 1 commit wiring `replan-sketch` events into the structured trace
- No new files; refactoring existing `agent/section-flow/` modules

**Effort**: 2-3 days.

**Acceptance**:
- `reviewSection` and `verifyCitations` can be called from a unit test with a fixture deliverable and produce a verdict matching the existing in-section-flow behaviour on the same input.
- Compose-time review regression fixtures pin the 5 contamination cases from the Phase 0 retest.
- Structured trace includes `replan-sketch` events with reason + retained-step count.

## Phase 1: MCP server foundation

**Goal**: insrc daemon exposes its skill catalog subset as an MCP server. CLI users can `insrc query --tool <name> --args <json>` and get structured results. External agents can register insrc-mcp-server in their config and consume tools.

### 1.1 New files

```
src/insrc/mcp/                  # EXTERNAL-AGENT-FACING MCP surface (design §4.1-§4.4)
  server.ts                     # MCP stdio server entry point
  tool-registry.ts              # maps insrc_* tool names to skill calls
  tools/
    entity.ts                   # 6 insrc_entity_* tools
    artifact.ts                 # 2 insrc_artifact_* tools
    memory.ts                   # 2 insrc_memory_* tools (READS only; writes via internal IPC)
    repo.ts                     # 2 insrc_repo_* tools
    spec.ts                     # 2 insrc_spec_* tools (Phase 2a wires them; Phase 1 stubs)
  transport/
    stdio.ts                    # MCP-over-stdio protocol handler
  session-token.ts              # token issue + validate for session-scoped tools
  __tests__/
    server.test.ts
    tool-registry.test.ts
    tools/*.test.ts
src/insrc/internal-ipc/         # LOCAL-LLM-FACING internal IPC surface (design §4.5)
  registry.ts                   # maps internal.* IPCs to handlers
  handlers/
    intent.ts                   # internal.intent.resolve (wraps existing resolveIntent)
    memory.ts                   # internal.memory.recall, internal.session.append-turn
    handoff.ts                  # internal.handoff.spawn, internal.handoff.return (Phase 2a wires)
    review.ts                   # internal.review.citation-verify, internal.review.section-review
    gating.ts                   # internal.gating.evaluate (Phase 3 wires)
  __tests__/
    registry.test.ts
    handlers/*.test.ts
src/insrc/cli/commands/
  query.ts                      # insrc query subcommand (MCP surface only)
src/insrc/cli/setup-external-agent.ts  # insrc setup claude-code / insrc setup codex
bin/insrc-mcp-server            # subprocess entry (delegates to src/insrc/mcp/server.ts)
```

**Critical separation**: `src/insrc/mcp/` is the external-agent surface; `src/insrc/internal-ipc/` is the local-LLM surface. The two never cross. A CI check (Phase 0 deliverable or carried as a Phase 1 check) asserts no file under `src/insrc/internal-ipc/` imports from `src/insrc/db/graph/`, `src/insrc/db/lance/entity-vec`, `src/insrc/db/entities`, or `src/insrc/db/relations` — those are the entity/repo/search backing stores and the local LLM has no business touching them through any path.

### 1.2 Tool implementation

Each tool wraps an existing skill call OR a graph/memory store query. None requires LLM. Implementation pattern:

```ts
// src/insrc/mcp/tools/entity.ts
export const insrc_entity_search: McpTool = {
  name: 'insrc_entity_search',
  description: 'Semantic ANN search over entity embeddings.',
  inputSchema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string' },
      limit: { type: 'integer', default: 10, maximum: 50 },
      kind: { type: 'string' },
      repo: { type: 'string' }
    }
  },
  async invoke(input, ctx) {
    // existing search path
    return searchEntities(input.query, {
      limit: input.limit ?? 10,
      kind: input.kind,
      repo: input.repo
    });
  }
};
```

`ctx` carries the session token; session-scoped tools (`insrc_artifact_get`, `insrc_spec_*`) verify it against the issued-token table; global tools ignore it.

### 1.3 CLI subcommand

```
insrc query --tool insrc_entity_search --args '{"query":"INGRN class","limit":5}'
→ writes JSON to stdout
→ exit 0 on success, 2 on unknown tool, 3 on schema-validation failure, 4 on tool error
```

`insrc query --list` returns the tool schema list (matches MCP `tools/list`).

### 1.4 Setup commands

```
insrc setup claude-code
→ writes settings.json mcp block: { mcpServers: { insrc: { command: "/path/to/insrc-mcp-server" } } }
→ confirms with user before writing

insrc setup codex
→ writes ~/.codex/config.toml [mcp_servers.insrc] block + env_vars
→ confirms with user before writing
```

### 1.5 Tests

- Unit tests per tool covering input validation + happy/error paths.
- Integration test: spawn insrc-mcp-server stdio subprocess, send `tools/list` and a `tools/call`, verify response.
- E2E test: spawn Claude Code in headless mode against a real daemon, call `insrc_entity_search`, assert results.
- **Surface-isolation test**: assert no file under `src/insrc/internal-ipc/` imports entity/repo/search modules (CI grep + AST check). This is the structural enforcement of design §4.0.

### 1.6 Internal IPC surface (local-LLM-only)

Eight IPCs the local LLM calls during section-flow scope assembly + audit-time review. None are MCP-exposed.

```ts
// src/insrc/internal-ipc/handlers/intent.ts
export const intent_resolve: InternalIpc = {
  name: 'internal.intent.resolve',
  async invoke({sessionId, message, slashForced}, ctx) {
    return resolveIntent(ctx.sessionForId(sessionId), message, {slashForced});
  }
};

// src/insrc/internal-ipc/handlers/memory.ts
export const memory_recall: InternalIpc = {
  name: 'internal.memory.recall',
  async invoke({query, limit, since}) {
    const turns = await annSearchTurnVec(query, {limit, since});
    const segments = await annSearchResponseSegmentVec(query, {limit});
    return {turns, segments};
  }
};

// (handoff.spawn, handoff.return, review.citation-verify, review.section-review,
//  gating.evaluate are stubbed in Phase 1 and wired in Phases 2a / 3)
```

Each handler returns typed JSON. The local LLM's section-flow caller routes through this registry; the registry knows nothing about the MCP server or its tools.

**Phase 1 ships**: handler stubs + the registry + the intent/memory handlers (real implementations, wrapping existing modules). Handoff and gating handlers stub through and throw `NotImplementedError` until Phase 2a / Phase 3.

**Effort**: 4-6 days.

**Acceptance**:
- All ~12 MCP tools callable from CLI and MCP, returning structured JSON matching their schemas.
- All 8 internal IPCs registered; the two implemented in Phase 1 (intent.resolve, memory.recall) pass round-trip tests; the others stub through cleanly.
- Surface-isolation CI check passes.
- `insrc setup claude-code` produces a working settings.json that Claude Code consumes without error.
- `insrc setup codex` same for Codex.
- E2E test: Claude Code can `insrc_entity_search` against a real LanceDB.

**Dependency**: Phase 0.

## Phase 2a: Daemon-side handoff (CLI-testable, no VS Code yet)

**Goal**: end-to-end handoff pipeline runnable from CLI. Spec assembly → spawn Claude Code subprocess → watch worktree → audit deliverable → diff. No VS Code UI yet.

### 2a.1 New files

```
src/insrc/handoff/
  index.ts                      # public entry: runHandoff(spec, agentChoice, opts)
  spec-assembler.ts             # turns section-flow output + template into spec.md
  templates/
    registry.ts                 # template version registry
    debug-session.ts            # DEBUG-SESSION.md v1 (the wedge template)
    types.ts                    # Template, TemplateMeta, AcceptanceCriterion
  spawn/
    claude-code.ts              # spawn + capture stdout/stderr/exit
    codex.ts                    # (Phase 4 — stub here; throws "not implemented")
    base.ts                     # shared spawn primitives
  worktree.ts                   # git worktree create / merge / discard
  audit/
    deliverable-parser.ts       # extract claims + citations from deliverable.md
    citation-verifier.ts        # reuse existing src/insrc/agent/section-flow/citation-verifier.ts
    machine-checks.ts           # evaluate file-exists / regex / test-passes criteria
    judge.ts                    # combined verdict
  diff-presenter.ts             # produce a structured diff for the user
  __tests__/
    spec-assembler.test.ts
    templates/debug-session.test.ts
    worktree.test.ts
    audit/*.test.ts
    integration.test.ts         # uses a scripted Claude Code stub
src/insrc/cli/commands/
  handoff.ts                    # insrc handoff --spec ... --agent claude-code
```

### 2a.2 Spec assembler

Takes a **scope payload** (not a content-full WorkingMemoryEntry), a template id, the user's intent, and prior-turn memory excerpts. Produces:

- `spec.md` (rendered template — scope + criteria + discovery guidance, NOT pre-fetched entity content)
- `spec.meta.json` (template version, acceptance criteria, prior-turn references, risk tag, permissions block)

```ts
interface SpecAssemblerInput {
  templateId: TemplateId;
  intent: string;
  scope: ScopePayload;          // emitted by section-flow's TODO-decomposition step
  memoryExcerpts: MemoryRef[];   // ONLY prior-turn ids + 1-line summaries; NO freshly pre-fetched entity content
  workspaceRoot: string;
}

interface ScopePayload {
  repoId: string;
  repoPath: string;
  inScopeGlobs: string[];
  outOfScopePaths: string[];
  entryPointHints?: EntityRef[];  // ONLY when the user's prior conversation makes the entry point obvious
  dependencyClosureRepos?: string[];
  riskHints: 'low' | 'medium' | 'high';
}

interface MemoryRef {
  kind: 'turn' | 'artifact';
  id: string;
  oneLineSummary: string;
}

interface SpecAssemblerOutput {
  specId: string;
  specMd: string;
  specMeta: SpecMeta;
}
```

Uses **local LLM** for the template-filling step (fills in Objective, Scope, Memory excerpts, Acceptance Criteria sections). The local LLM does NOT call `insrc_entity_*` / `insrc_repo_*` — those are off-surface for it (Phase 1.6). If section-flow's TODO-decomposition step couldn't determine an `entryPointHint`, the spec ships without one and the external agent discovers it via `insrc_entity_search` at execution time.

No cloud calls during assembly.

Risk classifier (deterministic) runs alongside LLM-assigned risk and ratchets up per template rules (see design §11.4).

**What the spec assembler does NOT do**:
- Call `searchEntities(...)` to pre-find code referenced by user intent.
- Call `findCallers(...)` / `findCallees(...)` to pre-build impact analysis.
- Read source files to extract field definitions, function signatures, log spans, stack traces.
- Read JSON / Parquet / CSV files to pre-extract data shapes.

All of the above happen in Phase 5 (external agent), not Phase 3.

### 2a.3 Templates

Phase 2a ships ONE template: `DEBUG-SESSION.md`. Each template has **two shapes**: the SPEC (what insrc emits, light on content) and the DELIVERABLE (what the agent returns, the actual investigation + fix). Tests pin both.

#### Spec shape (insrc emits)

```markdown
# Debug Session: {intent}

## Objective
{user intent + classifier output}

## Scope
- Repo: {repoId} at {repoPath}
- In-scope paths: {inScopeGlobs}
- Out-of-scope (do not modify): {outOfScopePaths}
- Entry point hint (optional): {entryPointHints, if known from prior turns}
- Dependency closure: {dependencyClosureRepos}

## Memory excerpts (when relevant)
{prior-turn refs and 1-line summaries; NO freshly pre-fetched content}

## Acceptance Criteria
- [ ] machine: test {targetTest} passes {runCount}/{runCount} runs ({command})
- [ ] machine: no new flakiness introduced ({command})
- [ ] soft: fix targets the root cause identified in Conclude (LLM judgment)

## Constraints
- Sandbox: {worktree path}
- Risk: {risk}
- Time budget: {seconds}s
- May not edit: {outOfScopePaths}

## Discovery guidance
- Start with `insrc_entity_search("<failing test name>", repo="<repoId>")` to locate the test and likely impl files.
- Use `insrc_entity_callers(<id>)` / `insrc_entity_callees(<id>)` for impact analysis.
- Use `insrc_memory_recall("<prior fix attempts>")` if you suspect this issue has come up before.
- Use native Read/Grep/Glob for everything else.
- Don't assume the spec lists every file you'll need; scope is deliberately light.

## Deliverable structure
Write your investigation into `spec-deliverable.md` with these sections:
Reproduce, Localize, Hypothesize, Test, Conclude (one per stage of your investigation).
```

#### Deliverable shape (external agent emits)

```markdown
# Debug Session Deliverable: {intent}

## Reproduce
{steps + commands the agent ran to reproduce}

## Localize
{evidence the agent gathered — log spans, stack traces, file:line refs}

## Hypothesize
{ranked candidate causes with cited evidence}

## Test
{outputs from tests the agent ran on each hypothesis}

## Conclude
{determined cause + the applied fix description}
```

The audit phase (§2a.5) validates the deliverable shape, not the spec shape. The spec shape is validated at assembly time before spawn.

Tests pin both shapes independently.

### 2a.4 Spawn + worktree

```ts
async function spawnClaudeCode(spec: AssembledSpec, ctx: HandoffContext): Promise<SpawnResult> {
  const worktree = await createWorktree(spec, ctx);
  const sessionToken = issueSessionToken(spec.specId, ctx.sessionId);
  const env = {
    ...process.env,
    INSRC_SESSION_TOKEN: sessionToken,
    INSRC_DAEMON_SOCKET: ctx.daemonSocket,
    INSRC_SPEC_ID: spec.specId,
  };
  // write .mcp.json (Claude Code) referencing insrc-mcp-server stdio
  await writeFile(`${worktree}/.mcp.json`, JSON.stringify({
    mcpServers: { insrc: { command: '/usr/local/bin/insrc-mcp-server' } }
  }));
  // write hooks for Mode B (stub in 2a, full in Phase 3)
  // spawn
  const proc = spawn('claude', [
    '--print', '--cwd', worktree,
    '--allowedTools', 'Read,Grep,Bash,Edit,Write',
    '--disallowedTools', 'WebFetch,WebSearch'
  ], { env });
  proc.stdin.write(spec.specMd);
  proc.stdin.end();
  return captureOutput(proc, worktree);
}
```

Worktree: `git worktree add ~/.insrc/handoffs/{sid}/worktree/ <ref>` against the user's current branch.

### 2a.5 Audit

- Parse deliverable.md (the agent's output) against the template's required sections.
- Run citation-verifier (reuse existing section-flow code).
- Evaluate machine-checkable acceptance criteria (shell out for test runs).
- Skip soft criteria for now (Phase 2a has no cloud-LLM shim wired).
- Verdict: `accept` if all hard criteria pass and citations verify; `revise-edits` if minor; `revise-major` if substantial.

### 2a.6 Diff presenter

Computes structured diff between main worktree and handoff worktree. Output is a JSON structure the VS Code UI consumes in Phase 2b, but in 2a we render it as text for the CLI:

```
=== Files Changed (2) ===
 M test/foo.test.ts (4 lines)
 M src/foo.ts (10 lines)

=== Audit ===
✓ test foo.test.ts passes 50/50 runs
✓ no new flakiness
? soft: root-cause alignment (no judge configured)

=== Verdict ===
accept (machine checks pass; soft criteria skipped)
```

### 2a.7 CLI entry point

```
insrc handoff --spec ~/.insrc/specs/some-spec.md --agent claude-code
→ runs the pipeline
→ prints diff + verdict to stdout
→ exit 0 on accept, 1 on revise-edits, 2 on revise-major, 3 on agent crash
```

For testing, accepts `--scripted-agent <path>` instead of a real Claude Code, to inject a scripted stub.

### 2a.8 Tests

- Unit tests per module (~30 tests across spec-assembler, templates, audit, worktree).
- Integration test: scripted-agent end-to-end. Spec is generated, scripted-agent returns a fixture deliverable, audit runs, verdict matches expected.
- Tool-call replay test: scripted agent that calls insrc MCP tools (via stdio subprocess), verifying daemon answers correctly under session-token scoping.

**Effort**: 4-5 days.

**Acceptance**:
- `insrc handoff --spec ... --agent claude-code` runs end-to-end against a real Claude Code installation on a small wedge scenario (the flaky-test scenario).
- 80%+ unit test coverage on new files.
- Scripted-agent integration test passes deterministically.

**Dependency**: Phase 1.

## Phase 2b: VS Code extension headless UX

**Goal**: VS Code users can issue handoff requests from the chat UI; daemon handles the rest; UI shows progress, modals, final diff.

### 2b.1 Modified files

```
src/insrc-ide/extension/
  chat/handoff-renderer.ts          # NEW: streams daemon-emitted handoff events to chat UI
  progress/handoff-progress.ts      # NEW: wraps vscode.window.withProgress per handoff
  diff/handoff-diff.ts              # NEW: opens vscode.diff and surfaces accept/reject buttons
  permission-modal/index.ts         # NEW: showWarningMessage with modal + actions
  daemon-client.ts                  # MODIFY: subscribe to handoff events over IPC
  ipc/events.ts                     # MODIFY: add HandoffEvent types
```

### 2b.2 Daemon → extension event protocol

New event types over the existing daemon socket:

```ts
type HandoffEvent =
  | { kind: 'spec-assembling'; specId: string; }
  | { kind: 'spec-ready'; specId: string; preview: string; risk: Risk; permissions: PermissionsBlock; }
  | { kind: 'awaiting-mode-a'; specId: string; }    // user must approve permissions block
  | { kind: 'spawned'; specId: string; agent: 'claude-code' | 'codex'; pid: number; }
  | { kind: 'progress'; specId: string; status: string; elapsedMs: number; }
  | { kind: 'mode-b-gate-request'; gateId: string; specId: string; tool: string; args: unknown; justification: string; }
  | { kind: 'agent-completed'; specId: string; deliverablePath: string; }
  | { kind: 'auditing'; specId: string; }
  | { kind: 'audit-ready'; specId: string; verdict: 'accept' | 'revise-edits' | 'revise-major'; diff: DiffShape; }
  | { kind: 'handoff-final'; specId: string; outcome: 'accepted' | 'rejected' | 'failed'; }
```

Extension subscribes; daemon emits these as the handoff progresses.

### 2b.3 Chat UI rendering

The chat turn that initiated the handoff shows a progressive rendering: status text + inline action buttons. Visual hierarchy:

```
You: /debug the flaky test in foo.test.ts

[Spec assembled — Debug Session, risk: low, 4 acceptance criteria]
[Permissions: 5 allowed, 1 prompt, 3 denied]    [Allow] [Edit] [Cancel]
↓
[Running Claude Code... (0:45)]
↓
[Mode B: Allow `npm test -- --grep flaky`? Reason: ...]    [Allow] [Deny]
↓
[Audit: 2/2 machine checks passed. Soft criterion skipped.]
[Diff: 2 files changed, 14 lines]    [Review] [Accept] [Reject]
↓
✓ Handoff complete. Fix applied: race condition in beforeEach()
```

Each line is a chat message subcomponent rendered via the existing chat-message renderer + custom component types for handoff status.

### 2b.4 Permission modal

Mode A: shown as a non-modal notification with an "Edit" button that opens the permissions block as an editable JSON in a quick-pick UI. User can tighten / loosen the block before approving.

Mode B (in-flight): non-modal for `medium` risk, modal for `high` risk:

```ts
const action = await vscode.window.showWarningMessage(
  `Claude Code wants to run: ${tool}`,
  { modal: spec.risk === 'high', detail: justification },
  'Allow', 'Deny', 'Allow this session'
);
```

`'Allow this session'` persists for the spec's lifetime only. Not across handoffs.

Timeout: extension reads agent's tool-call timeout (defaults to 60s if unknown), schedules auto-dismiss at ~80% of that, sends 'deny' to daemon if no user response.

### 2b.5 Diff view

```ts
const mainUri = vscode.Uri.file(`${workspace}/`);
const worktreeUri = vscode.Uri.file(handoffWorktree);
await vscode.commands.executeCommand('vscode.diff', mainUri, worktreeUri, `${specTitle} — review`);
```

Accept/reject is two custom commands registered on the editor toolbar:

```ts
vscode.commands.registerCommand('insrc.handoff.acceptDiff', async (specId) => {
  daemonClient.send({ kind: 'accept-diff', specId });
});
vscode.commands.registerCommand('insrc.handoff.rejectDiff', async (specId, reason) => {
  daemonClient.send({ kind: 'reject-diff', specId, reason });
});
```

### 2b.6 Workspace trust

```ts
if (!vscode.workspace.isTrusted) {
  // disable handoff entirely; fall back to file-drop mode
  daemonClient.disableHandoff('untrusted-workspace');
}
```

Untrusted workspaces still get reports (no spawn). Handoff intents downgrade to spec-only output.

### 2b.7 Tests

- Mocha-based extension tests using `@vscode/test-electron`:
  - End-to-end: trigger a handoff, simulate daemon events, verify UI renders correctly.
  - Mode B modal: spawn an event, verify modal shows, simulate click, verify daemon receives.
  - Diff accept/reject roundtrip.
- Unit tests on event protocol shape (serialization roundtrip).

**Effort**: 3-4 days.

**Acceptance**:
- User can run `/debug` in chat, see the spec preview, approve permissions, watch progress, approve Mode B requests, review final diff, accept or reject — all from VS Code without ever touching a terminal.
- Workspace trust correctly disables handoff in untrusted folders.

**Dependency**: Phase 2a.

## Phase 2c: Terminal UX setting

**Goal**: opt-in `insrc.handoff.uxMode = "terminal"` setting that surfaces the agent's streaming output in a VS Code terminal panel instead of (or alongside) the headless progress UI.

### 2c.1 New files

```
src/insrc-ide/extension/
  terminal/handoff-pty.ts           # implements vscode.Pseudoterminal
  terminal/index.ts                 # registers terminal-mode integration
```

### 2c.2 Implementation

`vscode.window.createTerminal({ name: 'insrc: <spec>', pty: handoffPty })` where `handoffPty` is a `vscode.Pseudoterminal` reading from the daemon's stdout-relay event stream.

Daemon adds an event:
```ts
| { kind: 'agent-stdout-chunk'; specId: string; chunk: string; }
| { kind: 'agent-stderr-chunk'; specId: string; chunk: string; }
```

Terminal-mode subscribes to these and writes them to the PTY. Headless-mode ignores them (or summarises into the progress notification).

Mode B modals still appear normally over the terminal.

### 2c.3 Setting

```jsonc
{
  "insrc.handoff.uxMode": {
    "type": "string",
    "enum": ["headless", "terminal"],
    "default": "headless"
  }
}
```

### 2c.4 Tests

- Setting-toggle test: with `terminal`, verify terminal is created; with `headless`, verify not.
- PTY round-trip: emit a stdout-chunk event, verify the terminal receives.

**Effort**: 2 days.

**Acceptance**:
- Toggling the setting and re-running a handoff switches UX modes cleanly.
- Terminal mode shows live agent output; Mode B modals still fire.

**Dependency**: Phase 2b.

## Phase 3: Permission gating Modes A + B

**Goal**: full three-mode gating wired in. Mode A pre-flight (already in 2b), Mode B in-flight via PreToolUse hooks (new), Mode C audit-time (already in 2a).

### 3.1 New files

```
src/insrc/gating/
  hook-server.ts                # unix-socket server that hook scripts call
  permission-policy.ts          # matches a (tool, args) against spec's permission block
  risk-ratchet.ts               # deterministic rules ratcheting risk tag up
  __tests__/
    permission-policy.test.ts
    risk-ratchet.test.ts
    integration.test.ts         # end-to-end with a scripted hook
bin/insrc-permission-hook       # the hook script (small binary or wrapper)
```

### 3.2 Hook script

Single binary; reads JSON from stdin, connects to daemon socket (path from env var), receives `{tool_name, tool_input, session_id, cwd}`, asks daemon `gate.request-permission`, returns the daemon's verdict as JSON to stdout.

```bash
#!/usr/bin/env bash
# insrc-permission-hook
exec /usr/local/lib/insrc/bin/insrc-permission-hook-bin
```

(Binary in a different path so PATH pollution doesn't matter.)

### 3.3 Permission policy

```ts
interface PermissionPolicy {
  allow: PermissionRule[];   // auto-allow
  prompt: PermissionRule[];  // ask user via Mode B modal
  deny: PermissionRule[];    // hard reject
}
interface PermissionRule {
  tool: string;
  paths?: string[];          // glob patterns
  commands?: string[];       // for Bash; substring or glob
}

function evaluate(policy: PermissionPolicy, request: ToolRequest): 'allow' | 'prompt' | 'deny';
```

`deny` always wins; then `prompt`; then `allow`; default `prompt` (fail-safe).

### 3.4 Risk ratchet rules

Hard-coded list of patterns that force `risk: high` regardless of LLM tag:

```ts
const RATCHET_TO_HIGH: PermissionRule[] = [
  { tool: 'Edit', paths: ['**/infra/**', '**/migrations/**', '**/prod/**'] },
  { tool: 'Bash', commands: ['git push', 'rm -rf', 'sudo', 'npm publish', 'docker push'] },
  // ... extensible via template metadata
];
```

`risk: medium` ratchet rules separately for `--force`, branch-affecting git commands, etc.

LLM tag can never lower risk below ratchet result.

### 3.5 Per-agent hook registration

```ts
// spawn.claude-code.ts
await writeFile(`${worktree}/.claude/settings.json`, JSON.stringify({
  hooks: {
    PreToolUse: [{
      matcher: { type: 'all' },
      command: '/usr/local/bin/insrc-permission-hook'
    }]
  }
}));

// spawn.codex.ts (Phase 4)
await writeFile(`${worktree}/.codex/hooks.json`, JSON.stringify({
  hooks: [
    { event: 'PreToolUse', matcher: { tool: '*' }, command: '/usr/local/bin/insrc-permission-hook' },
    { event: 'PermissionRequest', matcher: { tool: '*' }, command: '/usr/local/bin/insrc-permission-hook' }
  ]
}));
```

### 3.6 Tests

- Permission policy unit tests covering allow / prompt / deny combinations + glob matching.
- Risk ratchet unit tests covering each rule.
- Hook end-to-end test using a scripted external agent that emits a tool call → hook fires → daemon answers based on a pre-configured policy → hook returns to agent → assert correct action.
- Failure-mode tests: daemon down (hook should deny safely), socket EAGAIN (retry then deny), modal timeout (default-deny within tool-timeout budget).

**Effort**: 1 week.

**Acceptance**:
- A risk:high spec with a `git push` action triggers a modal in the VS Code UI; user clicks Allow → action proceeds; user clicks Deny → action fails cleanly; user does nothing → auto-deny within 80% of tool-timeout.
- LLM-emitted `risk: low` for a spec touching `migrations/` is ratcheted to `risk: high` and the user sees the modal.
- `insrc-permission-hook` works identically for both Claude Code and Codex (Phase 4 validates this end-to-end).

**Dependency**: Phase 2c.

## Phase 4: Codex integration

**Goal**: parity with Claude Code — same templates, same gating, separate spawn path.

### 4.1 New / modified files

```
src/insrc/handoff/spawn/codex.ts                # full implementation
src/insrc/cli/setup-external-agent.ts           # codex case
src/insrc-ide/extension/                        # extension changes:
  daemon-client.ts                              # handle agent: 'codex' events
  handoff-renderer.ts                           # render codex-specific status messages
```

### 4.2 Codex spawn specifics

```ts
async function spawnCodex(spec: AssembledSpec, ctx: HandoffContext): Promise<SpawnResult> {
  const worktree = await createWorktree(spec, ctx);
  const sessionToken = issueSessionToken(spec.specId, ctx.sessionId);
  const env = { ...process.env, INSRC_SESSION_TOKEN: sessionToken, INSRC_DAEMON_SOCKET: ctx.daemonSocket, INSRC_SPEC_ID: spec.specId };
  // Write .codex/config.toml with [mcp_servers.insrc] block
  await writeFile(`${worktree}/.codex/config.toml`, [
    '[mcp_servers.insrc]',
    'command = "/usr/local/bin/insrc-mcp-server"',
    'env_vars = ["INSRC_SESSION_TOKEN", "INSRC_DAEMON_SOCKET", "INSRC_SPEC_ID"]'
  ].join('\n'));
  // Write .codex/hooks.json for Mode B
  await writeHooksJson(`${worktree}/.codex/hooks.json`);
  const proc = spawn('codex', [
    'run', '--workdir', worktree,
    '--sandbox-mode', 'workspace-write',
    '--writable-roots', worktree,
    '--approval-policy', 'on-request'
  ], { env });
  proc.stdin.write(spec.specMd);
  proc.stdin.end();
  return captureOutput(proc, worktree);
}
```

### 4.3 Template contract tests

Both agents must produce deliverables that pass the same template-contract test suite. Add a "cross-agent compat" test phase:

```ts
describe('template contract: DEBUG-SESSION', () => {
  for (const agent of ['claude-code', 'codex']) {
    it(`${agent}: produces valid deliverable from canonical spec`, async () => {
      const spec = await loadFixture('debug-session-spec.md');
      const result = await runHandoff(spec, agent, { scriptedFixtures: true });
      expectDeliverableMatchesTemplate(result.deliverable, 'DEBUG-SESSION');
    });
  }
});
```

### 4.4 Provider routing logic

```ts
function pickAgent(setting: 'claude-code' | 'codex' | 'auto', session: Session): AgentChoice {
  if (setting !== 'auto') return setting;
  return session.activeCloudProvider === 'anthropic' ? 'claude-code' : 'codex';
}
```

### 4.5 Tests

- Real-codex integration test (gated on `INSRC_TEST_CODEX=1` env, like existing ollama integration tests).
- Contract suite passes for both agents on the same spec fixtures.
- Hook script invoked from Codex behaves identically to Claude Code invocation.

**Effort**: 4-5 days.

**Acceptance**:
- `insrc.handoff.preferredAgent = "codex"` works end-to-end on the DEBUG-SESSION wedge.
- Setting `auto` picks Claude Code when Anthropic active, Codex when OpenAI active.
- Contract suite green for both agents.

**Dependency**: Phase 3.

## Phase 5: Hardening

**Goal**: production-ready handoff. Failure modes covered, observability shipped, edge cases handled.

### 5.1 Scope

- Subprocess crash recovery: agent dies mid-execution → daemon marks handoff failed, surfaces "Failed: agent crashed" with stack trace.
- Daemon crash mid-handoff (worktree exists, no daemon): on daemon restart, detect orphaned worktrees, surface as "Failed: session interrupted" with Retry / Discard options.
- Network drops: MCP tool calls retry with exponential backoff; persistent failures fall through as tool errors the agent can handle.
- Hook timeout: if modal auto-denies, the agent's tool call gets a clean rejection and proceeds with whatever recovery it has.
- Worktree cleanup on accept: merge changes back to main, remove worktree, update audit log.
- Worktree cleanup on reject: discard worktree without merging.
- Token expiry: tokens TTL out after 1 hour; renew while handoff is in-flight; expired requests rejected at daemon.

### 5.2 Observability

```
src/insrc/handoff/observability/
  trace-writer.ts                # writes structured trace.jsonl
  cost-meter.ts                  # tracks token + wall-time per handoff
  metrics.ts                     # cumulative metrics per session, per template
```

Per-handoff trace records all tool calls, gate decisions, audit results, token counts. Stored under `sessions/{sid}/spec/{specId}.trace.jsonl`.

### 5.3 Tests

- Failure-injection tests: kill agent mid-stream, simulate daemon restart with orphaned worktree, simulate socket disconnect during hook callback.
- Trace integrity: trace.jsonl is well-formed JSONL even on crash (line-buffered write + flush before exit).

**Effort**: 3-5 days.

**Acceptance**:
- All failure scenarios produce a user-actionable error message instead of silent hang.
- Per-handoff trace + cost record persists across all paths.

**Dependency**: Phase 4.

## Phase 6: HTTP gateway (fallback transport)

**Goal**: HTTP/REST gateway for environments where stdio MCP isn't viable.

### 6.1 Scope

```
src/insrc/mcp/transport/http.ts          # HTTP+SSE transport
src/insrc/mcp/server-http.ts             # HTTP server binding (localhost-only by default)
bin/insrc-mcp-server                     # extend to support --transport http
```

Same tool surface as stdio; same auth (bearer token via `INSRC_SESSION_TOKEN`); same session-scoping.

Codex consumes via `bearer_token_env_var` in config.toml; Claude Code via similar config.

**Effort**: 3 days.

**Dependency**: Phase 5.

## Phase 7: Remaining templates (rolling)

One template per week as workflows demand:

- `SPEC.md` — code change request (after DEBUG-SESSION is solid)
- `DESIGN.md` — architecture decision record
- `REQUIREMENTS.md` — requirements doc
- `TEST-PLAN.md` — test strategy
- `REVIEW.md` — review checklist
- `MIGRATION.md` — migration plan (risk: high by default)
- `AUDIT.md` — audit of existing artifact against ground truth (the manual audit pattern from the run #6 conversation, automated)

Each adds:
- New file in `src/insrc/handoff/templates/`
- Template-specific acceptance criteria patterns
- Unit tests pinning structure
- Risk-ratchet rules if any new path patterns

**Effort**: rolling, ~3-5 days per template depending on complexity.

**Dependency**: Phase 5.

## Phase 8: Multi-handoff orchestration (post-MVP)

Deferred. Chained specs (Turn N's spec references Turn N-1's deliverable as cited evidence). Spec dependencies (Spec B can't start until Spec A is accepted). Large-feature pipelines (design → implement → test → deploy as one user-initiated workflow).

Implementation likely involves a "workflow" abstraction over individual handoffs. Out of scope until the single-handoff path is rock-solid.

## Cross-cutting: Pair / Delegate migration

Three sub-phases overlapping with the main plan:

### M.1 Pre-handoff (today through Phase 3)

No change. Existing Pair / Delegate code paths handle implement / refactor / debug intents as they do now.

### M.2 Transitional (Phase 4 onwards)

Add a per-session opt-in:

```jsonc
{
  "insrc.coding.useExternalAgent": true   // default false during transition
}
```

When `true`, `implement` / `refactor` / `debug` intents route to handoff (spec assembly using Pair's existing step machine, then external-agent execution). When `false`, existing Pair behaviour.

Add a per-intent override (`@external-agent` mention).

### M.3 Steady state (after Phase 7 stable)

Flip default to `true`. Add deprecation warning to Pair's in-process execution path. Document the migration in CHANGELOG.

### M.4 Cleanup (post-MVP)

Remove Pair's `apply` step and the retry-on-validation loop. Pair becomes purely a spec-assembly module. Delegate likewise.

**Effort**: not separately tracked; tied to main phases above.

## Risks

| Risk | Mitigation |
|---|---|
| External agent CLI changes break our spawn integration | Pin tested versions; cross-agent contract tests; nightly compat run. |
| Codex's hook system evolves (it's newer than Claude Code's) | Document tested Codex version; integration test gated on env var. |
| Local LLM still struggles with spec-assembly | Substantially reduced under the new role split — spec assembly is now scope + criteria + memory excerpts, with NO source-code or data-shape extraction. The dominant failure modes from runs #1-6 (method-local vars, DuckDB shape leakage, compound JSON-sample steps) all live in extraction steps that don't exist in spec-assembly anymore. Residual risk is scope-decision errors (wrong repo, wrong glob); the external agent's discovery loop self-corrects for these. If scope errors persist, fall back is widening scope (let the agent investigate more) — NOT pre-fetching more content in the spec. |
| Local LLM accidentally calls entity/repo MCP tools | Structurally prevented: surface-isolation CI check (Phase 1.5) asserts `src/insrc/internal-ipc/` cannot import entity/repo modules; the IPC registry has no handler for them. The local LLM's only graph-adjacent capability is `internal.memory.recall` over turn/segment vectors. |
| Daemon-VS-Code IPC overhead becomes user-visible | Stream events; batch UI updates; the daemon was already designed for streaming. |
| User confusion about which agent does what work | UX clearly labels: "Spec by insrc (local) → executed by Claude Code". Trace + cost records make the boundary auditable. |
| Hook script trust prompts annoying users | Sign the hook binary; document the trust step in `insrc setup ...`; provide `--dangerously-bypass-hook-trust` only for the user's own (signed) hook. |
| Worktree pollution if cleanup fails | `insrc handoff list-orphans` CLI command + auto-cleanup on daemon startup. |
| Permission policy gets too verbose for users | Template defaults are tight; LLM-emitted rules are validated; user can edit per-handoff. |
| Multi-workspace ambiguity (which folder is the handoff for?) | Quick-pick UI when ambiguous; default to active editor's folder. |
| Hooks fail silently and tool calls just hang | Hook script always returns within tool-timeout; daemon enforces hard timeout independent of modal. |

## Out of scope

- Cross-machine MCP (HTTP gateway exists for that case, but multi-host orchestration isn't covered).
- Web-based version of insrc-the-frontend (only VS Code + CLI in this plan).
- Auto-discovery of which agent to use based on task content (always uses configured / explicit `preferredAgent`).
- Mid-handoff spec mutation (the user can't edit the spec while the agent is running).
- Sub-agent spawning from within an external agent (Claude Code subagents are their problem, not ours).
- Real-time co-editing UX where the user and the agent both modify files concurrently. Handoff is sandbox-then-review.

## File structure (new + modified)

```
NEW:
src/insrc/mcp/
  server.ts                          (Phase 1)
  tool-registry.ts                   (Phase 1)
  tools/{entity,artifact,memory,repo,spec}.ts (Phase 1, spec stubs)
  transport/{stdio,http}.ts          (Phase 1, http Phase 6)
  session-token.ts                   (Phase 1)
  server-http.ts                     (Phase 6)
  __tests__/                         (Phase 1)
src/insrc/handoff/
  index.ts                           (Phase 2a)
  spec-assembler.ts                  (Phase 2a)
  templates/
    registry.ts                      (Phase 2a)
    types.ts                         (Phase 2a)
    debug-session.ts                 (Phase 2a)
    spec.ts                          (Phase 7)
    design.ts                        (Phase 7)
    requirements.ts                  (Phase 7)
    test-plan.ts                     (Phase 7)
    review.ts                        (Phase 7)
    migration.ts                     (Phase 7)
    audit.ts                         (Phase 7)
  spawn/{base,claude-code,codex}.ts  (Phase 2a + Phase 4)
  worktree.ts                        (Phase 2a)
  audit/{deliverable-parser,citation-verifier,machine-checks,judge}.ts (Phase 2a)
  diff-presenter.ts                  (Phase 2a)
  observability/{trace-writer,cost-meter,metrics}.ts (Phase 5)
  __tests__/                         (Phase 2a + 4 + 5)
src/insrc/gating/
  hook-server.ts                     (Phase 3)
  permission-policy.ts               (Phase 3)
  risk-ratchet.ts                    (Phase 3)
  __tests__/                         (Phase 3)
src/insrc/cli/commands/
  query.ts                           (Phase 1)
  handoff.ts                         (Phase 2a)
src/insrc/cli/setup-external-agent.ts (Phase 1 + Phase 4)
bin/
  insrc-mcp-server                   (Phase 1)
  insrc-permission-hook              (Phase 3)
src/insrc-ide/extension/
  chat/handoff-renderer.ts           (Phase 2b)
  progress/handoff-progress.ts       (Phase 2b)
  diff/handoff-diff.ts               (Phase 2b)
  permission-modal/index.ts          (Phase 2b)
  terminal/{handoff-pty,index}.ts    (Phase 2c)
  ipc/events.ts                      (Phase 2b, MODIFY existing)

MODIFY:
src/insrc/agent/intent/resolver.ts   # add outputType to intent metadata (Phase 2a)
src/insrc/agent/router.ts            # external-agent selection logic (Phase 4)
src/insrc/agent/session.ts           # session.permissionMode interacts with risk (Phase 3)
src/insrc/agent/tasks/pair/agent.ts  # transitional path: spec-emit vs in-process (Phase M.2)
src/insrc/agent/tasks/delegate/agent.ts # same (Phase M.2)
src/insrc/agent/section-flow/run-section-flow.ts # wire spec-assembler at completion (Phase 2a)
src/insrc/agent/section-flow/citation-verifier.ts # reuse from handoff/audit/ (no change)
src/insrc/db/compaction.ts           # add kind: 'spec'/'deliverable'/'trace' rules (Phase 5)
src/insrc-ide/extension/daemon-client.ts # handoff event subscription (Phase 2b)
src/insrc-ide/extension/package.json  # new settings + commands (Phase 2b, 2c)
```

## Open decisions before Phase 1

1. **Spec format JSON variant**: do we ship JSON alongside markdown from day one, or only when we need machine consumption downstream? Decide before Phase 2a.
2. **Codex test gating**: should the Codex integration test be required in CI, or opt-in like the existing ollama tests? Decide before Phase 4.
3. **Template registry mutability**: are templates compiled into the daemon, or user-pluggable via a `~/.insrc/templates/` directory? Compiled is simpler for v1; pluggable is more powerful long-term.
4. **Auto-trigger from pivot intents**: should `/design` → "make it so" auto-trigger a handoff, or always require an explicit `/implement`? UX choice; affects Phase 2a's intent classifier changes.
5. **Hook script distribution**: shipped with insrc daemon binary, or a separate npm package the user installs? Simpler shipped; more flexible separate.

6. **Direct-report intent migration timing** (`/data-analyze`, `/code-analysis`, `/research`, `/review`, `/document`): the new role split (design §4.0) strictly applies to handoff intents (implement/refactor/debug/test). Direct-report intents currently run section-flow's local-LLM extraction path end-to-end. Phase 0 retest data argues for migrating them to a `DATA-ANALYZE` / `CODE-ANALYZE` handoff template too (external agent extracts, local LLM composes report). Decision: do we migrate before Phase 7 template rollout (cleaner contract, more refactor up-front), or after (ship the wedge first, migrate when failure-mode pressure justifies)? My current lean is *after* — Phase 0 retest showed the safety nets catching contamination at the audit layer, so direct-report intents are unlikely to ship visibly broken results in the meantime. Re-evaluate after Phase 6.

These don't block Phase 0; resolve during Phase 1 design review.
