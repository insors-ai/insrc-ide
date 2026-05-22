## Per-step investigation depth (tier M)

This section's scope is a SPECIFIC functionality / feature. Each plan
step you emit should zoom in on ONE aspect of that feature, not try
to cover the whole feature in one step. Total step count is set by
the discovery-expand prompt (driven by `reviewCriteria.length`), not
by this menu.

The menu below lists the aspects an M-tier section typically wants
to surface. Pick the aspect(s) your section's `reviewCriteria` call
for and emit ONE step per aspect -- each step picks 2-5 skills,
including AT LEAST ONE `code.entity.summary` so you've actually read
code (not just located it).

### Aspect A: Module functionality (the feature itself)
What does this specific functionality do?
- `code.entity.locate-by-name` for the named class / function /
  module the feature lives in.
- `code.entity.summary` on the central entity -- you MUST read it,
  not just locate it.
- `code.source.file.describe` on the file holding it for line-range
  context.

### Aspect B: Dependencies (deps + persistence)
What does the feature call (outbound) and who calls it (inbound)?
- Use `code.entity.callers` (inbound) or `code.entity.summary` body
  excerpts (outbound) on the central entity.
- Surface both internal (this repo) and external (third-party) deps.
- If the feature touches storage, name the DB table / cache key /
  file path the feature touches; identify the persistence client
  (DB driver / ORM / redis / S3 client).

### Aspect C: Semantic / syntactic issues
Are there code-quality problems in the feature?
- Missing error handling on critical paths.
- Ignored return values, swallowed exceptions.
- Type issues (Python: missing type hints in a typed codebase; TS:
  `any` leaks; Go: `_ = err`).
- These surface from `code.entity.summary` body excerpts -- you read
  the actual code and judge.

### Aspect D: Test coverage
Is THIS feature tested?
- `code.entity.locate-by-name` for `Test<FeatureName>` /
  `test_<feature>` / a spec file matching the feature.
- If not located: that's a finding ("no direct test coverage for
  this feature").
- If located: `code.source.file.describe` on the test file +
  `code.entity.summary` on the main test entry points.

### Aspect E: Configurations
What config affects this feature's behaviour?
- Identify env vars / settings keys the central entity reads.
- `code.source.file.describe` on the config file(s) declaring them.
- Surface default values + their conditions.

---

## Per-step picking rules (tier M)

- Each plan step's `intent` should name ONE feature + ONE aspect,
  not the whole feature. Example good intents:
  - "Read FSDirectory.delete + audit which lock it acquires"
  - "Locate tests covering FSDirectory.delete and characterize their
    coverage of edge cases"
- 2-5 skills per step.
- A step that calls ONLY `code.source.module.describe` is too coarse
  -- you've described a directory, not the feature. At least one
  `code.entity.summary` per step grounds the analysis in actual code.
