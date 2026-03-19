# Extension → Native Migration Plan

> Migrating `vscode-insrc/` (extension plugin model) to native VS Code workbench implementation in the fork.

## Status: BRAINSTORMING

## Why migrate?

The extension uses the plugin API (webviews, `vscode.*` commands, TreeDataProvider, CodeLens, StatusBarItem). In the fork, we have direct access to the workbench internals — DI services, native views, editor contributions, the full platform layer. Native implementation gives us:

1. **No webview overhead** — chat, brainstorm, plan, test, doc views are all webview panels today. Native views use the same rendering pipeline as the rest of VS Code.
2. **DI integration** — services inject directly, no `postMessage` bridge or global singletons.
3. **Proper state management** — observable state via `Event<T>`, not serialized postMessage round-trips.
4. **Editor-grade features** — Monaco widgets, inline decorations, quick picks, all without API restrictions.
5. **Single process model** — no extension host sandbox boundary. The chat panel can directly call services.

## What exists in vscode-insrc/

### Infrastructure (daemon + RPC)
| Component | File | What it does | Migration target |
|-----------|------|-------------|-----------------|
| Daemon lifecycle | `daemon/lifecycle.ts` | Spawn, health poll, restart, install/update | Already migrated → `DaemonService.connect()` (auto-spawn detached) |
| RPC client | `daemon/rpc.ts` | JSON-RPC over Unix socket (per-call) | Already migrated → `DaemonService.rpc()` / `stream()` (persistent + multiplexed) |

### UI Components
| Component | File | What it does | Native equivalent |
|-----------|------|-------------|-------------------|
| Chat panel | `ui/chatPanel.ts` + `webview/chat.html` | Webview: message list, input, streaming, gates, file attach, session mgmt | Native editor pane with Monaco input |
| Status bar | `ui/statusBar.ts` | 10-state status item with tooltip | `StatusbarEntryDescriptor` contribution |
| Tree view | `ui/treeView.ts` | Repos, sessions (date-grouped), turns, agent runs | `ITreeViewDataProvider` or custom view |
| Diff manager | `ui/diffManager.ts` | Virtual doc scheme, inline diff, CodeLens accept/reject/edit | `ITextModelService` + diff editor contribution |
| Setup wizard | `ui/setupWizard.ts` + `webview/wizard.html` | 5-step onboarding (system detect, ollama, models, keys, config) | Multi-step quick pick or walkthrough contribution |
| Settings panel | `ui/settingsPanel.ts` + `webview/settings.html` | Config UI for models, tiers, keys, daemon | Settings editor contribution or custom view |
| Annotation manager | `annotations/annotationManager.ts` | Highlight selection, gutter icons, CodeLens, compile to chat | Editor decoration contribution + CodeLens provider |

### Specialized Agent Views
| View | File | What it does | Native equivalent |
|------|------|-------------|-------------------|
| Brainstorm | `views/brainstormView.ts` + webview | Idea pool, diverge/converge/promote rounds, spec builder | **Step 4 in ide-migration-status.md** |
| Plan | `views/planView.ts` + webview | Kanban columns (pending/progress/done/failed/skipped) | Custom tree view or panel |
| Test | `views/testView.ts` + webview | Test plan, per-file status, impl bug gates, report | Custom tree view or panel |
| Doc | `views/docView.ts` + webview | Split rendered+raw, revision history, save | Monaco editor with preview |

### Commands (24 registered)
| Category | Commands |
|----------|----------|
| Chat | `openPanel`, `newSession` |
| Settings | `openSettings`, `openSetupWizard`, `configSearch` |
| Daemon | `restartDaemon`, `forceRestartDaemon`, `showLogs` |
| Repos | `addRepo`, `reindex`, `removeRepo`, `refreshTree`, `openRepoFolder` |
| Diffs | `diffAccept`, `diffReject`, `diffEdit`, `diffAcceptAll`, `diffRejectAll` |
| Annotations | `addAnnotation`, `sendAnnotations` |
| Agent | `agentList`, `agentResume`, `agentDiscard` |
| Views | `openPlanView`, `openDocView`, `openBrainstormView`, `openTestPanel` |
| Utility | `togglePermissionMode`, `showCost`, `testRun`, `testPlan`, `conversationCompact`, `conversationStats` |

### Keybindings
| Binding | Command |
|---------|---------|
| `Ctrl+Shift+I` / `Cmd+Shift+I` | Open chat panel |
| `Ctrl+Shift+A` / `Cmd+Shift+A` (with selection) | Add annotation |
| `Ctrl+Shift+N` / `Cmd+Shift+N` | New session |

### RPC surface (daemon methods called)
| Category | Methods |
|----------|---------|
| Config | `config.show`, `config.search`, `config.list`, `config.reload`, `config.reindex`, `system.recommend` |
| Chat | `chat.start`, `chat.send`, `chat.reply`, `chat.close`, `chat.inject`, `chat.cancel` |
| Repos | `repo.list`, `repo.add`, `repo.remove`, `repo.reindex` |
| Sessions | `session.list`, `session.history` |
| Agent | `agent.list`, `agent.resume`, `agent.discard` |
| Keys | `keys.list`, `keys.set`, `keys.delete` |
| Daemon | `daemon.status`, `daemon.shutdown` |
| Conversation | `conversation.stats`, `conversation.compact` |

### Stream message types (from chat.send)
| Type | Data | Consumer |
|------|------|----------|
| `delta` | `{ content }` | Chat panel - append text |
| `progress` | `{ step, status }` | Chat panel + agent views |
| `gate` | `{ gateId, actions, ... }` | Chat panel - show gate card, diff manager |
| `qna.update` | `{ questions }` | Chat panel - Q&A display |
| `tool` | `{ name, args, result }` | Chat panel - tool call display |
| `escalation` | `{ from, to, reason }` | Chat panel - escalation badge |
| `checkpoint` | `{ sessionId, data }` | Session service |
| `context.set` / `context.clear` | `{ key, value }` | Session service |
| `done` | - | End stream |
| `error` | `{ error }` | Error display |

## Migration tiers

### Tier 0: Infrastructure -- DONE
- [x] DaemonService interface + implementation (persistent connection, multiplexed, auto-spawn detached)
- [x] SessionService interface + implementation (stream subscription, typed events)
- [x] Service DI registration (`insrc.contribution.ts`)
- [x] DaemonService electron-main refactor (Node.js code in main process, IPC proxy in sandbox)
- [x] Auto-connect on instantiation, ProxyChannel args fix

### Tier 1: Foundation services -- MOSTLY DONE
- [x] **RepoService** - wraps `repo.*` RPCs, exposes repo list with change events
- [x] **AgentRunService** - wraps `agent.*` RPCs, exposes run list with status events
- [x] **WorkspaceService** - manages insrc workspace file, syncs daemon repos to workspace folders
- [x] **ChatService** - wraps `chat.*` RPCs, streaming, gate resolution, session lifecycle, session persistence (IStorageService)
- [x] **DiffService** - diff parsing, virtual doc scheme, CodeLens accept/reject/edit, file write on accept
- [x] **Session resume** - daemon chat.restore RPC, ContextManager hydration (L2/L3a/L3b from DB)
- [ ] **ConfigService** - wraps `config.*` and `system.recommend` RPCs, exposes observable config state
- [ ] **KeychainService** - wraps `keys.*` RPCs (or use VS Code's `SecretStorage`)
- [ ] **ConversationService** - wraps `conversation.*` RPCs (stats, compact -- low priority)

### Tier 2: Editor contributions -- PARTIALLY DONE
- [x] **File decorations** - `IDecorationsProvider` for Explorer: indexed/stale/error badges on repo roots
- [x] **Commands** - 13 of 24 registered (add/remove/reindex repo, refresh, rename workspace, agent resume/discard, step provider quick pick, connect daemon)
- [x] **Keybindings** - `Ctrl+Shift+I` (sidebar), `Ctrl+Alt+C` (chat)
- [ ] **Status bar** - `StatusbarEntryDescriptor`, daemon/agent status indicator (quick win)
- [x] **Diff manager** - virtual document scheme (insrc-proposed), inline diff editor, CodeLens accept/reject/edit, chat gate integration
- [x] **Diff commands** - insrc.diffAccept, insrc.diffReject, insrc.diffEdit, insrc.diffAcceptAll, insrc.diffRejectAll
- [x] **Inline diff default** - diffEditor.renderSideBySide set to false
- [ ] **Annotation manager** - editor decorations, CodeLens, gutter icons, compile-to-chat
- [ ] **Remaining commands** (6) - daemon logs, cost display, annotation commands, toggle permissions
- [ ] **Status bar** - `StatusbarEntryDescriptor`, daemon/agent status indicator (quick win)

### Tier 3: Navigation + session management -- MOSTLY DONE
- [x] **Explorer integration** - insrc panes registered inside Explorer ViewContainer
- [x] **Sessions tree** - WorkbenchAsyncDataTree, date-grouped, click opens in chat
- [x] **Runs tree** - WorkbenchAsyncDataTree, grouped by agent type
- [x] **Step providers tree** - WorkbenchAsyncDataTree, per-agent step bindings
- [x] **Step provider quick pick** - 3-step flow (agent -> step -> provider)
- [x] **Workspace sync** - auto-adds daemon repos to workspace folders on connect
- [x] **Insrc icon** - spiral galaxy SVG + PNG exports, activity bar icon
- [ ] **Setup wizard** - custom `EditorPane` (system detect, ollama, model pull, API keys)

### Tier 4: Agent views (custom panels) -- NOT STARTED
- [ ] **Brainstorm view** - idea list, discussion, convergence, spec preview
- [ ] **Plan view** - kanban-style step tracker
- [ ] **Test view** - test plan, per-file status, gates, report
- [ ] **Doc view** - rendered + raw split, revision history

### Tier 5: Chat panel -- DONE
- [x] **Chat view** in auxiliary bar (secondary sidebar)
  - [x] Trusted HTML rendering (daemon sends HTML, rendered via dompurify policy)
  - [x] User/assistant message bubbles (right/left aligned, different border-radius)
  - [x] Streaming content display with live updates
  - [x] Gate cards with inline action buttons + optional feedback
  - [x] Progress indicator (step/status bar with spinner)
  - [x] Code blocks with language header + copy button
  - [x] Collapsible long messages (>12 lines, gradient fade + "Show more")
  - [x] Tool call blocks (collapsible cards: name, input, output)
  - [x] Escalation notices (provider change badges with model info)
  - [x] File attachment (picker + chips with remove)
  - [x] Session switching (header dropdown with recent sessions)
  - [x] Repo selector (pill dropdown)
  - [x] Intent selector (dropdown in input area)
  - [x] Referenced file display (collapsible file content blocks, clickable paths)
  - [x] Chat icon (spiral galaxy + chat bubble overlay)

### Theme + visual polish -- DONE
- [x] **insrc Light + insrc Dark** theme (pastel green palette from brand design system)
- [x] **Curved tabs** (Chrome-style, 14px border-radius)
- [x] **Outline/Timeline hidden** by default
- [x] **Preview mode disabled** by default (files open permanently)
- [x] **Animated logo** (color-cycling spiral for progress indicator)

## Next priorities (recommended order)

1. **Status bar** (Tier 2) -- quick win, high visibility. Shows daemon state, active agent, indexing progress.
2. **ConfigService** (Tier 1) -- dependency for setup wizard and advanced settings.
3. **Annotation manager** (Tier 2) -- enables curated multi-file context for chat.
4. **Setup wizard** (Tier 3) -- first-run experience, onboarding.
5. **Brainstorm view** (Tier 4) -- primary agent view, already has a detailed plan.
6. **Plan view** (Tier 4) -- agent step tracking.
7. **KeychainService + remaining commands** -- polish.
8. **Test view + Doc view** (Tier 4) -- lower priority agent views.

## UI Layout - DECIDED

Three-panel layout, left and right collapsible:

```
┌──────────┬───────────────────────────────────┬───────────────┐
│ PRIMARY  │          EDITOR AREA              │  SECONDARY    │
│ SIDEBAR  │                                   │  SIDEBAR      │
│  (left)  │  Code files + agent views open    │   (right)     │
│          │  as editor tabs/panes             │               │
│ Activity │                                   │  Chat         │
│ bar icon │  file.ts | Brainstorm | Plan |    │  (persistent, │
│          │                                   │   always      │
│ Repos    │  ┌─────────────────────────────┐  │   available)  │
│ Sessions │  │  Whatever is active:        │  │               │
│ Runs     │  │  - code editing             │  │  Input        │
│          │  │  - brainstorm idea discuss  │  │  Streaming    │
│          │  │  - plan kanban              │  │  Gates        │
│          │  │  - test runner              │  │  Sessions     │
│          │  │  - doc preview              │  │               │
│          │  └─────────────────────────────┘  │               │
├──────────┴───────────────────────────────────┴───────────────┤
│ Panel (Terminal / Output / Problems) - unchanged             │
└──────────────────────────────────────────────────────────────┘
```

### Panel roles

| Panel | VS Code construct | Contains |
|-------|-------------------|----------|
| **Left: Explorer** | Primary Sidebar (Explorer `ViewContainer`) | File tree with insrc decorations (indexing status badges on files). Unchanged otherwise. |
| **Left: insrc** | Primary Sidebar (insrc `ViewContainer`, own activity bar icon) | Repos, sessions (date-grouped), agent runs, step providers. Collapsible. |
| **Center** | Editor Area | Code files AND agent views (brainstorm, plan, test, doc) as editor tabs. Full real estate. |
| **Right** | Secondary Sidebar (`AuxiliaryBar`) | Chat only. Persistent across editor tab switches. Collapsible. |
| **Bottom** | Panel | Terminal, Output, Problems - unchanged from VS Code |

### Left sidebar: hybrid approach — DECIDED

Evaluated three options:

| Option | Description | Verdict |
|--------|-------------|---------|
| A. Own activity bar icon only | Separate ViewContainer for insrc, Explorer untouched | Misses file-level indexing visibility |
| B. Inside Explorer only | Add insrc panes alongside Outline/Timeline | Clutters Explorer, no dedicated space |
| **C. Hybrid (chosen)** | **Own activity bar icon + file decorations in Explorer** | **Best of both** |

**insrc activity bar icon** (`ViewContainerLocation.Sidebar`):
- Repos pane - indexed repos with status
- Sessions pane - date-grouped (Today, Yesterday, This week, Older), click to open chat + agent view
- Agent runs pane - active/paused/crashed/completed runs, right-click to resume/discard
- Step providers pane - per-agent step bindings tree, right-click to change provider

**Explorer file decorations** (`IDecorationsProvider`):
- Surfaces indexing state where users already look (the file tree)
- Badges/colors on files: indexed (green), stale (orange), parse error (red), ignored (dim)
- Tooltip shows entity count, last indexed time
- Zero clutter - just badges on existing files, no extra panes in Explorer

### Key implications

1. **Chat is the secondary sidebar**, not a bottom panel or editor tab. It persists while the user switches between code and agent views in the center.
2. **Agent views are editor panes** (custom `EditorPane` subclasses), not sidebar views. They get full editor-area width and open as tabs alongside code files.
3. **Left sidebar has two modes** - Explorer (files + insrc decorations) and insrc (sessions/repos/runs). User clicks activity bar icons to switch.
4. **Chat talks to whatever is in center** - if brainstorm is active, chat context includes the focused idea. If code is active, chat context includes the file/selection.
5. **Both sidebars are collapsible** - user can collapse right sidebar to maximize code area, collapse left to maximize editor + chat.

### VS Code registration targets

| Component | Registration |
|-----------|-------------|
| insrc sidebar | `ViewContainerLocation.Sidebar` with custom activity bar icon |
| File decorations | `IDecorationsService.registerDecorationsProvider()` |
| Chat (right) | `ViewContainerLocation.AuxiliaryBar` (Secondary Sidebar) |
| Agent views | `EditorPane` subclasses registered via `EditorPaneDescriptor` |
| Status bar | `StatusbarEntryDescriptor` |
| Commands | `CommandsRegistry` |
| Keybindings | `KeybindingsRegistry` |

## Decisions

### 1. Chat: standalone in secondary sidebar — DECIDED

**Not** building on `contrib/chat/`. Evaluated and rejected because:

- **Copilot identity baked in** — `CHAT_PROVIDER_ID = 'copilot'` hardcoded, all view IDs/storage/UI strings branded Copilot
- **Callback streaming** — agent `invoke()` uses `progress()` callback, not event streams. Incompatible with our `DaemonService.stream()` → `Emitter<T>` pattern
- **No custom widget types** — content parts (markdown, tree, confirmation) are hardcoded in renderer. Can't inject gate cards, brainstorm cards, plan step cards without forking their rendering pipeline
- **Single session per view** — no tabs, no concurrent sessions
- **Fixed view location** — hardcoded to `workbench.panel.chat`, can't move to AuxiliaryBar
- **Gate round-trip** — `IChatConfirmation` triggers a new request instead of resolving a promise

Building standalone in `contrib/insrc/` gives us:
- Secondary sidebar (AuxiliaryBar) placement, collapsible
- Native streaming from `SessionService.onDidReceiveDelta` / `onDidReceiveGate` / `onDidProgress`
- Custom message rendering (gate cards, tool displays, escalation badges, brainstorm cards)
- Multi-session tabs
- Direct gate resolution via `SessionService` events
- No Copilot branding

### 2. Settings + Setup: split approach — DECIDED

**Basic settings → VS Code native settings editor** (zero effort, already works via `insrc.*` namespace):
- `insrc.ollama.host`, `insrc.model.local`, `insrc.model.tiers.*`
- `insrc.model.context.local` / `.claude`, `insrc.permissions.mode`, `insrc.routing.mode`
- Embedding model + dimensions
- Covers ~80% of the settings panel's form fields

**Setup wizard → custom `EditorPane`** (multi-step stateful flow, can't be a walkthrough):
- Step 1: System detection via `system.recommend` RPC (CPU/RAM/GPU/Ollama table)
- Step 2: Ollama optimization cards with copy-to-clipboard commands
- Step 3: Model pulling — spawns `ollama pull`, streams live progress bars
- Step 4: API keys — password inputs saving to OS keychain via `keys.set` RPC
- Step 5: Apply config + done
- One-time flow, opens on first activation or via command

**Agent step providers → quick pick + tree view** (frequently changed, needs fast access):
- Users change per-step model bindings often — needs better UX than a config file
- Config lives in `~/.insrc/config.json` under `models.agents`, managed via daemon RPC
- 14 agents × variable steps, values are `"local"` / `"claude:fast"` / `"claude:standard"` / `"claude:powerful"` or full `StepBinding`
- **Quick pick flow** for changes: `Ctrl+Shift+P` → "insrc: Set Step Provider" → pick agent → pick step → pick provider. Calls `config.write` RPC.
- **Tree view in left sidebar** (under insrc activity bar) for visibility of current bindings:
  ```
  STEP PROVIDERS
    ▸ pair
        propose → claude:standard
        review  → local
        apply   → local
    ▸ delegate
        execute → local
        validate → claude:powerful
  ```
- Right-click any step → "Change Provider" → quick pick
- Current bindings shown as descriptions in pick items
- All native VS Code primitives, zero custom panels

**Advanced settings → custom `EditorPane`** (rarely used, custom UI required):
- Config store browser — hierarchical tree with search/detail/edit
- Daemon management — status, update check, update, restart

**Dropped:**
- Full custom settings webview panel — replaced by native settings + quick pick + tree view
- Settings HTML/CSS/JS (`webview/settings.html`) — no webviews in the fork
- Dynamic HTML agent override table — replaced by tree view + quick pick

### 3. Annotations: custom decorations + CodeLens — DECIDED

Keep the lightweight approach. Annotations are a context-building tool for chat (select code → add note → compile all annotations → send to chat). Custom `IDecorationsProvider` for amber highlights, `CodeLensProvider` for note preview, gutter icons. "Send Annotations" compiles to structured message for the agent.

VS Code's `CommentController` was considered but rejected — heavier UI than needed, and the "compile to chat" flow would need custom wiring anyway.

### 4. Dropped from extension — no longer needed

| Extension code | Why it's dropped |
|----------------|-----------------|
| `daemon/lifecycle.ts` install/update flow | Fork ships with daemon built-in |
| `daemon/rpc.ts` per-call sockets | Replaced by `DaemonService` persistent connection + multiplexing |
| `postMessage` bridge in all webviews | No webviews in the fork |
| All `webview/*.html` files | Native views replace every webview |
| `ui/settingsPanel.ts` + `webview/settings.html` | Basic settings → native settings editor; advanced → custom EditorPane |
| `ui/chatPanel.ts` + `webview/chat.html` | Standalone chat view in secondary sidebar |
| `forceRestartDaemon` command | Auto-reconnect with exponential backoff handles it |
| Extension activation / `extension.ts` | All registration via workbench contributions |
| Global state persistence (`insrc.chatPanelOpen`) | DI services + `IStorageService` handle state |
