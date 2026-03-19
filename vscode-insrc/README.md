# insrc — Local-First Coding Agent for VS Code

A VS Code extension for [insrc](https://github.com/insors-ai/insrc), the local-first hybrid coding agent that builds a live Code Knowledge Graph from your source code.

## Features

### Chat Panel
- Opens as a pinned editor tab (`Ctrl+Shift+I`)
- Streaming responses with live typing indicator and elapsed timer
- Intent selector: Auto, Implement, Refactor, Debug, Test, Design, Brainstorm, Plan, Review, Research
- File attachments via paperclip button or drag-and-drop
- Slash commands (`/design`, `/plan`, `/brainstorm`, `/keys`, etc.)
- Gate UI for agent approval workflows (approve/reject/edit with feedback)
- Model configuration popup (local model, embedding, tiers)

### Inline Diff
- Agent proposals rendered as VS Code inline diffs
- Per-file accept/reject/edit with feedback
- Virtual document provider — no buffer corruption

### Navigation Panel
- All indexed repos from daemon (not just workspace folder)
- Sessions grouped by date (Today/Yesterday/This week/Older)
- Expandable turns with tier badges (hot/warm/cold/archive)
- Agent runs with status (active/paused/crashed/completed)
- Conversation stats
- Click repo to open in Explorer

### Code Annotations
- Select code → `Ctrl+Shift+A` → add a note
- Amber highlight decoration + CodeLens preview
- Accumulate across files, send all to chat

### Status Bar
- 10 states: running, processing, indexing, Ollama down, stopped, crashed, stale, setup required, auto-accept, delta indexing
- Rich tooltip with daemon health, uptime, queue, repos
- Click to show daemon logs

### Daemon Lifecycle
- Auto-start on activation
- Health polling (30s interval)
- Auto-restart on crash (3 attempts)
- Force restart (`Ctrl+Shift+P` → "insrc: Force Restart Daemon")

### Setup Wizard
- Hardware detection (CPU, RAM, GPU/VRAM)
- Model recommendations based on machine config
- Ollama optimization suggestions
- Auto-pull missing models

### Settings Panel
- Model configuration (local, embedding, tiers)
- Context window and budget shapes
- Agent-specific model overrides
- Config store browser (templates, feedback, conventions)

### Specialized Views
- **Test View** — test runner with results display
- **Plan Tracker** — step-by-step plan with status badges
- **Docs Preview** — rendered HTML design documents
- **Brainstorm Canvas** — idea pool and spec builder

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+I` | Open chat panel |
| `Ctrl+Shift+A` | Add annotation (when text selected) |
| `Ctrl+Shift+N` | New session |

## Requirements

- [insrc](https://github.com/insors-ai/insrc) daemon running (`npm install && npx tsx src/cli/index.ts daemon start`)
- [Ollama](https://ollama.ai) installed with a code model (e.g., `qwen3-coder`)
- Node.js 20+

## Commands

All commands available via `Ctrl+Shift+P`:

| Command | Description |
|---------|-------------|
| insrc: Open Chat | Open the chat panel |
| insrc: New Session | Start a new chat session |
| insrc: Restart Daemon | Gracefully restart the daemon |
| insrc: Force Restart Daemon | SIGKILL + respawn (for stuck indexer) |
| insrc: Add Repo for Indexing | Index a new repository |
| insrc: Re-index Current Workspace | Trigger full re-index |
| insrc: Toggle Permission Mode | Switch between validate/auto-accept/strict |
| insrc: Open Settings | Open the settings panel |
| insrc: Open Setup Wizard | Run first-time setup |
| insrc: Add Annotation | Annotate selected code |
| insrc: Send Annotations to Chat | Send all annotations to chat |
| insrc: Show Daemon Logs | Open the output channel |
| insrc: Compact Conversation History | Merge old conversation turns |
| insrc: Conversation Stats | Show conversation statistics |

## Configuration

Settings under `insrc.*` in VS Code preferences:

```json
{
  "insrc.ollama.host": "http://localhost:11434",
  "insrc.model.local": "qwen3-coder:latest",
  "insrc.model.tiers.fast": "claude-haiku-4-5",
  "insrc.model.tiers.standard": "claude-sonnet-4-6",
  "insrc.model.tiers.powerful": "claude-opus-4-6",
  "insrc.permissions.mode": "validate",
  "insrc.daemon.autoStart": true
}
```

## License

Apache-2.0
