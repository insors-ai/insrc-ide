## Investigation menu (tier L)

This analysis covers a medium-to-large module. You are working on ONE
section of this report -- pick the menu items YOUR section's objective
requires, then run the named skill sequence.

### 1. Module functionality
Goal: what does this module DO + what are its public entry points?
- `code.source.module.describe` on the module.
- `code.entity.locate-by-name` for the module's named exports /
  public classes / public functions.
- `code.entity.summary` on the most important 2-3 entities to read
  what they actually implement.

### 2. Exposed endpoints
Goal: how is this module called?
- `code.entity.locate-by-name` for *Controller / *Handler /
  *Endpoint / message receivers within the module.
- For internal-only modules: callers of the public surface --
  who imports it, how.

### 3. Data Persistence details
Goal: does the module touch a DB / cache / file store?
- `code.entity.locate-by-name` for repo / DAO / Manager / *Store /
  *Cache classes within the module.
- `code.source.file.describe` on migration / schema files for the
  module's tables, if any.
- Identify the persistence client (DB driver, ORM, redis client,
  S3 client) actually used.

### 4. Dependencies (internal + external)
Goal: what does this module depend on?
- Internal: which OTHER modules in this repo does it import?
  `code.source.module.describe` on the heavily-imported modules.
- External: which third-party packages? Sample 1-2 import-heavy
  files via `code.source.file.describe`.

### 5. Test coverage
Goal: how well-tested is this module's surface?
- `code.source.module.describe` on the module's test directory
  (or sibling `__tests__/` or `*_test.go`).
- `code.source.file.describe` on the test file(s) covering the
  module's main entry points.

### 6. Deployment artifacts (configs that affect this module)
Goal: how does this module get configured at deploy time?
- `code.source.file.describe` on any module-specific config files
  / env var docs.
- Identify which config keys the module actually reads
  (`code.entity.locate-by-name` for getEnv / config.get callers).

---

## Depth + stop signal (tier L)

A tier-L section explores ONE module in depth (not the whole repo).

- **Minimum**: 3 substantive `skill_invoke` calls before
  `EVIDENCE_COMPLETE`. Less = you haven't grounded the module's shape.
- **Target**: 4-7 calls -- a module's functionality + endpoints +
  persistence + tests can usually be covered in this range.
- **Hard cap**: 32 calls. Approach this only if the module spans many
  subsystems.

A section that hasn't called `code.entity.summary` at least once is
likely under-researched -- you've described directories but not read
actual code.
