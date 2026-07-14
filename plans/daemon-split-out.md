# Splitting the daemon out of insrc-ide

## Goal

Move the entire daemon / backend (currently the `src/insrc/` sub-tree
inside [`insors-ai/insrc-ide`](https://github.com/insors-ai/insrc-ide))
into a separate repo [`insors-ai/insrc`](https://github.com/insors-ai/insrc)
already cloned at `/Users/subhagho/work/projects/insors/insrc/`. After
the split:

- `insors-ai/insrc-ide` owns only the VSCode fork + `src/vs/workbench/contrib/insrc/` UI contributions.
- `insors-ai/insrc` owns the daemon, indexer, storage, tool registry, MCP servers, workflow framework, agent providers, and the CLI.
- The IDE clones the new `insrc` repo into `~/.insrc/daemon/` (default `insrc.daemon.repoUrl` changes) and continues to spawn the daemon exactly like today.
- The IPC contract (Unix socket JSON-RPC at `~/.insrc/daemon.sock`) stays unchanged. No wire-format break.

Why now: the two repos have a clean layering boundary — the IDE only talks to the daemon over IPC, never imports its TypeScript. Splitting shortens the daemon's iteration loop (no VSCode gulp build to run for a daemon-only test) and clarifies ownership: contributions to the daemon land in `insrc`, contributions to the IDE UI land in `insrc-ide`.

## Non-goals

- Publishing `@insrc/backend` to npm. The IDE resolves the daemon by `git clone`, not by dependency. Publishing can come later if we want CLI-only installs.
- Making the IDE side's `common/types.ts` a shared package. Today the RPC types live in both places (mirrored). We'll keep the mirror pattern initially and revisit once the split is stable.
- Rewriting the daemon in a different language / runtime.
- Changing storage substrates, tool registry shape, or workflow framework.

## Repo shape decisions (already committed to in the shell)

- Repo root layout: `src/{agent,analyze,bin,cli,config,daemon,db,indexer,mcp,shared,workflow}` at the top of the new repo — no wrapping `src/insrc/` sub-tree. The current sub-tree exists because it's a package inside a VSCode fork; standalone it's just noise.
- `tsconfig.json` → `rootDir: "src"`, `outDir: "out"` (down from `../../out/insrc` — no shared out with the fork).
- `package.json.name` stays `@insrc/backend` for symmetry with the old package.
- `bin` entries keep the same names (`insrc-mcp`, `insrc` CLI) so `.mcp.json` configs and shell aliases don't break.

Decision points that remain open (call these out on review):

1. **License header text.** The daemon files carry `Copyright (c) Procix Software India. All rights reserved.` today. If the new repo has a different license posture, we'd rewrite headers during the move. Default: preserve as-is.
2. **Bench / scripts.** The current `src/insrc/bench/` and top-level `scripts/` were deleted in the post-cleanup state; nothing to migrate.
3. **Node target.** IDE tree assumes Node 20+ (matches VSCode). Standalone we could bump to Node 22 (long-term maintenance branch as of 2026). Default: stay at Node 20 for now — matches Electron / VSCode.
4. **CI.** The IDE repo has its own CI (VSCode's build). New repo needs its own — the minimum useful workflow is `npm ci && npm run build && npx tsx --test src/**/__tests__/*.test.ts`. Suggest: add `.github/workflows/ci.yml` in the migration commit.

## What moves, verbatim

Every file under `src/insrc/` in `insrc-ide` moves to `src/` in `insrc`, preserving the sub-tree shape. Concretely:

| From (`insrc-ide/src/insrc/`) | To (`insrc/src/`)   | Notes                                                              |
|-------------------------------|---------------------|--------------------------------------------------------------------|
| `agent/`                      | `agent/`            | Ollama + CliProvider + structured-output helper.                   |
| `analyze/`                    | `analyze/`          | 10 explorations + context-builder.                                 |
| `assets/`                     | `assets/`           | Shipped by `copy-assets.mjs`.                                      |
| `bin/`                        | `bin/`              | Daemon + MCP + CLI entrypoints (shebang preserved).                |
| `cli/`                        | `cli/`              | `insrc` CLI (`workflow`, `daemon`, `repo`, `setup`).               |
| `config/`                     | `config/`           | On-disk config store (templates, feedback, per-repo settings).     |
| `daemon/`                     | `daemon/`           | IPC, queue, lifecycle, tool registry + built-ins, RPC handlers.    |
| `db/`                         | `db/`               | LMDB graph, LanceDB vectors, DuckDB pool.                          |
| `indexer/`                    | `indexer/`          | Tree-sitter parsers, resolver, manifest, embedder, watcher.        |
| `mcp/`                        | `mcp/`              | `insrc_analyze_step`, `insrc_workflow_step` MCP servers.           |
| `prompts/`                    | `prompts/`          | Shaper / analyze / workflow prompt templates.                      |
| `shared/`                     | `shared/`           | Core types, paths, logger.                                         |
| `types/`                      | `types/`            | TS ambient declarations for native modules.                        |
| `workflow/`                   | `workflow/`         | Define / design / tracker framework + amendments + gates.          |
| `copy-assets.mjs`             | `copy-assets.mjs`   | Root-level build helper. Path constants adjust to new `out/` root. |
| `package.json`                | `package.json`      | Rewritten around the shell we already dropped in (deps re-added).  |
| `tsconfig.json`               | `tsconfig.json`     | Already in place with adjusted `rootDir`/`outDir`.                 |

Files that stay in `insrc-ide` (unchanged in this split):

- `src/vs/**` — the VSCode fork.
- `src/vs/workbench/contrib/insrc/` — every IDE-side contribution (sidebar, panes, service impls, RPC clients).
- `src/vs/platform/insrc/electron-main/insrcDaemonInstaller.ts` — the installer that clones + builds the daemon. Configuration default (`insrc.daemon.repoUrl`) flips to the new repo.
- Everything currently under `docs/`, `plans/`, `design/` that describes the daemon lives in **both** repos during the transition, then migrates to `insrc/docs/` in a follow-up. This plan doc itself stays in `insrc-ide` until the split lands.
- `.insrc/artifacts/*.json` and `docs/{defines,designs}/**` — these are per-workspace outputs of the workflow framework, unrelated to the code split.

## What the IDE has to change

Two files:

1. [`src/vs/platform/insrc/electron-main/insrcDaemonInstaller.ts`](../src/vs/platform/insrc/electron-main/insrcDaemonInstaller.ts):
   - `DEFAULT_REPO_URL` → `https://github.com/insors-ai/insrc.git`.
   - `DEFAULT_REPO_BRANCH` → the branch we cut on the new repo (`main` recommended — new repo, clean slate).
   - `DAEMON_SRC = join(DAEMON_DIR, 'src', 'insrc')` → `join(DAEMON_DIR, 'src')`.
   - `DAEMON_OUT = join(DAEMON_DIR, 'out', 'insrc')` → `join(DAEMON_DIR, 'out')`.
   - `DAEMON_ENTRY_CLONED = join(DAEMON_OUT, 'daemon', 'index.js')` → unchanged content, but resolves under the new `out/` root.
   - The symlink helper (`out/insrc/node_modules -> ../../src/insrc/node_modules`) flips to `out/node_modules -> ../src/node_modules`.

2. [`src/vs/workbench/contrib/insrc/common/insrcConfiguration.ts`](../src/vs/workbench/contrib/insrc/common/insrcConfiguration.ts):
   - `insrc.daemon.repoUrl` default → `https://github.com/insors-ai/insrc.git`.
   - `insrc.daemon.repoBranch` default → `main`.
   - Migration note in the description text so existing installs know their setting was preserved (VSCode will keep the user's overridden value; the default only affects fresh installs).

Everything else the IDE does over IPC keeps working — the socket path, the RPC method names, the payload shapes, all identical.

## Migration path

Order matters — the IDE keeps working end-to-end at every step.

### Phase 1 — dry-run in place (this plan)

- New repo shell exists and builds a smoke `.ts` file. ✅ Done.
- This plan committed to `insrc-ide/plans/`. ← This step.
- No files moved yet. IDE still talks to the current in-tree daemon.

### Phase 2 — populate the new repo

- Bulk-copy `insrc-ide/src/insrc/**` → `insrc/src/**` with `rsync -a --delete --exclude node_modules --exclude out src/insrc/ ../insrc/src/`.
- Add the runtime deps to the new repo's `package.json` (copy the `dependencies` block from the old one, keep the shell's `devDependencies` + `engines`).
- Copy `copy-assets.mjs` and rewrite its `SRC` / `DST` constants for the new tree.
- Add `.github/workflows/ci.yml` (build + test on push).
- `npm install && npm run build` in the new repo — confirm the same 200+ tests pass.
- Commit to a branch on `insors-ai/insrc` (e.g. `main` directly, since it's a fresh repo) and push.

**Verification gate:** `npx tsx --test src/**/__tests__/*.test.ts` in the new repo prints the same green count as running the same command in `insrc-ide/src/insrc/`.

### Phase 3 — flip the IDE

- On a feature branch in `insrc-ide`:
  - Point `insrc.daemon.repoUrl` / `repoBranch` defaults at `insors-ai/insrc` / `main`.
  - Adjust `DAEMON_SRC` / `DAEMON_OUT` in the installer.
  - Delete `src/insrc/` (`git rm -r src/insrc/`).
  - Delete `.mcp.json` MCP server entries whose paths pointed at `src/insrc/mcp/**` (or repoint at `~/.insrc/daemon/out/mcp/**`).
- Build the IDE fork end-to-end. Run it. Confirm the daemon auto-installs from the new repo, the indexer completes, and every ephemeral pane still opens.
- Commit + push. Cut a new IDE release branch on top.

**Verification gate:** starting a fresh IDE profile picks up the daemon from `insors-ai/insrc`, indexes a scratch repo, and answers an `insrc_analyze_step` call.

### Phase 4 — clean up

- Move daemon-scoped docs (`design/indexer.html`, `plans/graph-storage-lmdb.md`, `plans/tools.md`, etc.) into `insrc/docs/` / `insrc/plans/`. Leave stubs in `insrc-ide` that point at the new paths.
- Turn on branch protection on `insors-ai/insrc:main`.
- Update `CLAUDE.md` in `insrc-ide` to note the split (project structure section shrinks to the `src/vs/**` slice; a pointer paragraph to the daemon repo replaces the deleted section).
- Add a matching `CLAUDE.md` to the daemon repo covering the surviving conventions (imports with `.js` extension, entity IDs, "no direct cloud REST", etc.).

## Risks + mitigations

| Risk                                                    | Mitigation                                                                                                                                                              |
|---------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Existing users' installed daemon points at `insrc-ide`. | Users on old settings keep working (their config is retained). A one-line note in the release changelog nudges them to update. New defaults only affect fresh installs. |
| Native module builds (LMDB, better-sqlite3, keytar, tree-sitter, canvas) break in a fresh repo. | Phase 2 verification gate is exactly this — same tests, same platform, same node. If a build breaks it surfaces there, not in the IDE.                                  |
| Path constants embedded in tests refer to `src/insrc/`. | Grep-audited during the migration commit; tests use relative paths (`../` up to package root) not absolute ones.                                                        |
| Stale ESM module cache in a running daemon after the URL flip. | Existing `EnsureDaemonResult.updated` signal already triggers a daemon kill on any pull that advanced HEAD. First IDE start after the flip clones fresh → `updated: true` → daemon restarts. |
| The IPC contract silently drifts.                       | Keep `common/types.ts` in the IDE and `shared/types.ts` in the daemon literally identical for the RPC shapes. Fold into a shared package only after two release cycles of stability. |

## What we're NOT deciding today

- Whether `@insrc/backend` becomes an npm package. Cloning-and-building stays the shipping model.
- Whether the CLI ships as a Homebrew formula or a standalone binary. Both are possible on top of the split, neither is required for it.
- Whether the daemon repo should host its own release branches (matching the IDE's `release/1.x`). Recommendation: start with `main`-only and re-evaluate after the first two IDE releases post-split.

## Rollback

If Phase 3 turns up an unrecoverable issue with the split:

- Revert the IDE branch that flipped `repoUrl`. Users' installed daemons revert to pointing at `insrc-ide` on next start; `EnsureDaemonResult.updated` triggers a re-clone from the old URL.
- Leave `insors-ai/insrc` in place — it costs nothing to keep and it's already fresh code.

Nothing in this migration touches persisted data on disk (LMDB / LanceDB / DuckDB layouts under `~/.insrc/`), so a rollback is code-only.
