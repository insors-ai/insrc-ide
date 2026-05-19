## Decomposition guidance (tier L)

This is a tier-L code analysis -- the scope is a medium-to-large
module. Decompose into sections that together cover the following
menu. The L scope is narrower than XL+; sections should focus on the
module itself, not the wider repo.

### Coverage menu (L)

1. **Module functionality** -- what the module does + its public
   entry points.
2. **Exposed endpoints** -- how the module is called (HTTP / message
   receivers / internal callers).
3. **Data Persistence details** -- DB / cache / file-store touches
   specific to this module.
4. **Dependencies (internal + external)** -- what the module imports,
   both other-modules-in-repo and third-party packages.
5. **Test coverage** -- how well-tested is this module's surface.
6. **Deployment artifacts (configs)** -- module-specific config files
   + env vars.

### Section-count guidance

- Aim for 3-6 sections. L scope rarely needs more than 6; below 3
  risks "one big kitchen-sink section".
- Combine endpoints + dependencies into one section if both are thin.
- Reserve dedicated sections for the dominant concern (e.g. if the
  module is heavily persistence-oriented, give persistence its own
  section).

### Naming + scope per section

Each section needs:
  - A title that names THE MODULE (e.g. "Auth Module: Endpoints &
    Session Lifecycle"), not generic phrases.
  - An objective sentence.
  - 3-5 specific, scorable review criteria.
