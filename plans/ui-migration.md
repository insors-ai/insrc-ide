# UI Migration Plan — VS Code Fork (insrc IDE)

## Problem

The VS Code WebviewPanel constraint limits complex agent UX:

- **Single iframe** — all UI in one `postMessage`-based sandbox
- **No shared state** — every interaction round-trips through `postMessage` relay
- **No native components** — tree views, split panels, inline widgets all require custom HTML/JS
- **No multi-panel layouts** — brainstorm discussion can't sit alongside code context
- **Gate card pattern** — forcing complex multi-turn flows into modal-like cards is brittle

The brainstorm flow (idea list → per-idea discussion → convergence → spec) needs a richer interaction surface than a chat panel can provide.

## Architecture Advantage

The codebase is already well-separated:

```
┌─────────────────────────────────────────────┐
│ Frontend (VS Code extension)                │  ← only this changes
│  vscode-insrc/src/ui/chatPanel.ts           │
│  vscode-insrc/src/webview/chat.html         │
└──────────────┬──────────────────────────────┘
               │ JSON-RPC over Unix socket
┌──────────────▼──────────────────────────────┐
│ Daemon (src/daemon/)                        │  ← stays the same
│  server.ts — IPC handler                    │
│  task.ts — task pipeline, controllers       │
│  chat-handler.ts — session management       │
│  controllers/ — brainstorm, designer, etc.  │
└──────────────┬──────────────────────────────┘
               │
┌──────────────▼──────────────────────────────┐
│ Agent core (src/agent/, src/indexer/, src/db)│  ← stays the same
│  LLM providers, parsers, graph/vector DB    │
└─────────────────────────────────────────────┘
```

**Migration surface:** Only `vscode-insrc/` is replaced. The daemon, agent, LLM pipeline, graph DB, and IPC protocol are UI-agnostic.

---

## Step 1: Fork Setup + Build System

### 1.1 Fork and structure

```bash
# New repo: insors-ai/insrc-ide
git clone https://github.com/microsoft/vscode insrc-ide
cd insrc-ide

# Track a stable release branch
git checkout release/1.96
git checkout -b insrc/main
```

All insrc-specific code lives in a single contrib directory:

```
src/vs/workbench/contrib/insrc/
  browser/                    # Browser-layer implementations
  common/                     # Shared types, constants, service interfaces
  electron-main/              # Main-process daemon lifecycle (optional)
```

This keeps the merge surface minimal — one directory, no modifications to core VS Code files.

### 1.2 Upstream sync strategy

```
upstream/release/1.96 ──→ upstream/release/1.97 ──→ ...
         │                          │
         ▼                          ▼
insrc/main (rebased)        insrc/main (rebased)
```

- Track VS Code `release/*` branches (monthly cadence)
- Rebase `insrc/main` onto each new release
- Conflicts are rare since insrc code is isolated in `contrib/insrc/`
- CI job: attempt rebase on new upstream release, flag if conflicts

### 1.3 Build integration

VS Code uses `gulp` for build. Add insrc contrib to the build:

```typescript
// src/vs/workbench/contrib/insrc/insrc.contribution.ts
import { registerWorkbenchContribution2 } from '../../common/contributions.js';
import { InsrcDaemonService } from './common/daemonService.js';
import { BrainstormViewPaneContainer } from './browser/brainstorm/brainstormView.js';
// ... register all contributions
```

Register in the main contributions barrel:
```typescript
// src/vs/workbench/contrib/contributions.ts (add one line)
import './insrc/insrc.contribution.js';
```

**This is the only modification to a core VS Code file.** Everything else is additive.

### 1.4 Product branding

```
product.json changes:
  "nameShort": "insrc"
  "nameLong": "insrc IDE"
  "applicationName": "insrc-ide"
  "dataFolderName": ".insrc-ide"
  "extensionGallery": { ... }  // Can still use VS Code marketplace
```

### 1.5 Deliverables

| Deliverable | Description |
|---|---|
| Fork repo `insrc-ide` | Based on VS Code release/1.96 |
| `contrib/insrc/` directory | Empty scaffold with contribution registration |
| Build + package script | Produces `insrc-ide` Electron app |
| CI pipeline | Build on push, rebase check on upstream release |

---

## Step 2: DaemonService — IPC Foundation

### 2.1 Service interface

```typescript
// src/vs/workbench/contrib/insrc/common/daemonService.ts

export const IInsrcDaemonService = createDecorator<IInsrcDaemonService>('insrcDaemonService');

export interface IInsrcDaemonService {
  /** Connection state */
  readonly onDidChangeState: Event<'connected' | 'disconnected'>;
  readonly isConnected: boolean;

  /** JSON-RPC call */
  rpc<T>(method: string, params?: Record<string, unknown>): Promise<T>;

  /** Streaming RPC (for chat, brainstorm, etc.) */
  stream(method: string, params: Record<string, unknown>): AsyncIterable<StreamDelta>;

  /** Start/stop daemon lifecycle */
  ensureDaemon(): Promise<void>;
  stopDaemon(): Promise<void>;
}
```

### 2.2 Implementation

```typescript
// src/vs/workbench/contrib/insrc/browser/daemonServiceImpl.ts

export class InsrcDaemonServiceImpl implements IInsrcDaemonService {
  private socket: net.Socket | null = null;

  constructor(
    @ILogService private readonly logService: ILogService,
    @IConfigurationService private readonly configService: IConfigurationService,
  ) {}

  async rpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    // JSON-RPC over Unix socket — same protocol as cli/client.ts
    // Reuse framing logic from src/cli/client.ts
  }

  async *stream(method: string, params: Record<string, unknown>): AsyncIterable<StreamDelta> {
    // Streaming variant — yields deltas as they arrive
    // Maps to daemon's chat.send streaming protocol
  }
}
```

### 2.3 Registration

```typescript
registerSingleton(IInsrcDaemonService, InsrcDaemonServiceImpl, InstantiationType.Delayed);
```

Every view/panel/service in the fork accesses the daemon through DI — no direct socket access, no message-passing relay.

### 2.4 Deliverables

| Deliverable | Description |
|---|---|
| `IInsrcDaemonService` interface | Typed RPC + streaming |
| Socket implementation | Unix socket with JSON-RPC framing |
| DI registration | Available to all workbench contributions |
| Daemon lifecycle | Auto-start on IDE launch, graceful shutdown |

---

## Step 3: Session Service — State Management

### 3.1 Service interface

```typescript
// src/vs/workbench/contrib/insrc/common/sessionService.ts

export const IInsrcSessionService = createDecorator<IInsrcSessionService>('insrcSessionService');

export interface IInsrcSessionService {
  /** Active brainstorm sessions */
  readonly activeSessions: ReadonlyMap<string, BrainstormSession>;
  readonly onDidChangeSession: Event<SessionChangeEvent>;

  /** Create or resume a brainstorm session */
  createSession(repoPath: string, message: string): Promise<BrainstormSession>;
  resumeSession(sessionId: string): Promise<BrainstormSession>;

  /** Session state (synced from daemon) */
  getState(sessionId: string): BrainstormState | undefined;

  /** Persistence */
  saveCheckpoint(sessionId: string): Promise<void>;
  listCheckpoints(repoPath: string): Promise<SessionCheckpoint[]>;
}

export interface BrainstormSession {
  id: string;
  repoPath: string;
  state: BrainstormState;
  createdAt: string;
  lastActivity: string;
}
```

### 3.2 Persistence

Uses VS Code's `IStorageService` (SQLite-backed) for session state:

```typescript
// Checkpoint on every controller.next() cycle
this.storageService.store(
  `insrc.brainstorm.${sessionId}`,
  JSON.stringify(state),
  StorageScope.WORKSPACE,
  StorageTarget.MACHINE,
);
```

Sessions survive IDE restarts. The daemon's controller state and the IDE's session state stay in sync via the streaming protocol.

### 3.3 Deliverables

| Deliverable | Description |
|---|---|
| `IInsrcSessionService` interface | Session CRUD, state access |
| Checkpoint persistence | SQLite via `IStorageService` |
| Resume logic | Reconstruct controller state from checkpoint |
| Session list | Show previous brainstorm sessions for a repo |

---

## Step 4: Brainstorm Workbench Views

### 4.1 View container registration

```typescript
// Register the brainstorm view container in the sidebar/panel
const viewContainer = Registry.as<IViewContainersRegistry>(
  ViewExtensions.ViewContainersRegistry
).registerViewContainer({
  id: 'insrc.brainstorm',
  title: 'Brainstorm',
  icon: brainstormIcon,
  order: 10,
}, ViewContainerLocation.AuxiliaryBar);  // Right sidebar
```

### 4.2 Idea List View

```typescript
// src/vs/workbench/contrib/insrc/browser/brainstorm/ideaListView.ts

export class IdeaListView extends ViewPane {
  private tree!: WorkbenchAsyncDataTree<BrainstormState, IdeaTreeItem>;

  renderBody(container: HTMLElement): void {
    // Native tree view with:
    // - Status dot (● pending, ○ discussed/accepted, ✕ rejected)
    // - Idea text (truncated)
    // - Verdict badge (strong/moderate/user)
    // - Click → opens discussion in editor area
  }
}

// Tree data provider
class IdeaTreeDataSource implements IAsyncDataSource<BrainstormState, IdeaTreeItem> {
  getChildren(element: BrainstormState | IdeaTreeItem): IdeaTreeItem[] {
    if (element instanceof BrainstormState) {
      return element.ideas.filter(i => i.status !== 'rejected');
    }
    return []; // Ideas are leaf nodes
  }
}
```

**Interactions:**
- Click → `IInsrcSessionService.focusIdea(ideaId)` → opens discussion editor
- Right-click → context menu: Accept, Reject, Delete
- Drag → reorder (visual only, updates priority)

### 4.3 Discussion Editor

A custom editor type that opens in the main editor area when an idea is selected:

```typescript
// src/vs/workbench/contrib/insrc/browser/brainstorm/discussionEditor.ts

export class DiscussionEditor extends EditorPane {
  // Layout:
  // ┌─────────────────────────────────────────┐
  // │ Idea header: text, verdict, tags        │
  // ├─────────────────────┬───────────────────┤
  // │ Discussion          │ Code Context      │
  // │ (chat-like view)    │ (entity list,     │
  // │                     │  expandable)      │
  // │                     │                   │
  // │                     │                   │
  // ├─────────────────────┴───────────────────┤
  // │ Input: [type your thoughts...]          │
  // │ [Accept] [Reject] [Refine] [Back]       │
  // └─────────────────────────────────────────┘
}
```

The discussion editor:
- Shows idea metadata (verdict, rationale, tags, refs) in a sticky header
- Left panel: chat-like message thread (user ↔ agent)
- Right panel: code entities from per-idea vector search (collapsible, clickable → opens file)
- Bottom: input field + action buttons
- Messages stream in via `IInsrcDaemonService.stream()`
- Refine action updates the idea in-place and refreshes the tree view

### 4.4 Convergence View

Opens after all ideas are discussed/accepted:

```typescript
// src/vs/workbench/contrib/insrc/browser/brainstorm/convergenceView.ts

export class ConvergenceView extends ViewPane {
  // Themes as collapsible groups
  // Ideas nested under their theme
  // Drag ideas between themes
  // Theme name/description editable inline
  // Action bar: Approve themes, Add theme, Re-cluster
}
```

### 4.5 Spec Preview

Opens in the editor area as a read-only markdown preview:

```typescript
// src/vs/workbench/contrib/insrc/browser/brainstorm/specPreview.ts

export class SpecPreviewEditor extends EditorPane {
  // Split view:
  // Left: rendered markdown (requirements spec)
  // Right: raw markdown (editable)
  // Bottom: Save options (format, path)
}
```

### 4.6 View layout

```
┌──────────────────────────────────────────────────────────────┐
│ insrc IDE                                                    │
├──────────┬───────────────────────────────┬───────────────────┤
│ Explorer │                               │ Brainstorm ▼      │
│          │   Discussion Editor           │ ┌───────────────┐ │
│ (files)  │   ┌────────────┬──────────┐   │ │ Idea List     │ │
│          │   │ Discussion │ Code     │   │ │               │ │
│          │   │ thread     │ Context  │   │ │ ● [1] Multi-  │ │
│          │   │            │          │   │ │   stage...    │ │
│          │   │ User: ...  │ [func]   │   │ │ ○ [2] Context │ │
│          │   │ Agent: ... │ [iface]  │   │ │   -aware...  │ │
│          │   │            │ [func]   │   │ │ ● [3] Segment │ │
│          │   │            │          │   │ │   scoring... │ │
│          │   ├────────────┴──────────┤   │ │               │ │
│          │   │ [input] [Accept] ...  │   │ │ [Accept rem.] │ │
│          │   └───────────────────────┘   │ │ [Diverge]     │ │
│          │                               │ │ [Converge]    │ │
│          │                               │ └───────────────┘ │
├──────────┴───────────────────────────────┴───────────────────┤
│ Agent Chat / Terminal                                        │
└──────────────────────────────────────────────────────────────┘
```

### 4.7 Deliverables

| Deliverable | Description |
|---|---|
| View container registration | Brainstorm sidebar in auxiliary bar |
| `IdeaListView` | Native tree with status dots, verdicts, click-to-discuss |
| `DiscussionEditor` | Split editor: discussion thread + code context |
| `ConvergenceView` | Theme grouping with drag-and-drop |
| `SpecPreviewEditor` | Rendered + raw markdown split view |

---

## Step 5: Agent Chat Panel (Native)

Replace the webview chat panel with a native workbench panel.

### 5.1 Panel registration

```typescript
// Register in the bottom panel area (alongside Terminal)
Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry)
  .registerViewContainer({
    id: 'insrc.agent',
    title: 'Agent',
    icon: agentIcon,
    order: 5,
  }, ViewContainerLocation.Panel);
```

### 5.2 Chat view

```typescript
export class AgentChatView extends ViewPane {
  // Message list (virtual scroll for performance)
  // Input area with provider @mentions
  // Streaming response rendering
  // Intent badge
  // Session history (tabs or dropdown)
}
```

### 5.3 Context banner

When a brainstorm idea is focused, the chat input shows a context banner:

```typescript
export class ContextBannerWidget {
  // Renders above the input field
  // Shows: idea index, text snippet, verdict, tags
  // Dismiss button → clears focus, returns to idea list
  // All messages sent while banner is active include the idea context
}
```

### 5.4 Deliverables

| Deliverable | Description |
|---|---|
| `AgentChatView` | Native chat panel replacing webview |
| `ContextBannerWidget` | Focused idea banner above input |
| Streaming renderer | Delta-based message rendering |
| Session tabs | Switch between active sessions |

---

## Step 6: Code Knowledge Graph Explorer

Post-MVP feature — leverages the fork's native capabilities.

### 6.1 Graph visualization

```typescript
export class GraphExplorerView extends ViewPane {
  // Interactive graph rendered with d3-force or similar
  // Nodes: entities (functions, classes, interfaces)
  // Edges: CALLS, DEPENDS_ON, CONTAINS
  // Click node → opens file at entity definition
  // Right-click → "Analyze", "Find callers", "Impact analysis"
  // Highlight: currently discussed idea's code refs
}
```

### 6.2 Inline entity annotations

```typescript
export class EntityAnnotationContribution implements IEditorContribution {
  // CodeLens above functions: "3 callers | 2 callees | last analyzed: 2h ago"
  // InlayHint: entity relationship indicators
  // Gutter icons: entity type indicators (function, class, interface)
  // Click CodeLens → expands caller/callee list inline
}
```

### 6.3 Deliverables

| Deliverable | Description |
|---|---|
| `GraphExplorerView` | Interactive entity graph |
| `EntityAnnotationContribution` | CodeLens + InlayHints for entities |

---

## Step 7: Distribution + CI

### 7.1 Build targets

```
insrc-ide-linux-x64.deb
insrc-ide-linux-x64.rpm
insrc-ide-linux-x64.tar.gz
insrc-ide-darwin-x64.dmg
insrc-ide-darwin-arm64.dmg
insrc-ide-win32-x64.exe
```

### 7.2 CI pipeline

```yaml
# .github/workflows/build.yml
jobs:
  build:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: true
      - run: yarn
      - run: yarn compile
      - run: yarn gulp vscode-linux-x64  # or platform-specific
      - uses: actions/upload-artifact@v4
```

### 7.3 Extension compatibility

The fork inherits VS Code's extension API. All existing VS Code extensions work out of the box. The `insrc` extension (`vscode-insrc/`) is deprecated — its functionality is now native.

### 7.4 Auto-update

Use `electron-updater` or VS Code's built-in update mechanism (modified to point to insrc release server).

---

## Migration Sequence

```
Week 1:  Step 1 — Fork setup, build, branding
Week 2:  Step 2 — DaemonService, socket connection, DI
Week 3:  Step 3 — SessionService, checkpoint persistence
Week 4:  Step 4a — IdeaListView, DiscussionEditor
Week 5:  Step 4b — ConvergenceView, SpecPreviewEditor
Week 6:  Step 5 — AgentChatView, ContextBanner
Week 7:  Step 7 — Distribution, CI, packaging
Week 8:  Testing, polish, first internal release
Week 9+: Step 6 — Graph explorer, entity annotations (post-MVP)
```

## What Stays the Same

| Component | Changes? |
|---|---|
| `src/daemon/` | No |
| `src/agent/` | No |
| `src/indexer/` | No |
| `src/db/` | No |
| `src/shared/` | No |
| `src/cli/` | No |
| IPC protocol | No |
| Ollama/Claude providers | No |
| Task/Controller model | No |
| Graph/Vector DB | No |

## What Gets Replaced

| Old | New |
|---|---|
| `vscode-insrc/src/webview/chat.html` | `AgentChatView` (native) |
| `vscode-insrc/src/ui/chatPanel.ts` | `IInsrcDaemonService` + views |
| Gate card rendering (HTML/JS) | Native tree views + editor panes |
| `postMessage` relay | Direct DI service calls |
| `.vsix` packaging | Electron app packaging |
