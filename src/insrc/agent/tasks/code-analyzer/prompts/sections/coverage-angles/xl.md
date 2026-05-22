## Per-step investigation depth (tier XL+)

This section's scope is a LARGE SLICE of a repo (or the whole repo).
Each plan step you emit should zoom in on ONE subsystem / one
architectural layer / one cross-cutting concern, not try to cover the
whole slice in one step. Total step count is set by the
discovery-expand prompt (driven by `reviewCriteria.length`), not by
this menu.

The menu below lists the architectural concerns a tier-XL+ section
typically wants to surface. Pick the concern(s) your section's
`reviewCriteria` call for and emit ONE step per concern -- each step
picks 3-5 skills at COARSE granularity (one or two `module.describe`s
+ targeted summaries of representative entities, not a deep dive
into every file).

### Concern A: Functional overview of a subsystem
What does this slice of the codebase DO at the top level?
- `code.source.module.describe` on the top-level modules / packages
  in scope.
- `code.source.file.describe` on README.md, docs/index, top-level
  design docs.

### Concern B: Platform & tech stack
What language(s), runtime, frameworks does this slice use?
- `code.source.file.describe` on the manifest(s): package.json,
  go.mod, pom.xml, Cargo.toml, requirements.txt, pyproject.toml.
- Cross-reference with Dockerfile / CI config to see runtime / OS.

### Concern C: Architecture & design (organization, conventions, persistence, config framework)
Sub-areas:

  - **Code organization** -- `code.source.module.describe` on each
    top-level directory; understand how modules split, depth (flat
    vs nested), naming patterns.
  - **Coding conventions** -- sample 2-3 representative files via
    `code.source.file.describe` (one each from a domain / service /
    util layer). Look for class style, error-handling pattern, log
    usage, naming.
  - **Data persistence design** -- `code.entity.locate-by-name` for
    repo / DAO / Manager / *Store / *Repository classes.
    `code.source.file.describe` on migration / schema files (sql,
    migrations/, models/). Look for ORM markers (SQLAlchemy,
    Hibernate, GORM, Sequelize).
  - **Configuration framework** -- `code.source.file.describe` on
    config files (*.yaml / *.toml / *.properties / *.json /
    application.conf). `code.entity.locate-by-name` for *Config /
    *Settings / Properties classes. Identify how config loads
    (env vars / files / hierarchical).

### Concern D: Key endpoints (how the outside world talks to this code)
- HTTP: `code.entity.locate-by-name` for *Controller / *Handler /
  *Resource / *Servlet / *Endpoint.
- Messaging: locate *Producer / *Consumer / *Subscriber / *Listener
  / *Topic.
- CLI: locate `main` functions or argparse / commander / cobra entry
  points.
- gRPC / Thrift: locate .proto / .thrift definition files via
  `code.source.file.describe`.

### Concern E: Testing framework
What's tested, how, with which framework?
- `code.source.module.describe` on top-level test / tests /
  __tests__ / spec dirs.
- `code.source.file.describe` on a build / test config file
  (gradle, pytest.ini, jest.config, vitest.config).
- `code.entity.locate-by-name` for test base classes (*TestBase /
  *Spec / Fixtures) or test utility modules.

### Concern F: Deployment
How does this code ship?
- `code.source.file.describe` on Dockerfile / docker-compose.yml.
- `code.source.file.describe` on k8s manifests (deploy / service /
  configmap) under deploy/ k8s/ helm/.
- `code.source.file.describe` on CI files (.github/workflows/,
  .gitlab-ci.yml, jenkinsfile).

### Concern G: External dependencies
What does this code depend on outside its own tree?
- Read manifest (covered in concern B) for declared deps.
- Sample import statements from a few representative files; look
  for unusual / heavyweight imports (DBs, message brokers, AI SDKs).
- If applicable: `code.source.module.describe` on `vendor/` or
  `third_party/` for inline deps.

---

## Per-step picking rules (tier XL+)

- Each plan step's `intent` should name ONE concern, not the whole
  slice. Example good intents:
  - "Survey the NameNode subsystem -- locate the NameNode class +
    summarise its initialization flow"
  - "Map the persistence layer at the architectural level -- locate
    *Manager / *Repository / migration files across the in-scope
    modules"
- 3-5 skills per step at coarse granularity (one or two
  `module.describe`s + a few `code.entity.summary` calls on
  representative entities). Don't try to deeply read every file in a
  subsystem in one step -- that's what a follow-up M / L drill-down
  is for.
- A step that ONLY calls `module.describe` (zero file / entity reads)
  is under-grounded. Pick one or two anchor entities per concern and
  summary them so the writer has named classes to cite.
