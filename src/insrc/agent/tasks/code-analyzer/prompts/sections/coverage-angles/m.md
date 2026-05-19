## Investigation menu (tier M)

This analysis covers a specific functionality / feature. Depth is the
priority -- read actual code, not just module summaries. You are
working on ONE section of this report; pick the relevant menu items +
run the named skill sequence.

### 1. Module functionality (the feature)
Goal: WHAT does this specific functionality do?
- `code.entity.locate-by-name` for the named class / function /
  module the feature lives in.
- `code.entity.summary` on the central entity -- you MUST read it,
  not just locate it.
- `code.source.file.describe` on the file holding it for line-range
  context.

### 2. Detailed code analysis (deps + persistence)

Sub-areas:

  a. **Dependencies** -- look at WHAT the central entity calls
     (outbound) and WHO calls it (inbound). Use whatever
     `code.entity.*` skills the catalog exposes for callers /
     callees. Surface both internal (this repo) and external
     (third-party package) deps.

  b. **Data persistence** -- if the feature touches storage:
     - DB: identify the table(s), the query layer, the migration
     - Cache: identify the cache client, key shape, TTL/invalidation
     - File stores: identify the storage client (S3 / fs), path
       convention, lifecycle
     `code.source.file.describe` on the persistence files involved.

### 3. Semantic / syntactic issues
Goal: are there code-quality problems in the feature?
- Look for missing error handling on critical paths.
- Look for ignored return values, swallowed exceptions.
- Look for type issues (Python: missing type hints in a typed
  codebase; TS: `any` leaks; Go: ignored errors via `_ = err`).
- These come from `code.entity.summary` on the file's main
  entities; you read the actual code and judge.

### 4. Test coverage
Goal: is THIS feature tested?
- `code.entity.locate-by-name` for `Test<FeatureName>` /
  `test_<feature>` / a spec file matching the feature.
- If not located: that's a finding ("no direct test coverage for
  this feature").
- If located: `code.source.file.describe` on the test file.

### 5. Configurations
Goal: what config affects this feature's behaviour?
- Identify env vars / settings keys the central entity reads.
- `code.source.file.describe` on the config file(s) declaring them.
- Surface default values + their conditions.

---

## Depth + stop signal (tier M)

A tier-M section is a DEEP analysis of a single feature. Quality >
breadth.

- **Minimum**: 3 substantive `skill_invoke` calls before
  `EVIDENCE_COMPLETE`, AT LEAST ONE of which is `code.entity.summary`
  (you've read code, not just located it).
- **Target**: 4-8 calls -- the feature itself + its primary
  callers/callees + its persistence + its tests + its config can
  usually be covered here.
- **Hard cap**: 32. M-tier rarely needs more than 10 if your picks
  are well-targeted.

A tier-M section that NEVER opens an actual code file (no
`code.entity.summary` and no `code.source.file.describe`) is a
hallucination risk -- you're working from module summaries alone.
PUSH PAST.
