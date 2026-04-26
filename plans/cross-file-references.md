# Cross-file references in the indexer

## Mission

Resolve unresolved relations (`INHERITS`, `IMPLEMENTS`, cross-file
`CALLS`, module-stub `IMPORTS`-to-file links, Python relative
imports) across the full Kuzu graph after the per-file index pass
completes. Today the indexer's [`resolver.ts`](../src/insrc/indexer/resolver.ts)
runs **per file** with that file's own entities only -- everything
that requires looking at another file's entity ID stays
`resolved: false` with a raw string in the `to` field, and
[`db/relations.ts`](../src/insrc/db/relations.ts) `upsertRelation`
(line 28) **drops every `resolved: false` edge on the floor**.
Kuzu's REL tables are typed `FROM Entity TO Entity` with no extra
columns, so unresolved edges can't even live in the REL tables in
their current shape. This plan introduces a **second-pass cross-
file resolver** plus the **persistence layer** it needs to walk
unresolved relations and link them to actual entity IDs.

The single load-bearing invariant is **referenced files must be
indexed first**. The second pass cannot resolve edge `A -> Foo`
unless the file defining `Foo` has already been parsed and its
entity is in the graph. The plan is designed around that
constraint:

- For initial bulk index: the second pass runs **after the queue
  drains** (every file in the repo has been parsed once).
- For incremental updates (file watcher): the second pass runs
  after a **settle period** with no further file changes -- so
  newly-arrived files have a chance to land before resolution
  retries.
- The pass is **idempotent + re-runnable**. An edge that didn't
  resolve in pass N gets retried in pass N+1; the only state
  that changes is the edge's `resolved` flag + `to` field.
- Edge invalidation on file change: when a file is re-indexed or
  deleted, edges that linked to its entities are flipped back to
  unresolved + queued for the next settle pass.

## Related plans

- [`jvm-languages.md`](jvm-languages.md) §3.4 explicitly
  deferred Java + Scala import-to-file resolution to a "future
  cross-file pass." This plan is that pass. JVM source-root
  detection lives here too -- needed to map
  `import com.example.Foo` to `src/main/java/com/example/Foo.java`.
- [`data-driver.md`](data-driver.md) -- the analyzer's transitive
  closure search depends on resolved IMPORTS / DEPENDS_ON edges;
  cross-file linking improves the closure precision.
- [`artifact-tasks.md`](artifact-tasks.md) §4.1 React introspection
  recurses into in-tree imported components -- the recursive
  descent currently uses ad-hoc filesystem probing because the
  graph doesn't carry resolved edges. Once this plan lands,
  introspection can follow the graph instead.

## Status

| Phase | Scope                                                                                  | Status |
|-------|----------------------------------------------------------------------------------------|--------|
| 0     | Foundations: persistence schema for unresolved relations, settle hook, idempotency     | partial -- 62bea4defb7 (settle hook deferred to Phase 3) |
| 1     | Quick win -- fix Python relative-import path resolution                                | done -- 8a45171cc82 |
| 2     | Source-root detection (Java / Scala / Python / Go / TS path-mappings)                  | done -- uncommitted |
| 3     | Cross-file pass: module-stub-to-file linking + INHERITS / IMPLEMENTS                   | todo   |
| 4     | Cross-file CALLS resolution (using imported scope)                                     | todo   |
| 5     | Incremental mode: watcher settle window + invalidation on edit/delete                  | todo   |
| 6     | Performance + idempotency validation, integration tests                                | todo   |

**Legend** for per-task status cells: `todo`, `in-progress`, `done`
(with commit sha or `uncommitted`), `partial` with deferred scope
called out (see
[`feedback_plan_status`](../../../.claude/projects/-home-subho-work-dev-insors-insrc-ide/memory/feedback_plan_status.md)).

---

## Goals

1. **Resolve `INHERITS` / `IMPLEMENTS` to entity IDs.** "Find every
   subclass of `BaseService`" should follow graph edges, not match
   raw strings. Today it doesn't work because the edges' `to` fields
   carry strings like `'BaseService'` and the actual class entity
   has its hex-32 ID.
2. **Link `IMPORTS` module stubs to in-tree file entities.** When
   `import com.example.Foo` corresponds to `src/main/java/com/example/Foo.java`,
   the IMPORTS edge should point at the file entity, not at a
   floating module-stub. Module stubs stay in the graph for
   external deps where no in-tree file exists.
3. **Resolve cross-file `CALLS`.** A `foo()` call where `foo` is
   imported from another file should link to the actual function
   entity, not stay as a raw string match.
4. **Fix the Python relative-import latent bug.** `from .foo import
   bar` is correctly tagged `meta.isRelative: true` by
   `python.ts`, but the resolver only knows TS extensions. Adding
   `.py` to the candidate map closes a clear correctness gap.
5. **Per-language correctness across all six supported languages**
   (TS, JS, Python, Go, Java, Scala). Each language's import shape
   maps to its own resolution strategy (TS: relative + path-mapped;
   Python: relative `.py` probing; Go: full module-path matching;
   Java + Scala: source-root + package-path probing).
6. **Idempotent + incremental.** Running the cross-file pass twice
   over the same graph state changes nothing. File-watcher
   incremental indexing re-resolves edges affected by the changed
   file without re-running everything.

## Non-goals

- **Type inference.** The pass uses entity *names* + *packages* to
  match. It doesn't type-check anything. A call `foo()` where two
  files in scope export different `foo` functions stays ambiguous
  (resolution policy: leave unresolved with `meta.candidates`
  listing the IDs).
- **External-dep indexing.** A `lodash.merge` call doesn't need to
  resolve to any actual lodash file; the IMPORTS edge to the
  `lodash` module stub is enough for analyzer questions like "show
  me code that uses lodash."
- **Per-file `CALLS` resolution.** That stays in the per-file
  resolver -- this pass only handles what crosses files.
- **Graph rewriting.** No retroactive entity moves / merges. Edges
  flip from unresolved to resolved (or vice-versa on
  invalidation); entities never change identity.

---

## Module layout

```
src/insrc/indexer/
  resolver.ts                  # existing -- per-file resolver. Phase 1
                               # extends per-language candidate map.
  cross-file-resolver.ts       # NEW -- the second-pass walker
  source-roots.ts              # NEW -- per-language source-root detection
  index.ts                     # add settle timer + cross-file pass invocation
                               # in `IndexerService.fullIndex()` and
                               # `IndexerService.fileEvent()`; call
                               # `deleteUnresolvedForFile` alongside
                               # `deleteEntitiesForFile` on per-file re-index
  watcher.ts                   # untouched -- the settle timer lives in
                               # IndexerService, layered above the watcher's
                               # existing 200 ms event-debounce
  __tests__/
    cross-file-resolver.test.ts # unit tests against synthetic graph state
    source-roots.test.ts
    cross-file-incremental.test.ts # invalidation + retry behaviour
```

Database touches:
- **New `UnresolvedRelation` node table** in [`db/schema.ts`](../src/insrc/db/schema.ts)
  -- the persistence backing for `resolved: false` edges. See
  Phase 0.2 for the schema.
- New helpers in [`db/relations.ts`](../src/insrc/db/relations.ts):
  - `upsertRelations(db, batch)` extended -- when an edge is
    `resolved: false`, write to `UnresolvedRelation` instead of
    silently dropping it (today's behaviour at line 28).
  - `listUnresolvedRelations(db, repoPath, scopeFile?)` -- load
    rows from `UnresolvedRelation` filtered by repo (and optionally
    by `fromFile` for scoped re-passes).
  - `deleteUnresolvedForFile(db, file)` -- drop unresolved rows
    whose `fromFile` matches; called on per-file re-index alongside
    `deleteEntitiesForFile`.
  - `promoteToResolved(db, unresolved, targetEntityId)` -- on
    successful resolution, insert into the typed REL table + delete
    the matching `UnresolvedRelation` row.

---

## Phase 0 -- Foundations

### 0.1 `UnresolvedRelation` persistence schema

New Kuzu node table -- the backing store for every relation that
the per-file resolver couldn't resolve:

```
CREATE NODE TABLE IF NOT EXISTS UnresolvedRelation(
  id          STRING,        -- SHA256(repo + fromEntity + kind + rawTo)
  repo        STRING,        -- absolute repo root path
  fromEntity  STRING,        -- entity id of the source side
  fromFile    STRING,        -- absolute file path that produced the edge
                             --   (used for invalidation on file change)
  kind        STRING,        -- 'IMPORTS' | 'CALLS' | 'INHERITS' | 'IMPLEMENTS'
  rawTo       STRING,        -- raw string: import specifier, callee name, ...
  meta        STRING,        -- JSON-encoded; isRelative, candidates, etc.
  attemptedAt STRING,        -- ISO timestamp of last resolution attempt
  PRIMARY KEY(id)
)
```

The deterministic `id` makes the table idempotent: re-parsing a
file produces the same unresolved-row IDs, so re-upsert is a no-op.

Why a node table and not extra columns on the typed REL tables:
- Kuzu's REL tables are `FROM Entity TO Entity` only -- adding
  free-form properties means a schema migration that breaks
  existing graphs. The node-table approach is additive.
- Resolved edges in `INHERITS` / `IMPLEMENTS` / etc. stay pure --
  no `resolved` flag to filter on every traversal.
- When an entity is deleted, Kuzu's `DETACH DELETE` cleans up its
  resolved REL edges automatically. Unresolved rows in the node
  table need explicit cleanup (see Phase 5.2).

### 0.2 `upsertRelations` extension

Currently [`db/relations.ts:28`](../src/insrc/db/relations.ts#L28)
silently drops `resolved: false` edges:

```ts
if (!relation.resolved) return;   // today: data loss
```

Replace with: route resolved edges to the typed REL table (today's
behaviour) and unresolved edges to `UnresolvedRelation`. Both
writes are idempotent MERGE/UPSERT.

### 0.3 Settle hook on the indexer

[`IndexerService`](../src/insrc/indexer/index.ts) (the actual
class name -- not `Indexer`) gains a settle pipeline:

- **Bulk path** (`processJob()` with a `'full-index'` job): after
  the per-file loop in `fullIndex()` completes, call
  `runCrossFileResolver({ db, repoRoot })` exactly once before
  returning.
- **Incremental path** (file-watcher driven): each
  `fileEvent()` call re-indexes the changed file, then schedules a
  settle timer on top of the watcher's existing 200 ms event
  debounce. After ~2 s with no further file events, run
  `runCrossFileResolver({ db, repoRoot, scopeFile })` over the
  unresolved subset for that file.
- **Manual / RPC path**: a new `db.reindexCrossFile` RPC for tests
  + tooling. Useful when a graph migration changes the relation
  schema or when source-roots cache invalidates.

### 0.4 Idempotency contract

The pass walks `UnresolvedRelation` rows and per row either:
- **Resolves** -- insert into the typed REL table, delete the
  unresolved row.
- **Stays unresolved** -- update only `attemptedAt`; the next pass
  retries.
- **Marks ambiguous** -- update `meta` with `candidates: [<id>, ...]`
  but leave the unresolved row in place. The next pass re-checks;
  if disambiguation becomes possible (e.g. one candidate's file
  was deleted), the edge resolves on the following pass.

Re-running the pass on identical graph state is a no-op:
- The typed REL tables aren't touched (their edges are already
  there).
- Ambiguous rows with the same candidate set produce identical
  `meta` JSON, so the MERGE-update is a write-with-no-change.
- `attemptedAt` is the only field that ticks -- intentionally not
  part of the idempotency snapshot in Phase 6.2.

### 0.5 Per-language candidate map

[`resolver.ts`](../src/insrc/indexer/resolver.ts)'s
`TS_EXTENSION_MAP` is extended into a per-language structure:

```ts
const EXTENSION_MAP: Readonly<Record<Language, ExtensionCandidates>> = {
  typescript: { js: ['.ts', '.tsx', '.js', '.jsx'], ... },
  javascript: { ... },
  python:     { py: ['.py'], '': ['/__init__.py'] },
  go:         { go: ['.go'] },
  java:       { java: ['.java'] },
  scala:      { scala: ['.scala'], sc: ['.sc'] },
  // markup / config languages share the no-resolution default
  ...
};
```

Phase 1 lands this map (small, fixes a known bug) before the
heavier cross-file work in phases 3-4.

### 0.6 Blocks

- Phase 1 -- depends on the per-language candidate map (0.5).
- Phases 3, 4, 5 -- depend on the persistence schema (0.1, 0.2)
  and the settle hook (0.3). Without persistence, the second pass
  has nothing to walk.

---

## Phase 1 -- Quick win: fix Python relative imports

The shortest path to user-visible value. No cross-file pass needed
for this one -- the per-file resolver already handles relative
imports; it just doesn't know `.py` extensions.

### 1.1 Extension map split per language

`resolver.ts` `buildCandidates` looks up the candidate list keyed
by `(language, fromFile-extension)` instead of just the file
extension. Other than the lookup change, the function signature
stays identical.

### 1.2 Python candidate set

```ts
python: {
  '':   ['.py', '/__init__.py'],
  '.py': ['.py'],
}
```

`from .foo import bar` resolves the dotted-relative path stem
against `<dir>/foo.py` first, then `<dir>/foo/__init__.py`.

`from . import x` resolves against `<dir>/__init__.py` (whole-
package import).

### 1.3 Tests

`indexer/__tests__/resolver-python.test.ts`:
- `from .foo import bar` -> file-id of `<dir>/foo.py`
- `from .foo` (no name) -> file-id of `<dir>/foo.py` or
  `<dir>/foo/__init__.py`
- `from .. import x` -> file-id of `<parent-dir>/__init__.py`
- Missing target -> stays unresolved (edge unchanged)

### 1.4 Blocks

- Phase 3 -- the cross-file pass uses the same per-language map
  for module-stub-to-file resolution.

---

## Phase 2 -- Source-root detection

Java + Scala (and to a lesser extent Python + Go) need to know
where source files live to resolve `package`-style imports to
files. Maven / Gradle / SBT manifests carry this; the manifest
parsers from
[`jvm-languages.md`](jvm-languages.md) §3 already capture the
dependency lists, but not the source-root paths.

### 2.1 `source-roots.ts` API

```ts
export interface SourceRoots {
  readonly java:   readonly string[];   // absolute paths
  readonly scala:  readonly string[];
  readonly python: readonly string[];
  readonly go:     readonly string[];
  readonly typescript: readonly string[];
  readonly javascript: readonly string[];
}

export function detectSourceRoots(repoRoot: string): SourceRoots;
```

Per-language detection rules:

- **Java**: parse pom.xml's `<sourceDirectory>` (defaults to
  `src/main/java`); walk `<modules>` recursively for multi-module
  projects. Gradle: read `sourceSets.main.java.srcDirs` from the
  `dependencies { ... }` block (best-effort regex; default
  `src/main/java`). Without a manifest: probe `src/main/java`.
- **Scala**: same shape as Java for SBT (`src/main/scala`,
  `src/main/scala-2.13`, `src/main/scala-3` cross-build dirs).
  Mill: same convention. Without a manifest: probe `src/main/scala`.
- **Python**: probe for `__init__.py` directories starting from
  the repo root + `src/`. The deepest `__init__.py`-bearing
  directory is the package root; its parent is the source root.
  Convention fallback: repo root.
- **Go**: read `go.mod`'s `module` directive (e.g.
  `module github.com/foo/bar`); the source root is the repo root,
  and the import-path prefix is the module declaration.
- **TypeScript / JavaScript**: read `tsconfig.json`'s
  `compilerOptions.baseUrl` and `paths` map. Without a tsconfig:
  source root is the repo root.

### 2.2 Caching

Source roots are stable for a repo unless its manifest changes.
Cache them on the `Indexer` instance; invalidate when
`parseManifest()` returns different output. Reload on manifest-
file change events from the watcher.

### 2.3 Tests

`indexer/__tests__/source-roots.test.ts` -- per-language fixtures:
- Maven multi-module project -> roots include each child module
  prefix
- Gradle Kotlin DSL with custom sourceSets
- SBT with cross-build (`scala-2.13` / `scala-3`)
- Python flat package + nested package
- Go with non-trivial module path
- TS with `"baseUrl": "./src"` + `"paths": { "@/*": ["./*"] }`
- No-manifest fallback for each language

### 2.4 Blocks

- Phase 3 -- IMPORTS-to-file linking needs to know where files
  live by package.

---

## Phase 3 -- Cross-file pass: module stubs + INHERITS / IMPLEMENTS

The big one. Introduces `cross-file-resolver.ts` and the actual
second pass over the graph.

### 3.1 Pass entry point

```ts
export interface CrossFileResolveOpts {
  readonly db: DbClient;
  readonly repoRoot: string;
  readonly sourceRoots: SourceRoots;
  /** Limit the pass to relations whose `from` is in this file. Used
   *  for incremental updates after a single-file index. Omit for a
   *  bulk pass over the whole repo. */
  readonly scopeFile?: string | undefined;
}

export interface CrossFileResolveResult {
  readonly resolved: number;
  readonly ambiguous: number;
  readonly stillUnresolved: number;
  readonly elapsedMs: number;
}

export async function runCrossFileResolver(
  opts: CrossFileResolveOpts,
): Promise<CrossFileResolveResult>;
```

### 3.2 Pipeline

1. **Load unresolved rows** from `UnresolvedRelation` via
   `listUnresolvedRelations(db, repoRoot, scopeFile?)`. Paged in
   batches of 1000 to bound memory on huge repos.
2. **Build name -> entity index** for the repo, keyed by
   `(language, kind, name)`. Populated from a single Kuzu query
   over the `Entity` node table at pass start; cached for the
   duration of the pass.
3. **For each unresolved row**, run a per-kind resolution
   strategy (3.3 - 3.5).
4. **Batch-promote** every 500 resolutions: insert into the typed
   REL table + delete the corresponding `UnresolvedRelation` rows
   in a single transaction (`promoteToResolved`).

### 3.3 IMPORTS module stubs -> file entities

The Java parser emits IMPORTS edges to module-stub entities like
`com.example.Foo`. The resolver tries to find a file entity in the
repo whose `(language, package, name)` matches. Resolution rule:

- **Java / Scala**: split the module name into package + type
  (`com.example.Foo` -> package `com.example`, type `Foo`). For
  each source root in `sourceRoots[language]`, probe
  `<root>/<package-as-path>/<TypeName>.java` (or `.scala`). If the
  file exists in the repo + has a corresponding `file`-kind entity
  in the graph, replace the IMPORTS edge target with the file
  entity ID.
- **Python**: dotted absolute paths (`foo.bar.baz`) probe
  `<root>/foo/bar/baz.py` and `<root>/foo/bar/baz/__init__.py`.
- **Go**: prefix-strip the import path against `go.mod`'s module
  declaration (`github.com/repo/foo` minus `github.com/repo` =
  `foo`); probe `<repo>/foo/`.
- **TS / JS path-mapped**: read `tsconfig.json` `paths`; rewrite
  the import specifier; probe with the existing
  `buildCandidates`.

When a stub points to an external dep (no in-tree file exists),
the IMPORTS edge stays as-is. The module-stub entity remains in
the graph for analyzer questions like "what depends on
`org.springframework.boot:spring-boot-starter-web`?".

### 3.4 INHERITS resolution

Edge: `class FooImpl INHERITS Foo` (raw string).

Resolution:
1. Look up entities matching `(language: <from-lang>, kind: 'class' | 'interface', name: 'Foo')`.
2. Filter by **import scope**: an entity is in scope if either
   - it lives in the same file as the from-entity, OR
   - the from-entity's file imports the package containing it.
3. **Single match** -> resolve. **Multiple matches** -> mark
   ambiguous with `meta.candidates`. **No match** -> stay
   unresolved (target may not be indexed yet).

The import-scope filter is what makes this work in a multi-package
codebase: two unrelated `Logger` classes in different packages
don't conflict because each from-class only imports one of them.

### 3.5 IMPLEMENTS resolution

Same shape as INHERITS but the from-edge's relation kind is
IMPLEMENTS and the target kind filter is `interface` (or `class`
for Scala traits, which use the `interface` kind).

### 3.6 Tests

`indexer/__tests__/cross-file-resolver.test.ts`:
- Two-file Java project: `Foo.java` defines `Foo`, `Bar.java`
  imports + extends. After cross-file pass, INHERITS edge points
  at the `Foo` class entity.
- Multi-package Scala project with two `Logger` classes in
  different packages; INHERITS edges resolve to the correct one
  based on import-scope filter.
- IMPORTS module stub for `com.example.Foo` resolves to the file
  entity when `com/example/Foo.java` exists; stays unresolved when
  it doesn't.
- Python `from .foo import bar` IMPORTS resolves to `foo.py` (uses
  Phase 1 + Phase 2 source-root detection).
- TS `import { X } from '@/lib/x'` (path-mapped) resolves via
  tsconfig.

### 3.7 Blocks

- Phase 4 -- cross-file CALLS uses the resolved IMPORTS edges to
  determine "what's in scope" for a callee lookup.

---

## Phase 4 -- Cross-file CALLS resolution

The hardest pass conceptually. A `foo()` call's target depends on
*which `foo`* is in scope, which depends on the file's resolved
IMPORTS.

### 4.1 Scope reconstruction

For each unresolved CALLS edge `<from> -> 'foo'`:
1. Find the from-entity's file.
2. Walk the file's resolved IMPORTS edges. For each:
   - **File-target IMPORTS** (Phase 3 resolved): the file's
     exported entities are in scope.
   - **Module-stub IMPORTS** (external dep): no in-graph entity
     to match against; skip.
3. Build the **scope set**: file-local entities + entities
   exported from imported files.

### 4.2 Match logic

- **Single match** in scope -> resolve.
- **Multiple matches** -> ambiguous + record candidates. The
  parser already records receiver text for invocations like
  `obj.method()`; future iterations can use that to narrow.
- **No match** -> stay unresolved.

### 4.3 isExported gating

Only entities marked `isExported: true` count as available from
imported files. Per-language definitions of "exported" already
live in the parser modules (Java's `public` modifier; Python's
`__all__` or top-level visibility; TS's `export` keyword; etc.).

### 4.4 Tests

- Two-file Python project: `helpers.py` defines `validate`,
  `main.py` imports + calls. After cross-file pass, CALLS
  resolves to `helpers.validate`.
- Same-named function in two unrelated files; CALLS edges resolve
  to the correct one based on import scope.
- Function not exported -> not in scope; CALLS stays unresolved
  even when an unexported same-named function exists.
- Method call via receiver (`user.validate()`) -> records the
  receiver in `meta` even when the call stays unresolved (analyzer
  hint).

### 4.5 Blocks

- None. Phase 4 closes the cross-file resolution surface.

---

## Phase 5 -- Incremental mode

Bulk passes are easy. Incremental is where the "referenced files
must be indexed first" invariant gets stress-tested.

### 5.1 Settle window on top of the existing watcher debounce

[`Watcher`](../src/insrc/indexer/watcher.ts) already coalesces
events with a 200 ms debounce
([watcher.ts:13](../src/insrc/indexer/watcher.ts#L13)) before
calling its handlers. The settle window sits **after** that:

- The indexer's `fileEvent()` handler enqueues a per-file index
  job (today's behaviour).
- After the index job completes for a file, kick / reset a 2 s
  settle timer on the `IndexerService`.
- When the settle timer fires (no new file events for 2 s), call
  `runCrossFileResolver({ db, repoRoot, scopeFile })` for each
  file touched in the settle window.
- The settle pass scopes to **unresolved rows whose `fromFile`
  matches one of the touched files**, plus any rows whose target
  may have shifted (covered by sub-case 2 in 5.2 if `ResolvedTrace`
  lands).

### 5.2 Edge invalidation on file change

When a file changes (or is deleted), two cleanup paths run:

1. **Resolved edges to entities in that file** -- handled
   automatically by Kuzu. `deleteEntitiesForFile` issues a
   `DETACH DELETE` on every Entity stub in the file; Kuzu
   cascades the delete to all REL edges (`INHERITS`,
   `IMPLEMENTS`, `CALLS`, `IMPORTS`, ...) pointing at those
   entities. No application code needed for this side -- it's
   already correct in [`db/entities.ts`](../src/insrc/db/entities.ts).

2. **The unresolved twins of those edges** must be re-created so
   the next settle pass sees them again. Two sub-cases:
   - The changed file is the **source side** of the edge:
     `deleteUnresolvedForFile(db, file)` drops every
     `UnresolvedRelation` row whose `fromFile` matches. The next
     `indexFile` for that file re-emits unresolved rows from the
     fresh parse.
   - The changed file is the **target side** of a previously-
     resolved edge: the source file's parse-result still names
     the target as a raw string, but its `UnresolvedRelation`
     row was deleted by `promoteToResolved`. Recovery: when
     `promoteToResolved` fires, **also write the source-side
     edge into a `ResolvedTrace` record** (denormalized:
     `(fromEntity, kind, rawTo, fromFile)`), which the next
     settle pass uses to re-derive unresolved edges for the
     source file when its target's file changes.

   Sub-case 2 is the cost of using a node table for unresolved
   storage. Alternative: tolerate eventual consistency -- when the
   source file is next edited (or on a periodic full re-pass), its
   unresolved edges get rebuilt from the parser. Document the
   trade-off; defer `ResolvedTrace` to a follow-up unless tests
   show the eventual-consistency window matters in practice.

3. The next settle pass picks up the unresolved rows and retries
   resolution.

### 5.3 First-time-index ordering

When file A is added and references entity in file B, but B
hasn't been indexed yet:

- A's per-file resolver leaves the edge unresolved.
- A's parse triggers a settle timer.
- B's parse triggers another settle timer.
- After 2 s with no changes, the cross-file pass runs over both
  files. A's edge resolves to B's entity now that B is in the
  graph.

This is the core "referenced files must be indexed first"
invariant in action: the settle delay gives both files time to
land before the cross-file pass runs.

### 5.4 Bulk-mode override

For initial repo crawl (`fullIndex` in
[`IndexerService`](../src/insrc/indexer/index.ts#L254)), skip the
per-file settle timers; run the cross-file pass exactly once after
the per-file loop completes. Faster than the watcher path's
per-file debouncing.

### 5.5 Tests

`indexer/__tests__/cross-file-incremental.test.ts`:
- Synthetic two-file repo. Index A first; assert A's edges
  unresolved (target B doesn't exist yet). Index B; assert
  watcher debounce; after settle, assert A's edges resolved.
- File-deletion invalidation: index A + B with cross-edges;
  delete B; the typed REL edges from A vanish via Kuzu's
  `DETACH DELETE`. Whether A's `UnresolvedRelation` rows
  reappear depends on the 5.2 sub-case 2 decision -- if
  `ResolvedTrace` is implemented, assert the rows are recreated
  + retry leaves them unresolved (target gone). If
  eventual-consistency is chosen, assert the rows appear after A
  is re-indexed.
- Re-creation: re-add B with same content; assert edges resolve
  again on the next settle.
- Concurrent changes during the settle window: A changes, B
  changes, then 2 s pass. One cross-file pass runs, both files'
  edges resolve.

### 5.6 Blocks

- Phase 6 -- performance + idempotency validation needs the
  incremental path working.

---

## Phase 6 -- Performance + idempotency validation

### 6.1 Big-O budget

The pass walks unresolved edges; for each, it runs O(1)
lookups against pre-built indexes (name -> entity, path ->
file-entity). Total: O(unresolved edges + log entities) per pass.

Budget for a 100 KLoC repo (~50k entities, ~10k unresolved cross-
edges initially):
- First bulk pass: < 5 s wall-clock.
- Re-pass after a single-file change: < 100 ms.

### 6.2 Idempotency test

Run the indexer twice in a row on a synthetic repo:
1. First run: bulk index + cross-file pass.
2. Snapshot the entity + relation tables.
3. Second run: bulk index + cross-file pass.
4. Snapshot again.
5. Assert the two snapshots are byte-identical (modulo
   `indexedAt` timestamps, `attemptedAt` on `UnresolvedRelation`,
   and `elapsedMs` log fields).

### 6.3 Memory ceiling

The name-to-entity index in memory caps at the entity count.
For a 1M-entity repo (very large), at ~100 bytes per index entry,
that's ~100 MB. Acceptable on dev machines; consider chunked
processing if it ever exceeds 500 MB.

### 6.4 Tests

`indexer/__tests__/cross-file-perf.test.ts` -- gated by an env
flag (`INSRC_PERF_TESTS=1`):
- Synthetic 10k-entity repo
- Full bulk index + cross-file pass; assert < 5 s
- Re-pass on no-changes; assert near-zero elapsed time
- Re-pass after single-file change; assert < 100 ms

---

## Testing strategy

### Per-phase

Each phase ships its own unit-test file under
`src/insrc/indexer/__tests__/`. Uses Node's stdlib `node:test` +
`node:assert`; no test-framework dep.

### Synthetic repos

`test/fixtures/cross-file/` carries small per-language projects:
- `java-multi-module/` -- Maven parent + 2 child modules; two
  packages with same-named class; cross-package import + INHERITS
- `scala-cross-build/` -- SBT with `scala-2.13` + `scala-3`
  source dirs
- `python-package/` -- `__init__.py` directories + relative
  imports + cross-package call
- `go-monorepo/` -- single go.mod with multiple packages
- `ts-path-mapped/` -- tsconfig with `baseUrl` + `paths`

### End-to-end smoke

`scripts/test-cross-file-smoke.ts` -- bulk-indexes each fixture,
runs the cross-file pass, asserts the expected resolved-edge
count + that specific edges point at the expected entity IDs.
Gated by `INSRC_E2E_TESTS=1` per the project rule on running
tests by default.

### Integration with file-watcher

`indexer/__tests__/cross-file-incremental.test.ts` exercises the
watcher + settle pipeline against an in-memory queue + DB stub;
no real `@parcel/watcher` involvement.

---

## Open risks

1. **Resolution latency on huge repos.** A monorepo with 1M+
   entities + 100k cross-edges could push the bulk pass over the
   5 s budget. Mitigation: paginate the unresolved-edge query;
   stream the name index lazily; consider a Kuzu Cypher join
   instead of in-memory lookup if perf doesn't hit budget.

2. **Cyclic imports.** A imports B, B imports A. The per-file
   parser handles this fine (each file emits its IMPORTS
   independently). The cross-file pass resolves each edge
   independently -- no recursion, no infinite loop. But the order
   of resolution matters for ambiguity scoring: if A -> Foo
   resolves before B -> Foo, the B match may use stale ambiguity
   data. Acceptable since both edges resolve correctly in the
   end; document the non-deterministic ambiguity case.

3. **Ambiguous resolutions.** Two unrelated `Logger` classes
   in different packages where the from-entity's file doesn't
   import either. The pass marks ambiguous + records candidates,
   but downstream surfaces (analyzer queries, the `flow:code`
   artifact) need to handle the ambiguous-edge case explicitly.
   Documenting that `meta.candidates` is the disambiguation
   surface is part of this plan; using it sensibly is the
   downstream consumer's concern.

4. **Race conditions during settle.** A file change lands
   *during* the cross-file pass. The pass operates on a snapshot
   loaded at start; the late change won't be seen, but the next
   settle picks it up. Need to ensure the pass's writes don't
   conflict with concurrent per-file writes (locking around the
   relations table or per-edge optimistic CAS).

5. **Stale unresolved-row accumulation.** Rows in
   `UnresolvedRelation` whose `fromEntity` was deleted but the
   cleanup missed them (e.g. a crash between
   `deleteEntitiesForFile` and `deleteUnresolvedForFile`). The
   bulk re-resolve would catch + delete them, but only when run
   manually. Mitigation: on each settle pass, prune rows whose
   `fromEntity` no longer exists in the `Entity` node table.
   Cheap to layer in; could land in Phase 6.

6. **Manifest changes invalidating source roots.** When pom.xml
   gains a `<sourceDirectory>` override, all Java cross-edges
   need re-resolution. Trigger: watcher event on `pom.xml` /
   `build.gradle` / `build.sbt` / `build.sc` -> manifest re-parse
   -> source-roots cache invalidation -> full repo re-pass.

7. **First-index correctness at repo boot.** The initial bulk
   pass runs after the queue drains. But what if the queue grows
   *during* the pass (a watcher event arrives mid-pass)? The
   pass operates on a snapshot; the new file's edges land in the
   next settle. Acceptable -- two passes max, no correctness
   loss.

---

## Deferred / follow-ups

1. **Type inference for ambiguous CALLS.** If the receiver of
   `obj.method()` carries a type annotation in the source, the
   parser could record it in `meta` and the resolver could narrow
   to that type's methods. Significant scope; future plan.

2. **Cross-language references.** TypeScript code that calls a
   Python helper via subprocess, or Java code that calls Scala
   via JVM interop. Out of scope -- each language's edges
   resolve to entities of the same language only in v1.

3. **External-dep symbol resolution.** Indexing `node_modules` /
   `~/.gradle/caches/...` so calls to `lodash.merge` resolve to
   an actual entity rather than just the module stub. Significant
   scope (dependency-tree depth + bytecode parsing for JVM
   deps); separate plan.

4. **Macro / annotation-processor expansion.** Lombok's
   `@Data`-generated getters / setters, Scala 3 macros, TypeScript
   `decorators` that emit code at compile time. Source-only
   parser doesn't see them. Documented limitation.

5. **Cross-file resolution metrics.** Surface
   `resolved / ambiguous / stillUnresolved` counts in the
   indexer's daemon log + an RPC for tooling. Useful for
   debugging "why isn't my finding firing" -- the answer is
   often "the edge that the analyzer query depends on never
   resolved." Lightweight; could land alongside Phase 6.

---

## Status tracking

### Phase 0 -- Foundations

| Item                                                | Status | Notes |
|-----------------------------------------------------|--------|-------|
| `UnresolvedRelation` Kuzu node table + schema migration | done -- 62bea4defb7 |    |
| `upsertRelations` no longer drops `resolved: false` rows | done -- 62bea4defb7 |   |
| `listUnresolvedRelations` + `deleteUnresolvedForFile` + `promoteToResolved` helpers | done -- 62bea4defb7 |  |
| Settle hook on `IndexerService` (bulk + incremental + RPC) | deferred to Phase 3 | needs `cross-file-resolver.ts` to invoke |
| Idempotency contract documented                     | done   | captured in plan body |
| Per-language candidate map skeleton                 | done -- 62bea4defb7 | TS/JS only; Python in Phase 1 |

### Phase 1 -- Quick win: Python relative imports

| Item                                       | Status | Notes |
|--------------------------------------------|--------|-------|
| `EXTENSION_MAP` per-language split         | done   | landed in Phase 0.5 |
| Python `.py` + `__init__.py` candidates    | done -- 8a45171cc82 | dot-prefix walker (not extension-map) -- the dot semantics don't fit the map shape |
| `resolver.ts` plumbing for the new map     | done -- 8a45171cc82 | special-cased for python |
| Unit tests                                 | done -- 8a45171cc82 | resolver-python.test.ts, 8 cases |

### Phase 2 -- Source-root detection

| Item                                       | Status | Notes |
|--------------------------------------------|--------|-------|
| `source-roots.ts` skeleton + API           | done -- uncommitted | shipped richer types than the plan: SourceRoots carries GoSourceInfo + TsSourceInfo (modulePath / paths map) rather than plain string[] for those two |
| Java / Scala manifest source-root parsing  | done -- uncommitted | Maven `<modules>` recursion + `<sourceDirectory>` override; Gradle dotted form + `<lang> { srcDirs(...) }` block; SBT/Mill convention; Scala cross-build dirs (scala-2.13 / scala-3) |
| Python source-root probing                 | done -- uncommitted | walks shallowest `__init__.py` + always seeds repo root + repo/src as fallbacks (covers PEP 420 namespace packages) |
| Go module-path detection from go.mod       | done -- uncommitted | first-line `module <path>`; null when no go.mod |
| TS tsconfig `baseUrl` / `paths` parsing    | done -- uncommitted | resolves baseUrl absolutely; reads paths into a Map; strips JSON comments; jsconfig.json takes priority for the JS slot, otherwise falls back to tsconfig |
| Caching + invalidation on manifest change  | deferred to Phase 5 | the cross-file pass will hold the SourceRoots; cache + invalidation lives with the settle hook |
| Unit tests                                 | done -- uncommitted | source-roots.test.ts, 14 cases across all six languages + no-manifest fallbacks |

### Phase 3 -- Cross-file pass: stubs + INHERITS / IMPLEMENTS

| Item                                       | Status | Notes |
|--------------------------------------------|--------|-------|
| `cross-file-resolver.ts` + entry API       | todo   |       |
| `listUnresolvedRelations` Kuzu query       | todo   |       |
| Name-to-entity index builder               | todo   |       |
| IMPORTS module-stub-to-file linking (per-language) | todo |  |
| INHERITS resolution                        | todo   |       |
| IMPLEMENTS resolution                      | todo   |       |
| Ambiguity tracking (`meta.candidates`)     | todo   |       |
| Batch-write helper                         | todo   |       |
| Unit tests (per-language fixtures)         | todo   |       |

### Phase 4 -- Cross-file CALLS

| Item                                       | Status | Notes |
|--------------------------------------------|--------|-------|
| Per-file scope reconstruction              | todo   |       |
| `isExported` gating                        | todo   |       |
| CALLS resolver                             | todo   |       |
| Receiver hint preservation in `meta`       | todo   |       |
| Unit tests                                 | todo   |       |

### Phase 5 -- Incremental mode

| Item                                          | Status | Notes |
|-----------------------------------------------|--------|-------|
| Settle window timer on `IndexerService`       | todo   |       |
| Per-file index triggers settle                | todo   |       |
| `deleteUnresolvedForFile` on per-file re-index | todo  |       |
| Source-side cleanup (5.2 sub-case 1)          | todo   |       |
| Target-side cleanup decision: `ResolvedTrace` vs eventual-consistency | todo |  |
| Scoped re-pass (`scopeFile` filter)           | todo   |       |
| Manifest-change source-root invalidation      | todo   |       |
| Race-free settle path                         | todo   |       |
| Unit tests + fake-clock incremental tests     | todo   |       |

### Phase 6 -- Performance + idempotency

| Item                                       | Status | Notes |
|--------------------------------------------|--------|-------|
| Bulk pass < 5 s on 100 KLoC fixture        | todo   |       |
| Idempotency snapshot test                  | todo   |       |
| Memory ceiling < 500 MB on 1M-entity repo  | todo   |       |
| Daemon log metrics                         | todo   |       |
| Gated perf + e2e smoke scripts             | todo   |       |
