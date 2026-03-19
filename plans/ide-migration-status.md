# insrc-ide Migration Status

## Project Setup

- **Repo:** `insors-ai/insrc-ide` (fork of `microsoft/vscode`)
- **Branch:** `release/1.96`
- **Path:** `/home/subho/work/dev/insors/insrc-ide`
- **Node.js:** v22.22.1 required (v22.18.0 works for most, preinstall check needs 22.22.1)
- **Dependencies:** `npm install` succeeded, native deps (native-keymap, kerberos) built after installing `libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev`

## Directory Layout

```
insrc-ide/
  src/
    vs/workbench/contrib/insrc/       # VS Code workbench integration
      common/
        daemonService.ts              # IInsrcDaemonService interface (DI decorator)
        sessionService.ts             # IInsrcSessionService interface
      electron-sandbox/
        daemonServiceImpl.ts          # JSON-RPC + streaming over Unix socket
        insrc.contribution.ts         # Contribution registration
      browser/                        # (future) browser-compatible views
    insrc/                            # insrc backend (copied from insrc repo)
      daemon/                         # Background daemon process
      agent/                          # Interactive coding agent
      indexer/                        # Code parsing + knowledge graph
      db/                             # Database access layer (Kuzu + LanceDB)
      shared/                         # Core types, paths, logger
      cli/                            # CLI entry point and commands
      config/                         # Configuration management
      package.json                    # Separate deps for native modules
  plans/                              # Migration + brainstorm plans
  design/                             # Architecture design documents
  vscode-insrc/                       # Legacy VS Code extension (to be deprecated)
```

## Completed Steps

### Step 1: Code Migration
- [x] Backend code copied to `src/insrc/`
- [x] Supporting files: `plans/`, `design/`, `vscode-insrc/`, `CLAUDE.md`
- [x] `src/insrc/package.json` created with native deps (kuzu, lancedb, tree-sitter, ollama, anthropic)
- [x] `tsconfig.insrc.json` copied for reference
- [x] One-line import added to `workbench.common.main.ts` for contribution registration

### Step 2: DaemonService
- [x] Interface: `common/daemonService.ts` — `IInsrcDaemonService` with DI decorator
  - `rpc<T>(method, params)` — single request/response JSON-RPC
  - `stream(method, params)` — async iterable streaming (deltas, gates, progress)
  - `ensureDaemon()` / `stopDaemon()` — daemon process lifecycle
  - `onStatusChange` event
- [x] Implementation: `electron-sandbox/daemonServiceImpl.ts` — Unix socket client
- [x] Import paths verified correct (`../../../../` depth matches other contrib modules, zero TS errors)
- [x] Pre-commit hygiene: `src/insrc/`, `vscode-insrc/`, `design/`, `plans/` excluded in `build/filters.js` and `.eslint-ignore`

### Step 3: SessionService
- [x] Interface: `common/sessionService.ts` — `IInsrcSessionService` with DI decorator
- [ ] Implementation needs redesign: should be a proper state container, not a thin RPC wrapper
  - Must mirror controller state from daemon stream messages
  - Must expose observable state that views bind to
  - Must handle full stream protocol (deltas, gates, progress, checkpoints)
  - Must decouple views from raw IPC protocol

## Step 2/3 Review Fixes — BEFORE Step 4

Code review identified issues in DaemonService and SessionService that must be fixed before building views on top.

### Lifecycle decision: auto-spawn detached

The daemon performs heavy indexing tasks that can run for a long time depending on repo size. It **must not die with the IDE**. Evaluated five options:

| Approach | Daemon survives IDE close | UX friction | Complexity |
|----------|--------------------------|-------------|------------|
| Connect-only (Remote Server pattern) | Yes | High (manual start) | Lowest |
| **Auto-spawn detached (chosen)** | **Yes** | **None** | **Low** |
| Shared Process service | No | None | Medium |
| Utility Process (Electron) | No | None | High |
| PTY Host pattern (fork + heartbeat) | No | None | Highest |

Options 3–5 tie the daemon to VS Code's process tree — daemon dies when IDE closes, killing in-progress indexing. Option 1 is clean but adds friction. **Option 2** gives zero-friction UX while keeping the daemon fully independent.

**Chosen pattern:**
- `connect()` — tries Unix socket first; if daemon not running, spawns with `detached: true` + `unref()`, then connects
- No `stopDaemon()` on the interface — stopping is a CLI concern (`insrc daemon stop`)
- `dispose()` closes sockets only, daemon keeps running
- Daemon outlives the IDE like a user-space service (similar to Docker daemon, LSP servers started by editors)

### Fix 1 — High: Daemon lifecycle + persistent connection (issues #3, #5, #6, #9, #10)

**Problems:**
- `ensureDaemon()`/`stopDaemon()` on the interface imply IDE owns lifecycle; `dispose()` calls `stopDaemon()` which would kill in-progress indexing
- Each `rpc()` creates a new `net.createConnection()` — expensive, and `isConnected` is unreliable (reflects whichever socket last fired an event)

**Fix — Interface (`common/daemonService.ts`):**
- Remove `ensureDaemon()` and `stopDaemon()`
- Add `connect(): Promise<void>` — connect to running daemon, or auto-spawn detached + connect
- `isConnected` and `onDidChangeState` reflect the single persistent socket

**Fix — Implementation (`electron-sandbox/daemonServiceImpl.ts`):**
- Maintain a single persistent `net.Socket` to `daemon.sock`
- Multiplex requests by `id` — `Map<number, { resolve, reject }>` for pending RPC responses
- Parse incoming newline-delimited JSON, dispatch by `id`
- `connect()` flow:
  1. Try `net.createConnection(SOCK_FILE)` → if success, done
  2. If `ENOENT`/`ECONNREFUSED` → spawn daemon with `cp.spawn(process.execPath, [daemonEntry], { detached: true, stdio: 'ignore' })` + `child.unref()`
  3. Retry connection with backoff (max 10s)
- On socket close/error: fire `onDidChangeState('disconnected')`, reject all pending requests, attempt auto-reconnect with exponential backoff (`[0, 5, 5, 10, 10, 10, 10, 10, 30]` seconds, modeled after VS Code's `PersistentConnection`)
- `dispose()` closes the socket only — does **not** stop the daemon

**Files:**
- `src/vs/workbench/contrib/insrc/common/daemonService.ts`
- `src/vs/workbench/contrib/insrc/electron-sandbox/daemonServiceImpl.ts`

### Fix 2 — High: Event-based streaming + typed messages (issues #1, #4, #14, #18)

**Problems:**
- `stream()` returns `AsyncIterable<StreamDelta>` — views can't bind to async iterables, they need `Event<T>`
- `StreamDelta` is `{ type: string; data?: Record<string, unknown> }` — too loose, every consumer casts
- SessionService never calls `stream()` and doesn't mirror daemon state

**Fix — DaemonService interface (`common/daemonService.ts`):**
- Replace `StreamDelta` with a discriminated union:
  ```typescript
  type DaemonStreamMessage =
      | { type: 'delta'; content: string }
      | { type: 'gate'; gateId: string; actions: string[] }
      | { type: 'progress'; step: string; status: string }
      | { type: 'checkpoint'; sessionId: string; data: unknown }
      | { type: 'context.set'; key: string; value: unknown }
      | { type: 'context.clear'; key: string };
  ```
- Replace `stream()` return type with a disposable stream handle:
  ```typescript
  interface IInsrcStreamHandle extends IDisposable {
      readonly onMessage: Event<DaemonStreamMessage>;
      readonly onDidEnd: Event<void>;
      readonly onDidError: Event<Error>;
  }
  stream(method: string, params: Record<string, unknown>): IInsrcStreamHandle;
  ```

**Fix — DaemonService implementation:**
- Stream handle backed by the persistent connection — stream messages matched by `id`, dispatched as events via `Emitter<T>`
- Multiple concurrent streams supported (each gets its own `id` + handle)

**Fix — SessionService interface (`common/sessionService.ts`):**
- Add reactive state events:
  ```typescript
  readonly onDidReceiveDelta: Event<{ sessionId: string; content: string }>;
  readonly onDidReceiveGate: Event<{ sessionId: string; gateId: string; actions: string[] }>;
  readonly onDidProgress: Event<{ sessionId: string; step: string; status: string }>;
  ```

**Fix — SessionService implementation (`electron-sandbox/sessionServiceImpl.ts`):**
- On `createSession()`/`resumeSession()`: call `daemonService.stream()` to get a handle, subscribe to `onMessage`
- Incoming messages update `_sessions` map state and fire typed events
- Views bind to SessionService events, never touch DaemonService directly
- Add `closeSession(sessionId)` — disposes stream handle, removes from `_sessions` map

**Files:**
- `src/vs/workbench/contrib/insrc/common/daemonService.ts`
- `src/vs/workbench/contrib/insrc/common/sessionService.ts`
- `src/vs/workbench/contrib/insrc/electron-sandbox/daemonServiceImpl.ts`
- `src/vs/workbench/contrib/insrc/electron-sandbox/sessionServiceImpl.ts`

### Fix 3 — Medium: RPC/stream timeouts + CancellationToken (issues #2, #7, #8)

**Problem:** If the daemon hangs or a socket stays open without responding, promises hang forever. No way to cancel in-flight requests.

**Fix:**
- `rpc()` accepts optional `CancellationToken` — on cancellation, reject pending promise
- Default 30s timeout on `rpc()` — reject with `TimeoutError` if no response
- Stream handles: 60s inactivity timeout — if no message received, fire `onDidError` and dispose
- Timeouts implemented via `setTimeout` + cleanup; cancellation via `CancellationToken.onCancellationRequested`

**Files:**
- `src/vs/workbench/contrib/insrc/common/daemonService.ts` — add `CancellationToken` param to `rpc()`
- `src/vs/workbench/contrib/insrc/electron-sandbox/daemonServiceImpl.ts` — implement timeouts

## Pending Steps

### Step 4: Brainstorm Workbench Views — NEXT
Register view container and build native brainstorm views:
- `IdeaListView` — selectable list of ideas (replaces gate card)
- `IdeaDiscussionView` — per-idea discussion panel
- `ConvergenceView` — theme review + convergence
- `SpecPreviewView` — final document preview
- Context banner in input area for focused idea discussion

Reference: `plans/brainstorm/brainstorm-interaction-model.md`

### Step 5: Agent Chat Panel — NEEDS CLEAN DESIGN
The chat panel must not be a port of the webview. Needs redesign:
- Native Monaco-based input with context banners
- Stream rendering for LLM output
- Gate cards as native interactive widgets
- Multi-session support
- Integration with VS Code's existing chat infrastructure (consider extending `contrib/chat/`)

### Step 6: Distribution + CI
- Product branding (product.json, icons)
- Build scripts for linux-x64, darwin-arm64, win32-x64
- Native dep compilation per platform
- Bundling insrc backend into distribution
- Auto-update infrastructure

## Service Architecture Redesign

The DaemonService and SessionService were initially ported from the VS Code extension's `postMessage` model. In the fork, the architecture is fundamentally different:

**Old (extension):** `Webview → postMessage → chatPanel.ts → cliRpc → daemon socket`
**New (fork):** `Native view → DI service → daemon socket`

### DaemonService Rethink — DECIDED

The daemon performs heavy indexing that must survive IDE restarts. It is **not** an IDE-managed child process.

- **`connect()`** tries the Unix socket first; if not running, auto-spawns with `detached: true` + `unref()`
- Daemon outlives the IDE — closing VS Code does not kill the daemon
- No `stopDaemon()` on the service interface — stopping is a CLI concern (`insrc daemon stop`)
- `dispose()` closes sockets only
- Persistent single socket with request multiplexing, auto-reconnect on disconnect

### SessionService Rethink

Currently a thin wrapper over daemon RPCs + localStorage. In the fork, it must become a **proper state container**:

1. **Mirror controller state** from daemon stream messages — the SessionService is the single source of truth for all views
2. **Expose observable state** that views bind to via VS Code's `Event<T>` pattern — no polling, no raw stream parsing in views
3. **Handle the full stream protocol** — deltas, gates, progress, checkpoints, context.set/clear
4. **Decouple views from IPC** — views never see raw JSON-RPC messages, only typed state transitions

**Key question resolved:** The daemon stays as a separate process. The indexer/watcher and the agent pipeline both run in the daemon. The SessionService mirrors state, it doesn't own execution.

## Architecture Decisions

| Decision | Rationale |
|----------|-----------|
| Daemon stays as separate process | Blast radius isolation — agent/LLM bugs don't crash the IDE |
| `src/insrc/` has own `package.json` | Native deps (kuzu, lancedb, tree-sitter) isolated from VS Code's deps |
| Services follow VS Code layer pattern | `common/` = interfaces, `electron-sandbox/` = Node.js impls, `browser/` = web impls |
| DaemonService auto-spawns detached daemon | `connect()` tries socket first, spawns `detached+unref` if not running; daemon survives IDE close |
| SessionService = state container | Views observe state changes via events, not polling or raw stream parsing |
| Chat panel is NOT a port of webview | Clean design leveraging native VS Code UI primitives |

## Blockers

### ~~1. Pre-commit Hygiene~~ — RESOLVED
`src/insrc/`, `vscode-insrc/`, `design/`, `plans/` are excluded from all hygiene filters in `build/filters.js` (`all`, `unicodeFilter`, `indentationFilter`, `copyrightFilter`, `tsFormattingFilter`) and from `.eslint-ignore`. Verified: `node build/hygiene.js src/insrc/shared/types.ts` produces zero errors.

### ~~2. Import Path Depth~~ — RESOLVED
Import paths are correct (`../../../../base/`, `../../../../platform/`). Verified: `npx tsc -p src/tsconfig.json --noEmit` produces zero errors for insrc contrib files.

### 3. TypeScript Version
VS Code main uses TypeScript 6.0-dev. Release/1.96 uses 5.x — compatible with insrc's 5.9.3.

## Source Repo Reference

Original insrc repo: `/home/subho/work/dev/insors/insrc`
- Will be deprecated once the fork can build, launch, and run brainstorm end-to-end
- Until then, development continues in both repos (daemon/agent features in insrc, IDE integration in insrc-ide)
