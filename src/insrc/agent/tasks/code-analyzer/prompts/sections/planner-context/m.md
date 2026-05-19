## Decomposition guidance (tier M)

This is a tier-M code analysis -- the scope is a specific
functionality or feature. Tier-M analyses go DEEP on one feature; the
report's sections should reflect that depth, not breadth across the
codebase.

### Coverage menu (M)

1. **Feature functionality** -- WHAT the specific feature does;
   central entity + its role.
2. **Detailed code analysis** -- dependencies (callers + callees),
   data persistence touches (cache / DB / files).
3. **Semantic / syntactic issues** -- code quality problems in the
   feature's implementation.
4. **Test coverage** -- is THIS feature tested, and how.
5. **Configurations** -- env vars / settings that affect the
   feature's behaviour.

### Section-count guidance

- Aim for 3-5 sections. Tier-M reports are smaller in breadth but
  deeper in each section than L-tier ones.
- A "Feature Overview & Central Entity" section as the opener is
  usually right.
- Dedicated "Code Quality & Issues" section if there are concerns to
  surface.
- Combine test-coverage + configurations into one "Quality &
  Configuration" section if either alone is thin.

### Naming + scope per section

Each section needs:
  - A title that names THE FEATURE (e.g. "Token Refresh Flow:
    Implementation & Edge Cases"), not the module containing it.
  - An objective sentence anchored on the feature's central entity.
  - 3-5 review criteria that score depth (e.g. "Identifies the
    error-handling pattern around the central entity and any caller
    not honouring it").
