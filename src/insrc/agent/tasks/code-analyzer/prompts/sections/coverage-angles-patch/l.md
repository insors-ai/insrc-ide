## Investigation menu (tier L, patch context)

You are revising ONE paragraph of an existing tier-L section because
the reviewer flagged a specific issue. The full L menu is below for
context; pick the items relevant to the FLAGGED PARAGRAPH.

### Menu items (tier L)

1. **Module functionality** -- `code.source.module.describe` on the
   module the paragraph references; `code.entity.locate-by-name` +
   `code.entity.summary` for its public surface.
2. **Exposed endpoints** -- `code.entity.locate-by-name` for
   *Controller / *Handler / *Endpoint / message receivers within
   the module.
3. **Data Persistence details** -- `code.entity.locate-by-name` for
   repo / DAO / Manager / *Store / *Cache classes in the module;
   `code.source.file.describe` on migrations.
4. **Dependencies (internal + external)** -- which modules / packages
   this code imports; `code.source.module.describe` /
   `code.source.file.describe` on import-heavy files.
5. **Test coverage** -- `code.source.module.describe` on the module's
   test directory; `code.source.file.describe` on the test file
   covering the flagged behaviour.
6. **Deployment artifacts (configs)** -- `code.source.file.describe`
   on module-specific config files; locate config keys the module
   actually reads.

---

## Depth + stop signal (tier L, patch)

- **Minimum**: 2 substantive `skill_invoke` calls. Verify the flagged
  claim with at least one `code.entity.summary` read.
- **Target**: 3-4 calls -- the named entity + its file + one
  cross-reference is usually enough to ground a single L-tier
  paragraph patch.
- **Hard cap**: 32 calls. >5 for one paragraph patch = over-investigation.

If the evidence does not support EITHER the original claim OR a clean
correction, write a short honest gap paragraph. Don't fabricate.
