# `shared.fs.*` skill family + namespace cleanup

## Motivation

Across the 5th–7th live runs of the section-flow GRN-vs-INGRN
investigation, the first TODO ("list JSON files in
`test/integration/data/BB/GRN`") L2-fallback'd every time, in every
run, without a single cycle producing real progress. Symptom in the
daemon log: cycle 1 schedules `code.source.repo.describe` +
`code.source.module.describe` + `code.source.grep` against the test
fixture directory, none of which can enumerate the JSON files there;
cycle review rejects; recycle exhausts; L2 fallback synthesises a
section from the model's general knowledge with no grounded evidence.

Root cause has two parts.

### Part 1: missing skill

There is no skill that returns "the list of files under directory X
matching glob Y." The capability exists at the tool layer
(`db_file_list_files` at
[tools/builtins/db/index.ts:713](../src/insrc/daemon/tools/builtins/db/index.ts#L713),
wired to `listFilesForConnection`), but nothing in the skill catalog
calls it. Adjacent skills almost-but-not-quite cover it:

- `code.source.module.describe` returns `files[]` -- but only for
  SOURCE files in indexed code repos. Data files (JSON fixtures, CSVs,
  Parquet) aren't entities the indexer catalogs as `kind='file'`.
- `data.source.file.sample-shape({pattern, prefix})` enumerates
  matching files internally to sample them, then returns the inferred
  shape -- never the file list.
- `code.source.grep` searches *content*, not filenames.

So when the planner asks "what JSON files exist here," all three
adjacent skills return either nothing or the wrong thing. Cycle
reviewer correctly judges the gap-fact uncovered, recycle exhausts,
L2 inevitably.

### Part 2: misnamed skill family

`code.source.grep`, `code.source.repo.describe`, and
`code.source.module.describe` look like code-specific skills but the
first two are actually general filesystem operations:

- `code.source.grep` is just `grep -rn` -- it walks files and matches
  patterns. The "code" prefix is a lie; it has no AST awareness, no
  language understanding, no graph integration. Greping a JSON
  fixture for `"vendor_details"` uses the exact same code path as
  greping a TypeScript source file for `MyClass`.
- `code.source.repo.describe` reports repo-level stats (file counts,
  language breakdown). Repo-level, not code-level.

Only `code.source.module.describe` legitimately belongs under `code.*`
-- it walks indexed graph entities and reports the public surface
(exported classes, functions, etc.), which is a code-semantic
operation, not a filesystem walk.

The naming matters because the planner uses skill ids + descriptions
to pick what to call. When grep is named `code.source.grep`, the
planner doesn't reach for it when the question is about data files
("the question is about JSON data, code skills don't apply"). The
existing `code.source.grep` is *underused* on data-shaped questions
purely because its name says "code."

## Plan

Two phases, independently shippable, validated separately.

### Design principle: flags over skills

Multiple filesystem operations that look like distinct verbs at first
collapse into flag variants of a smaller core set. The skill catalog
the planner reasons over should have as few entries as possible while
still covering every distinct *verb* (list / search / read / grep).
Variants of the same verb (one-level-deep vs recursive vs tree-render,
or default-sort vs sort-by-mtime) become flags on the parent skill,
not separate catalog entries. Fewer ids means less planner
disambiguation noise; richer flags mean each skill is a real verb
rather than a near-duplicate.

Four skills total. The full surface:

#### `shared.fs.list-files` -- the list verb

Covers flat listings, tree renders, sorted-by-mtime ("recent"), and
single-path-metadata ("stat").

```ts
shared.fs.list-files({
  path:        string,                              // absolute directory path
  pattern?:    string,                              // glob, e.g. "*.json"; default = all files
  recursive?:  boolean,                             // default false
  sortBy?:     'name' | 'mtime' | 'size',           // default 'name'
  limit?:      number,                              // cap; default 200
  format?:     'flat' | 'tree',                     // default 'flat'
}) -> {
  files: Array<{ path: string; kind: 'file' | 'dir' | 'symlink'; size: number; modifiedAt: number }>;
  truncated: boolean;
  rendered?: string;                                // populated when format='tree'
}
```

How the flags compose for known use cases:

| Use case                              | Flags                                       |
|---------------------------------------|---------------------------------------------|
| List JSON files in a dir              | `pattern: "*.json"`                         |
| Tree view of `src/` 3 levels deep     | `recursive: true, format: 'tree'`           |
| 10 most-recently-modified `.ts` files | `pattern: "*.ts", sortBy: 'mtime', limit: 10` |
| Stat a single path                    | `pattern: "<exact-filename>"`               |
| What changed lately in `src/`         | `recursive: true, sortBy: 'mtime', limit: 20` |

#### `shared.fs.find` -- the search-by-name verb

Different from `list-files` in that it recurses by default and matches
on the filename *component* (not full path). The right verb for
"find me an INGRN.py somewhere in this repo."

```ts
shared.fs.find({
  path:         string,             // absolute directory to walk
  namePattern:  string,              // glob against the filename component
  kinds?:       Array<'file' | 'dir' | 'symlink'>,
  limit?:       number,              // default 50
}) -> {
  matches: Array<{ path: string; kind: 'file' | 'dir' | 'symlink' }>;
  truncated: boolean;
}
```

#### `shared.fs.grep` -- the content-search verb (renamed)

Same logic as today's `code.source.grep`. See Phase 2 below for the
deprecation-window strategy.

#### `shared.fs.peek` -- the bounded-read verb

A bounded read of a file's content. Necessary because the graph only
indexes *code* entities; ad-hoc files (JSON fixtures, configs,
READMEs, CSVs) aren't indexed and the planner has no way to inspect
them otherwise.

Different output shape from list-files (text content, not metadata),
which is exactly why it's a separate skill rather than a flag on
list-files.

```ts
shared.fs.peek({
  path:    string,                  // absolute file path
  head?:   boolean,                 // default true; false = peek at tail
  lines?:  number,                  // cap; default 50
  bytes?:  number,                  // hard cap; default 8192
}) -> {
  content:        string;
  truncated:      boolean;
  totalBytes:     number;
  totalLines?:    number;           // populated when content is text-decodable
  encoding:       'utf-8' | 'binary';
}
```

The dual cap (lines AND bytes) prevents the planner from
accidentally pulling a giant file's contents into the LLM context. A
1MB single-line JSON gets capped at 8KB; a 200-line log gets capped
at 50 lines. Whichever cap hits first wins.

### Phase 1: add `shared.fs.list-files` + `shared.fs.peek`

Two new skills. Closes the immediate gap (TODO 1 in the GRN run --
file listing) and the next-bottleneck (TODO 3 -- "parse one
representative JSON file" which today requires 3+ data.source.file.*
calls just to ground a single fixture's shape).

**Implementation**:

- `list-files`: thin wrapper around `node:fs/promises` `readdir` +
  `stat`, with optional glob via micromatch (already a transitive
  dep). Tree render is a simple ASCII tree builder over the same
  file array. NOT via the data-driver tool layer -- filesystem
  walking doesn't need a connection registry.
- `peek`: `fs.read` with bounded buffer; UTF-8 decode attempt with
  binary fallback flag.

**Tests** (each skill):

- Pattern matching (positive + negative).
- Recursive vs flat.
- Sort by each `sortBy` value.
- Tree render shape (golden-string comparison).
- Limit/truncation: confirm `truncated: true` and the array honours
  the cap.
- Non-existent path returns empty / no-throw, confidence='low'.
- `peek`: head + tail mode, both caps independently honoured, binary
  file produces `encoding: 'binary'` and no decoded content.

**Validation gate**: re-run the GRN data analysis. Confirm:

- TODO 1 (`locate-grn-json-files`) closes in 1 cycle, no L2 fallback.
- TODO 3 (`parse-sample-json-structure`) uses `shared.fs.peek`
  against one JSON file instead of chaining three `data.source.file.*`
  calls.

### Phase 2: namespace cleanup -- move misplaced skills

After Phase 1 validates in a live run, move the non-code-specific
`code.source.*` skills into `shared.fs.*`.

**Skills to rename:**

| From                       | To                       | Reason |
|----------------------------|--------------------------|--------|
| `code.source.grep`         | `shared.fs.grep`         | Filesystem grep, no code semantics. |
| `code.source.repo.describe`| `shared.fs.repo.describe`| Reports repo stats; works on any repo dir. |

**Skills that STAY under `code.*`:**

- `code.source.module.describe` -- walks graph entities, reports
  public surface. Genuinely code-semantic.
- All `code.class.*`, `code.entity.*`, `code.compare.*` -- semantic.

**Phase 2 also lands `shared.fs.find`** (the search-by-name verb).
Held back from Phase 1 because it wasn't a directly observed
bottleneck in the GRN runs, but the surface area lives here now and
ships once the namespace cleanup is in flight anyway.

**Migration strategy:**

1. Register the new `shared.fs.*` skill ids. Each new skill
   `executes` identical logic to its predecessor (where applicable).
2. Mark the old `code.source.grep` and `code.source.repo.describe`
   as deprecated aliases -- both ids remain registered, both route to
   the same implementation, but the OLD skill's catalog description
   gets a `[DEPRECATED -> shared.fs.X]` prefix. The planner sees
   both; over time it'll prefer the cleaner names because the prompt
   surfaces them up front.
3. After two clean live runs, remove the old ids from the catalog
   (skill code stays under the new name).

**Tests:**

- Each new skill gets unit tests (pattern matching, limit, recursive,
  etc.).
- A catalog-integrity test asserts `shared.fs.list-files`,
  `shared.fs.find`, `shared.fs.grep`, `shared.fs.peek`,
  `shared.fs.repo.describe` all appear in the registered skill list.
- During the deprecation window, a test asserts that both
  `code.source.grep` and `shared.fs.grep` resolve to the same
  execute function (regression guard against accidental divergence).

**Validation gate**: re-run the GRN data analysis. Confirm:

- Planner picks `shared.fs.list-files` for "what files exist" gap facts.
- Planner picks `shared.fs.grep` over `code.source.grep` for queries
  about data files (look at the planner's emitted `skillId` strings).
- Planner reaches for `shared.fs.find` on "where is INGRN.py defined"
  if extract-fields / locate-by-name aren't the right verb.
- No regressions in code-shaped questions (`code.source.grep` still
  works under its old name during deprecation; `code.entity.*`
  skills unaffected).

## Out of scope (intentional)

- An unbounded `shared.fs.read({path})` skill. `shared.fs.peek` is
  the only allowed file-content path, and its dual cap (lines AND
  bytes) is a hard wall. The planner gets enough to ground without
  the context-blowup risk.
- Rewriting `code.source.module.describe` -- the graph-aware logic
  there is correct.
- Globbing across multiple roots (multi-repo workspace fan-out). Each
  call takes a single root; the planner can chain across multiple
  calls if needed.
- A `shared.fs.count({path, pattern?})` skill. `list-files` with
  `limit: 0` (or `limit: 1` + `truncated: true`) is enough; adding a
  count-only verb would just pad the catalog.

## Risk

Low for Phase 1 (new skill, isolated). Medium for Phase 2 (renames
touch the catalog the planner sees). Two-step deprecation window
mitigates: planner sees both old and new ids during the transition
and picks whichever the cycle-review prompt steers it toward.

## Out-of-band: the `dependsOn` chain work is unrelated

The cross-step `dependsOn` plumbing landed in `ac588230efb` solves a
different problem (chaining entityId from `locate-by-name` into
`entity.summary`). It does NOT help with the missing-skill gap
described here -- no amount of dep-chaining can produce a file list
when no skill emits one. Phase 1 of this plan is the structural
complement.

## Tracking

Open this file in the plans/ directory as a tracking doc. Add a
`Status` block at the top once Phase 1 lands:

```
Status: 2026-MM-DD -- Phase 1 shipped; validated against GRN
        analysis run #N. Phase 2 pending.
```

Close the plan when both phases have validated.
