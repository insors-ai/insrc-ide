## Per-step investigation depth (tier S)

This section's scope is FILE-LEVEL -- 2-3 specific files. Each plan
step you emit should zoom in on ONE facet of the target file(s), not
try to cover everything in one step. Total step count for this
section is set by the discovery-expand prompt (driven by
`reviewCriteria.length`), not by this menu.

The menu below lists the facets a file-level section typically wants
to surface. For each `reviewCriterion` your section lists, pick the
facet(s) that ground it and emit ONE step per facet -- each step
should pick 2-4 skills at fine granularity (every entity summary,
every caller).

### Facet A: In-depth file review (line-range deep)
For each target file:
- `code.source.file.describe` on the file.
- `code.entity.summary` on every named entity the file exports.
- Surface line ranges in the resulting evidence so the writer can
  cite them precisely.

### Facet B: Nested dependencies
For each non-stdlib import of the target file:
- `code.entity.locate-by-name` then `code.entity.summary` on the
  imported target.
- Chase internal-repo imports to depth-1 or depth-2; don't recurse
  forever.

### Facet C: Data persistence touches
Does the file read/write storage?
- Spot DB queries / cursor opens / file opens / cache calls in the
  `code.entity.summary` output.
- For DB: name the query, the table, parameterized vs string-formatted.
- For files: name the path / pattern, the open mode, whether it
  closes on all paths.

### Facet D: Semantic + syntactic checks
What's BAD or RISKY about how the file is written?
- Missing error handling, ignored returns, swallowed exceptions, type
  leaks.
- Python / shell: `set -e` / `set -u` discipline, quoting,
  exit-code propagation.
- Config / env files: verify referenced keys / env vars / paths exist.
- DB migration scripts: forward-compatible vs breaking, transactional
  safety.
- Build / deploy scripts: secret-leak risk (echo / `set -x` with
  secrets in scope).

### Facet E: Usage review (callers with risks)
Who uses the file's exported entities, and do they use them correctly?
- `code.entity.locate-by-name` for callers of the file's exports, OR
  `code.entity.callers` once you have entity ids.
- For each caller: judge whether they pass required guards (auth
  checks, input validation, lock acquisition), the right argument
  types, handle documented error paths.
- Surface risks ("caller X does not handle the ValueError that
  function Y can raise") as evidence facts.

---

## Per-step picking rules (tier S)

- Each plan step's `intent` should name ONE file + ONE facet, not
  the whole review. Example good intents:
  - "Read FSDirectory.java's exported entities to characterize the
    namespace-tree API surface"
  - "Audit FSDirectory.java callers for whether they hold the
    writelock before mutating"
- 2-4 skills per step (chains like locate -> summary -> callers count
  as one step).
- A file-level step that calls only `code.source.module.describe` is
  too coarse for tier S -- you've described a directory, not a file.
  Push past into `code.source.file.describe` + `code.entity.summary`.
