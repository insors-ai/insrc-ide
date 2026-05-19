## Decomposition guidance (tier S)

This is a tier-S code analysis -- the scope is 2-3 specific files
(code / config / deploy / DB scripts). Tier-S reports are narrow and
near-exhaustive on the named files.

### Coverage menu (S)

1. **In-depth file review** -- what each file does, line-range by
   line-range.
2. **Nested dependencies** -- what each file imports + what the
   imported code does (depth-1 or -2).
3. **Data persistence touches** -- DB queries / file opens / cache
   calls in the file's body.
4. **Semantic + syntactic checks** -- error handling, shell
   discipline, config/migration safety, secret-leak risk.
5. **Usage review (callers with risks)** -- who calls the file's
   exports + whether they pass the required guards.

### Section-count guidance

- Aim for 2-3 sections. Tier-S is small; over-decomposition fragments
  files that should be reviewed together.
- For 2 files: one section per file, plus optionally a "Cross-file
  Usage & Risks" closing section if the files have caller relationships.
- For 1 script file: a single comprehensive section with sub-areas
  for "What it does" / "What it touches" / "What's risky" is often
  cleaner than splitting.

### Naming + scope per section

Each section needs:
  - A title that names the FILE(s) it reviews (e.g. "`migrate_users.py`:
    Schema Delta & Transaction Safety").
  - An objective sentence anchoring on the file's purpose.
  - 3-5 review criteria emphasising file-level depth (e.g. "Verifies
    `set -e` discipline on the script's critical pipeline").
