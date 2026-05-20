## Decomposition guidance (tier M)

This is a tier-M code analysis -- the scope is a specific
functionality or feature. Your job: decompose into 3-5 sections that
together answer the USER REQUEST in depth. Tier-M reports go DEEP on
the named feature; sections should reflect that depth, not breadth
across the codebase.

### How to use the coverage menu

1. **Read the user request first.** What specific feature / behaviour
   did they ask about? Which central class / function is the anchor?
2. **Decompose into request-driven sections.** Each section is one
   meaningful slice of the FEATURE the user is asking about
   (implementation, dependencies, persistence, tests, config).
3. **Cross-check against the coverage menu BELOW.** Skip axes that
   aren't relevant -- M-tier is depth-focused, not breadth.

### Coverage menu (do NOT name sections after these)

  - the feature's central entity + what it does
  - dependencies (what calls it, what it calls)
  - data persistence touches (DB, cache, file stores)
  - semantic / syntactic code quality issues in the feature
  - test coverage of the feature
  - configurations that affect the feature's behaviour

### Section-count guidance

- Aim for 3-5 sections. Tier-M reports are smaller in breadth but
  deeper in each section than L-tier ones.
- Combine thin axes into one section (e.g. "Quality & Configuration"
  if both are thin).
- A "Feature Overview & Central Entity" section as opener is usually
  right -- titled with the actual feature name.

### Naming + scope per section

Each section needs:
  - A title that names the FEATURE (e.g. "Token Refresh Flow:
    Implementation & Edge Cases", "Vector Index Rebuild: Trigger Paths
    & Failure Modes"). NOT generic labels like "Module Functionality"
    or "Test Coverage".
  - An objective sentence anchored on the feature's central entity.
  - 3-5 review criteria that score depth (e.g. "Identifies the
    error-handling pattern around the central entity and any caller
    not honouring it").
