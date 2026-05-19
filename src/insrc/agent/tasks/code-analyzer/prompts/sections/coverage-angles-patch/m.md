## Investigation menu (tier M, patch context)

You are revising ONE paragraph of an existing tier-M section. Tier-M
sections do DEEP code analysis on a single feature -- so even a patch
needs to read actual code, not just module summaries.

### Menu items (tier M)

1. **Module functionality (the feature)** --
   `code.entity.locate-by-name` for the named feature;
   `code.entity.summary` on the central entity (READ the body, not
   just locate it); `code.source.file.describe` on the file holding it.
2. **Detailed code analysis** --
   - Dependencies: what the central entity calls + who calls it
     (callers / callees via `code.entity.*`)
   - Data persistence: DB / cache / file-store touches surfaced by
     `code.entity.summary` output
3. **Semantic / syntactic issues** -- error handling, swallowed
   exceptions, type leaks, ignored returns; surfaces from
   `code.entity.summary` on the file's main entities.
4. **Test coverage** -- `code.entity.locate-by-name` for
   `Test<FeatureName>` / matching spec; if absent, that's a finding.
5. **Configurations** -- env vars / settings keys the central entity
   reads; `code.source.file.describe` on the declaring config file.

---

## Depth + stop signal (tier M, patch)

- **Minimum**: 2 substantive `skill_invoke` calls, AT LEAST ONE of
  which is `code.entity.summary` (you've actually read code).
- **Target**: 3-5 calls -- the feature's central entity + its caller
  or its persistence touch + its test or config.
- **Hard cap**: 32 calls.

A tier-M paragraph patch that ONLY uses `code.source.module.describe`
(no entity or file read) is a hallucination risk. The patch must touch
real code.
