# External Coding Agent Integration

**Status**: Draft for review
**Date**: 2026-06-13
**Scope**: How insrc exposes its knowledge graph, memory, and SDLC orchestration to external coding agents (Claude Code, OpenAI Codex, future agents) so that insrc handles the *thinking* (context assembly, planning, review) and the external agent handles the *doing* (file edits, command execution, interactive coding loops).

---

## 1. Goals & Non-Goals

**Goals**:

1. Make insrc the higher-level SDLC orchestrator that produces structured specs and hands them off to external coding agents for execution.
2. Expose insrc's unique assets (semantic knowledge graph, cross-session memory, cross-repo dependency closure, cited evidence trail) as queryable tools for the external agent, without duplicating capabilities the agent already has natively (Read, Grep, Bash, Edit).
3. Agent-agnostic interface contract — the same insrc backend works with Claude Code, Codex, and future agents through standardized protocols (MCP for tools, PreToolUse hooks for gating), not bespoke shims.
4. Preserve insrc's review/audit guarantees: the external agent's output gets validated against the spec's cited acceptance criteria before acceptance.
5. Pay-as-you-think cost model — almost all token cost is paid by the external agent's execution turn(s). insrc itself uses local LLM for orchestration and deterministic code for everything verifiable; insrc cloud LLM is invoked only for rare cheap-judgment shims that don't warrant spinning up a full external-agent session.

**Non-Goals**:

- Compete with Claude Code / Codex on file editing, refactoring, or interactive coding loops.
- Replace MCP — adopt and extend it for agents that speak it; bridge agents that don't.
- Build a custom coding agent inside insrc. The reverse — insrc orchestrates over external agents.
- Ship before the SDLC core (citation contract, recycle, section-review) is solid. This builds on that foundation.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                          USER PROMPT                            │
│              "/data-analyze ..." / "/debug ..."                 │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                       INSRC AGENT LOOP                          │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Local LLM (orchestrator)                                 │  │
│  │  - intent classification                                  │  │
│  │  - template selection                                     │  │
│  │  - section-flow loop (TODO / sketch / cite)               │  │
│  │  - context assembly into structured spec                  │  │
│  │  - acceptance-criteria emission                           │  │
│  └───────────────────────────────┬───────────────────────────┘  │
│                                  │                              │
│                                  │  (calls SDLC skills,         │
│                                  │   queries graph + memory)    │
│                                  ▼                              │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Deterministic code (everything verifiable, no LLM)       │  │
│  │  - spec schema validation (sections, citations resolve)   │  │
│  │  - citation verifier (substring + count + structural-null)│  │
│  │  - state machine transitions in the planning loop         │  │
│  │  - acceptance-criteria machine-checks                     │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  Optional cloud LLM (single-shot cheap-judgment shim only)      │
│  - Invoked rarely when local + deterministic can't decide AND   │
│    the decision is too small to warrant a full external-agent   │
│    session. Typical: ~0-2 calls per handoff.                    │
└────────────────────────────┬────────────────────────────────────┘
                             │ spec.md + acceptance criteria
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                       HANDOFF GATEWAY                           │
│   - MCP transport         (Claude Code, MCP-native agents)      │
│   - HTTP/REST transport   (Codex, function-calling agents)      │
│   - CLI subprocess        (lowest common denominator)           │
│   - File drop             (zero-integration: spec.md to user)   │
└────────────────────────────┬────────────────────────────────────┘
                             │ spawns external agent w/ spec
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│              EXTERNAL CODING AGENT (Claude Code / Codex)        │
│  - reads pre-rendered spec (cited context insrc assembled)      │
│  - drills down via insrc tools when spec is incomplete:         │
│        entity.search, entity.summary, memory.recall,            │
│        artifact.get, repo.search-cross-repo, ...                │
│  - executes the actual work (Edit, Write, Bash)                 │
│  - returns structured deliverable (diff / files / report)       │
└────────────────────────────┬────────────────────────────────────┘
                             │ deliverable + agent trace
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                       INSRC AUDIT LOOP                          │
│  - parse deliverable against spec template                      │
│  - verify claims cite the context insrc provided                │
│  - cloud-tier review judgement on output quality                │
│  - accept | revise-edits | revise-major (recycle)               │
└─────────────────────────────────────────────────────────────────┘
```

**Key roles**:

- **insrc local LLM**: orchestrator. Cheap, runs on Ollama. Handles context assembly, template filling, intent classification.
- **insrc deterministic code**: everything verifiable — citation substring/count checks, spec schema validation, state-machine transitions, machine-checkable acceptance criteria. No LLM required.
- **External coding agent**: executor + substantial reasoner. Runs Claude Code / Codex / future. Edits files, runs commands, produces deliverables. THIS is where the bulk of "intelligence" lives — insrc deliberately doesn't try to compete here.
- **insrc cloud LLM (optional)**: single-shot judgment shim. Used only when local + deterministic can't answer AND the decision is too small to warrant a full external-agent session. Examples: a final accept/revise verdict on a deliverable, a "did this spec capture user intent?" sanity check. Skippable; the user can run insrc in fully-local + external-agent mode and lose almost nothing.
- **insrc daemon**: state. Owns LMDB graph + LanceDB vectors + spill files + session history. Exposes them as MCP tools.

---

## 3. Interface Contracts

Three transport layers, one underlying tool surface. The transport an agent uses is independent of the tool semantics.

### 3.1 MCP (Model Context Protocol) — Primary, stdio-first

Both Claude Code and Codex natively speak MCP. Stdio transport is the recommended path for both: it sidesteps the bearer-token machinery, the session-scoped credential gymnastics, and the localhost-binding requirements that HTTP needs.

- **Transport**: stdio (subprocess launched per session). HTTP+SSE supported as fallback (see §3.2).
- **Registration**:
  - Claude Code: `claude mcp add insrc /usr/local/bin/insrc-mcp-server` (writes to settings).
  - Codex: `codex mcp add insrc` or directly to `~/.codex/config.toml`:
    ```toml
    [mcp_servers.insrc]
    command = "/usr/local/bin/insrc-mcp-server"
    env_vars = ["INSRC_SESSION_TOKEN", "INSRC_DAEMON_SOCKET"]
    ```
- **Schema**: JSON Schema per tool, identical to insrc's internal skill schemas. Tool names use `insrc_*` snake-case (see §4).
- **Streaming**: progress events for long-running queries (transitive closures on deep graphs).
- **Auth**: implicit — runs at user level; the user trusts insrc the same way they trust their shell. Session-scoped capabilities (e.g. `artifact.get`, `spec.*`) carried via env var (`INSRC_SESSION_TOKEN`) the spawn injects into the MCP subprocess.

### 3.2 HTTP/REST Gateway — Fallback for restricted environments

For environments where stdio subprocess isn't viable: container sandboxes without subprocess privileges, web-based agents, custom function-calling agents that only consume REST endpoints. **Not** the primary path — most agents are fine with stdio.

- **Endpoints**: `POST /v1/tools/{tool}` with JSON body matching the same schema as the MCP tool.
- **Auth**: bearer token issued by insrc per session (rotated per handoff). Codex consumes via `bearer_token_env_var` configuration (env-var only — no per-invocation rotation, so token lifetime = process lifetime).
- **Discovery**: `GET /v1/tools` returns the full tool schema list (same JSON Schemas as MCP).
- **Streaming**: server-sent events for long queries.
- **Transport security**: localhost-only by default. Cross-machine access requires explicit config.

### 3.3 CLI Subprocess — Fallback

For agents that have no programmatic integration, or for ad-hoc human-driven workflows.

- **Command**: `insrc query --tool entity.search --args '{"query":"...","limit":5}'`
- **Output**: JSON to stdout matching the MCP tool's response shape.
- **Discovery**: `insrc query --list` returns the tool list.
- **Use case**: external agents can `Bash` the CLI when MCP/HTTP isn't available; humans can dry-run queries before scripting them.

### 3.4 File Drop — Zero Integration

For users who want to manually feed insrc's output to their preferred tool.

- insrc writes `~/.insrc/handoffs/{session-id}/spec.md` and prints the path.
- User pastes the path into their tool of choice or opens the file and works manually.
- No tool callbacks — insrc gets the deliverable when the user saves it to a known location.
- Useful for unsupported agents, evaluation/debug, and skeptical users who want to read what insrc decided before any external agent sees it.

---

## 4. Tool Surface

The tool surface is **deliberately small** (~12 tools across 4 families). Each tool is something the external agent cannot reach natively — semantic graph queries, cross-session memory, cross-repo awareness, or active spec context. Filesystem and lexical-grep tools that external agents have natively are explicitly excluded.

**Naming convention**: all tools are named `insrc_<family>_<verb>` in snake_case, no dots. Rationale:

- Codex exposes MCP tools **without** auto-namespacing (raw tool names enter the reasoning loop directly), so a leading `insrc_` prefix is required for disambiguation.
- Claude Code auto-prefixes MCP tools as `mcp__insrc__<tool>`; the `insrc_` in the inner name is harmless (Claude Code users see `mcp__insrc__insrc_entity_search`, slightly redundant but unambiguous).
- Snake-case (no dots) avoids JSON-pointer escaping issues some agents have with dotted tool names.

### 4.1 Knowledge Graph (`insrc_entity_*`)

| Tool | Purpose | Inputs | Output |
|---|---|---|---|
| `insrc_entity_search` | Semantic ANN search over entity embeddings (LanceDB) | `query: string`, `limit?: int`, `kind?: string`, `repo?: string` | `{ hits: [{ entityId, kind, name, path, distance, summary }] }` |
| `insrc_entity_summary` | Pre-extracted typed summary of an entity | `entityId: string` | `{ entity, fields, methods, parents, children, docstring }` |
| `insrc_entity_callers` | Direct callers of a function/method (LMDB graph) | `entityId: string`, `depth?: int` | `{ callers: [{ entityId, callSite }] }` |
| `insrc_entity_callees` | Direct callees | `entityId: string`, `depth?: int` | `{ callees: [{ entityId, callSite }] }` |
| `insrc_entity_closure` | Graph walk along typed edges | `entityId: string`, `edgeKind: string`, `maxDepth?: int` | `{ reachable: [entityId], depthByEntity: {} }` |
| `insrc_entity_unreachable` | Dead-code detection within a closure | `repoId: string`, `entryPoints: [entityId]` | `{ unreachable: [{ entityId, kind, path }] }` |

### 4.2 Session Memory + Artifacts (`insrc_artifact_*`, `insrc_memory_*`)

| Tool | Purpose | Inputs | Output |
|---|---|---|---|
| `insrc_artifact_get` | Read a cited summary + raw output of a prior skill call | `artifactId: string` | `{ id, skillId, summary, claims, rawPath, raw }` |
| `insrc_artifact_search` | ANN over artifact_vec scoped to a session | `query: string`, `sessionId?: string`, `limit?: int` | `{ hits: [{ artifactId, summary, distance }] }` |
| `insrc_memory_recall` | Semantic search over turn history (turn_vec) | `query: string`, `since?: timestamp`, `limit?: int` | `{ turns: [{ turnId, intent, response, distance }] }` |
| `insrc_memory_related_turns` | Find prior turns about the same subject (response_segment_vec) | `query: string`, `limit?: int` | `{ segments: [{ turnId, segment, distance }] }` |

### 4.3 Cross-Repo Dependency Closure (`insrc_repo_*`)

| Tool | Purpose | Inputs | Output |
|---|---|---|---|
| `insrc_repo_depends_on` | List repos in the active repo's dependency closure | `repoId: string` | `{ closure: [{ repoId, name, path, transitive: bool }] }` |
| `insrc_repo_search_cross_repo` | Search entities across the closure | `query: string`, `repoId: string`, `limit?: int` | `{ hits: [{ entityId, repoId, ... }] }` |

### 4.4 Active Spec Context (`insrc_spec_*`)

These tools are only meaningful during an active handoff — they let the external agent ask insrc about the spec it's executing.

| Tool | Purpose | Inputs | Output |
|---|---|---|---|
| `insrc_spec_acceptance_criteria` | Structured acceptance criteria for the active spec | `specId: string` | `{ criteria: [{ id, description, citedEvidence: [artifactId] }] }` |
| `insrc_spec_context` | Drill into a section of the spec by topic | `specId: string`, `topic: string` | `{ section, citedEvidence: [artifactId], pre-rendered: string }` |

**Schema versioning**: every tool name embeds an implicit version 1. Breaking changes ship as `insrc_entity_search_v2`, with v1 maintained until v2 has settled. Schemas registered with the MCP server / HTTP gateway carry an explicit `version` field.

---

## 5. Handoff Templates

The SDLC artifacts insrc produces are **versioned templates**. Each template defines:

- **Required sections** the external agent must produce.
- **Cited evidence slots** — placeholders insrc fills with artifact references before handoff.
- **Acceptance criteria format** — machine-readable criteria the audit loop verifies.

### 5.1 Initial template set (v1)

| Template | Use case | Owner stage |
|---|---|---|
| `SPEC.md` | Code change request — implement X, with cited evidence for what X needs to do | Implementation handoff |
| `DESIGN.md` | Architecture decision record — propose Y, with cited evidence for tradeoffs | Design review handoff |
| `DEBUG-SESSION.md` | Diagnosis record — reproduce, localize, hypothesise, test, conclude | Debug investigation |
| `REQUIREMENTS.md` | Requirements doc — what the system must do, with cited business / user evidence | Requirements gathering |
| `TEST-PLAN.md` | Test strategy — what to test, why, with cited risk evidence | Test planning |
| `REVIEW.md` | Review checklist — gates + findings, with cited compliance evidence | Code review / audit |
| `MIGRATION.md` | Migration plan — staged changes + rollback, with cited dependency evidence | Migration execution |
| `AUDIT.md` | Audit of existing artifact against ground truth | Quality assurance |

### 5.2 Template structure (concrete shape — applies to all)

```markdown
# {Title}

## Objective
{One paragraph from user intent + classifier output}

## Context (cited)
- [artifact-id-1]: {one-line summary insrc emitted}
- [artifact-id-2]: ...

## Body (template-specific sections)
{e.g. for DEBUG-SESSION: "Reproduce", "Localize", "Hypothesize", "Test", "Conclude"}
{e.g. for SPEC: "Files to change", "Behaviour change", "Test additions"}

## Acceptance Criteria (machine-readable, cited)
- [ ] criterion-1: {description}
       Cites: [artifact-id-1, artifact-id-3]
- [ ] criterion-2: ...

## Constraints
- Must not modify: {paths}
- Sandbox: {git-worktree-path or "in-place"}
- Time budget: {seconds}

## Tooling hints
- Use `insrc_entity_callers(X)` to confirm impact scope
- Use `insrc_memory_recall("prior work on Y")` if context is incomplete
```

Templates ship as TypeScript modules in the repo, versioned, with unit tests that pin the output structure. Adding a new template is a deliberate engineering act, not a runtime LLM decision.

---

## 6. End-to-End Workflow

The complete flow from user prompt to validated deliverable.

### 6.1 Phase 1 — Intent + Template Selection (insrc, fast)

1. User: high-level intent ("/debug the flaky test in foo.test.ts").
2. insrc: intent classifier picks intent family (e.g. `debug`).
3. insrc: template registry maps family → `DEBUG-SESSION.md` template.
4. insrc: fact-gap analysis — what's missing for the template (test history, recent changes, related entities)?

### 6.2 Phase 2 — Context Assembly (insrc, section-flow loop)

5. insrc: section-flow runs as today — TODO / sketch / decide-next-step / per-leaf summarize-step / closure markers.
6. Each leaf produces cited artifacts: log spans, entity summaries, call graphs, prior decisions from memory.
7. The local LLM at each leaf assembles narrow cited claims into `artifact_vec.summary`.
8. After enough TODOs close, insrc has accumulated the cited evidence the template needs.

### 6.3 Phase 3 — Spec Assembly + Acceptance Criteria (insrc local, fast)

9. Local LLM: read the template + accumulated artifacts + gap-facts → fill the template's sections.
10. Local LLM: emit acceptance criteria with embedded `[artifact-id]` references.
11. insrc deterministic: validate spec structure — sections present, criteria parseable, every cited `[artifact-id]` resolves to a real artifact, acceptance criteria contain at least one machine-verifiable item.
12. (Optional) cloud LLM cheap-judgment shim: "does the spec capture the user's intent?" — single call, single token-budget. Skippable; if disabled, structural validation alone gates the handoff and any semantic mismatch is caught by the audit phase post-handoff.

### 6.4 Phase 4 — Handoff (insrc → external agent)

**The external agent subprocess is spawned at this step, not pre-warmed at session start.** Per-handoff spawn is the only way Mode A pre-flight permission grants (§9), per-handoff worktree isolation (§7.3), and per-handoff MCP session tokens (§7.2) can all work — Claude Code's `--allowedTools` and Codex's `sandbox_mode` / `bearer_token_env_var` are set at spawn time and immutable afterward. Cold start cost is ~3-7s (agent + MCP server + worktree), negligible vs typical handoff duration (1-30+ min).

13. insrc: write spec to `~/.insrc/handoffs/{sessionId}/spec.md`. Create worktree at `~/.insrc/handoffs/{sessionId}/worktree/`.
14. insrc: prepare agent-specific config in the worktree:
    - Claude Code: write `.mcp.json` registering insrc-mcp-server (stdio), write `settings.json` registering insrc-permission-hook for PreToolUse.
    - Codex: write `.codex/config.toml` with `[mcp_servers.insrc]` block (stdio) + write `.codex/hooks.json` with PreToolUse + PermissionRequest hooks pointing at insrc-permission-hook.
15. insrc: set spawn-scoped env vars: `INSRC_SESSION_TOKEN`, `INSRC_DAEMON_SOCKET`, `INSRC_SPEC_ID`. These flow to both the MCP subprocess and the hook script.
16. insrc: spawn the external agent with the spec as the prompt + insrc-MCP + insrc-hooks enabled:
    - Claude Code: `claude --print --allowedTools "Read,Grep,Bash,Edit,Write" --disallowedTools "WebFetch,WebSearch" < spec.md`
    - Codex: `codex run --workdir <worktree> --sandbox-mode workspace-write --writable-roots <worktree> --approval-policy on-request < spec.md`
    - File-drop fallback: print the spec path to the user.

### 6.5 Phase 5 — External Agent Execution (external, autonomous)

17. External agent: reads the spec. Most context is pre-rendered.
18. External agent: when it needs more, calls insrc MCP tools (`insrc_entity_callers`, `insrc_memory_recall`, `insrc_artifact_get`).
19. External agent: any sensitive action (Bash command, Edit outside writable_roots, etc.) triggers a PreToolUse hook → insrc-permission-hook → daemon → IDE → user. See §8 for the gating modes.
20. External agent: executes its native loop — Edit, Write, Bash — to produce the deliverable.
21. External agent: writes the deliverable to a structured location (`spec-deliverable.md` plus diff/files).

### 6.6 Phase 6 — Audit + Decision (insrc, mostly deterministic)

22. insrc deterministic: parse deliverable against template (structure check + extract claims/citations).
23. insrc citation-verifier: every claim in the deliverable must cite an artifact insrc provided. New citations to files the external agent read directly are allowed if the agent emits them with file:line refs (which insrc verifies by reading those locations).
24. insrc deterministic: machine-checkable acceptance criteria (file exists, regex matches, command exits 0, test passes) evaluated.
25. (Optional) cloud LLM cheap-judgment shim: "do the LLM-judgment criteria (e.g. 'docstring matches actual behaviour') hold?" Single call. Skippable; if disabled, ALL acceptance criteria must be machine-verifiable to allow accept — soft criteria force a manual user-confirmation gate instead.
26. Decision:
    - **accept**: commit the work (or mark the handoff complete in the user's session).
    - **revise-edits**: re-handoff to the external agent with specific edit notes from the citation-verifier + machine-check results.
    - **revise-major**: re-run insrc's planning loop with updated state; emit a new spec.

**When cloud LLM judgment is genuinely needed**: only the "soft" semantic criteria that can't be reduced to a regex/test/file-check. Template authors are encouraged to keep soft criteria minimal — every soft criterion adds either an insrc cloud call or a user-confirmation gate.

---

## 7. State & Persistence Model

### 7.0 Persistent vs ephemeral

State is split deliberately between what survives across handoffs (owned by the daemon) and what's created per handoff (owned by the spawn):

| Persistent (daemon-owned, survives handoffs) | Ephemeral (handoff-scoped, torn down) |
|---|---|
| LMDB graph + LanceDB vectors + spill files | Claude Code / Codex subprocess |
| Session history, working memory, embeddings | insrc-mcp-server subprocess (auto-launched by agent via stdio) |
| Spec, deliverable, trace, audit records | `~/.insrc/handoffs/{sid}/worktree/` |
| Cited artifacts (artifact_vec rows) | Per-handoff session token (`INSRC_SESSION_TOKEN`) |
| MCP tool registry + skill catalog | hooks.json / `.codex/config.toml` written into worktree |
| IDE socket connection | PreToolUse hook script processes (fire per tool call, exit) |

The daemon is the long-lived process. External coding agents are short-lived children, created and reaped per handoff. The "always-on assistant" feel comes from the daemon's persistent state, accessed by ephemeral agents through MCP queries.

### 7.1 Spec lifecycle

Every spec is a first-class persisted artifact in insrc's session state.

```
sessions/{sessionId}/
  spec/
    {specId}.md                 # rendered spec markdown
    {specId}.meta.json          # template version, acceptance criteria, cited artifact ids
    {specId}.deliverable.md     # external agent's response
    {specId}.trace.jsonl        # external agent's reasoning trace (when captured)
    {specId}.audit.json         # citation-verifier results + cloud review verdict
```

Stored alongside `artifact_vec` rows so semantic search over prior specs is the same path as over prior turns.

### 7.2 Handoff session tokens

Each handoff issues a short-lived (TTL ~1 hour) token scoped to a single `sessionId`. The token is the only way the external agent can read session-scoped tools (`artifact.get`, `spec.context`). Global tools (`entity.search`) work without a token. This prevents cross-session contamination if a user runs multiple parallel handoffs.

### 7.3 Working tree isolation

For specs that result in file modifications (`SPEC.md`, `MIGRATION.md`), insrc creates a fresh git worktree:

```
~/.insrc/handoffs/{sessionId}/worktree/
```

The external agent is sandboxed there. The user's primary worktree is untouched until the audit phase accepts the deliverable and merges/copies the changes back.

This protects the user from a bad spec / bad execution and gives insrc the ability to throw the whole thing away on revise-major without polluting the user's repo.

### 7.4 Tracing

Every handoff emits a structured trace:

```json
{
  "handoff_id": "...",
  "session_id": "...",
  "spec_id": "...",
  "external_agent": {"name": "claude-code", "version": "..."},
  "started_at": "...",
  "duration_ms": ...,
  "tool_calls": [{"tool": "entity.search", "args": {}, "result_summary": "..."}],
  "deliverable_path": "...",
  "audit_verdict": "accept",
  "tokens": {"insrc_local": 0, "insrc_cloud": 0, "external": 0}
}
```

Stored in the session for debugging, cost analysis, and downstream review.

---

## 8. Security & Sandboxing

### 8.1 Tool authorization

- Read-only tools (`entity.*`, `memory.*`, `artifact.*`) are always available.
- Tools that read session-scoped artifacts (`spec.*`, `artifact.get` on session artifacts) require a session token.
- No tool in the surface allows writes — insrc's data is read-only to the external agent. All writes happen through insrc's own daemon paths, after audit acceptance.

### 8.2 External agent permission scope

When insrc spawns the external agent, it explicitly restricts what tools the agent can use:

- Claude Code: `--allowedTools "Read,Grep,Bash,Edit,Write"` and `--disallowedTools "WebFetch,WebSearch"` (no internet from inside the sandbox by default).
- Codex: equivalent flags.
- The agent runs inside the session-scoped worktree with no permissions outside it.

### 8.3 User confirmation gates

Specs marked `risk: high` (production paths, infra changes, destructive ops) trigger an explicit user confirmation before insrc spawns the external agent. See §9 for the full three-mode gating model (pre-flight, in-flight via hooks, audit-time).

### 8.4 MCP/HTTP transport security

- MCP runs over stdio — process-local, no network exposure.
- HTTP gateway binds to `localhost:PORT` only by default. Bearer-token auth on every request. Token rotated per handoff. Logs every tool call with the calling agent's identity.

---

## 9. Permission Gating & In-flight Approval

Specs are sandboxed to the worktree (§7.3), but sandboxes alone don't capture the difference between "agent edits a source file" (routine) and "agent runs `git push` or `rm -rf` or modifies migration scripts" (needs explicit human approval). Three gating modes, layered.

### 9.1 Mode A — Pre-flight gating (spec-level approval)

insrc emits permission grants in the spec during assembly (deterministic rules + LLM tags):

```yaml
risk: high
sandbox: ~/.insrc/handoffs/{sid}/worktree/
permissions:
  allow:
    - tool: Edit       paths: ["src/**", "test/**"]
    - tool: Bash       commands: ["npm test", "git diff", "git status"]
  prompt:
    - tool: Bash       commands: ["git push", "rm -rf", "npm publish"]
    - tool: Edit       paths: ["**/migrations/**", "infra/**"]
  deny:
    - tool: WebFetch
    - tool: Bash       commands: ["sudo", "/etc/**"]
```

- `allow`: auto-granted at spawn.
- `prompt`: triggers Mode B mid-flight ask.
- `deny`: hard-blocked.

For `risk: high` specs the whole permissions block is shown to the user in an IDE modal BEFORE spawn. User accepts → spawn proceeds. User edits → revise spec. User rejects → cancel handoff.

Maps directly to:
- Claude Code: `--allowedTools` (auto-grants) + `--disallowedTools` (denies); `prompt` entries hand off to Mode B hooks.
- Codex: `sandbox_mode = "workspace-write"` + `writable_roots` (auto-grants); `approval_policy = "on-request"` triggers Mode B for `prompt` entries; `--full-auto` honored if user explicitly accepts at the modal.

### 9.2 Mode B — In-flight gating (mid-execution approval)

Both Claude Code and Codex support **PreToolUse hooks** that intercept tool calls before execution and can approve, deny, or modify them. The hook protocol is structurally identical across agents:

```
External agent: about to run `git push origin main`
      ↓
PreToolUse hook fires with tool_name + tool_input JSON on stdin
      ↓
Hook script (insrc-permission-hook) calls daemon over Unix socket:
   insrc_gate_request_permission({
     tool: "Bash", args: "git push origin main",
     spec_id: <id>, justification: "publishing the fix to main"
   })
      ↓
Daemon checks spec's permission policy → matches `prompt` rule
      ↓
Daemon emits IDE event → user sees modal:
   "Allow `git push origin main`? Reason: ..."  [Allow] [Deny] [Allow this session]
      ↓
Daemon returns verdict to hook
      ↓
Hook returns JSON:  {"continue": true}  or  {"continue": false, "stopReason": "..."}
      ↓
External agent proceeds OR fails the tool call (and continues or escalates)
```

Per-agent configuration:

- **Claude Code**: hook registered in the project's `settings.json` under `hooks.PreToolUse`. Hook script path + matcher per tool family.
- **Codex**: hook registered in `~/.codex/hooks.json` or `[hooks]` table in `config.toml`. Codex's hook system has an explicit `PermissionRequest` event in addition to `PreToolUse` — insrc uses both. Hook composition rule: "any deny wins; any allow proceeds; otherwise default approval flow." Codex requires explicit "hook trust review" before execution; insrc's hook script ships signed.

The **same** `insrc-permission-hook` script binary works for both agents — only the config file location differs. The hook is shipped as part of insrc's install and registered per-agent during initial setup (`insrc setup claude-code` / `insrc setup codex`).

Hook return semantics map cleanly across agents:

| Verdict | Claude Code hook output | Codex hook output |
|---|---|---|
| Allow | `{"continue": true}` | `{"continue": true}` or `{"hookSpecificOutput": {"permissionDecision": "allow"}}` |
| Deny | `{"continue": false, "stopReason": "..."}` or exit code 2 + stderr | Same |
| Modify input | `{"hookSpecificOutput": {"updatedInput": {...}}}` | Same |

### 9.3 Mode C — Audit-time gating (sandbox commit approval)

The strongest gate: nothing the agent did touches the real tree until the user accepts the diff.

- Agent works in `~/.insrc/handoffs/{sid}/worktree/`.
- All Edits / Writes / commits happen in the worktree.
- When the agent finishes, insrc audit phase runs (citation verifier + machine-check criteria).
- If audit passes: show the user a structured diff between worktree and main, ask "apply this?"
- User can accept all, accept selectively (hunk-by-hunk), or reject.
- Selective acceptance re-handoff: insrc tells the agent which hunks were rejected and why; agent revises.

This is the **default** safety net — even with Modes A+B in place, no agent output reaches the real tree without final review.

### 9.4 Recommended layering by spec risk tag

```
risk: low      →  Mode C only (sandbox + final diff review)
risk: medium   →  Mode A pre-flight + Mode C audit
risk: high     →  Mode A pre-flight + Mode B in-flight + Mode C audit
                  (the user gets THREE opportunities to stop the train)
```

Spec authoring: the local LLM emits a draft `risk:` tag during spec assembly, but deterministic rules **ratchet up only**. E.g. any `Edit` path containing `infra/`, `migrations/`, `prod/` forces `risk: high` regardless of what the LLM said. LLMs can never lower risk below what rules require. Rule table lives in template metadata and is unit-tested.

### 9.5 IDE UX concerns

- **Timeout default**: long-running handoffs may catch the user away. Modal default-denies after a configurable timeout (default 60s). Agent treats the deny as a tool-call failure and proceeds with whatever recovery it has.
- **"Allow always" trap**: clicking "Allow always" out of fatigue defeats Modes A+B. The IDE makes "Allow always" meaningfully harder than "Allow once" — e.g. requires typing a confirmation phrase, sudo-style.
- **Permission session scope**: "Allow this session" persists for the duration of the current spec only; not across spec revisions or different handoffs. Promotion to "Allow this user-session" requires a separate, more deliberate confirmation step.

### 9.6 Implementation impact

- insrc ships ONE `insrc-permission-hook` script (small binary or wrapper) that works for both agents. Per-agent config files just point at it.
- The daemon's `gate.request-permission` IPC + IDE-modal pipeline is shared infrastructure — already partly built for existing `permissionMode` in `Session`.
- Spec generation gets a new step: emit the `permissions:` block from template rules + deterministic risk classifier.
- Templates declare risk defaults and rule overrides; e.g. `DEBUG-SESSION.md` defaults to `risk: low`, `MIGRATION.md` to `risk: high`.

---

## 10. VS Code Extension Integration

insrc primarily ships as a VS Code extension. The extension is a thin UI layer; the daemon owns orchestration, MCP, subprocesses, and state.

### 10.1 Process topology

```
VS Code extension (UI layer)
   ↕  IPC over ~/.insrc/daemon.sock
insrc daemon (orchestration + state + MCP server registry)
   │
   └── spawns per handoff:
       ├── Claude Code / Codex subprocess
       └── insrc-mcp-server subprocess (auto-launched by agent via stdio)
           ↓ on PreToolUse / PermissionRequest:
           └── insrc-permission-hook → daemon → IPC → extension modal
```

The external coding agent runs as a child of the **daemon**, not of the VS Code extension. If VS Code crashes mid-handoff, the daemon and its agent subprocess survive; the user can re-attach when VS Code restarts and either accept the in-flight handoff or kill it. This split also means the daemon can be driven from the CLI (`insrc ...`) with the same handoff machinery — VS Code is one frontend, not the only one.

### 10.2 UX modes

Two modes ship in v1; the third is a deferred enhancement.

#### Default — Quiet headless

- Status-bar entry: `insrc → claude-code (running, 0:42)`.
- Progress notification via `vscode.window.withProgress({ location: ProgressLocation.Notification })`.
- Mode B gating: `vscode.window.showWarningMessage` with action buttons. Modal flag derives from spec risk tag (high → modal; medium/low → non-modal notification).
- Completion: opens the final diff via `vscode.commands.executeCommand('vscode.diff', mainUri, worktreeUri, '<spec-title> review')`.
- User accepts/rejects from the diff view's action buttons.

Most users — two clicks per handoff (approve gates + accept final diff).

#### Opt-in — Watched terminal

User-configurable: `insrc.handoff.uxMode = "terminal"` (default `"headless"`).

- Extension creates `vscode.window.createTerminal({ name: 'insrc: <spec-title>' })`.
- The terminal is the display channel for the agent's streaming output. Daemon still owns the actual subprocess; the terminal is a `vscode.Pseudoterminal` reading from the daemon's IPC event stream.
- User can scroll, copy, ctrl-c, etc. Transparency mode for advanced users.
- Mode B gating modals still appear normally — terminal-mode doesn't replace the approval UX, it adds visibility.
- Final diff review uses the same `vscode.diff` path as headless.

This is the developer escape hatch and the natural debugging mode for insrc itself.

#### Deferred — Webview review

For `DEBUG-SESSION`, `MIGRATION`, `AUDIT` templates where review needs rich structure: tabs for "Spec", "Agent Trace", "Files Changed", "Audit Results", "Citations". Each citation clickable to source via `vscode.workspace.openTextDocument`. Built later when those templates demand it.

### 10.3 Mode B gating UI

Standard non-modal (medium-risk specs):
```ts
vscode.window.showWarningMessage(
   'Claude Code wants to run: `git push origin main`',
   { modal: false, detail: 'Reason: publishing the fix' },
   'Allow', 'Deny', 'Allow this session'
)
```

Modal (high-risk specs):
```ts
vscode.window.showWarningMessage(
   'Claude Code wants to run: `rm -rf node_modules`',
   { modal: true, detail: 'Reason: ...' },
   'Allow', 'Deny'
)
```

For Edit operations, the modal includes a preview diff before approval.

**Timeout coordination**: a tool call has a configured timeout (Codex default 60s, Claude Code typically longer). If the user is away, the modal needs to auto-dismiss with "Deny" BEFORE the agent's tool-call timeout fires, so the agent gets a clean rejection and can recover instead of timing out into an undefined state. Extension reads the agent's timeout (or assumes 60s) and sets modal auto-dismiss to ~80% of that.

### 10.4 Worktree handling

Default — sandbox is hidden working area. User only sees the diff at audit time, presented as "changes to merge back into your main worktree".

Escape valve — `risk: high` specs surface an "Inspect worktree" button on the diff review notification. Click → `vscode.commands.executeCommand('vscode.openFolder', worktreeUri, true)` opens a new VS Code window at the worktree path. User can poke around file-by-file before approving the merge-back.

### 10.5 VS Code API surface

| Need | API |
|---|---|
| Long-running progress | `vscode.window.withProgress({ location: ProgressLocation.Notification })` |
| Compact status entry | `vscode.window.createStatusBarItem` |
| Permission modal | `vscode.window.showWarningMessage(msg, { modal: true, detail }, ...actions)` |
| Hunk-level review | `vscode.window.showQuickPick` with `canPickMany: true` |
| Diff view | `vscode.commands.executeCommand('vscode.diff', uri1, uri2, title)` |
| Source navigation from citations | `vscode.workspace.openTextDocument` + `vscode.window.showTextDocument` with `selection: Range` |
| Open worktree in new window | `vscode.commands.executeCommand('vscode.openFolder', uri, /* forceNewWindow */ true)` |
| Output channel for agent trace (headless mode) | `vscode.window.createOutputChannel('insrc → claude-code')` |
| Terminal mode | `vscode.window.createTerminal({ name, pty: <Pseudoterminal> })` |
| Completion notification | `vscode.window.showInformationMessage('Handoff complete', 'Review diff', 'Dismiss')` |

### 10.6 Settings surface

Kept deliberately small:

```jsonc
{
  "insrc.handoff.uxMode": "headless" | "terminal",   // default "headless"
  "insrc.handoff.defaultDenyTimeoutMs": 60000,       // gating modal auto-dismiss
  "insrc.handoff.maxConcurrent": 1,                  // parallel handoffs cap
  "insrc.handoff.preferredAgent": "claude-code" | "codex" | "auto",
  "insrc.gating.modalRiskThreshold": "high" | "medium" | "low",
  "insrc.spec.alwaysShowBeforeHandoff": false        // skip auto-accept; force preview
}
```

### 10.7 Workspace trust + multi-workspace

- **Trust**: VS Code's workspace trust mechanism gates extensions in untrusted folders. insrc daemon spawning external agents requires trusted workspace. Untrusted folders disable handoffs (or fall back to file-drop mode where insrc writes spec.md and prints the path, no spawn).
- **Multi-workspace**: a VS Code window can have multiple workspace folders. The active editor's folder is the default target; for ambiguous cases (no active editor, multi-root with no preferred folder), extension uses a quick-pick: "Which workspace folder is this handoff for?"

### 10.8 Claude Code VS Code extension coexistence

Claude Code has its own VS Code extension. If both insrc and Claude Code's extension are installed, insrc spawning `claude` CLI must not conflict with the extension's own session state. Mitigations:

- insrc spawns with explicit `--no-resume` (or equivalent) to ensure a fresh session.
- insrc's subprocess uses a separate working directory (the handoff worktree), not the user's primary workspace.
- Document the coexistence pattern and test it as part of release validation.

### 10.9 Open VS Code-specific questions

1. **Telemetry / privacy**: spec content shipped to OpenAI's Codex servers vs Anthropic's Claude Code — different ToS. Setting toggle for "anonymise spec content" (best-effort) and default-on for hosted models, default-off for local-only paths.
2. **VS Code remote (SSH / WSL / dev containers)**: where does the daemon run — host or remote? Sockets behave differently across the remote boundary. Initial answer: daemon on the same side as the workspace; extension proxies UI events.
3. **Notebook contexts (.ipynb)**: handoff to a coding agent inside a notebook is a different shape (cell-by-cell, kernel context). Defer to post-v1.

---

## 11. Chat Session Integration

The handoff framework sits inside the existing chat session — it doesn't replace it, it becomes one of the things a chat turn can produce. The user's view stays the same: type a prompt, get a result. What changes is what "get a result" can mean — for coding intents, "result" includes a spec, an external-agent execution, and an audited deliverable, all surfaced as one coherent turn outcome.

### 11.1 Intent routing: report vs handoff vs pivot

Existing intents (per `CLAUDE.md`) split into three categories under the new framework:

| Category | Intents | Output | Handoff? |
|---|---|---|---|
| **Direct-report** | `review`, `document`, `research`, `code-analysis`, `data-analyze` | Markdown report in the chat | No — insrc produces the answer directly |
| **Handoff** | `implement`, `refactor`, `debug`, `test` | Code change / fix / test addition | Yes — spec → external agent → audit → diff |
| **Pivot** | `plan`, `requirements`, `design`, `brainstorm`, `deploy`, `release`, `infra`, `migration` | Spec-shaped document. Becomes a handoff trigger if the user says "make it so" or equivalent. | Optional, user-initiated follow-up |

Concretely: `/debug ...` always tries to land at a handoff. `/design ...` produces a DESIGN.md the user reviews; the next turn can be `/implement using the design above` which initiates a handoff.

Intent metadata gains a new field:
```ts
interface IntentMetadata {
  // existing
  intent: Intent;
  // new
  outputType: 'report' | 'spec-then-handoff' | 'spec-only';
  defaultTemplate?: TemplateId;
  defaultRisk?: 'low' | 'medium' | 'high';
}
```

The intent classifier picks `outputType` based on (a) intent family defaults, (b) presence/absence of follow-up trigger phrases ("make it so", "implement this", "apply"), (c) user setting `insrc.handoff.autoTriggerFromPivot: bool`.

### 11.2 One turn, one handoff (default)

A handoff is **one chat turn**, not a new conversation thread. From the user's perspective:

```
User: /debug the flaky test in foo.test.ts

[insrc daemon runs section-flow: TODO + sketch + cited evidence]
[Spec assembled: DEBUG-SESSION.md with risk: medium]
[Mode A modal: Allow these permissions for Claude Code? (Allow / Edit / Cancel)]
[User: Allow]
[Status bar: "insrc → claude-code (running, 1:23)"]
[Mid-flight Mode B modal: "Allow `npm test -- --grep flaky`? (Allow / Deny)"]
[User: Allow]
[Status bar continues until completion]
[Diff view opens: "DEBUG-SESSION review (2 files changed, 14 lines)"]
[User: Accept]

insrc: Debug session completed. Identified the race condition in
       beforeEach(); applied fix; test now passes 100/100 runs.
       [✓ Spec][✓ Deliverable][✓ Audit][Diff]
```

The entire sequence is one row in `turn_vec`. The spec, deliverable, trace, audit, and final diff are sub-artifacts attached to the turn via `artifact_vec` (with the existing cited-summary path), discoverable later by `insrc_memory_recall` / `insrc_artifact_search`.

This matters because future turns can leverage prior handoffs naturally:

```
[Two weeks later]
User: did we ever fix the flaky test in foo.test.ts?
   → insrc local LLM calls insrc_memory_recall("flaky test foo.test.ts")
   → hits the prior turn's spec + deliverable
   → answers: "Yes, on 2026-05-29. Fix was in beforeEach(); race condition
              between setUp and database mock. Citation: [spec-id], [diff-hash]."
```

### 11.3 Pair / Delegate coding agents: migration path

Existing coding agents (Pair for single-shot, Delegate for batch) currently handle `implement` / `refactor` / `debug` intents internally — they edit files, run tests, etc., inside insrc's process tree.

Under the new framework, **the execution moves out** to the external coding agent. But Pair's step-based state machine (`agent/framework/`) is still useful for the **spec assembly phase** — turning a vague "fix the bug" into a structured spec with cited evidence and acceptance criteria.

Migration plan:

| Phase | Pair / Delegate behaviour |
|---|---|
| Pre-handoff | Today's behaviour — Pair edits files directly, runs validation, applies/rejects via review-gate. |
| Transitional | Pair's step machine produces a `SPEC.md` instead of edits; routes to handoff for execution. User setting `insrc.handoff.useExternalAgent: bool` lets users opt out and keep today's behaviour during the transition. |
| Steady state | Pair / Delegate code paths exist only as the spec-assembly half. The `propose → review-gate → apply → validate` loop becomes `assemble-spec → user-approves-permissions → handoff → audit`. |
| Optional cleanup | Once handoff is the only execution path, the Pair `apply` step + retry-on-validation-failure loop is dead code. Retire it. |

In short: Pair / Delegate **become** the spec-assembly layer for handoff. The framework stays; the in-process execution doesn't.

The Designer agent (`design`), Planner agent (`plan`), Brainstorm agent — all already produce reports / specs without executing. These migrate to the new template-based spec output but otherwise stay structurally the same.

### 11.4 Permission mode floor + risk ratchet

`Session.permissionMode` (existing: `read-only` / `ask-before` / `full-auto`) sets a floor that the spec's `risk:` tag can only ratchet up, never down.

| Session mode | risk:low | risk:medium | risk:high |
|---|---|---|---|
| read-only | **handoff disabled** (only reports allowed) | disabled | disabled |
| ask-before | forced to risk:medium (Mode A + Mode C) | risk:medium honored | risk:high (Mode A + B + C) |
| full-auto | Mode C only (sandbox + final diff) | Mode A + C | risk:high (Mode A + B + C) |

This gives sane defaults: a user in `read-only` mode can never accidentally trigger an agent execution. A user in `ask-before` always sees at least the final diff review. `full-auto` users can let low-risk specs flow through with minimal interruption but never lose the audit step.

The local LLM emits a draft risk tag; deterministic rules then ratchet it up if any rule matches (e.g. `Edit` paths under `infra/`, `migrations/`, `prod/` force `risk:high` regardless). The LLM cannot lower risk below what rules require.

### 11.5 Multi-handoff conversations

A complex user goal often decomposes into several handoffs:

```
User: I want to add OAuth login to the dashboard.

Turn 1 (intent=design → spec-only):
   insrc emits DESIGN.md with acceptance criteria for the feature.
   User reviews and replies "looks good, let's build it".

Turn 2 (intent=implement → handoff):
   Spec: SPEC.md derived from Turn 1's design.
   Handoff to Claude Code, audit, diff accepted.

Turn 3 (intent=test → handoff):
   Spec: TEST-PLAN.md derived from Turn 2's deliverable.
   Handoff to Claude Code, audit, diff accepted.
```

Each handoff is its own turn. Cross-turn references via `artifact_vec` — Turn 2's spec cites Turn 1's design; Turn 3's spec cites Turn 2's deliverable. The chat UI shows the chain naturally; the user can scroll back and see each piece.

Sub-handoffs WITHIN a single turn (e.g. "implement and then test in one shot") are deferred to post-MVP. Most users prefer to review-then-proceed at each step anyway.

### 11.6 TodoList workbench surfacing

The TodoList workbench (Q8 / P6 of the section-flow plan) shows TODOs the user can act on. Handoff state slots in naturally as a TODO status:

| TODO status | Meaning |
|---|---|
| `Planning` | section-flow assembling the spec |
| `Awaiting permission` | Mode A modal showing |
| `Running` | External agent executing |
| `Awaiting approval` | Mode B modal showing (mid-flight) |
| `Auditing` | Citation verifier + machine-checks running |
| `Awaiting review` | Diff view open, user reviewing |
| `Completed` | Accepted; changes applied |
| `Rejected` | User declined the diff |
| `Failed` | Audit failed or agent crashed |

The user sees a single coherent surface for in-flight and completed handoffs across the session.

### 11.7 Session restore semantics

Existing chat session restore reloads conversation turns from the DB. With handoffs:

| State at restore time | Behaviour |
|---|---|
| All handoffs completed before crash | Restored normally; turns surface as completed. |
| Handoff in-flight, daemon still running (VS Code crashed) | Extension reconnects to daemon, picks up the handoff state, resumes UI. User sees "Resumed: Claude Code still running" status. |
| Handoff in-flight, daemon also gone (full reboot) | Daemon detects orphaned worktree on next start. Surfaces as `Failed: session interrupted` with "Retry" or "Discard worktree" actions. The spec is preserved; the user can re-run. |
| Mid-flight Mode B gating modal pending | If the daemon survived: re-display the modal. If not: count as a denied tool call; daemon decides whether to retry the handoff (with a fresh agent process) or surface as failed. |

The daemon's persistent state guarantees no work is silently lost.

### 11.8 Provider routing inheritance

Existing `agent/router.ts` selects the LLM provider for each turn based on intent + active provider config + `@mention` overrides. For handoff turns:

- **insrc local LLM** (orchestration, spec assembly): inherits the session's local provider (Ollama). Unchanged.
- **insrc optional cloud LLM** (cheap-judgment shim, §6.6 step 25): inherits the session's active cloud provider (Anthropic / OpenAI / etc.). Unchanged.
- **External coding agent** (the executor): chosen by `insrc.handoff.preferredAgent` setting (`claude-code` / `codex` / `auto`). `auto` picks based on session's active cloud provider (Anthropic active → Claude Code; OpenAI active → Codex) so the user's existing API key authorises the execution.

This keeps the cost story honest: the external agent bills against the user's existing coding-agent subscription, not a separate insrc account.

### 11.9 Conversation compaction with handoffs

Existing compaction (`db/compaction.ts`) trims old conversation state to fit memory budgets. Handoff artifacts add bulk that needs a strategy:

- Spec markdown: small, keep in full per turn.
- Deliverable markdown: small, keep in full.
- Trace (agent's reasoning stream, sometimes 100KB+): truncate after N days to the first/last few KB + a summary. Full trace stays on disk (spill); summary stays in `artifact_vec`.
- Mode B gating decisions: append-only log, never compacted (audit trail).

Implementation: compaction gains a `kind: 'spec' | 'deliverable' | 'trace' | 'gating-log'` discriminator that selects the right reduction rule.

### 11.10 Open chat-integration questions

1. **Streaming partial results to chat**: should the chat UI surface intermediate state (spec preview before approval, agent reasoning as it streams in terminal mode) or only final outcomes? Different user types want different things. Setting-driven.
2. **Cross-turn handoff chaining**: should Turn 2 automatically reference Turn 1's deliverable when both target the same feature? Probably yes, via existing memory recall; needs an explicit "chain" link in `turn_vec` metadata to make it discoverable.
3. **Conversation handoff handover**: if the user switches active provider mid-conversation, what happens to in-flight handoffs? Probably finish them on the original provider; new turns route to the new provider.

---

## 12. Cost, Observability, Token Accounting

Every handoff publishes a structured cost record:

```json
{
  "handoff_id": "...",
  "insrc_local_tokens":  0,
  "insrc_cloud_tokens":  0,
  "external_agent_tokens": {
    "input": 0,
    "output": 0,
    "tool_calls": 0
  },
  "wall_time_ms": 0
}
```

Aggregated per session and per template family so the user can see "DEBUG-SESSION runs cost ~$X on average" and reason about which templates to invoke.

Tools called via MCP / HTTP are counted per-call, so we can see if an external agent burns ~50 drill-down queries on a single spec (indicating insrc's pre-rendered context was insufficient) vs ~3 queries (good spec quality).

---

## 13. Schema Versioning & Evolution

Three places versioned:

1. **Tool schemas** — `insrc.entity.search` is v1. Breaking changes ship as `insrc.entity.search.v2`. Both can be exposed during a deprecation window. Schemas served via MCP `tools/list` include explicit `version` field.

2. **Templates** — `SPEC.md.v1` is its own module. Adding/removing required sections is a breaking change; bump to `SPEC.md.v2`. The template registry maintains the version map. Specs persist with their `templateVersion` so the audit pass uses the right validator.

3. **MCP / HTTP protocol layer** — version of insrc's overall API surface (`v1` namespace prefix on HTTP paths, server capability flags on MCP handshake).

Backward compatibility commitment: support N-1 of every schema version for at least 90 days after N+1 ships. Deprecation warnings logged on use.

---

## 14. Phased Implementation

| Phase | Scope | Effort | Dependency |
|---|---|---|---|
| 0 | Strengthen current SDLC core: revert force-cloud, retest with local + nesting, ship method-local-var rule. Deferred: swap cloud default model (no longer strategic if cloud is rarely invoked from insrc itself). | 2-3 days | — |
| 1 | MCP server (stdio) over existing daemon. Expose initial 12 tools with `insrc_*` snake-case naming. CLI subprocess mode (`insrc query`). `insrc setup claude-code` / `insrc setup codex` registration commands. | 4-6 days | Phase 0 |
| 2a | Daemon side: spec assembly + handoff via `claude --print` with stdio MCP. Watch worktree for changes. CLI-callable from outside VS Code for testing. First template (`DEBUG-SESSION.md`) end-to-end. Mode C audit on deliverable. | 4-5 days | Phase 1 |
| 2b | VS Code extension: headless UX (status bar + progress + diff view). Mode B modal pipeline. Workspace trust handling. | 3-4 days | Phase 2a |
| 2c | Extension settings + terminal UX (opt-in `insrc.handoff.uxMode = "terminal"`). | 2 days | Phase 2b |
| 3 | Permission gating Modes A + B. Spec-level permission blocks emitted by template rules. `insrc-permission-hook` script (single binary, works for both agents). PreToolUse hooks registered for both Claude Code and Codex. IDE modal pipeline for in-flight approvals. | 1 week | Phase 2 |
| 4 | Codex agent integration. Same templates, separate spawn path + config writer. Validate both agents pass the same template contract tests. | 4-5 days | Phase 3 |
| 5 | Worktree sandboxing hardening + risk classifier ratchet rules. Cross-handoff token isolation. Failure-mode hardening (subprocess crashes, network drops, hook timeouts). | 3-5 days | Phase 4 |
| 6 | HTTP gateway (for restricted environments only). Same tool surface, different transport. | 3 days | Phase 5 |
| 7 | Remaining templates (`DESIGN`, `REQUIREMENTS`, `TEST-PLAN`, `REVIEW`, `MIGRATION`, `AUDIT`). One per week as workflows demand them. | rolling | Phase 5 |
| 8 | Multi-handoff orchestration (chained specs, spec dependencies, large-feature pipelines). | TBD | post-MVP |

End-to-end CLI integration with one template + one agent at Phase 2a (~1 week). VS Code-integrated working experience at Phase 2c (~2 weeks). Both agents + gating modes A+B+C at Phase 4 (~1 month).

---

## 15. Open Questions

1. **Spec format**: markdown is human-readable but lossy. Should we ship a JSON variant of the spec alongside the markdown for machine consumption? Decision needed before Phase 2.

2. **Streaming output from external agents**: Claude Code streams reasoning by default. Should insrc capture and re-render that stream to the user during a handoff, or surface only the final deliverable? Affects UX significantly.

3. **Acceptance criteria evaluation**: some criteria are clearly machine-verifiable (file exists, test passes, regex matches). Others need LLM judgment ("the docstring matches the actual behaviour"). How do we split the criteria into "machine-verify" vs "LLM-verify" buckets so audit is cheap when possible?

4. **Multi-step handoffs**: a complex feature might decompose into spec-A (designs the API) → spec-B (implements the API) → spec-C (writes tests). Does insrc chain these automatically as a meta-orchestration layer above section-flow, or stay flat for now?

5. **Failure escalation**: when an external agent produces a deliverable that fails citation verification, do we recycle (re-prompt the agent) or escalate (return to insrc planning to revise the spec)? Both are correct in different scenarios. Need a heuristic.

6. **MCP schema discovery + agent capability**: Claude Code introspects MCP tool schemas at session start. Codex's discovery story is less mature. How do we test that the agent actually called the tools we expected, and detect when an agent silently ignored an available tool we needed it to use?

7. **Cross-agent compatibility tests**: every template + agent pair is a separate integration. Do we maintain a per-pair test matrix, or define a contract test all agents must pass? The contract approach scales better but requires upfront definition.

---

## Summary

This design positions insrc as the **higher-level SDLC orchestrator + context engine** for external coding agents. Three transport layers (MCP, HTTP, CLI) cover Claude Code, Codex, and future agents with the same backend. The tool surface is deliberately small (~12 tools) and additive — semantic graph, cross-session memory, cross-repo awareness, active spec context — explicitly excluding capabilities the external agent already has. Templates are versioned first-class artifacts; specs are persisted; audit at the planning and execution boundaries catches hallucination through deterministic citation verification plus machine-checkable acceptance criteria.

The pivot is real: insrc stops trying to do the agent's job and instead does what only it can — assemble structured, cited context and validate that the agent's output stays grounded in it. Almost all reasoning happens in the external agent; insrc's own LLM use is local-tier orchestration plus optional single-shot cloud judgment shims. The pieces from the citation contract, recycle loop, and section-review pattern carry forward — they were always for this kind of work, just initially aimed at data-analyzer instead of coding-agent handoff.

**Auth surface implication**: with insrc cloud LLM reduced to an optional shim, the user can plausibly run insrc with NO cloud-provider API key of its own — local Ollama for orchestration, deterministic code for verification, the external agent uses the user's existing Claude Code / Codex credentials. This sharpens insrc's value proposition: insrc adds the context engine + audit loop on top of a cloud-coding-agent subscription the user already has, without doubling their LLM bill.

Phased to deliver a working wedge in two weeks, production-quality multi-agent support in a month. Open questions are real but none block Phase 1.

---

**Next step**: review this for direction (not detail). Confirm the agent-agnostic transport mix, the template starter set, and the phased sequencing. Then Phase 0 (revert force-cloud, retest, ship method-local-var rule) is the prerequisite to Phase 1.
