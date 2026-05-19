## Investigation menu (tier XL+, patch context)

You are revising ONE paragraph of an existing tier-XL+ section because
the reviewer flagged a specific issue. The full XL+ investigation menu
is below for context, but you are NOT redoing the whole section --
pick the menu items relevant to the FLAGGED PARAGRAPH and investigate
only enough to address the reviewer's note.

### Menu items (tier XL+)

1. **Functional Overview** -- `code.source.module.describe` on the
   top-level module(s) the paragraph references.
2. **Platform & Tech Stack** -- `code.source.file.describe` on
   manifests (package.json / go.mod / pom.xml / requirements.txt).
3. **Architecture & Design** --
   - Code Organization: `code.source.module.describe` on the named dir
   - Coding Conventions: sample 2-3 representative files via
     `code.source.file.describe`
   - Data Persistence: `code.entity.locate-by-name` for repo / DAO /
     *Store classes; `code.source.file.describe` on migrations
   - Configuration: `code.source.file.describe` on config files;
     `code.entity.locate-by-name` for *Config / *Settings
4. **Key Endpoints** -- `code.entity.locate-by-name` for *Controller /
   *Handler / *Endpoint / *Producer / *Consumer / *Subscriber, or
   `code.source.file.describe` on .proto / .thrift files.
5. **Testing Framework** -- `code.source.module.describe` on test
   dirs; `code.source.file.describe` on build / test config files.
6. **Deployment** -- `code.source.file.describe` on Dockerfile / k8s
   / CI manifests.
7. **External Dependencies** -- read the manifest; sample
   import statements via `code.source.file.describe`.

---

## Depth + stop signal (tier XL+, patch)

Patch investigation is narrower than gather -- you're grounding ONE
paragraph, not the whole section.

- **Minimum**: 2 substantive `skill_invoke` calls before emitting the
  replacement paragraph. Fewer = you're likely paraphrasing the
  reviewer's flag without verifying.
- **Target**: 3-5 calls -- enough to verify the flagged claim AND its
  citation, with one cross-reference for confidence.
- **Hard cap**: 32 calls (section-level budget). For a single paragraph
  patch, anything above ~8 is over-investigating.

If the investigation confirms the reviewer was right, write a corrected
paragraph grounded in what you found. If the evidence does not support
EITHER the original claim OR a clean correction, write a short honest
gap paragraph -- don't fabricate.
