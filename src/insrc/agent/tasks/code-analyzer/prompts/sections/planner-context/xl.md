## Decomposition guidance (tier XL+)

This is a tier-XL+ code analysis -- the scope is a full repository or
a large module. Decompose the analysis into sections that together
cover the following menu. You don't have to emit one section per menu
item; cluster related items into coherent sections where it makes
sense.

### Coverage menu (XL+)

1. **Functional Overview** -- what does this code DO at the top level?
2. **Platform & Tech Stack** -- language(s), runtime, frameworks,
   build system.
3. **Architecture & Design**:
   a. Code Organization (top-level module split, depth, naming)
   b. Coding Conventions (class style, error handling, log usage)
   c. Data Persistence design (DBs, caches, file stores, ORMs)
   d. Configuration framework (where config comes from, how it loads)
4. **Key Endpoints** -- HTTP / messaging / CLI / gRPC entry points.
5. **Testing Framework** -- what's tested, how, with what framework.
6. **Deployment** -- Dockerfile, k8s manifests, CI.
7. **External Dependencies** -- third-party packages + their roles.

### Section-count guidance

- Aim for 6-10 sections for a typical XL+ repo. Too few (3-4) means
  each section is a kitchen sink; too many (>12) fragments the report.
- Group related architectural concerns -- "Architecture & Design"
  often splits into 2-3 sub-sections (Organization + Persistence +
  Configuration), but doesn't need to be 4.
- A "Functional Overview" or "Module Layout" section is usually the
  natural opener.
- Reserve dedicated sections for high-risk areas (auth, persistence,
  endpoints) where appropriate.

### Naming + scope per section

Each section needs:
  - A specific title (not "Architecture" -- prefer "HDFS Architecture
    & Core Components" or similar that names the codebase).
  - An objective sentence describing what the section's content will
    cover.
  - 3-5 review criteria -- concrete checks the reviewer can score
    against (e.g. "Names the persistence client(s) used and the table
    or file-system layout").
