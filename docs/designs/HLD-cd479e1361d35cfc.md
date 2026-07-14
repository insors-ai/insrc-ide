# HLD: A layered config resolver in src/insrc/config reads the existing global loader first and overlays a per-repo override file (JSON) at ~/

## Framework summary

A layered config resolver in src/insrc/config reads the existing global loader first and overlays a per-repo override file (JSON) at ~/.insrc/repos/<slug>/config.json when present [[c1]]. All 15 config read sites (daemon boot, indexer, embedder, seven Lance stores, and tests) migrate to a repo-aware loader; the CLI reads / writes / deletes dimensions inside the same override file. No LMDB migration and no repo-tree writes; the global config's schema is unchanged and overrides are hand-editable JSON.

## Architecture shape

**File layout.** The override file lives at ~/.insrc/repos/<slug>/config.json, mirroring the shape of the existing global config surface [[c1]]. A per-repo file may carry any subset of the four covered dimensions (embeddingModel, embeddingDim, coreModel, shaperModel); missing dimensions fall through to the global loader. Slug derivation reuses the existing ~/.insrc/repos/<slug>/ naming already established by the daemon's repo registry.

**Read path.** src/insrc/config gains repo-aware wrappers around the two existing loaders: loadEffectiveLocalConfig(repoPath) and loadEffectiveAnalyzeConfig(repoPath) [[c2]]. Each first invokes the existing global loader, then reads the per-repo override JSON if it exists, then applies per-dimension right-wins to produce a typed effective config. Every current caller of loadLocalProviderConfig / loadAnalyzeShaperConfig migrates to pass a repo path. Call sites without a repo scope (setup wizard, daemon bootstrap before any repo is known) fall through to the global loader as they do today.

**Write path.** The CLI writes into ~/.insrc/repos/<slug>/config.json via atomic-write + rename. Set writes a single dimension into the JSON object; unset removes a single dimension key; if the file ends up with no dimensions after an unset, the file itself is deleted so a missing file cleanly means "no overrides". The CLI runs entirely on the filesystem and does not require the daemon to be up.

**Failure surface.** Dim-mismatch detection stays at daemon boot but becomes per-repo: on every repo the daemon serves, it compares the persisted Lance embedding-dim against the effective embeddingDim from the resolver. Mismatch surfaces the same shape of error today's ONNX-vs-Ollama global path emits, but naming the specific repo slug and the specific cleanup step (drop the per-repo Lance directory and re-index that repo). The programmatic runtime override entry point (ShaperProviderOverrides) [[c3]] continues to layer over the effective config unchanged.

## Shared contracts

### sc1: PerRepoOverrideFile

**Owner Story:** `s1`
**Consumed by:** `s2`, `s3`, `s4`

**Purpose:** The on-disk shape of a per-repo override file and the path convention that locates it, so the writer Stories (s2 / s4) and the daemon reader Story (s1) agree on the format and location.

**Interface sketch (type-level):**

```
// Path convention: ~/.insrc/repos/<slug>/config.json
// where <slug> is derived from the canonical repo path by the existing
// repo registry (same slug the daemon already uses for workflow-runs and
// per-repo state).

interface PerRepoOverrideFile {
    // Any subset of these four dimensions MAY be present. A missing key
    // falls through to the global config's value for that dimension.
    // The file MUST contain no additional keys; unknown keys are a
    // validation error at read time.
    embeddingModel?: string;
    embeddingDim?:   number;
    coreModel?:      string;
    shaperModel?:    string;
}

// Path helper (type-only sketch)
declare function perRepoOverridePath(repoPath: string): string;
```

**Assumptions cited:** [[c1]] [[c2]]

## Story boundaries

### Story `s1`

**Owns:** `sc1`

The resolver code inside src/insrc/config that layers the override file over the global loader, the migration of all 15 existing config read sites (daemon boot, indexer, embedder, seven Lance stores, and the two test files) to pass the repo path through the loader, and the per-repo dim-mismatch check that surfaces at daemon boot. Every read-site call signature change is internal to s1: CLI Stories never touch the runtime loaders.

### Story `s2`

**Depends on:** `sc1`

Argument parsing for the set subcommand, validation that the dimension name is one of the four allowed dimensions and the value type-checks, the error message wording for the not-registered-repo case, and the single-file atomic write. The set command NEVER reads existing overrides beyond loading + rewriting the JSON object.

### Story `s3`

**Depends on:** `sc1`

Pretty-print output for the list subcommand and the exact wording used when no overrides are present (must make explicit that fallback is to global). No interaction with the daemon; pure filesystem read.

### Story `s4`

**Depends on:** `sc1`

The idempotent-unset semantics (no-op success message when the requested dimension was not set) and the file-cleanup semantics (delete the file when the last dimension is unset so a missing file cleanly indicates no overrides). No interaction with the daemon.

## Non-functional targets

- **Performance:** Adds one fs.readFileSync (per-repo JSON, a few KB max) per repo-scoped config read; negligible compared to the existing global load. Zero performance change for calls without a repo scope.
- **Security:** Override file lives inside ~/.insrc/, which is user-owned; no elevated privileges required. Same trust boundary as the existing global config file.
- **Observability:** Every daemon read of the effective config logs which dimensions were sourced from global vs. per-repo, so users can trace where a given model choice was resolved from when debugging.
- **Durability:** Override files are single-JSON atomic writes (write to .tmp, rename); no LMDB migration, no backup coordination. Losing an override file loses only the machine-local override for that repo; the global config is unaffected.

## Rollout

### Phase A -- foundational resolver + sc1

**Stories:** `s1`

s1 owns sc1 (the on-disk override file schema + path). The resolver code, the migration of all 15 config read sites (daemon boot, indexer, embedder, seven Lance stores, two test files), and the per-repo dim-mismatch check land here. Nothing user-visible changes at the CLI yet, but the daemon starts honouring any override file a user places by hand under ~/.insrc/repos/<slug>/config.json.

**Backward compat:** The global loader remains callable in its existing signature for call sites that do not have a repo scope (setup wizard, daemon bootstrap before any repo is known). Every existing single-repo install continues to work: no override file present means the daemon reads exactly what it reads today.

### Phase B -- CLI CRUD for overrides

**Stories:** `s2`, `s3`, `s4`

Once sc1 is in place from Phase A, the three CLI subcommands (set / list / unset) can land together. They all agree on sc1's schema + path convention and none of them depend on each other functionally. Bundling them into one phase avoids partial UX (e.g., users seeing set but not knowing how to inspect or clear).

**Backward compat:** The CLI is purely additive under the existing insrc command tree; existing insrc daemon / repo / setup / workflow subcommands are untouched. No CLI users are broken.

**Ordering rationale:** Story dependencies dictate the order: s2 / s3 / s4 all depend on s1 via sc1 (the file schema). Landing s1 first means the daemon can already honour hand-written overrides, so if Phase B slips, users still have a usable path (edit JSON directly). Landing Phase B second gives users the CLI ergonomics without any prior work being wasted.

### Risky bits

| Area | Why | Mitigation |
| :--- | :--- | :--- |
| Read-site migration (15 sites) | Missing any of the 15 existing callers of loadLocalProviderConfig / loadAnalyzeShaperConfig would silently keep that caller on the global loader and produce inconsistent effective config across the daemon. | Change the loader's parameter signature (add a required repoPath) so tsc flags every unmigrated caller at compile time. Follow up with a text-search verification that no direct call to the old-name loaders remains in the tree. |
| Per-repo dim-mismatch UX | Dim-mismatch detection moves from once-at-daemon-boot to per-repo, which multiplies the surface where the error can fire and risks a scattered / inconsistent error voice. | Reuse the exact wording of today's ONNX-vs-Ollama global-path error, prefixed with the specific repo slug and named cleanup step (drop that repo's Lance dir + re-index). Emit at daemon-repo-attach time, not per query, so users see it up front. |
| Slug alignment between override file and repo registry | If the override file's slug drifts from what the daemon's repo registry uses (because a user re-adds a repo under a different canonical path), the daemon would silently stop honouring the override for the new registration. | Derive the override-file slug exclusively through the existing repo-registry slug helper; document explicitly that overrides key on slug, not on absolute path, and warn on `insrc repo remove` when an override file exists for the slug being removed. |

## Alternatives considered

### a1: Layered config resolver over per-repo files under ~/.insrc/repos/<slug>/ — **CHOSEN**

Overrides live in a per-repo JSON file inside insrc's existing per-repo state directory, resolved by a new loader in src/insrc/config that layers over the global loader.

Add a `loadEffectiveConfig(repoPath)` resolver inside src/insrc/config that reads the existing global ~/.insrc/config.json loader FIRST, then overlays a per-repo override file at ~/.insrc/repos/<slug>/config.json when present. The override file mirrors the global surface's shape (embeddingModel, embeddingDim, coreModel, shaperModel) but carries only the dimensions the user actually pinned; unset dimensions fall through to global. All 15 read sites (daemon boot, indexer, embedder, Lance stores) migrate from `loadLocalProviderConfig()` / `loadAnalyzeShaperConfig()` to `loadEffectiveConfig(repoPath)`.

The daemon already owns ~/.insrc/repos/<slug>/ (repo registry, workflow-runs), so a new config.json in that directory is a natural extension. The resolver is pure: read global JSON, parse per-repo JSON if it exists, merge with per-dimension right-wins, return a typed config object. No new persistent store, no schema migration.

**Pros:**
- Follows the existing on-disk convention: per-repo state already lives under ~/.insrc/repos/<slug>/, so users know exactly where to look.
- Global fallback is trivially preserved (missing file = empty overlay = pass-through).
- Overrides are inspectable and editable as plain JSON without needing the CLI.
- CLI set/list/unset is trivial (mkdir + write JSON / rm dimension key).

**Cons:**
- Overrides are machine-local: not portable across the user's own machines or teammates.
- Renaming a repo path leaves the override file orphaned until the new path is registered (recoverable but surprising).
- Dim-mismatch detection has to happen per repo at boot rather than once at daemon startup as today.

**Cost estimate:** M

### a2: Repo-embedded .insrc/config.json inside the repo tree

Store overrides in a .insrc/config.json file at the target repo root; users decide whether to commit or gitignore.

Store overrides in a `.insrc/config.json` file at the target repo's root. The resolver in src/insrc/config, invoked from the daemon when it serves a repo, reads this file directly from the repo tree instead of from ~/.insrc. The file mirrors the global surface's shape, and merge semantics are the same as a1 (per-dimension right-wins over global). Users choose whether to commit the file (share a team-wide preference like a specific embedding model for a huge codebase) or gitignore it (keep machine-specific choices private).

Because the file lives with the repo, it travels naturally: clone the repo on a new machine, pick up the same override. The CLI writes into the repo tree, gated on a warning when a would-be-committed file would contain a machine-specific value (like an Ollama host or a local-only ONNX config).

**Pros:**
- Portable: overrides follow the repo across machines or teammates when committed.
- Teams can share a repo-wide default by committing the file.
- Discovery is obvious: users find the config in the repo they're working in, no hunting under ~/.insrc.
- No coupling to insrc's ~/.insrc/repos/<slug>/ layout; works for repos not registered via `insrc repo add`.

**Cons:**
- Committing a .insrc/config.json risks coupling version control to machine-specific choices (Ollama host, ONNX vs Ollama, GPU vs CPU).
- Requires the daemon (and CLI) to write into the user's repo tree, which some environments (CI sandboxes, read-only mounts, submodule checkouts) do not allow.
- Introduces a schema-versioning concern for a file that outlives the daemon's version.
- Encourages a false sense of team-shareable model config while the Epic's non-goals explicitly rule out org-level sync.

**Cost estimate:** M

**Rejected because:** All five constraints satisfy but the design leaks into the Epic's non-goal territory (team-level sync via committing the file) and depends on writeable-repo-tree, which is not universally available. Cost same as a1 with more failure modes.

### a3: LMDB-persisted repo overrides via the existing DbClient repo registry

Store per-repo overrides as extra fields on the existing repo registry row in ~/.insrc/graph.lmdb; resolver + CLI both go through the DbClient.

Extend the existing repo registry row (already stored in ~/.insrc/graph.lmdb by `insrc repo add`) with an optional overrides sub-object carrying the four model dimensions. A new `loadEffectiveConfig(repoPath)` resolver in src/insrc/config queries the DbClient for the row and overlays any populated dimensions on top of the global loader's output. The CLI writes via the same DbClient using an existing `repo.update` IPC (or a new `repo.overrides.set / .unset / .list` triple).

Since insrc already treats the repo registry as the contract for what a repo is, adding overrides there keeps every read/write on the same code path as any other repo attribute. LMDB gives atomic writes, and the existing backup/restore story covers overrides for free.

**Pros:**
- No new file surface: uses the existing durability + backup story of graph.lmdb.
- Atomic writes via LMDB transactions rule out half-written or partially-visible overrides.
- The repo registry contract automatically covers override validity; no orphan file risk.
- Reads scale trivially with the number of repos since they go through the daemon's existing DbClient path.

**Cons:**
- LMDB schema changes require migration + versioning; insrc has been bitten by this before and adds real tax to the rollout.
- Users cannot inspect or hand-edit overrides without going through the daemon; loses the debuggability of a plain JSON file on disk.
- Any external tool that wants to introspect overrides has to speak to the daemon over IPC, coupling tooling to the daemon's uptime.
- Overrides can only be set when the daemon is running (writes go through IPC), which blocks initial setup flows where the daemon is offline.

**Cost estimate:** L

**Rejected because:** One partial (k4) plus cost L for LMDB migration. Overrides also become invisible to filesystem tooling, which matters during debugging.

## Citations

- **[[c1]]** `analyze-bundle` `structural-map on /Users/subhagho/work/projects/insors/insrc-ide/src/insrc/config (HLD s1)` — "src/insrc/config is a foundational LEAF module: totalInDegree=15, totalOutDegree=0. Top importers = read sites where per-repo overrides must plug in: src/insrc/indexer/index.ts (3 edges), src/insrc/da"
- **[[c2]]** `code` `/Users/subhagho/work/projects/insors/insrc-ide/src/insrc/config/local.ts:LocalProviderInfraConfig` — "LocalProviderInfraConfig entity exposes host, embeddingModel, embeddingDim, coreModel (from approved Define artifact citations)."
- **[[c3]]** `code` `/Users/subhagho/work/projects/insors/insrc-ide/src/insrc/analyze/context/shaper-provider.ts:ShaperProviderOverrides` — "ShaperProviderOverrides entity: programmatic (in-code) override mechanism used by analyze callers to substitute a shaper provider at runtime (from approved Define artifact citations)."
