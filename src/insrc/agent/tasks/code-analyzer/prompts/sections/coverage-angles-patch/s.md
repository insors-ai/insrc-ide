## Investigation menu (tier S, patch context)

You are revising ONE paragraph of an existing tier-S section. Tier-S
is FILE-LEVEL review -- 2-3 specific files. The patch must touch the
actual file(s) the paragraph references.

### Menu items (tier S)

1. **In-depth file review** -- `code.source.file.describe` on the
   target file(s) the paragraph references; `code.entity.summary` on
   the named entity within. Surface line ranges so the writer can
   cite precisely.
2. **Nested dependencies** -- for non-stdlib imports referenced by the
   paragraph: `code.entity.locate-by-name` then `code.entity.summary`
   to read the imported target (depth-1 or depth-2 max).
3. **Data persistence touches** -- DB queries / cursor opens / file
   opens surfaced by `code.entity.summary`; for DB queries, name the
   table + whether parameterized.
4. **Semantic + syntactic checks** -- error handling, ignored returns,
   shell-script discipline (`set -e` / quoted vars), config /
   migration safety, secret-leak risk in build scripts.
5. **Usage review (callers with risks)** -- `code.entity.locate-by-name`
   + `code.entity.callers` for callers of the file's exports; judge
   whether each passes the required guards.

---

## Depth + stop signal (tier S, patch)

- **Minimum**: 2 substantive `skill_invoke` calls. The patch MUST
  touch the file the paragraph names (1 `code.source.file.describe`
  AND 1 `code.entity.summary` on the relevant entity).
- **Target**: 3-5 calls -- file + named entity + one caller / nested
  dep / config touch.
- **Hard cap**: 32 calls.

A tier-S paragraph patch that never reads the actual file is a
structural fail. The section objective named specific files; ground
the patch in their actual content.
