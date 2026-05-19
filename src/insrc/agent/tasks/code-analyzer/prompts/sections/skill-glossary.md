## Skill primitives (term mapping for this catalog)

The menus below use plain-language terms ("module", "file", "entity",
"caller"). They map to SPECIFIC catalog skills with SPECIFIC argument
names. The catalog is strict (`additionalProperties: false`) -- using
the wrong arg name will be rejected with an invalid-input error and
that call wastes your tool-call budget.

ALWAYS call `skill_describe({ id })` for a skill the first time you
use it. Read the input schema. Then use the EXACT arg names from the
schema in your `skill_invoke` call.

### Vocabulary -> skill mapping

| What the menu says | Catalog skill | Required args | Returns |
|---|---|---|---|
| "the repo's module list" / "what directories are top-level" | `code.source.repo.describe` | (none; uses session repo) | module list sorted by file count |
| "summarise this **module**" (a directory of source files) | `code.source.module.describe` | `modulePath` (absolute dir), `repoPath` (absolute repo root) | files, entity ids, sub-modules |
| "summarise this **file**" / "enumerate its entities + imports" | `code.source.file.describe` | `file` (absolute path -- NOT `path`), `repoPath` | language, entity ids, imports |
| "**locate** an entity by name" (class / function / method / etc.) | `code.entity.locate-by-name` | `name` (string); optional `kinds` (array of strings), `repoPath`, `language` | entity ids of matches |
| "**read** an entity's body" / "what does this entity do" | `code.entity.summary` | `entityId` (32-char hex; from a prior lookup) | typed metadata + body excerpt |
| "**who calls** this entity" | `code.entity.callers` | `entityId` (32-char hex) | calling entities (1-hop CALLS in-edges) |
| "**semantic search** for entities" (when you don't know the name) | `code.entity.search-by-vector` | `query` (string); optional `limit`, `filter` | top-K semantically similar entities |

### Standard skill chains

`summary` / `callers` cannot be called standalone -- they need an
`entityId`, which is a 32-char hex string that ONLY `locate-by-name`,
`search-by-vector`, `file.describe`, or `module.describe` emit. Use
one of these two canonical chains:

**Chain A: name-known investigation** -- you have a class / function
name and want to read its actual body or find its callers:

  1. `locate-by-name({ name: "FooHandler" })` -- get entity ids
  2. `summary({ entityId: <id from step 1> })` -- read the body
  3. (optional) `callers({ entityId: <id> })` -- find who uses it

**Chain B: module-down investigation** -- you want to map a directory's
shape and pick interesting entities to read:

  1. `repo.describe()` -- get the module list (skip if you already
     know the modulePath you want)
  2. `module.describe({ modulePath, repoPath })` -- get the files +
     entity ids in the module
  3. For each interesting file: `file.describe({ file, repoPath })`
     -- get entity ids defined in that file
  4. For the most important entities: `summary({ entityId })` -- read
     body

### Common arg-shape mistakes (observed in prior runs)

- `code.source.file.describe` takes `file`, **not** `path`. Passing
  `path` fails with `unexpected property 'path'`.
- `code.source.module.describe` takes `modulePath` + `repoPath`,
  **both** required, **both** absolute paths.
- `code.entity.summary` takes `entityId` (32-char hex), **not**
  `name`. You cannot summarise an entity by its name -- locate it
  first.
- `kinds` on `code.entity.locate-by-name` is an ARRAY of strings
  (e.g. `["class", "function"]`), not a single string.

When in doubt, call `skill_describe({ id })` first. Once per skill
per section is enough; the orchestrator caches.
