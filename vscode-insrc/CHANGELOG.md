# Changelog

## 0.0.1 — 2026-03-16

### Added
- **Scaffold + Build** (Seg 1): Extension project with esbuild bundler, package.json manifest, activity bar icon
- **Daemon Lifecycle** (Seg 2): Auto-start, health polling, auto-restart on crash, force restart (SIGKILL)
- **Status Bar** (Seg 3): 10 states with rich tooltip (uptime, queue, repos), permission mode toggle
- **TreeView Navigation** (Seg 4): Repos from daemon, sessions by date, turns with tier badges, agent runs, context menus
- **Chat Panel** (Seg 5): WebviewPanel in editor area, streaming responses, gate UI, intent selector, file attachments, slash commands
- **Streaming + Tools** (Seg 6): Tool call blocks (collapsible), escalation notices, intent badges, drag-and-drop files
- **Inline Diff** (Seg 7): Virtual document diff provider, per-file accept/reject/edit, diff-in-gate detection
- **Setup Wizard** (Seg 8): Hardware detection, model recommendations, Ollama optimization, auto-pull
- **Settings Panel** (Seg 9): Model config, context budgets, agent overrides, config store browser
- **Test View** (Seg 10): Test runner with results display
- **Plan Tracker** (Seg 11): Step-by-step plan with status badges and progress
- **Docs Preview** (Seg 12): Rendered HTML design documents
- **Brainstorm Canvas** (Seg 13): Idea pool and spec builder view
- **Agent Runs** (Seg 14): Run management in TreeView (active/paused/crashed/completed), resume, discard
- **Config Store** (merged into Seg 9): Browse templates, feedback, conventions
- **Conversation History** (Seg 16): Turn expansion, tier badges, compact command
- **Code Annotations** (Seg 17): Highlight + CodeLens + send to chat
- **Secure Key Storage**: OS keychain via keytar, /keys chat command, masked listing
- **Actionable Intents**: Execute daemon commands from chat (status, reindex, stats, compact)
- **Dynamic Typing Indicator**: Live status text + elapsed timer
- **Model Config Popup**: View local/embedding/tier models from chat header
