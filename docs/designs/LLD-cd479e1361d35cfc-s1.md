# LLD: s1

**Epic:** `support-per-repo-config-overrides-embedding`
**HLD base run:** `wf-1783920776460-bd44gr`
**HLD effective hash:** `ff7482e7beb3...`

## HLD context

**Framework:** A layered config resolver in src/insrc/config reads the existing global loader first and overlays a per-repo override file (JSON) at ~/.insrc/repos/<slug>/config.json when present [[c1]]. All 15 config read sites (daemon boot, indexer, embedder, seven Lance stores, and tests) migrate to a repo-aware loader; the CLI reads / writes / deletes dimensions inside the same override file. No LMDB migration and no repo-tree writes; the global config's schema is unchanged and overrides are hand-editable JSON.
**Rollout phase:** Phase A -- foundational resolver + sc1
**Owns:** `sc1` (PerRepoOverrideFile)

## Contract details

**Surface level:** internal-shared

### `loadEffectiveLocalConfig`

```typescript
function loadEffectiveLocalConfig(repoPath: string): LocalProviderInfraConfig
```

**Parameters:**
- `repoPath: string` — The canonical repo path the daemon is serving. Used to derive the per-repo slug via the existing repo registry so the resolver knows which override file to overlay.

**Returns:** `LocalProviderInfraConfig` — The effective local-provider config for this repo: the existing global loader's output with any dimensions in ~/.insrc/repos/<slug>/config.json overlaid on top per-dimension.

**Errors:**
- `UnregisteredRepoError` when The repoPath does not resolve to a registered repo slug via the existing repo registry.
- `InvalidOverrideFileError` when The per-repo override file exists but contains malformed JSON, unknown top-level keys, or values that fail the sc1 type contract (embeddingModel not a string, embeddingDim not a number, etc.).

**Preconditions:**
- The global loader in src/insrc/config/local.ts is unchanged and continues to return the same LocalProviderInfraConfig shape it does today [[c1]].
- The repo registry (`insrc repo add`) has been used to register repoPath, or the repo was registered previously.

**Postconditions:**
- Every key in LocalProviderInfraConfig has a value: either from the per-repo override (when the file provides that dimension) or from the global loader (when it does not).
- The programmatic override entry point (ShaperProviderOverrides) is untouched — it continues to layer on top of whatever this loader returns [[c3]].

### `loadEffectiveAnalyzeConfig`

```typescript
function loadEffectiveAnalyzeConfig(repoPath: string): AnalyzeShaperConfig
```

**Parameters:**
- `repoPath: string` — The canonical repo path the daemon is serving. Same derivation as loadEffectiveLocalConfig.

**Returns:** `AnalyzeShaperConfig` — The effective analyze-shaper config for this repo: the existing global analyze-shaper loader's output with the shaperModel dimension overlaid from ~/.insrc/repos/<slug>/config.json when present.

**Errors:**
- `UnregisteredRepoError` when Same as loadEffectiveLocalConfig — repoPath does not resolve to a registered repo slug.
- `InvalidOverrideFileError` when Same as loadEffectiveLocalConfig — the per-repo file exists but is malformed or contains keys outside the sc1 contract.

**Preconditions:**
- The global analyze-shaper loader in src/insrc/config/analyze.ts is unchanged and continues to return the same AnalyzeShaperConfig shape it does today [[c2]].
- The repo registry has been used to register repoPath.

**Postconditions:**
- Every key in AnalyzeShaperConfig has a value: either from the per-repo override (only shaperModel is overridable per sc1) or from the global loader (all other keys).
- The programmatic override entry point (ShaperProviderOverrides) is untouched [[c3]].

## Data model changes

### `loadLocalProviderConfig` — invariant-change

The public export named `loadLocalProviderConfig` in src/insrc/config/local.ts (function, lines 57-83, current signature `loadLocalProviderConfig(): LocalProviderInfraConfig`) is renamed to a module-private helper (leading underscore, no re-export from src/insrc/config's barrel). No behavior change; only the visibility + name change. The 15 external read sites named in the HLD architectureShape are migrated to call loadEffectiveLocalConfig(repoPath) instead [[c1]].

**Call sites:**
- `src/insrc/config/local.ts`
- `src/insrc/daemon/index.ts`
- `src/insrc/indexer/index.ts`
- `src/insrc/indexer/embedder.ts`
- `src/insrc/db/lance/*`

### `loadAnalyzeShaperConfig` — invariant-change

Parallel treatment to loadLocalProviderConfig: the current public analyze-shaper loader in src/insrc/config/analyze.ts (exact export name to be confirmed at implementation time per s1 backFlowNotes) is renamed to a module-private helper. The read sites for analyze-shaper config migrate to loadEffectiveAnalyzeConfig(repoPath). No behavior change on the global path [[c2]].

**Call sites:**
- `src/insrc/analyze/context/shaper-provider.ts`
- `src/insrc/config/analyze.ts`

## Interaction with shared contracts

| Contract | Role | How |
| :--- | :--- | :--- |
| `sc1` | implements | This Story OWNS sc1. It implements the read side: (1) computes the file path per sc1's path convention `~/.insrc/repos/<slug>/config.json` via the existing repo-registry slug helper; (2) reads the file with fs.readFileSync when it exists; (3) parses JSON and validates against sc1's four-key allowed set (embeddingModel, embeddingDim, coreModel, shaperModel), rejecting unknown keys with InvalidOverrideFileError as sc1 requires; (4) applies per-dimension right-wins over the global loader's output; (5) returns the LocalProviderInfraConfig / AnalyzeShaperConfig with per-dimension values sourced accordingly. Writer Stories s2 and s4 consume this same on-disk contract to add / remove dimensions in the file; s3 consumes it to list what's present. sc1's on-disk shape does not change under this Story — only the read code is added. |

## Error paths

### Error cases

- **Per-repo override file exists but is not valid JSON.** (recoverable)
  - Detection: The resolver's try/catch around JSON.parse of the file body catches SyntaxError; the resolver re-throws as InvalidOverrideFileError with the file path + parser message.
  - Response: Fail fast at the load call. Do NOT silently fall back to global — a malformed override the user thought was active would silently disappear, which is the opposite of the observability nonFunctional target.
  - User impact: The daemon boot for that repo fails with a clear error naming the file path + the JSON parser's line/column so the user can fix or delete the file.
- **Per-repo override file has unknown top-level keys (outside sc1's four allowed dimensions).** (recoverable)
  - Detection: After JSON.parse, the resolver iterates the parsed object's own keys and checks each against a hardcoded set of allowed sc1 keys. Any unknown key trips InvalidOverrideFileError before any dimension is overlaid.
  - Response: Fail fast with an error naming the offending key and enumerating the allowed set. Explicitly do NOT silently ignore unknown keys — typos in a user-edited file must not silently do the wrong thing.
  - User impact: The daemon boot for that repo fails with a message like 'unknown key "embedingModel" in ~/.insrc/repos/<slug>/config.json; allowed: embeddingModel, embeddingDim, coreModel, shaperModel'.
- **Per-repo override file has a value whose type does not match sc1's type contract (e.g. embeddingDim is a string, embeddingModel is a number).** (recoverable)
  - Detection: The resolver checks each present key's runtime typeof against the expected type from sc1 (embeddingModel: string, embeddingDim: number, coreModel: string, shaperModel: string). A mismatch trips InvalidOverrideFileError.
  - Response: Fail fast with a message naming the key and the expected vs. actual type.
  - User impact: The daemon boot for that repo fails with an actionable error the user can fix by re-editing the file.
- **The per-repo embedding dimension in the override file conflicts with what the repo's Lance vector store has already persisted.** (recoverable)
  - Detection: At daemon-repo-attach time, after the resolver returns an effective LocalProviderInfraConfig, the daemon compares the effective embeddingDim to the Lance store's persisted dim (same check the daemon already does today at global boot for ONNX-vs-Ollama). Mismatch is detected by the dim inequality.
  - Response: Emit the same shape of error today's ONNX-vs-Ollama global-path emit uses, prefixed with the specific repo slug and naming the cleanup step (drop `~/.insrc/repos/<slug>/lance/` and re-index that repo). Detection happens at daemon-repo-attach time so users see it up front, not per query (HLD architectureShape 'Failure surface').
  - User impact: The daemon refuses to serve the repo until the user runs the named cleanup; other repos on the same daemon continue serving normally.
- **The override file exists but fs.readFileSync raises EACCES / permission denied.** (recoverable)
  - Detection: try/catch around fs.readFileSync catches the errno; the resolver re-throws as InvalidOverrideFileError with the OS error message included.
  - Response: Fail fast. Do NOT fall back to global — a permission-denied file is user intent that must be surfaced, not silently masked.
  - User impact: The daemon boot for that repo fails with the OS-level permissions error naming the file path.

### Edge cases

| Input | Expected |
| :--- | :--- |
| The override file exists but is empty (zero bytes). | The resolver treats an empty file as InvalidOverrideFileError (JSON.parse of empty string throws SyntaxError). No dimension is overlaid. This is intentional: an empty file is likely user error, not intent to override nothing (that's what a missing file signals). |
| The override file is a JSON object with all four keys set to `null`. | InvalidOverrideFileError. `null` for a dimension is a type mismatch against sc1's four allowed types (string / number). To 'unset' a dimension, the user removes the key or the file, not sets it to null. |
| The override file is present but the JSON parses to something other than an object (array, number, string, boolean, null at the root). | InvalidOverrideFileError with a message like 'expected object, got <actual type>'. |
| The override file exists with only whitespace/newlines. | Same as the empty-file edge — SyntaxError → InvalidOverrideFileError. |
| The override file has exactly one dimension set (e.g. only embeddingModel). | Per-dimension right-wins: embeddingModel comes from the file, embeddingDim + coreModel + shaperModel come from the global loader. This is the intended sc1 semantics. |
| The repoPath resolves to a slug for which ~/.insrc/repos/<slug>/ does not yet exist as a directory. | The resolver treats this identically to 'file does not exist' — empty overlay, global loader wins. No implicit mkdir; the writer Stories (s2/s4) own directory creation as part of the write path. |
| Two concurrent daemon requests hit loadEffectiveLocalConfig with the same repoPath while the writer Story is mid-write to the override file. | sc1's write-then-rename atomic write means the reader either sees the pre-write file or the post-write file, never a partial file. If somehow the file is caught mid-rename, the reader falls back to whichever version the OS surfaced; the next boot's read reflects the final state. |

### Invariants to preserve

- The global ~/.insrc/config.json path continues to be the single source of truth for dimensions that have no per-repo override. Single-repo installs with no ~/.insrc/repos/<slug>/config.json file present continue to work exactly as they do today — zero behavior change on the pass-through path. [[c1]]
- LocalProviderInfraConfig and AnalyzeShaperConfig retain their existing field shapes; the effective loader returns the same interface type as today's global loader. Downstream consumers do not learn a new type. [[c2]]
- The ShaperProviderOverrides programmatic runtime-override entry point at src/insrc/analyze/context/shaper-provider.ts:59-64 continues to layer on top of whatever the effective loader returns. Runtime overrides remain the highest-priority source; per-repo file is a NEW SOURCE below runtime and above global, not a replacement of either. [[c3]]

## Test strategy

**Test framework:** `node:test with tsx (the repo-wide test runner used by every workflow / daemon / config test today)`

### Test levels

- **unit** — Exercise loadEffectiveLocalConfig + loadEffectiveAnalyzeConfig against tmpdir-backed override files: pass-through (no file), full overlay (all four dims), partial overlay (one dim), and every InvalidOverrideFileError case from s5.
  - Subjects: `loadEffectiveLocalConfig`, `loadEffectiveAnalyzeConfig`, `the sc1 key + type validator inside the resolver`
  - Fixtures: `a tmpdir stubbing ~/.insrc/repos/<slug>/config.json for various contents (valid partial, valid full, malformed JSON, unknown key, wrong-typed value, permission-denied, empty)`, `a stub for the existing global loader that returns a fixed LocalProviderInfraConfig / AnalyzeShaperConfig so overlay behavior is deterministic`
- **unit** — Verify the module-private renaming does not leak: importing loadLocalProviderConfig from src/insrc/config's barrel must fail to type-check.
  - Subjects: `src/insrc/config barrel exports`
- **integration** — Boot the daemon against a two-repo fixture where one repo has a per-repo embedding override and the other does not. Verify that the indexer + embedder + Lance stores serving each repo receive the correct effective config (per-repo for repo A, global for repo B).
  - Subjects: `daemon boot with per-repo overrides`, `read-site migration across the 15 named callers`
  - Fixtures: `a two-repo tmpdir install with ~/.insrc/config.json and ~/.insrc/repos/<slugA>/config.json seeded`, `the same test-harness used by the existing daemon integration tests (extended, not new)`
- **integration** — Verify the per-repo dim-mismatch error: seed a repo whose Lance store persisted dim = 1024 and a per-repo override embeddingDim = 768. Boot the daemon serving that repo and assert the exact error message shape + cleanup step.
  - Subjects: `daemon-repo-attach dim-mismatch check`
  - Fixtures: `a Lance store pre-populated with a known dim value`, `a per-repo override file whose embeddingDim conflicts`
- **contract** — sc1 read-side contract test: given every legal PerRepoOverrideFile shape (per-dimension subset), the resolver produces the expected effective config. Given every disallowed shape from s5 error cases, the resolver produces the expected InvalidOverrideFileError with the expected message shape.
  - Subjects: `sc1 read-side contract`, `InvalidOverrideFileError message shapes`

### Acceptance mapping

| Criterion | Proving tests |
| :--- | :--- |
| `ac1` | `unit: loadEffectiveLocalConfig(repoPath) returns exactly the global loader's output when ~/.insrc/repos/<slug>/config.json does not exist`, `integration: daemon serving repo B (no override file) uses global model choices verbatim, byte-for-byte with today's behavior` |
| `ac2` | `unit: loadEffectiveLocalConfig(repoPath) with a per-repo file setting embeddingModel + embeddingDim returns the overridden values`, `integration: daemon serving repo A (override embeddingModel=nomic, embeddingDim=768) uses those values when indexing + querying, not the global values` |
| `ac3` | `integration: per-repo dim-mismatch dim=768 vs persisted Lance dim=1024 boot produces the exact HLD-specified error naming the repo slug + drop-and-reindex cleanup step`, `unit: the dim-mismatch check reads from the effective config, not the global config` |
| `ac4` | `integration: ShaperProviderOverrides used programmatically continues to override whatever loadEffectiveAnalyzeConfig returns — runtime override wins over per-repo, per-repo wins over global`, `unit: the resolver does not import from or touch src/insrc/analyze/context/shaper-provider.ts` |

## Migration

**State before:** src/insrc/config exposes two publicly-imported loaders — `loadLocalProviderConfig()` at src/insrc/config/local.ts:57-83 (per s1 analyze bundle) and its analyze-shaper counterpart in src/insrc/config/analyze.ts (exact name to reconfirm at implementation time). Both take zero arguments and return the global-only config verbatim. The daemon boot, indexer, embedder, seven Lance stores, and two test files (15 read sites total per HLD architectureShape) all call these loaders directly with no repoPath in scope. There is no per-repo overlay: every repo the daemon serves sees the same global model choices [[c1]].

**State after:** src/insrc/config exposes two new publicly-imported loaders — `loadEffectiveLocalConfig(repoPath)` and `loadEffectiveAnalyzeConfig(repoPath)` — which read the existing global loaders first (now module-private, underscore-prefixed) and overlay the per-repo override file at ~/.insrc/repos/<slug>/config.json when present. The old public names are gone from the module's barrel exports. All 15 read sites pass their repoPath through the new loaders. Repos with no override file behave exactly as today; repos with an override file get per-dimension effective values with a per-repo dim-mismatch check firing at daemon-repo-attach time.

**Zero downtime:** yes — **Data rewrite:** no

### Steps

1. Add the new module-private helpers (renamed from the current public loaders, prefixed with underscore) inside src/insrc/config/local.ts and src/insrc/config/analyze.ts. No behavior change; existing tests continue to pass because the public re-exports still point at the same function body via a temporary alias. — ↩ rollbackable
2. Add the new resolver code inside src/insrc/config that reads the global result via the module-private helpers, reads the per-repo override JSON if it exists, validates against sc1's four-key allowed set + type contract, and applies per-dimension right-wins. Expose it as loadEffectiveLocalConfig / loadEffectiveAnalyzeConfig from the src/insrc/config barrel. — ↩ rollbackable
3. Add the per-repo dim-mismatch check to daemon-repo-attach. Reuse the exact error wording of the current ONNX-vs-Ollama global-path dim-mismatch error, prefixed with the specific repo slug and naming the drop-Lance-dir + re-index cleanup step. Do NOT wire this check into any user path yet — leaving it dormant behind a feature flag is out of scope; the check activates the moment repo attach runs it. — ↩ rollbackable
4. Migrate every one of the 15 read sites from `loadLocalProviderConfig()` / `<analyze-loader>()` calls to `loadEffectiveLocalConfig(repoPath)` / `loadEffectiveAnalyzeConfig(repoPath)`. Do this in one PR (not split by call site) so tsc's compile-time signal for missed callers actually fires — splitting the migration hides the risk mitigation. Threads repoPath through the daemon call chain wherever it does not already sit in scope. — ↩ rollbackable
5. Remove the old public re-exports of `loadLocalProviderConfig` and the analyze-shaper loader from src/insrc/config's barrel. This is the terminal step — once removed, any missed read site becomes a hard build error. Without this step the tsc-flags-every-caller mitigation is inert. — ↩ rollbackable
6. Add the escape-hatch entry point for callers with no repo scope (setup wizard, daemon boot before any repo attaches): expose a `loadGlobalLocalProviderConfig()` and `loadGlobalAnalyzeShaperConfig()` pair from the barrel that returns the global-only view. Document explicitly as no-repo-context only. — ↩ rollbackable
7. Add observability logging inside the resolver: on every effective-config load, log which dimensions were sourced from per-repo vs. global for the current repo slug (HLD nonFunctional observability target). — ↩ rollbackable

**Backward compat:** The global ~/.insrc/config.json path continues to be the single source of truth for dimensions with no per-repo override. Single-repo installs with no ~/.insrc/repos/<slug>/config.json file present see zero behavior change (invariant 1 from s5). The public export names change (`loadLocalProviderConfig` → `loadEffectiveLocalConfig` + a new global-only escape hatch), which is a BREAKING CHANGE at the module boundary — external callers must migrate. Internal to the insrc repo, every caller is under s1's scope and migrates in the same PR. No on-disk data migration is required: existing daemons boot against the new loaders with the same global config file, unchanged. The programmatic override entry point (ShaperProviderOverrides) is untouched.

## Alternatives considered

### a1: Fresh-named effective loaders; old names go module-private — **CHOSEN**

Add loadEffectiveLocalConfig(repoPath) and loadEffectiveAnalyzeConfig(repoPath) as the new public entrypoints; rename the current global loaders to underscore-prefixed module-private helpers.

src/insrc/config exposes two NEW public functions: loadEffectiveLocalConfig(repoPath: string): LocalProviderInfraConfig and loadEffectiveAnalyzeConfig(repoPath: string): AnalyzeShaperConfig. The existing loadLocalProviderConfig / analyze counterpart become module-internal helpers with a leading underscore (or move to a private file inside src/insrc/config). Every one of the 15 external read sites migrates to the new name, passing its repoPath. Callers without a repo scope (setup wizard, daemon boot before any repo is known) reach into src/insrc/config for a distinct loadGlobalLocalProviderConfig() escape hatch that is explicitly narrow and documented as no-repo-context only.

Because the old exported name disappears, tsc flags every unmigrated read site at compile time — the HLD riskyBits mitigation kicks in mechanically. The new loaders internally call the module-private globals for the base read + overlay the per-repo file. Return type stays LocalProviderInfraConfig / AnalyzeShaperConfig unchanged so downstream consumers do not have to reshape.

### a2: In-place overload with optional repoPath

Keep the existing loader names; make repoPath an optional trailing parameter that layers the per-repo file when present and passes through to global otherwise.

The current loadLocalProviderConfig / loadAnalyzeShaperConfig signatures grow an optional repoPath parameter: loadLocalProviderConfig(repoPath?: string): LocalProviderInfraConfig. When repoPath is undefined the loader behaves exactly as today (pure global read). When repoPath is provided the loader layers the per-repo override on top. No new public names; the diff at each read site is just adding a repoPath argument.

Callers that today have a repoPath in scope (indexer, embedder, Lance stores) pass it; callers that don't (setup wizard, boot code) pass nothing and get the current global behavior transparently. The runtime programmatic override entry point (ShaperProviderOverrides) continues to sit above the loader untouched.

**Rejected because:** Two partials on ac2 + ac3 (the two most load-bearing ACs, both operationalizing k3). Both partials trace to the same root cause: silent absence of a compile-time signal on unmigrated read sites, exactly the risk the HLD wrote a mitigation against.

### a3: Sources-annotated effective config record

Return a { config, sources } record so every read site can log per-dimension provenance without re-reading the override file.

Shape the return type of the new repo-scoped loaders as loadEffectiveLocalConfig(repoPath: string): { config: LocalProviderInfraConfig, sources: EffectiveConfigSources } where EffectiveConfigSources = { embeddingModel: 'global' | 'per-repo', embeddingDim: 'global' | 'per-repo', coreModel: 'global' | 'per-repo', shaperModel: 'global' | 'per-repo' }. Same for the analyze counterpart with its own key set.

Callers that only care about the values destructure { config } as before. Callers that want observability (the HLD nonFunctional requirement: 'log which dimensions were sourced from global vs. per-repo') read the sources field and log accordingly. The dim-mismatch check at daemon boot uses the sources field to produce a more specific error message ('embeddingDim override for repo X conflicts with the persisted Lance dim').

**Rejected because:** Fully satisfies but ships a broader return-type contract for observability the resolver can log directly without materializing. Non-goal: adds surface area without unlocking capability the Story didn't ask for.

## Citations

- **[[c1]]** `code` `src/insrc/config/local.ts:33-83` — "LocalProviderInfraConfig interface at :33-39 and loadLocalProviderConfig function at :57-83 (signature: loadLocalProviderConfig(): LocalProviderInfraConfig). Located via symbol.locate in s1 analyze bu"
- **[[c2]]** `code` `src/insrc/config/analyze.ts:33-53` — "AnalyzeShaperConfig interface at :33-53. Located via symbol.locate in s1 analyze bundle 2."
- **[[c3]]** `code` `src/insrc/analyze/context/shaper-provider.ts:59-64` — "ShaperProviderOverrides interface — the HLD's [[c3]] programmatic runtime-override entry point pinned as unchanged. Located via symbol.locate in s1 analyze bundle 2."
