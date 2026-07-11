# AGENTS.md — insrc

## Project principles

These are project-wide governance principles that apply to every design and implementation decision. When in doubt, defer to these.

- **Accuracy is primary; cost is the least priority.** When choosing between an accurate-but-expensive path (more LLM calls, bigger context, slower pipeline) and a cheap-but-lossy one, choose accuracy. The system's value is correctness, not throughput. Cost optimizations are valid only when they preserve accuracy; otherwise the cheap path is the wrong path. This includes both compute cost and user-attention cost — neither outranks accuracy.

## Project overview

**insrc** is a local-first hybrid coding agent that builds a live Code Knowledge Graph from source code. It runs a background daemon that parses repos via tree-sitter, stores structural relationships in a custom LMDB-backed graph layer and entity embeddings in LanceDB, then exposes an interactive agent REPL that routes tasks between a local LLM (Ollama) and a user-selected cloud provider (OpenAI, Anthropic, Gemini, or Mistral).

Repository: `github.com/insors-ai/insrc`

## Tech stack

- **Language**: TypeScript (strict mode, ESM-only via `"type": "module"`)
- **Runtime**: Node.js 20+, executed with `tsx` during development
- **Module system**: NodeNext (`"module": "nodenext"` in tsconfig)
- **Databases**: LMDB via `lmdb-js` (embedded KV store; substrate for the custom graph layer in `db/graph/`), LanceDB (embedded vector DB; entity embeddings + ANN search), DuckDB via `@duckdb/node-api` (in-memory query engine *only* -- backs the data-driver `db_file_*` tools for CSV / Parquet / JSONL attaches; **not** used for persistent storage)
- **Parsing**: tree-sitter (TypeScript, Python, Go, Java, Scala)
- **LLM providers**: Ollama (local -- qwen3-coder, qwen3-embedding) + one active cloud provider (OpenAI, Anthropic, Gemini, Mistral). Managed via the Model Providers pane (command `insrc.openModelProviders`); API keys live in the OS keychain.
- **Logging**: pino + pino-pretty (CLI) + pino-roll (file rotation)
- **CLI framework**: commander
- **HTTP**: undici

## Project structure

```
src/
  shared/          Core types, paths, logger (imported by everything)
    types.ts       All shared interfaces: Entity, Relation, LLMProvider, Task, Plan, etc.
    paths.ts       ~/.insrc/ directory layout constants
    logger.ts      pino-based logging (daemon vs CLI mode)
  indexer/         Code parsing and knowledge graph construction
    parser/        tree-sitter parsers (typescript.ts, python.ts, go.ts, java.ts, scala.ts, base.ts, artifact.ts)
    manifest.ts    Dependency manifest parsing (package.json, go.mod, etc.)
    resolver.ts    Import resolution
    embedder.ts    Ollama embedding generation
    watcher.ts     @parcel/watcher file system watcher
  db/              Database access layer (LMDB graph + Lance vectors)
    client.ts      Sentinel DbClient (kept for caller back-compat; substrate is opened lazily by graph/store.ts and lance/conn.ts)
    graph/         Custom LMDB-backed graph layer
      store.ts     LMDB env, 20 sub-DBs, txn helpers, runReaderCheck()
      keys.ts      Binary key encoding (u64 BE entity IDs, edge keys, name-index, kind bytes)
      ids.ts       u64 / u32 sequential ID allocators (in-txn variants)
      codec.ts     Typed msgpack encoder/decoder pairs for every row type
      edges.ts     1-hop primitive: outNeighbors / inNeighbors over out_edge / in_edge
      traversal.ts bfs / dfs / transitiveClosure / scc / unreachable (over u64 ids)
    lance/         LanceDB tables + per-table CRUD + ANN
      conn.ts      Lazy-init connection singleton, openOrCreateTable helper
      entity-vec.ts   entity_vec table (entity embeddings, repo+kind+artifact filters)
      session-vec.ts  session_vec table (session embeddings)
      turn-vec.ts     turn_vec table (turn embeddings, tier/type filters)
      config-vec.ts   config_vec table (config-store embeddings)
    entities.ts    Entity CRUD + name-index lookup + string<->u64 helpers (LMDB row + Lance vector cascade)
    relations.ts   Resolved + unresolved edges, deleteResolvedRelations
    repos.ts       Repo registry (LMDB)
    conversations.ts  Session + turn persistence (LMDB structured + Lance vectors)
    todos.ts       TODO list / item / comment storage (LMDB)
    search.ts      Domain wrappers: searchEntities (Lance ANN), findCallers/Callees/DefinedIn/Imports, resolveClosure, closureEntities, unreachableEntities, sccEntities
    compaction.ts  Conversation compaction (directive/warm/archive/dedup) on the LMDB+Lance pair
  daemon/          Background daemon process
    server.ts      JSON-RPC over Unix socket
    lifecycle.ts   Start/stop/PID management
    queue.ts       Index job queue
  agent/           Interactive coding agent
    index.ts       Main REPL loop — entry point for agent sessions
    session.ts     Session state management
    config.ts      AgentConfig loading from ~/.insrc/config.json
    classifier/    Intent classification (LLM-based with keyword fallback)
      scope.ts     Scope detection (single vs batch → Pair vs Delegate routing)
    router.ts      Flat per-turn provider resolution (vision -> mention -> step binding -> active provider default)
    context/       Layered context management (L1-L5 budget system)
    providers/     LLM provider implementations (ollama, anthropic, openai, gemini, mistral) + factory.ts dispatch
    attachments/
      router.ts        Attachment detection (image, pdf, text, code) + base64 encoding
      forced-vision.ts Single-call pipeline used when attachments route through `models.visionDefault`
    framework/     Agent framework (step-based state machine)
      types.ts     AgentDefinition, AgentStep, StepContext, Channel, gate types
      runner.ts    runAgent() — step execution, checkpointing, resume
      checkpoint.ts Atomic checkpoint persistence, heartbeat, artifacts
      channel.ts   ReplChannel (terminal transport)
      test-channel.ts TestChannel (scripted replies for tests)
      helpers.ts   StepContext builder, message factory
      provider-mention.ts  Generic @mention provider override parsing
    planner/       Planner agent (implementation/test/migration plans)
      agent.ts     plannerAgent definition (8 steps)
      types.ts     Plan, Step, TestStepData, ImplementationStepData
    tasks/         Intent-specific agents and pipelines
      shared/      Reusable helpers across agents
        investigate.ts  Tool-calling investigation (read-only exploration)
        codegen.ts      Diff generation → Codex validation → retry → escalate
        test-runner-helper.ts  Test execution + fix loop
        git-ops.ts      Auto-commit helper (configurable prefix)
      pair/        Pair coding agent (collaborative multi-turn)
        agent.ts   pairAgent definition (7 steps: check-context → analyze → propose → review-gate → apply → validate → summarize)
        types.ts   PairInput, PairMode, Proposal, DiffEntry, TodoItem
        steps.ts   Step implementations with propose/review/apply loop
      delegate/    Delegate coding agent (plan-driven autonomous)
        agent.ts   delegateAgent definition (6 steps: invoke-planner → approve-plan → execute → advance → failure-gate → report)
        types.ts   DelegateInput, DelegatePlan, CommitStrategy, GateLevel
        steps.ts   Step implementations with planner sub-agent and per-step codegen
      designer/    Multi-step design pipeline with validation gates
      brainstorm/  Brainstorm agent for iterative spec building
      implement.ts Legacy single-turn implement pipeline (fallback)
      refactor.ts  Legacy single-turn refactor pipeline (fallback)
      test.ts      Legacy single-turn test pipeline (being replaced by tester agent)
      debug.ts     Legacy single-turn debug pipeline (replaced by Pair debug mode)
    tools/         Agent tool system (registry, executor, validator, MCP client)
    faults/        Health monitoring and fault classification
    attachments/   File attachment handling (images, PDFs, code)
  cli/             CLI entry point and commands
    index.ts       commander setup (daemon, repo, chat commands)
    client.ts      IPC client for daemon communication
    commands/      Subcommand handlers (daemon.ts, repo.ts)
scripts/           Development/test scripts (run with `npx tsx scripts/<name>.ts`)
design/            Architecture design documents (HTML)
```

## Build and run

```bash
npm install                          # install dependencies
npm run build                        # tsc → dist/
npm run dev                          # tsx src/index.ts
npx tsx scripts/test-indexer.ts      # smoke test (parser + manifest + resolver, no DB)
npx tsx scripts/test-classifier-live.ts  # live classifier test
npx tsx scripts/test-designer-live.ts    # live designer pipeline test
npx tsx scripts/test-planner-live.ts     # live planner agent test
source ~/.insors && npx tsx scripts/test-pair-smoke.ts      # pair agent smoke test (sandbox)
source ~/.insors && npx tsx scripts/test-delegate-smoke.ts  # delegate agent smoke test (sandbox)
source ~/.insors && npx tsx scripts/test-ollama-bash.ts     # ollama tool-calling test
```

## Code conventions

### Imports
- Always use `.js` extension in import paths (NodeNext resolution requires it even for .ts files)
- Use `import type` for type-only imports (`verbatimModuleSyntax` is enabled)
- Shared types come from `../shared/types.js` — never import Ollama/Anthropic SDK types directly into agent logic

### TypeScript strictness
- `strict: true` with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`
- Optional properties use `| undefined` explicitly (e.g., `tools?: ToolDefinition[] | undefined`)
- Index access results are `T | undefined` — always handle the undefined case

### Logging
- Use `getLogger('module-name')` from `../shared/logger.js` — never use `console.log`
- For injectable log functions in pipelines, use `toLogFn(log)` to adapt pino to `(msg: string) => void`
- Log levels: `INSRC_LOG_LEVEL` env var (default: `info`)

### LLM provider abstraction
- All LLM interaction goes through the `LLMProvider` interface in `shared/types.ts`
- Never import provider SDKs directly in agent logic -- construct via `agent/providers/factory.ts` (`buildProvider({provider, model}, cfg)`)
- Provider files: `ollama.ts` (local), `anthropic.ts`, `openai.ts`, `gemini.ts`, `mistral.ts`
- Embedding model is local-only (Ollama): selected in the Model Providers pane's Local tab; `embed()` returns `[]` on every cloud provider
- Ollama tool calling: `/no_think` is auto-prepended to system prompts when tools are provided (required for qwen3-coder structured tool calls)
- Per-turn routing is a flat config lookup (`agent/router.ts`): vision attachment -> `models.visionDefault` (errors if unset); explicit `@mention`; per-step binding; active provider's `default`

### Entity IDs
- Deterministic: `SHA256(repo + file + kind + name)`, hex-32

### IPC
- Daemon communicates via JSON-RPC over Unix socket at `~/.insrc/daemon.sock`
- CLI/agent never opens LMDB or LanceDB directly — always goes through daemon IPC

### Intent classification (single funnel)
- **Every intent classification goes through `resolveIntent(session, message)`** in `agent/intent/resolver.ts`. No other module classifies user-message intent.
- Slash dispatchers (`/code-analyze`, `/data-analyze`, `/<intent-slash>`) call `resolveIntent(session, prompt, { slashForced: <intent> })` so the `[intent:current]` tag stamps consistently with the regular path
- The decomposer splits messages STRUCTURALLY only -- its `intent` field is advisory and gets overwritten by the resolver via `resolveActionIntents` before downstream code reads it
- Cold-classify path (inside `resolveIntent`) pulls a memory bundle (top-3 most-relevant prior turns + top-3 prior response segments via ANN over `turn_vec` + `response_segment_vec`) and emits a typed `relationship` (`NEW` / `FOLLOWUP` / `DRILL_DOWN` / `RESPONSE_TO` / `CONTINUATION` / `CORRECTION` / `COMPARE_WITH` / `TANGENT`) with citation refs
- `[intent:current]` tag is written EXCLUSIVELY by the resolver. Two grep-based CI asserts in `agent/intent/__tests__/funnel-enforcement.test.ts` pin both rules
- New code that wants to know the intent of a user message imports `resolveIntent`. New code that wants to know how the prompt relates to prior turns reads `resolved.relationship`. See `plans/intent-classification-consolidation.md`

### Context management
- 5-layer budget system (L1 system, L2 summary, L3a recent, L3b semantic, L4 task, L5 response)
- Context is assembled per-turn from graph queries, not raw file dumps
- Token budgets estimated via chars-per-token ratio (default: 3)

## Agent framework

Step-based state machine for multi-turn agents. Each agent is an `AgentDefinition<S>` with typed `AgentStep<S>` implementations.

### Core pattern
- Steps return `{ state, next }` — next step name or `null` to finish
- Gates (`ctx.gate()`) pause for user input with named actions
- Checkpoints written atomically after each step (crash-safe resume)
- Provider `@mention` overrides: `@local` + `@<activeProvider>` (one of `@openai`, `@anthropic`, `@gemini`, `@mistral`). `@sticky @<provider>` locks the override for the session; `@clear` resets. `@<non-active-provider>` errors -- switch active provider in the Model Providers pane first.

### Coding agents
- **Pair** (single-item): propose → review-gate → apply → validate loop. Modes: implement, refactor, debug, explore
- **Delegate** (batch-scope): planner sub-agent → approve plan → execute steps autonomously
- **Scope routing**: `detectScope()` classifies single vs batch → routes to Pair or Delegate
- **Shared helpers**: `investigate()` (read-only tool exploration), `generateAndValidate()` (local gen → cloud validate → retry), `runTestsAndFix()` (test + fix loop), `autoCommit()` (git stage + commit)

### Other agents
- **Designer**: iterative per-requirement design with validation gates
- **Planner**: 8-step plan generation (analyze → search → draft → validate → detail → serialize)
- **Brainstorm**: incremental spec building with user iteration

## Intent taxonomy

Supported intents: `implement`, `refactor`, `test`, `debug`, `review`, `document`, `research`, `code-analysis`, `plan`, `requirements`, `design`, `brainstorm`, `deploy`, `release`, `infra`

### Intent routing
- `implement`, `refactor`: scope detection → single → Pair agent, batch → Delegate agent
- `debug`: always Pair agent (debug mode)
- `test`: legacy pipeline (tester agent in design — see `design/test-agent.html`)
- `design`, `requirements`: Designer agent
- `plan`: Planner agent
- `brainstorm`: Brainstorm agent

## Key architectural rules

1. **Daemon owns all DB access** — agent/CLI communicate via IPC only
2. **Local-first** -- Ollama is always available (embeddings are local-only). Cloud providers are opt-in: pick one via the Model Providers pane and add its API key (stored in the OS keychain)
3. **Dependency-closure scoping** — searches span only transitive `DEPENDS_ON` closure of active repo
4. **Graph + vector** — structural queries use the LMDB graph layer's typed JS API (`findCallers / findCallees / outEdges / inEdges / transitiveClosure / unreachable`); semantic queries use LanceDB ANN. No Cypher / GQL / SQL exposed for graph traversal -- internal callers and the LLM-facing `graph_query` tool both go through the typed API. No FTS / BM25 (audit confirmed zero callers)
5. **No raw file dumps** — context is always structured entity summaries + relations from the graph
6. **Test agent never modifies impl code** — hands off to Pair agent (debug mode) for implementation bugs
7. **Repo registry is the contract** — workspace registry membership is established exclusively via the `repo.add` IPC (which calls `addRepo()`). The storage layer (`db/entities.ts`, `db/relations.ts`, etc.) never auto-allocates registry rows; an `Entity` whose `repo` path isn't registered fails the upsert with `UnregisteredRepoError`. Module entities (`kind: 'module'`) are the sole exception -- they route to one of four reserved namespace rows (`jvm` / `npm` / `python` / `go`), provisioned at first boot. See `plans/repo-registry-strict-contract.md`

## Design documents

- `design/agent.html` — overall agent architecture
- `design/agent-framework.html` — step-based framework design
- `design/coding-agents.html` — Pair and Delegate agent design
- `design/test-agent.html` — Test agent design (scenario planning, failure classification, Pair handoff)
- `design/agent-designer.html` — Designer pipeline
- `design/brainstorm-agent.html` — Brainstorm agent
- `design/planner-module.html` — Planner agent

## Code exploration via `insrc_analyze` / `insrc_analyze_step` (insrc MCP server)

For ANY question about this codebase's structure, conventions,
existing capabilities, adherence to documented rules, or design
decisions, CALL one of the two insrc analyze tools FIRST before
doing any manual file exploration (`Read`, `Grep`, `Glob`, shell
grep, etc.).

Both tools run the same deterministic graph queries + citation-
grounded synthesis and return the same verified 7-layer context
bundle. They are MORE accurate than manual grep + read for context
questions because every claim is grounded in a real exploration
output, file paths are drawn from the indexed graph (no hallucinated
paths), and contradictions in the docs are preserved verbatim.

### Which tool to use

| Intent                                                    | Tool                    |
|-----------------------------------------------------------|-------------------------|
| Map a module / explore its tree / count entities          | `insrc_analyze_step`    |
| List conventions / naming / test layout                   | `insrc_analyze_step`    |
| List indexed data sources or infra manifests              | `insrc_analyze_step`    |
| Adherence check ("does the code follow rule X from doc?") | `insrc_analyze_step`    |
| Capability discovery ("does the codebase already do Y?") | `insrc_analyze_step`    |
| Prose retrieval / decision trace from docs                | `insrc_analyze_step`    |
| Quick one-shot bundle (fine if you don't mind Ollama)    | `insrc_analyze`         |

- **`insrc_analyze_step`** is multi-turn: the server hands you the
  decomposer / synthesizer / narrow-LLM prompts + schemas via tool
  responses, and YOU emit the JSON as your next reasoning step. Every
  reasoning turn stays in this session — better accuracy, no subprocess
  spawn, no separate billing. Prefer this by default.
- **`insrc_analyze`** is one-shot: single tool call, server runs the
  whole pipeline. Inner narrow-LLM calls route to the daemon's
  configured `shaperProvider` (Ollama by default, slower + separate
  billing). Use only when you specifically want the Ollama path.

### `insrc_analyze_step` loop shape

Follow the `next` field in each response verbatim. The `guidance`
field explains the next call in one sentence; `prompt` + `schema`
are the authoritative instructions for the JSON you emit. Preserve
`state` verbatim between calls — it's a short opaque token tied
to a server-side run.

```
1. insrc_analyze_step({ phase: 'start', focus: '...' })
   -> { next: 'emit_plan', prompt, schema, state }
2. [emit JSON matching the plan schema]
   insrc_analyze_step({ phase: 'plan', plan: <JSON>, state })
   -> either { next: 'emit_narrow', ..., explorationId, state } (loop)
   -> or     { next: 'emit_bundle', ..., state }
3. [only if emit_narrow] emit JSON matching the narrow schema
   insrc_analyze_step({ phase: 'narrow', explorationId,
                        narrow: <JSON>, state })
   -> loop until emit_bundle
4. [emit JSON matching the bundle schema]
   insrc_analyze_step({ phase: 'bundle', bundle: <JSON>, state })
   -> { next: 'done', markdown } — render this to the user
```

### When NOT to use either

- Editing files (both tools are read-only).
- Running tests / builds.
- Answering non-context questions.
- When the returned bundle is empty or clearly off-topic — fall back
  to `Read` / `Grep` / `Glob` at that point.

### `repo` argument

If not passed, the tool uses `$INSRC_REPO` from the MCP server's
environment. Explicit `repo` overrides it. The repo must be
registered with the insrc daemon (`insrc repo add /path/to/repo`)
and finished indexing.
