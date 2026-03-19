# Sidebar Implementation Plan

> insrc activity bar icon + two view panes (Repos, Step Providers) + Explorer file decorations

## Architecture

### Layout

```
┌─────────────────────────────┐
│ [insrc icon]  INSRC         │
├─────────────────────────────┤
│ REPOS                    ▾  │
│  ▾ ✓ insrc          ready   │
│    ▾ Sessions               │
│      ▸ Today (2)            │
│        💬 "refactor auth"   │
│        💬 "brainstorm cache"│
│      ▸ Yesterday (1)        │
│    ▾ Runs                   │
│      ⟳ pair - propose       │
│      ✓ brainstorm (done)    │
│  ▸ ⟳ my-app     indexing... │
│  ▸ ⏰ old-lib       stale   │
│  [+ Add Repo]               │
├─────────────────────────────┤
│ STEP PROVIDERS            ▾  │
│  ▸ pair                     │
│      propose → claude:std   │
│      review  → local        │
│  ▸ delegate                 │
│      execute → local        │
│      validate → claude:pow  │
└─────────────────────────────┘
```

### VS Code constructs

| Component | Construct | Location |
|-----------|-----------|----------|
| Activity bar icon | `ViewContainer` | `ViewContainerLocation.Sidebar` |
| Repos pane | `ViewPane` + `WorkbenchAsyncDataTree` | Inside ViewContainer |
| Step Providers pane | `ViewPane` + `WorkbenchAsyncDataTree` | Inside ViewContainer |
| File decorations | `IDecorationsProvider` | Registered on `IDecorationsService` |

### Tree structure (Repos pane)

```
repo (RepoNode)                    ← collapsible, click = reveal in Explorer
├── "Sessions" (SectionNode)       ← collapsible header
│   ├── "Today (2)" (DateGroupNode)  ← collapsible
│   │   ├── session (SessionNode)    ← click = open in chat + resume
│   │   └── session (SessionNode)
│   ├── "Yesterday (1)"
│   └── "This week (3)"
└── "Runs" (SectionNode)           ← collapsible header
    ├── run (RunNode)               ← click = resume if paused
    └── run (RunNode)
```

Sessions expand to show turns:
```
session (SessionNode)
├── turn (TurnNode)    ← leaf, shows user message preview + tier badge
├── turn (TurnNode)
└── turn (TurnNode)
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
common/repoService.ts              ← IInsrcRepoService interface
common/agentRunService.ts          ← IInsrcAgentRunService interface
```

### New service implementations (electron-sandbox/)

```
electron-sandbox/repoServiceImpl.ts
electron-sandbox/agentRunServiceImpl.ts
```

### New sidebar views (browser/)

```
browser/sidebar/insrcViewContainer.ts       ← ViewContainer + activity bar registration
browser/sidebar/reposView.ts                ← Repos ViewPane + tree data source
browser/sidebar/reposTreeNodes.ts           ← Node types + tree item rendering
browser/sidebar/stepProvidersView.ts        ← Step Providers ViewPane + tree data source
browser/sidebar/insrcFileDecorations.ts     ← IDecorationsProvider for Explorer
```

### Modified files

```
electron-sandbox/insrc.contribution.ts      ← register new services + import sidebar
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

// Register views inside the container
Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([
  {
    id: 'insrc.repos',
    name: localize2('repos', "Repos"),
    ctorDescriptor: new SyncDescriptor(InsrcReposViewPane),
    canToggleVisibility: true,
    canMoveView: false,
    order: 0,
    weight: 70,        // takes 70% of sidebar height
  },
  {
    id: 'insrc.stepProviders',
    name: localize2('stepProviders', "Step Providers"),
    ctorDescriptor: new SyncDescriptor(InsrcStepProvidersViewPane),
    canToggleVisibility: true,
    canMoveView: false,
    collapsed: true,    // collapsed by default
    order: 1,
    weight: 30,
  },
], VIEW_CONTAINER);
```

## Step 4: Repos ViewPane

### reposTreeNodes.ts - Node types

```typescript
// Discriminated union for all tree node types
type InsrcTreeNode =
  | RepoTreeNode
  | SectionTreeNode
  | DateGroupTreeNode
  | SessionTreeNode
  | TurnTreeNode
  | RunTreeNode;

interface RepoTreeNode {
  readonly kind: 'repo';
  readonly info: RepoInfo;
}

interface SectionTreeNode {
  readonly kind: 'section';
  readonly label: 'Sessions' | 'Runs';
  readonly repoPath: string;
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

interface RunTreeNode {
  readonly kind: 'run';
  readonly run: AgentRunInfo;
}
```

### reposView.ts - ViewPane

```typescript
class InsrcReposViewPane extends ViewPane {
  private tree!: WorkbenchAsyncDataTree<void, InsrcTreeNode>;

  constructor(
    options: IViewPaneOptions,
    @IInsrcRepoService private readonly repoService: IInsrcRepoService,
    @IInsrcAgentRunService private readonly runService: IInsrcAgentRunService,
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
class InsrcTreeDataSource implements IAsyncDataSource<void, InsrcTreeNode> {
  hasChildren(element: void | InsrcTreeNode): boolean {
    if (element === undefined) return true;  // root
    switch (element.kind) {
      case 'repo': return true;
      case 'section': return true;
      case 'dateGroup': return true;
      case 'session': return true;  // has turns
      case 'turn': return false;
      case 'run': return false;
    }
  }

  async getChildren(element: void | InsrcTreeNode): Promise<InsrcTreeNode[]> {
    // root → repos from RepoService
    // repo → [SectionNode('Sessions'), SectionNode('Runs')]
    // section('Sessions') → date groups from daemonService.rpc('session.list', { repo })
    // section('Runs') → runs from AgentRunService.getRunsForRepo(repoPath)
    // dateGroup → sessions as SessionTreeNodes
    // session → turns from daemonService.rpc('session.history', { sessionId, limit: 30 })
  }
}
```

### Renderer (ITreeRenderer)

Maps each node kind to ThemeIcons + descriptions (ported from extension's treeView.ts):

| Node | Icon | Label | Description |
|------|------|-------|-------------|
| repo (ready) | `pass-filled` (green) | repo name | "ready" |
| repo (indexing) | `sync~spin` | repo name | "indexing..." |
| repo (stale) | `clock` (orange) | repo name | "stale" |
| repo (error) | `circle-slash` (red) | repo name | "error" |
| section | `comment-discussion` / `rocket` | "Sessions" / "Runs" | - |
| dateGroup | `calendar` | "Today (2)" | - |
| session | `comment-discussion` | summary or session ID prefix | time (HH:MM) |
| turn | `comment` (tier-colored) | user message preview (60 chars) | time + [tier] |
| turn (directive) | `pin` (orange) | preview | - |
| turn (summary) | `note` (dim) | preview | - |
| run (active) | `sync~spin` (orange) | agent + summary | "active - step" |
| run (paused) | `debug-pause` (orange) | agent + summary | "paused - step" |
| run (crashed) | `error` (red) | agent + summary | "crashed" |
| run (completed) | `pass-filled` (green) | agent + summary | "completed" |

### Context menus (MenuRegistry)

| Node contextValue | Actions |
|-------------------|---------|
| `insrc.repo` | Re-index, Remove, Open in Explorer |
| `insrc.session` | Open in Chat, Save Checkpoint |
| `insrc.run.paused` | Resume, Discard |
| `insrc.run.crashed` | Resume, Discard |
| `insrc.run.completed` | Discard |
| `insrc.run.active` | (view only) |

### Welcome view (when no repos)

```typescript
// When repos list is empty, show welcome content
Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViewWelcomeContent('insrc.repos', {
  content: localize('noRepos', "No repositories indexed.\n[Add Repository](command:insrc.addRepo)"),
  order: 0,
});
```

### Commands

| Command ID | Title | Handler |
|------------|-------|---------|
| `insrc.addRepo` | "insrc: Add Repository" | Folder picker → `repoService.addRepo()` → refresh |
| `insrc.removeRepo` | "insrc: Remove Repository" | Confirm dialog → `repoService.removeRepo()` → refresh |
| `insrc.reindexRepo` | "insrc: Re-index Repository" | `repoService.reindexRepo()` → refresh |
| `insrc.openRepoFolder` | "insrc: Open in Explorer" | `workspace.updateWorkspaceFolders()` + `revealInExplorer` |
| `insrc.refreshRepos` | "insrc: Refresh" | `repoService.refresh()` |
| `insrc.agentResume` | "insrc: Resume Agent Run" | `runService.resumeRun()` → refresh |
| `insrc.agentDiscard` | "insrc: Discard Agent Run" | Confirm → `runService.discardRun()` → refresh |
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
| 1 | RepoService interface | `common/repoService.ts` | - |
| 2 | AgentRunService interface | `common/agentRunService.ts` | - |
| 3 | RepoService implementation | `electron-sandbox/repoServiceImpl.ts` | DaemonService |
| 4 | AgentRunService implementation | `electron-sandbox/agentRunServiceImpl.ts` | DaemonService |
| 5 | Service registration | `electron-sandbox/insrc.contribution.ts` | #1-4 |
| 6 | ViewContainer + view registration | `browser/sidebar/insrcViewContainer.ts` | - |
| 7 | Repos tree node types | `browser/sidebar/reposTreeNodes.ts` | #1, #2 |
| 8 | Repos ViewPane | `browser/sidebar/reposView.ts` | #6, #7 |
| 9 | Step Providers ViewPane | `browser/sidebar/stepProvidersView.ts` | #6, DaemonService |
| 10 | Commands + context menus | `browser/sidebar/insrcCommands.ts` | #1-9 |
| 11 | File decorations provider | `browser/sidebar/insrcFileDecorations.ts` | #1 |
| 12 | Welcome view (no repos) | `browser/sidebar/insrcViewContainer.ts` | #6 |

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
