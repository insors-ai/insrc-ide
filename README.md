# Insrc IDE

A local-first hybrid coding IDE that builds a live Code Knowledge Graph from source code. Fork of VS Code with native agent integration, graph-powered code intelligence, and local + cloud LLM support.

Built by [Procix Software India](https://procix.com).

## What is Insrc?

Insrc is an IDE that understands your code structurally. A background daemon parses repos via tree-sitter, stores relationships in a graph database (Kuzu), and entity embeddings in a vector database (LanceDB). An interactive agent uses this knowledge graph to provide context-aware assistance powered by local LLMs (Ollama) with optional Claude escalation.

## Key Features

### Code Knowledge Graph
- **Automatic indexing** -- tree-sitter parsing for TypeScript, Python, Go
- **Structural relationships** -- calls, imports, implements, extends stored in Kuzu (Cypher queries)
- **Semantic search** -- entity embeddings via LanceDB for vector similarity + full-text search
- **Live updates** -- file watcher re-indexes on change

### Agent System
- **Research agent** -- goal-oriented investigation with tool calling (Read, Grep, Glob, graph search, web search)
- **Brainstorm agent** -- iterative idea generation with per-idea discussion, convergence, and spec building
- **Pair agent** -- collaborative multi-turn coding (propose, review, apply, validate)
- **Delegate agent** -- plan-driven autonomous execution for batch operations
- **Planner agent** -- implementation/test/migration plan generation
- **Designer agent** -- iterative per-requirement design with validation gates

### Chat Panel (Auxiliary Bar)
- Streaming responses with HTML rendering
- Tool call blocks (collapsible, shows input/output)
- Code blocks with language detection and copy button
- Collapsible long messages with gradient fade
- Gate cards for agent interactions (approve/reject/edit)
- File attachments with path resolution across workspace repos
- Session management with repo-scoped sessions
- Provider mentions (@local, @haiku, @sonnet, @opus)
- Intent selector (research, implement, refactor, debug, brainstorm, etc.)

### Prompt Notepad
- Full Monaco editor for composing large prompts
- CodeLens: Run All, Run Selection, Clear, Save as Template
- Variable expansion: `${repo}`, `${file}`, `${selection}`, `${clipboard}`
- Auto-save across sessions

### Sidebar (Explorer Integration)
- Repos with file decorations (indexed/indexing/stale/error badges)
- Sessions grouped by repo with date subgroups
- Agent runs grouped by type with status icons
- Step provider configuration tree
- Per-repo chat buttons

### Diff Manager
- Inline diff editor for agent-proposed code changes
- Accept/Reject/Edit CodeLens on proposed files
- Integrated with chat gate system

### Setup Wizard
- System detection (CPU/RAM/GPU/Ollama)
- Model management (list, pull with progress)
- API key management (secure storage)
- Recommended configuration

### Theme
- **Insrc Light** and **Insrc Dark** -- pastel green palette
- Curved Chrome-style tabs
- Custom spiral galaxy icon (activity bar, title bar, all platforms)

## Architecture

```
src/
  insrc/                          Backend (daemon, agent, indexer)
    daemon/                       Background daemon (JSON-RPC over Unix socket)
    agent/                        Agent framework + coding agents
      tasks/research/             Research agent (goal-oriented investigation)
      tasks/brainstorm/           Brainstorm agent (idea generation + spec)
      tasks/pair/                 Pair coding agent
      tasks/delegate/             Delegate coding agent
      tools/                      Tool system (registry, executor, SmartRead)
      context/                    5-layer context manager (L1-L5 budget system)
      providers/                  LLM providers (Ollama, Claude)
    indexer/                      Code parsing and knowledge graph
    db/                           Database layer (Kuzu + LanceDB)

  vs/workbench/contrib/insrc/     IDE integration (VS Code workbench)
    common/                       Service interfaces (DI decorators)
      daemonService.ts            Daemon connection + RPC + streaming
      sessionService.ts           Session lifecycle + events
      chatService.ts              Chat sessions + streaming + gates
      diffService.ts              Diff parsing + virtual docs
      configService.ts            Config + system info
      repoService.ts              Repo list + status
      agentRunService.ts          Agent run tracking
      workspaceService.ts         Workspace file management

    browser/                      UI components
      sidebar/                    Explorer panes (sessions, runs, step providers)
      chat/                       Chat panel (auxiliary bar)
      setup/                      Setup wizard (EditorPane)
      notepad/                    Prompt notepad (EditorPane)
      annotations/                Code annotation manager
      diff/                       Diff CodeLens + content provider

    electron-sandbox/             Service implementations (IPC proxy)
    electron-main/                Main process services (Node.js)

  vs/platform/insrc/              Platform-level services
    electron-main/                Daemon main service (net, child_process)

extensions/theme-insrc/           Built-in theme extension (Light + Dark)
resources/                        App icons (Linux, macOS, Windows, Web)
plans/                            Design documents and implementation plans
```

## Daemon Architecture

The daemon is a **detached background process** that outlives the IDE:

- **Auto-spawn**: IDE connects to existing daemon; if not running, spawns detached + unref
- **Persistent socket**: single multiplexed connection over Unix socket (`~/.insrc/daemon.sock`)
- **Auto-reconnect**: exponential backoff on disconnect
- **Independent lifecycle**: closing IDE does not stop the daemon; heavy indexing continues

Communication: JSON-RPC over newline-delimited JSON, with streaming support for agent responses.

## Context Management

5-layer budget system for LLM context assembly:

| Layer | Purpose | Budget |
|-------|---------|--------|
| L1 System | System prompt | Fixed 1,000 tokens |
| L2 Summary | Session summary (compressed history) | 4.7% of total |
| L3a Recent | Recent conversation turns | 6.3% of total |
| L3b Semantic | Similar past exchanges (vector search) | 6.3% of total |
| L4 Task | Code entities from knowledge graph | 25% of total |
| L5 Response | Reserved for LLM output | Remainder |

Context is assembled per-turn with clear section headers. The `ContextAwareProvider` transparently wraps all LLM calls -- callers don't manage context manually.

## SmartRead

Intelligent file reading that adapts strategy based on file size and content:

- **Small files** (<500 lines): read entire file
- **Large files**: detect format (code, JSON, log, markdown), choose strategy:
  - **grep**: search for relevant patterns
  - **head-tail**: first + last N lines
  - **section**: extract specific sections by heading
  - **chunked**: semantic chunking via doc-splitter for multi-pass processing
- **Directories**: list contents with sizes and types
- **Tool output overflow**: large results spill to temp files, SmartRead processes them

## Build and Run

```bash
# Install dependencies
npm install

# Development build (incremental, watches for changes)
node --max-old-space-size=8192 ./node_modules/gulp/bin/gulp.js watch-client

# Launch IDE
./scripts/code.sh --disable-gpu

# Start daemon (if not auto-spawned)
npx tsx src/insrc/daemon/index.ts

# Type check
npm run compile

# Hygiene (pre-commit)
node build/hygiene.js
```

## Configuration

Settings at `~/.insrc/config.json`:

```jsonc
{
  "ollama": { "host": "http://localhost:11434" },
  "models": {
    "local": "qwen3-coder:latest",
    "embedding": "qwen3-embedding:4b",
    "tiers": {
      "fast": "claude-haiku-4-5",
      "standard": "claude-sonnet-4-6",
      "powerful": "claude-opus-4-6"
    },
    "context": { "local": 16384, "claude": 200000 },
    "agents": {
      "pair": { "analyze": "local", "propose": "local", "validate": "claude" },
      "brainstorm": { "seed": "local", "diverge": "local", "converge": "claude" }
      // ... per-agent, per-step provider bindings
    }
  }
}
```

VS Code settings: `Ctrl+,` > search "insrc" for all configurable options.

## License

MIT License -- dual copyright:
- Copyright (c) 2015 - present Microsoft Corporation (VS Code base)
- Copyright (c) 2026 - present Procix Software India (Insrc extensions)

See [LICENSE.txt](LICENSE.txt) for full text.

For the original VS Code README, see [VSCODE-README.md](VSCODE-README.md).
