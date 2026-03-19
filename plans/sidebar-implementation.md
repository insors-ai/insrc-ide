# Sidebar Implementation Plan

> Unified Explorer with insrc icon -- file trees for all added repos + Sessions, Runs, Step Providers panes

## Architecture

### Design decision: workspace-backed Explorer

Instead of building a custom file tree, we leverage VS Code's native Explorer by managing an **insrc workspace file**. When a user adds a repo, it becomes a workspace folder -- the Explorer shows it automatically with full file operations, SCM integration, search, etc.

The insrc activity bar replaces the Explorer icon. Additional panes (Sessions, Runs, Step Providers) are registered into the same ViewContainer below the Explorer.

### Workspace lifecycle

**First launch:**
1. insrc creates `~/.insrc/insrc.code-workspace` with empty `folders` array
2. Default workspace name: `"insrc"` (user can rename via settings)
3. IDE opens this workspace automatically

**Workspace file format:**
```jsonc
// ~/.insrc/insrc.code-workspace
{
  "folders": [
    { "path": "/home/user/work/insrc" },
    { "path": "/home/user/work/my-app" }
  ],
  "settings": {
    "insrc.workspaceName": "My Projects"
  }
}
```

**Add repo flow:**
1. User runs `insrc.addRepo` (folder picker or command palette)
2. Calls `IWorkspaceEditingService.addFolders()` -- folder appears in Explorer immediately
3. Calls `daemonService.rpc('repo.add', { path })` -- daemon starts indexing
4. File decorations show indexing status on the folder

**Remove repo flow:**
1. User right-clicks repo folder -> "Remove from insrc"
2. Calls `IWorkspaceEditingService.removeFolders()` -- folder disappears from Explorer
3. Calls `daemonService.rpc('repo.remove', { path })` -- daemon drops index

**Rename workspace:**
- `insrc.renameWorkspace` command -> input box -> writes `insrc.workspaceName` setting
- Workspace title in title bar reflects the custom name

### Layout

```
+-----------------------------+
| [insrc icon]  INSRC         |
+-----------------------------+
| FILES (Explorer)          v |  <-- native Explorer, scoped to workspace folders
|  v insrc/                   |
|    > src/                   |
|    > design/                |
|      package.json        I  |  <-- decoration: indexed
|  > my-app/                  |
+-----------------------------+
| SESSIONS                  v |  <-- collapsed, grouped by repo
|  v insrc                    |
|    > Today (2)              |
|      "refactor auth"        |
|      "brainstorm cache"     |
|  > my-app                   |
+-----------------------------+
| RUNS                      v |  <-- collapsed
|  ~ pair -- propose (insrc)  |
|  ok brainstorm (done)       |
+-----------------------------+
| STEP PROVIDERS            v |  <-- collapsed
|  > pair                     |
|      propose -> claude:std  |
|  > delegate                 |
+-----------------------------+
```

### VS Code constructs

| Component | Construct | Location |
|-----------|-----------|----------|
| Activity bar icon | `ViewContainer` (replaces Explorer icon) | `ViewContainerLocation.Sidebar` |
| Files pane | Native `ExplorerView` re-registered into insrc container | Top pane |
| Sessions pane | `ViewPane` + `WorkbenchAsyncDataTree` | Below Explorer |
| Runs pane | `ViewPane` + `WorkbenchAsyncDataTree` | Below Sessions |
| Step Providers pane | `ViewPane` + `WorkbenchAsyncDataTree` | Bottom, collapsed |
| File decorations | `IDecorationsProvider` | Registered on `IDecorationsService` |

### Tree structure (Sessions pane)

Sessions are grouped by repo, then by date:

```
repo (RepoNode)                    <-- collapsible, one per workspace folder
├── "Today (2)" (DateGroupNode)    <-- collapsible
│   ├── session (SessionNode)      <-- click = open in chat + resume
│   └── session (SessionNode)
├── "Yesterday (1)"
└── "This week (3)"
```

Sessions expand to show turns:
```
session (SessionNode)
├── turn (TurnNode)    <-- leaf, shows user message preview + tier badge
├── turn (TurnNode)
└── turn (TurnNode)
```

### Tree structure (Runs pane)

Flat list of active/paused/crashed runs across all repos:

```
run (RunNode)          <-- shows agent + step + repo name
run (RunNode)
```

### Tree structure (Step Providers pane)

```
agent (AgentNode)                  ← collapsible (pair, delegate, planner, ...)
├── step (StepNode)                ← leaf, shows "propose → claude:standard"
├── step (StepNode)                ← right-click = "Change Provider" quick pick
└── step (StepNode)
```

## File inventory

All files under `src/vs/workbench/contrib/insrc/`:

### New service interfaces (common/)

```
common/repoService.ts              <-- IInsrcRepoService interface
common/agentRunService.ts          <-- IInsrcAgentRunService interface
common/workspaceService.ts         <-- IInsrcWorkspaceService interface (workspace file management)
```

### New service implementations (electron-sandbox/)

```
electron-sandbox/repoServiceImpl.ts
electron-sandbox/agentRunServiceImpl.ts
electron-sandbox/workspaceServiceImpl.ts   <-- create/manage ~/.insrc/insrc.code-workspace
```

### New sidebar views (browser/)

```
browser/sidebar/insrcViewContainer.ts       <-- ViewContainer + re-register ExplorerView + activity bar
browser/sidebar/sessionsView.ts             <-- Sessions ViewPane (repo -> date groups -> sessions -> turns)
browser/sidebar/sessionsTreeNodes.ts        <-- Session/Turn node types + rendering
browser/sidebar/runsView.ts                 <-- Runs ViewPane (flat list of agent runs)
browser/sidebar/stepProvidersView.ts        <-- Step Providers ViewPane + tree data source
browser/sidebar/insrcFileDecorations.ts     <-- IDecorationsProvider for Explorer
```

### Modified files

```
electron-sandbox/insrc.contribution.ts      <-- register new services + import sidebar
```

## Step 1: Service interfaces

### IInsrcRepoService (common/repoService.ts)

```typescript
interface RepoInfo {
  path: string;
  name: string;
  status: 'ready' | 'indexing' | 'stale' | 'error';
  lastIndexed?: string;
  entityCount?: number;
}

interface IInsrcRepoService {
  readonly _serviceBrand: undefined;
  readonly onDidChangeRepos: Event<void>;
  readonly repos: readonly RepoInfo[];

  refresh(): Promise<void>;
  addRepo(path: string): Promise<void>;
  removeRepo(path: string): Promise<void>;
  reindexRepo(path: string): Promise<void>;
}
```

Backed by daemon RPCs: `repo.list`, `repo.add`, `repo.remove`, `repo.reindex`.
Caches repo list in memory, fires `onDidChangeRepos` on any mutation.
Polls `repo.list` on a timer (or subscribes to daemon events when available).

**Integration with workspace:** `addRepo()` also calls `IInsrcWorkspaceService.addFolder()` to add the path as a workspace folder. `removeRepo()` also calls `removeFolder()`.

### IInsrcWorkspaceService (common/workspaceService.ts)

```typescript
interface IInsrcWorkspaceService {
  readonly _serviceBrand: undefined;

  /** Ensures ~/.insrc/insrc.code-workspace exists, creates if missing */
  ensureWorkspace(): Promise<URI>;

  /** Add a folder to the workspace file + IWorkspaceEditingService */
  addFolder(path: string): Promise<void>;

  /** Remove a folder from the workspace file + IWorkspaceEditingService */
  removeFolder(path: string): Promise<void>;

  /** Get/set the user-visible workspace name */
  readonly workspaceName: string;
  renameWorkspace(name: string): Promise<void>;
}
```

Backed by: `IWorkspaceEditingService` (add/remove folders), `IFileService` (read/write workspace file).
On first launch, creates `~/.insrc/insrc.code-workspace` and opens it via `IHostService.openWindow()`.

### IInsrcAgentRunService (common/agentRunService.ts)

```typescript
interface AgentRunInfo {
  id: string;
  agent: string;       // 'pair' | 'delegate' | 'designer' | 'brainstorm' | 'planner' | 'tester'
  status: 'active' | 'paused' | 'crashed' | 'completed';
  step?: string;        // current step name
  repo?: string;        // repo path this run belongs to
  createdAt: string;
  summary?: string;
}

interface IInsrcAgentRunService {
  readonly _serviceBrand: undefined;
  readonly onDidChangeRuns: Event<void>;

  getRunsForRepo(repoPath: string): Promise<AgentRunInfo[]>;
  resumeRun(runId: string): Promise<void>;
  discardRun(runId: string): Promise<void>;
}
```

Backed by: `agent.list`, `agent.resume`, `agent.discard`.
Filters by repo path on the client side (daemon returns all runs).

## Step 2: Service implementations

### RepoServiceImpl (electron-sandbox/repoServiceImpl.ts)

- Constructor injects `IInsrcDaemonService`, `ILogService`
- On construction: subscribe to `daemonService.onDidChangeState` - refresh when connected
- `refresh()`: calls `daemonService.rpc('repo.list')`, updates `_repos` array, fires event
- `addRepo()`: calls `rpc('repo.add', { path })`, then `refresh()`
- `removeRepo()`: calls `rpc('repo.remove', { path })`, then `refresh()`
- `reindexRepo()`: calls `rpc('repo.reindex', { path })`, then `refresh()`
- Polling: `RunOnceScheduler` at 30s interval calls `refresh()` while connected

### AgentRunServiceImpl (electron-sandbox/agentRunServiceImpl.ts)

- Constructor injects `IInsrcDaemonService`, `ILogService`
- `getRunsForRepo()`: calls `rpc('agent.list')`, filters by `run.repo === repoPath`
- `resumeRun()`: calls `rpc('agent.resume', { id })`, fires event
- `discardRun()`: calls `rpc('agent.discard', { id })`, fires event
- Caches last `agent.list` result, refreshes on demand

### InsrcWorkspaceServiceImpl (electron-sandbox/workspaceServiceImpl.ts)

- Constructor injects `IFileService`, `IWorkspaceEditingService`, `IHostService`, `ILogService`
- `ensureWorkspace()`:
  1. Check if `~/.insrc/insrc.code-workspace` exists via `IFileService.exists()`
  2. If not, write default workspace JSON with empty `folders` array
  3. Return URI to workspace file
- `addFolder(path)`: calls `IWorkspaceEditingService.addFolders([{ uri: URI.file(path) }])`
- `removeFolder(path)`: calls `IWorkspaceEditingService.removeFolders([URI.file(path)])`
- `renameWorkspace(name)`: writes `insrc.workspaceName` setting to workspace file

## Step 3: ViewContainer registration

### insrcViewContainer.ts

```typescript
const INSRC_VIEW_CONTAINER_ID = 'workbench.view.insrc';

// Register ViewContainer in primary sidebar
const VIEW_CONTAINER = Registry.as<IViewContainersRegistry>(
  ViewContainerExtensions.ViewContainersRegistry
).registerViewContainer({
  id: INSRC_VIEW_CONTAINER_ID,
  title: localize2('insrc', "insrc"),
  icon: insrcIcon,                    // custom ThemeIcon or codicon
  order: 10,                          // after Debug (order 5), before Extensions
  storageId: 'workbench.insrc.views.state',
  hideIfEmpty: false,
  openCommandActionDescriptor: {
    id: INSRC_VIEW_CONTAINER_ID,
    title: localize2('insrc', "insrc"),
    keybindings: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyI },
    order: 10,
  },
}, ViewContainerLocation.Sidebar);

// Move ExplorerView into this container (re-register from workbench.view.explorer)
// The native ExplorerView shows workspace folders -- which are the insrc repos.
Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([
  {
    id: 'workbench.explorer.fileView',  // re-use the existing Explorer view ID
    name: localize2('files', "Files"),
    // ExplorerView is already registered -- we move it to this container
    canToggleVisibility: false,
    canMoveView: false,
    order: 0,
    weight: 50,
  },
  {
    id: 'insrc.sessions',
    name: localize2('sessions', "Sessions"),
    ctorDescriptor: new SyncDescriptor(InsrcSessionsViewPane),
    canToggleVisibility: true,
    canMoveView: false,
    collapsed: true,
    order: 1,
    weight: 20,
  },
  {
    id: 'insrc.runs',
    name: localize2('runs', "Runs"),
    ctorDescriptor: new SyncDescriptor(InsrcRunsViewPane),
    canToggleVisibility: true,
    canMoveView: false,
    collapsed: true,
    order: 2,
    weight: 15,
  },
  {
    id: 'insrc.stepProviders',
    name: localize2('stepProviders', "Step Providers"),
    ctorDescriptor: new SyncDescriptor(InsrcStepProvidersViewPane),
    canToggleVisibility: true,
    canMoveView: false,
    collapsed: true,
    order: 3,
    weight: 15,
  },
], VIEW_CONTAINER);

// NOTE: Moving ExplorerView to a different container requires either:
// a) Deregistering it from workbench.view.explorer and re-registering here
// b) Using ViewDescriptorService.moveViews() at contribution time
// Since we own the fork, option (a) is cleanest -- modify the Explorer's
// registration in workbench.common.main.ts to target our container instead.
```

## Step 4: Sessions ViewPane

### sessionsTreeNodes.ts - Node types

```typescript
// Discriminated union for Sessions pane tree nodes
type SessionsTreeNode =
  | RepoTreeNode
  | DateGroupTreeNode
  | SessionTreeNode
  | TurnTreeNode;

interface RepoTreeNode {
  readonly kind: 'repo';
  readonly repoPath: string;
  readonly repoName: string;
}

interface DateGroupTreeNode {
  readonly kind: 'dateGroup';
  readonly label: string;        // 'Today', 'Yesterday', 'This week', 'Older'
  readonly repoPath: string;
  readonly sessions: SessionInfo[];
}

interface SessionInfo {
  id: string;
  repo: string;
  summary: string;
  createdAt: string;
}

interface SessionTreeNode {
  readonly kind: 'session';
  readonly session: SessionInfo;
}

interface TurnTreeNode {
  readonly kind: 'turn';
  readonly turn: TurnInfo;
}

interface TurnInfo {
  sessionId: string;
  idx: number;
  user: string;
  assistant: string;
  type?: string;      // 'turn' | 'directive' | 'summary' | 'merged'
  tier?: string;      // 'hot' | 'warm' | 'cold' | 'archive'
  createdAt?: string;
}

```

### sessionsView.ts - ViewPane

```typescript
class InsrcSessionsViewPane extends ViewPane {
  private tree!: WorkbenchAsyncDataTree<void, SessionsTreeNode>;

  constructor(
    options: IViewPaneOptions,
    @IInsrcSessionService private readonly sessionService: IInsrcSessionService,
    @IInsrcDaemonService private readonly daemonService: IInsrcDaemonService,
    // ...standard ViewPane deps
  ) { super(options, ...); }

  renderBody(container: HTMLElement): void {
    super.renderBody(container);
    // Create WorkbenchAsyncDataTree with:
    // - InsrcTreeDataSource (async children)
    // - InsrcTreeRenderer (tree item rendering)
    // - InsrcTreeIdentityProvider (node IDs)
  }

  layoutBody(height: number, width: number): void {
    this.tree.layout(height, width);
  }
}
```

### Data source (IAsyncDataSource)

```typescript
class SessionsTreeDataSource implements IAsyncDataSource<void, SessionsTreeNode> {
  hasChildren(element: void | SessionsTreeNode): boolean {
    if (element === undefined) return true;  // root
    switch (element.kind) {
      case 'repo': return true;
      case 'dateGroup': return true;
      case 'session': return true;  // has turns
      case 'turn': return false;
    }
  }

  async getChildren(element: void | SessionsTreeNode): Promise<SessionsTreeNode[]> {
    // root -> repos from workspace folders (IWorkspaceContextService)
    // repo -> date groups from daemonService.rpc('session.list', { repo })
    // dateGroup -> sessions as SessionTreeNodes
    // session -> turns from daemonService.rpc('session.history', { sessionId, limit: 30 })
  }
}
```

### Renderer (ITreeRenderer)

Maps each node kind to ThemeIcons + descriptions (ported from extension's treeView.ts):

**Sessions pane renderer:**

| Node | Icon | Label | Description |
|------|------|-------|-------------|
| repo | `repo` | repo name | session count |
| dateGroup | `calendar` | "Today (2)" | - |
| session | `comment-discussion` | summary or session ID prefix | time (HH:MM) |
| turn | `comment` (tier-colored) | user message preview (60 chars) | time + [tier] |
| turn (directive) | `pin` (orange) | preview | - |
| turn (summary) | `note` (dim) | preview | - |

**Runs pane renderer (in runsView.ts):**

| Node | Icon | Label | Description |
|------|------|-------|-------------|
| run (active) | insrc animated icon | agent + summary | "active -- step" (repo) |
| run (paused) | `debug-pause` (orange) | agent + summary | "paused -- step" (repo) |
| run (crashed) | `error` (red) | agent + summary | "crashed" (repo) |
| run (completed) | `pass-filled` (green) | agent + summary | "completed" (repo) |

### Context menus (MenuRegistry)

| Node contextValue | Actions |
|-------------------|---------|
| `insrc.session` | Open in Chat, Save Checkpoint |
| `insrc.run.paused` | Resume, Discard |
| `insrc.run.crashed` | Resume, Discard |
| `insrc.run.completed` | Discard |
| `insrc.run.active` | (view only) |

### Welcome view (when no repos)

```typescript
// When workspace has no folders, show welcome in Sessions pane
Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViewWelcomeContent('insrc.sessions', {
  content: localize('noRepos', "No repositories added.\n[Add Repository](command:insrc.addRepo)"),
  order: 0,
});
```

### Commands

| Command ID | Title | Handler |
|------------|-------|---------|
| `insrc.addRepo` | "insrc: Add Repository" | Folder picker -> `workspaceService.addFolder()` + `repoService.addRepo()` |
| `insrc.removeRepo` | "insrc: Remove Repository" | Confirm -> `workspaceService.removeFolder()` + `repoService.removeRepo()` |
| `insrc.reindexRepo` | "insrc: Re-index Repository" | `repoService.reindexRepo()` -> refresh |
| `insrc.renameWorkspace` | "insrc: Rename Workspace" | Input box -> `workspaceService.renameWorkspace()` |
| `insrc.refreshRepos` | "insrc: Refresh" | `repoService.refresh()` |
| `insrc.agentResume` | "insrc: Resume Agent Run" | `runService.resumeRun()` -> refresh |
| `insrc.agentDiscard` | "insrc: Discard Agent Run" | Confirm -> `runService.discardRun()` -> refresh |
| `insrc.openSession` | "insrc: Open Session" | Opens chat sidebar + resumes session |

### Keybinding

| Binding | Command |
|---------|---------|
| `Ctrl+Shift+I` / `Cmd+Shift+I` | Focus insrc sidebar (`workbench.view.insrc`) |

## Step 5: Step Providers ViewPane

### stepProvidersView.ts

Tree structure:
```
agent (AgentNode)            ← 14 agents from AgentProviderConfigs keys
├── step (StepNode)          ← step name → current binding
└── step (StepNode)
```

Data source:
- Calls `daemonService.rpc('config.show')` to get current `AgentConfig`
- Reads `config.models.agents` → `AgentProviderConfigs`
- For each agent with bindings, lists steps
- Agents with no overrides shown dimmed with "(defaults)" description

Node rendering:
| Node | Icon | Label | Description |
|------|------|-------|-------------|
| agent | `symbol-method` | agent name | step count or "(defaults)" |
| step (local) | `vm` | step name | "local" |
| step (claude:fast) | `zap` | step name | "claude:fast" |
| step (claude:standard) | `cloud` | step name | "claude:standard" |
| step (claude:powerful) | `cloud-upload` | step name | "claude:powerful" |

Context menu:
| Node | Actions |
|------|---------|
| step | Change Provider (quick pick) |
| agent | Reset to Defaults |

Quick pick flow ("Change Provider"):
1. Triggered by right-click on step → "Change Provider", or command palette
2. If from command palette: pick agent first → pick step → pick provider
3. If from context menu: agent + step known → pick provider only
4. Provider options: `local`, `claude:fast`, `claude:standard`, `claude:powerful`
5. Calls `daemonService.rpc('config.write', { path: 'models.agents.<agent>.<step>', value: binding })`
6. Refreshes tree

Command:
| Command ID | Title | Handler |
|------------|-------|---------|
| `insrc.setStepProvider` | "insrc: Set Step Provider" | Quick pick: agent → step → provider |
| `insrc.resetAgentDefaults` | "insrc: Reset Agent to Defaults" | Remove all overrides for agent |

## Step 6: Explorer file decorations

### insrcFileDecorations.ts

```typescript
class InsrcFileDecorationsProvider implements IDecorationsProvider {
  readonly label = 'insrc';
  readonly onDidChange: Event<URI[]>;

  constructor(
    @IInsrcRepoService private readonly repoService: IInsrcRepoService,
    @IInsrcDaemonService private readonly daemonService: IInsrcDaemonService,
  ) {
    // Fire onDidChange when repos change (reindex, status update)
  }

  provideDecorations(uri: URI): IDecorationData | undefined {
    // Check if file belongs to an indexed repo
    // Query daemon for file indexing status (cached)
    // Return decoration based on status
  }
}
```

Decoration rules:

| Status | Badge letter | Color | Tooltip |
|--------|-------------|-------|---------|
| Indexed | `I` | green (`testing.iconPassed`) | "insrc: indexed (42 entities, 2m ago)" |
| Stale | `S` | orange (`editorWarning.foreground`) | "insrc: stale (needs re-index)" |
| Parse error | `E` | red (`errorForeground`) | "insrc: parse error" |
| Ignored | - | dim (`disabledForeground`) | "insrc: ignored" |
| Not in repo | - | - | (no decoration) |

Data source: batch query daemon for file statuses within indexed repos. Cache results, invalidate on `onDidChangeRepos`.

Note: file-level decoration data requires a daemon RPC that returns per-file status. If `repo.list` doesn't include file-level granularity, we may need a new RPC (`repo.fileStatus`) or defer this to after the daemon supports it. For MVP, decorate at the **repo root folder level** only (show repo status badge on the folder).

## Implementation order

| # | Task | Files | Depends on |
|---|------|-------|------------|
| 1 | WorkspaceService interface | `common/workspaceService.ts` | - |
| 2 | RepoService interface | `common/repoService.ts` | - |
| 3 | AgentRunService interface | `common/agentRunService.ts` | - |
| 4 | WorkspaceService implementation | `electron-sandbox/workspaceServiceImpl.ts` | - |
| 5 | RepoService implementation | `electron-sandbox/repoServiceImpl.ts` | DaemonService, #4 |
| 6 | AgentRunService implementation | `electron-sandbox/agentRunServiceImpl.ts` | DaemonService |
| 7 | Service registration | `electron-sandbox/insrc.contribution.ts` | #1-6 |
| 8 | ViewContainer + Explorer re-registration | `browser/sidebar/insrcViewContainer.ts` | - |
| 9 | Sessions tree nodes | `browser/sidebar/sessionsTreeNodes.ts` | - |
| 10 | Sessions ViewPane | `browser/sidebar/sessionsView.ts` | #8, #9, SessionService |
| 11 | Runs ViewPane | `browser/sidebar/runsView.ts` | #8, #6 |
| 12 | Step Providers ViewPane | `browser/sidebar/stepProvidersView.ts` | #8, DaemonService |
| 13 | Commands + context menus | `browser/sidebar/insrcCommands.ts` | #1-12 |
| 14 | File decorations provider | `browser/sidebar/insrcFileDecorations.ts` | #2 |
| 15 | Welcome view (no repos) | `browser/sidebar/insrcViewContainer.ts` | #8 |

## Progress indicator

The animated spiral logo (`insrc-logo-animated.svg`) is used as a progress indicator.
Arms cycle through the brand greens via SVG `<animate>` on a 3s loop.

### Usage

| Context | How |
|---------|-----|
| Status bar | CSS `background-image: url(insrc-logo-animated.svg)`, toggle `.insrc-progress` class on/off |
| Repos tree (indexing) | Swap static icon to animated SVG on `RepoNode` when `status === 'indexing'` |
| Agent run (active) | Swap icon on `RunNode` when `status === 'active'` |
| Chat panel (waiting) | Show animated logo as loading spinner while waiting for agent response |

### Implementation

- Static icon: `insrc-logo.svg` or pre-rendered PNGs (`insrc-{16,24,28,32}.png`)
- Animated icon: `insrc-logo-animated.svg` (SVG animate, no JS needed)
- Toggle: add/remove a CSS class that switches `background-image` between static and animated
- No JS animation control needed -- CSS class toggle is sufficient since SVG `<animate>` auto-loops

### Files

```
browser/media/insrc-logo.svg              -- static logo (transparent bg)
browser/media/insrc-logo-animated.svg     -- animated logo (color-cycling arms)
browser/media/insrc-{16..512}.png         -- pre-rendered PNGs at standard sizes
browser/media/insrc-progress.css          -- .insrc-progress class definition
```

## Testing approach

No automated tests (per project conventions). Verify manually:
1. Activity bar icon appears, clicking opens sidebar
2. Repos pane shows repos from `repo.list` with correct icons/status
3. Expanding repo shows Sessions + Runs sections
4. Sessions date-grouped, clicking opens chat
5. Turns show under sessions with tier coloring
6. Runs show with status icons, right-click resume/discard works
7. Step Providers pane shows agents + steps, right-click change works
8. Quick pick flow works from command palette
9. "+ Add Repo" welcome view works when no repos
10. File decorations appear on indexed repo folders in Explorer
11. Sidebar state persists across reload
12. Tree refreshes when daemon reconnects
