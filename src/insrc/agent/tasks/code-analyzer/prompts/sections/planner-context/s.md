## Decomposition guidance (tier S)

This is a tier-S code analysis -- the scope is a small set of
specific files (code / config / deploy / DB scripts). Tier-S reports
are narrow and near-exhaustive on the named files.

### How to use the coverage menu

1. **Read the user request first.** Which files did they name? What
   specific question about those files do they want answered?
2. **Decompose by FILE (typically).** One section per named file is
   the usual shape; optionally add a "Cross-File Usage & Risks"
   section when the files interact meaningfully. A single script
   file usually wants ONE comprehensive section, not splits.
3. **Cross-check against the coverage menu BELOW.** Each file's
   section should touch the axes that apply (review, deps, persistence,
   safety checks, usage).

### Coverage menu (do NOT name sections after these)

  - in-depth file review (line-range by line-range)
  - nested dependencies (imports + the imported targets)
  - data persistence touches (queries, opens, cache calls)
  - semantic / syntactic checks (error handling, shell discipline,
    config / migration safety, secret-leak risk)
  - usage review (callers + whether they pass required guards)

### Decomposition strategy

Section count is REQUEST-DRIVEN, not tier-driven:

- Number of sections = (files named) + optional cross-file section.
  Two files -> 2-3 sections; one script -> 1 section.
- Over-decomposition fragments files that should be reviewed together.
  Don't split one file across multiple sections just to inflate count.
- The safety ceiling in the user message is an upper bound, not a
  target. A narrow tier-S request is allowed to return 1 section.

### Naming + scope per section

Each section needs:
  - A title that names the FILE(s) under review (e.g.
    "`migrate_users.py`: Schema Delta & Transaction Safety",
    "`deploy.sh`: Build Pipeline & Secret Handling"). NOT generic
    labels like "File Review" or "Usage Review".
  - An objective sentence anchored on the file's purpose.
  - 3-5 review criteria emphasising file-level depth (e.g. "Verifies
    `set -e` discipline on the script's critical pipeline").
