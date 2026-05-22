## Per-step investigation depth (tier L)

This section's scope is a MEDIUM-TO-LARGE module. Each plan step you
emit should zoom in on ONE responsibility within the module, not try
to cover the whole module in one step. Total step count is set by
the discovery-expand prompt (driven by `reviewCriteria.length`), not
by this menu.

The menu below lists the responsibilities a tier-L section typically
wants to surface. Pick the responsibility(s) your section's
`reviewCriteria` call for and emit ONE step per responsibility --
each step picks 3-5 skills, including AT LEAST ONE
`code.entity.summary` so you've actually read code (not just listed
file names).

### Responsibility A: Module functionality + public entry points
What does this module DO + what is its public API?
- `code.source.module.describe` on the module.
- `code.entity.locate-by-name` for the module's named exports /
  public classes / public functions.
- `code.entity.summary` on the most important 2-3 entities to read
  what they actually implement.

### Responsibility B: Exposed endpoints (how is this module called?)
- `code.entity.locate-by-name` for *Controller / *Handler /
  *Endpoint / message receivers within the module.
- For internal-only modules: callers of the public surface -- who
  imports it, how.

### Responsibility C: Data persistence
Does the module touch a DB / cache / file store?
- `code.entity.locate-by-name` for repo / DAO / Manager / *Store /
  *Cache classes within the module.
- `code.source.file.describe` on migration / schema files for the
  module's tables, if any.
- Identify the persistence client (DB driver, ORM, redis client,
  S3 client) actually used.

### Responsibility D: Dependencies (internal + external)
What does the module depend on?
- Internal: which OTHER modules in this repo does it import?
  `code.source.module.describe` on the heavily-imported modules.
- External: which third-party packages? Sample 1-2 import-heavy
  files via `code.source.file.describe`.

### Responsibility E: Test coverage
How well-tested is this module's surface?
- `code.source.module.describe` on the module's test directory
  (or sibling `__tests__/` or `*_test.go`).
- `code.source.file.describe` on the test file(s) covering the
  module's main entry points.

### Responsibility F: Deployment artifacts (configs that affect this module)
How does this module get configured at deploy time?
- `code.source.file.describe` on any module-specific config files
  / env var docs.
- Identify which config keys the module actually reads
  (`code.entity.locate-by-name` for getEnv / config.get callers).

---

## Per-step picking rules (tier L)

- Each plan step's `intent` should name ONE responsibility, not the
  whole module. Example good intents:
  - "Map the public API of the namenode module to identify the entry
    points for namespace mutation"
  - "Identify the persistence layer of the namenode module -- which
    files write to FSImage / EditLog and how"
- 3-5 skills per step.
- At least one `code.entity.summary` per step (read code, don't just
  list it). A tier-L step that only calls `module.describe` is
  describing a directory tree, not a responsibility.
