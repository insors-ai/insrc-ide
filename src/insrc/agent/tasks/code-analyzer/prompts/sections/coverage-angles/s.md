## Investigation menu (tier S)

This analysis is a FILE-LEVEL review of 2-3 specific files. Read each
file deeply, then walk callers + nested deps. You are working on ONE
section of this report; pick the relevant menu items.

### 1. In-depth file review
Goal: what does each file DO, line-range by line-range?
- `code.source.file.describe` on EACH target file.
- `code.entity.summary` on every named entity the file exports.
- Surface line ranges in your evidence so the writer can cite them
  precisely.

### 2. Nested dependencies
Goal: what does each file IMPORT, and what does the imported code do?
- For each non-stdlib import, `code.entity.locate-by-name` then
  `code.entity.summary` to read the imported target.
- For internal-repo imports specifically: chase to depth-1 or
  depth-2 (don't recurse forever; one or two hops is enough to
  understand the file's effective behaviour).

### 3. Data persistence touches
Goal: does the file read/write storage?
- Look for DB queries / cursor opens / file opens / cache calls in
  `code.entity.summary` output.
- For DB: name the query, the table, whether it's parameterized vs
  string-formatted.
- For files: name the path / pattern, the open mode, whether it
  closes on all paths.

### 4. Semantic + syntactic checks
Goal: what's BAD or RISKY about how the file is written?
- Code quality: missing error handling, ignored returns, swallowed
  exceptions, type leaks.
- For Python / shell scripts: check for `set -e` / `set -u`
  discipline, quoted-vs-unquoted variable expansions, exit-code
  propagation.
- For config / env files: verify referenced keys / env vars / paths
  are real (no dangling references to vars defined elsewhere).
- For DB migration scripts: forward-compatible vs breaking,
  transactional safety.
- For build / deploy scripts: secret-leak risk (echo / `set -x`
  with secrets in scope).

### 5. Usage review (callers with risks)
Goal: who uses this file, and do they use it CORRECTLY?
- `code.entity.locate-by-name` for callers of the file's exported
  entities, OR `code.entity.callers` once you have entity ids.
- For each caller: judge whether they pass required guards (auth
  checks, input validation, lock acquisition), the right argument
  types, handle the documented error paths.
- Surface risks ("caller X does not handle the ValueError that
  function Y can raise") as evidence facts.

---

## Depth + stop signal (tier S)

A tier-S section is a FILE-LEVEL deep dive. Coverage of the listed
files MUST be near-exhaustive.

- **Minimum**: 1 `code.source.file.describe` AND 2 `code.entity.summary`
  calls per target file. For 2 target files that's a 6-call floor.
- **Target**: 8-15 calls -- the files + their entities + their callers
  + their nested deps + their config touches.
- **Hard cap**: 32.

S-tier with fewer than 4 calls means you didn't open every target
file. That's a structural fail -- the section objective named specific
files and you didn't read them.
