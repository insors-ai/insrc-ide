# CLAUDE.md — insrc

## Project principles

These are project-wide governance principles that apply to every design and implementation decision. When in doubt, defer to these.

- **Accuracy is primary; cost is the least priority.** When choosing between an accurate-but-expensive path (more LLM calls, bigger context, slower pipeline) and a cheap-but-lossy one, choose accuracy. The system's value is correctness, not throughput. Cost optimizations are valid only when they preserve accuracy; otherwise the cheap path is the wrong path. This includes both compute cost and user-attention cost — neither outranks accuracy.
- **No direct cloud REST calls from our process.** Cloud LLM access happens through the locally-installed `claude` and `codex` CLI binaries (via `CliProvider`). Auth + quota stay with the user's CLI OAuth sessions. The four direct REST providers (Anthropic / OpenAI / Gemini / Mistral) were removed in the cleanup and must not be reintroduced.

## Current state (post-cleanup)

The project is in a **post-cleanup state**. The previous agent / meta-task / handoff / substrate / mcp / classifier / planner / designer / brainstormer / tester / analyzer stack was deleted; what remains is the **code-knowledge-graph infrastructure** (indexer + daemon core + storage + IDE viewer) plus a **`CliProvider` scaffold** ready for the next backend's tool-loop.

What survives:
- Indexer (tree-sitter parsing, manifest resolution, embedding generation)
- Daemon core (IPC, repo registry, queue, lifecycle, file-watcher)
- Storage (LMDB graph + Lance vectors, DuckDB query engine for data drivers)
- Built-in tools (~110 capability wrappers: file/git/shell/http/web/gh/k8s/pkg/ssh/test/notify/search/graph/db/data/code/cloud)
- IDE workbench (sidebar, status bar, ModelProviders, DbDrivers, Setup, Todos, Artifacts, Notepad panes; chat panel will rebuild in the next phase against `CliProvider`)
- Ollama provider (local LLM + embeddings)
- `CliProvider` (claude + codex CLI subprocess wrapper, structured-output aware)

What was deleted: `agent/*` (except `providers/{ollama, cli-provider, structured-output}` and the live test), `meta-task/`, `handoff/`, `mcp/`, `gating/`, `internal-ipc/`, the four direct cloud REST providers, `daemon/{controllers, cross-agent, skills, substrate, tools/builtins/{skills,plan,diff,artifact}}`, ~25 agent-coupled `daemon/` root files, all agent-bound `cli/commands/`, `bench/`, `scripts/`, `bin/permission-hook.ts`, and the corresponding IDE panes (brainstorm, handoff, meta-task, code-analyzer, data-analyzer, access, annotations, diff, chat).

The daemon currently boots, indexes repos, serves the infrastructure IPC surface, and returns `backend offline` for any agent-flow RPC. The chat panel and the agent flows get rebuilt incrementally on top of `CliProvider` + the surviving tool capability layer.

## Tech stack

- **Language**: TypeScript (strict mode, ESM-only via `"type": "module"`)
- **Runtime**: Node.js 20+, executed with `tsx` during development
- **Module system**: NodeNext (`"module": "nodenext"` in tsconfig)
- **Databases**: LMDB via `lmdb-js` (embedded KV; substrate for the custom graph layer in `db/graph/`), LanceDB (embedded vector DB; entity embeddings + ANN search), DuckDB via `@duckdb/node-api` (in-memory query engine *only* — backs the data-driver `db_file_*` tools for CSV / Parquet / JSONL attaches; **not** used for persistent storage)
- **Parsing**: tree-sitter (TypeScript, Python, Go, Java, Scala)
- **LLM providers**: Ollama (local, qwen3-coder + qwen3-embedding) + `CliProvider` (wraps `claude --print` and `codex exec`). Cloud auth is delegated to the CLI's OAuth session — no API keys stored on our side.
- **Logging**: pino + pino-pretty (CLI) + pino-roll (file rotation)
- **CLI framework**: commander
- **HTTP**: undici

## Project structure

```
src/insrc/
  shared/          Core types, paths, logger
    types.ts       Entity / Relation / LLMProvider / Tool / etc.
    paths.ts       ~/.insrc/ directory layout
    logger.ts      pino-based logging
  indexer/         Tree-sitter parsing + graph construction
    parser/        per-language tree-sitter parsers
    manifest.ts    dependency manifest parsing
    resolver.ts    import resolution
    embedder.ts    Ollama embedding generation
    watcher.ts     @parcel/watcher file watcher
  db/              Storage (LMDB graph + Lance vectors)
    client.ts      Sentinel DbClient
    graph/         Custom LMDB-backed graph layer (store, keys, codec, edges, traversal)
    lance/         LanceDB tables (entity-vec, session-vec, turn-vec, artifact-vec, config-vec, ...)
    entities.ts    Entity CRUD
    relations.ts   Resolved + unresolved edges
    repos.ts       Repo registry
    conversations.ts  Session + turn persistence
    search.ts      Graph + ANN search wrappers
  daemon/          Background daemon process
    index.ts       Entry point + IPC handler registry
    server.ts      Unix-socket JSON-RPC server
    lifecycle.ts   PID, socket, embedding bootstrap
    queue.ts       Index job queue
    session.ts     Minimal ChatSession (id + repoPath)
    chat-sessions.ts  Session pool (transport only)
    chat-handler.ts   chat.* RPC handlers (transport only)
    todos-rpc.ts   TODO framework RPC
    artifacts-rpc.ts  Template management RPC
    db-rpc.ts      Data-driver RPC
    artifacts/     Template loader + offline-bundle helpers
    db/            DuckDB pool + driver registry + per-format converters
    tools/         Tool registry + executor + ~110 built-in capability wrappers
  config/
    local.ts       Infra-only config (Ollama host, embedding model + dim, core model)
    store.ts       On-disk config storage (templates, feedback)
    search.ts, paths.ts, frontmatter.ts, feedback.ts, templates.ts
  agent/
    providers/
      ollama.ts            Local provider (LLM + embeddings)
      cli-provider.ts      Subprocess wrapper for claude + codex CLI binaries
      structured-output.ts ajv + retry helpers (still used by ollama)
      __tests__/           Live integration tests (gated behind INSRC_LIVE_TESTS=1)
  cli/
    index.ts       commander setup (daemon + repo commands; setup wizard)
    commands/
      daemon.ts
      repo.ts
      setup.ts
  bin/
    daemon.ts      Daemon entry binary

src/vs/workbench/contrib/insrc/
  common/          Service interfaces (daemonService, sessionService, workspaceService, repoService, agentRunService, chatService stub, configService, keychainService, lspToolService, todosService, artifactsService, dbConnectionsService, insrcArtifacts, insrcConfiguration)
  browser/         Workbench contributions
    sidebar/       Explorer panes (sessions, runs, workspace tree, file decorations, commands, workspace sync, view container)
    setup/         Setup wizard editor pane
    models/        Model providers editor pane
    dbDrivers/     Data sources editor pane
    todos/         TODOs editor pane
    artifacts/     Artifacts editor pane
    notepad/       Prompt notepad editor pane
    shared/        Ephemeral pane infrastructure
    media/         Shared CSS + icons
    insrc.contribution.ts  Registers everything above
    insrcStatusBar.ts      Daemon + indexing status indicators
    lspToolBridge.ts       Pushes diagnostics to daemon
    toolSettingsBridge.ts  Pushes insrc.tools.* settings to daemon
    toolSecretCommands.ts  Palette commands for tool credentials
  electron-sandbox/  Service implementations (daemonService, sessionService, ..., chatService stub)
```

## Build and run

```bash
cd src/insrc && npm install                 # install backend deps
cd src/insrc && npm run build               # tsc
INSRC_LIVE_TESTS=1 npx tsx --test \
  src/insrc/agent/providers/__tests__/cli-provider.live.test.ts
```

## Code conventions

### Imports
- Always use `.js` extension in import paths (NodeNext resolution requires it even for `.ts` files)
- Use `import type` for type-only imports (`verbatimModuleSyntax` is enabled)
- Shared types come from `../shared/types.js` — never import SDK types directly into application logic

### TypeScript strictness
- `strict: true` with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`
- Optional properties use `| undefined` explicitly (e.g., `tools?: ToolDefinition[] | undefined`)
- Index access results are `T | undefined` — always handle the undefined case

### Logging
- Use `getLogger('module-name')` from `../shared/logger.js` — never use `console.log`
- Log levels: `INSRC_LOG_LEVEL` env var (default: `info`)

### LLM provider abstraction
- All LLM interaction goes through the `LLMProvider` interface in `shared/types.ts`
- Two implementations: `OllamaProvider` (local) and `CliProvider` (subprocess wrapper for claude + codex)
- The factory + per-step routing lands in the next backend; for now, callers construct providers directly

### Entity IDs
- Deterministic: `SHA256(repo + file + kind + name)`, hex-32

### IPC
- Daemon communicates via JSON-RPC over Unix socket at `~/.insrc/daemon.sock`
- CLI / agent / workbench never opens LMDB or LanceDB directly — always goes through daemon IPC

## Key architectural rules

1. **Daemon owns all DB access** — agent / CLI / workbench communicate via IPC only
2. **Local-first** — Ollama is always available (embeddings are local-only). Cloud LLM access goes through `CliProvider` (claude + codex CLI subprocesses); no direct REST.
3. **Dependency-closure scoping** — graph searches span only the transitive `DEPENDS_ON` closure of the active repo
4. **Graph + vector** — structural queries use the LMDB graph layer's typed JS API (`findCallers / findCallees / outEdges / inEdges / transitiveClosure / unreachable`); semantic queries use LanceDB ANN. No Cypher / GQL / SQL exposed for graph traversal.
5. **No raw file dumps** — context is always structured entity summaries + relations from the graph
6. **Repo registry is the contract** — workspace registry membership is established exclusively via the `repo.add` IPC. The storage layer never auto-allocates registry rows; an `Entity` whose `repo` path isn't registered fails the upsert with `UnregisteredRepoError`. See `plans/repo-registry-strict-contract.md`.

## Design documents

- `design/indexer.html` — indexer architecture
- `plans/storage-migration-lmdb-lance.md` — storage substrate
- `plans/graph-storage-lmdb.md` — graph layer
- `plans/repo-registry-strict-contract.md` — repo registry contract
- `plans/tools.md` — tool registry + ~110 built-ins

## Code exploration via `insrc_analyze` / `insrc_analyze_step` (insrc MCP server)

For ANY question about this codebase's structure, conventions,
existing capabilities, adherence to documented rules, or design
decisions, CALL one of the two insrc analyze tools FIRST before
doing any manual file exploration (`Read`, `Grep`, `Glob`, `Bash`
grep, etc.).

Both tools run the same deterministic graph queries + citation-
grounded synthesis and return the same verified 7-layer context
bundle. They are MORE accurate than manual grep + read for context
questions because:

- Every claim is grounded in a real exploration output (module
  profile, symbol locate, class hierarchy, doc constraint, etc.).
- File paths are drawn from the indexed graph — no hallucinated paths.
- Contradictions in the docs are preserved verbatim, not auto-resolved.

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

### Follow-up pattern

If a coarse bundle didn't drill deep enough, call again with a narrower
`focus`, tighter `scope`, or specific `target`. Example:

```
1. insrc_analyze_step({ phase: 'start',
     focus: "map the analyze/context module" })
   -> coarse module tree

2. insrc_analyze_step({ phase: 'start',
     focus: "how does the decomposer emit an exploration plan",
     target: 'code', scope: 'S' })
   -> narrower how-does-it-work bundle
```

### `repo` argument

If not passed, the tool uses `$INSRC_REPO` from the MCP server's
environment (currently `/Users/subhagho/work/projects/insors/insrc-ide`).
Explicit `repo` overrides it. The repo must be registered with the
insrc daemon (`insrc repo add /path/to/repo`) and finished indexing.
