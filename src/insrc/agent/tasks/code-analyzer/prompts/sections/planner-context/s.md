## Decomposition guidance (tier S)

This is a tier-S code analysis -- the scope is 2-3 specific files
(code / config / deploy / DB scripts). Tier-S reports are narrow and
near-exhaustive on the named files. Decompose into 2-3 sections.

### How to use the coverage menu

1. **Read the user request first.** Which files did they name? What
   specific question about those files do they want answered?
2. **Decompose by FILE (typically).** For 2 files: one section per
   file plus optionally a "Cross-File Usage & Risks" section. For 1
   script: a single comprehensive section is often cleaner than
   splitting.
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

### Section-count guidance

- Aim for 2-3 sections.
- Over-decomposition fragments files that should be reviewed together.
- For 1 script file: a single comprehensive section with "What it
  does" / "What it touches" / "What's risky" sub-areas is usually
  cleaner.

### Naming + scope per section

Each section needs:
  - A title that names the FILE(s) under review (e.g.
    "`migrate_users.py`: Schema Delta & Transaction Safety",
    "`deploy.sh`: Build Pipeline & Secret Handling"). NOT generic
    labels like "File Review" or "Usage Review".
  - An objective sentence anchored on the file's purpose.
  - 3-5 review criteria emphasising file-level depth (e.g. "Verifies
    `set -e` discipline on the script's critical pipeline").
