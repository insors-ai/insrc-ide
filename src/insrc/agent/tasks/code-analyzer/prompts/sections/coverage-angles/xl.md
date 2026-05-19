## Investigation menu (tier XL+)

This analysis covers a repo or large module. The full menu of areas a
tier-XL+ report investigates is listed below. You are working on ONE
section of this report -- pick the menu items YOUR section's objective
requires, then run the named skill sequence for each. Don't try to
cover every menu item; don't stop after one item if the objective spans
several.

### 1. Functional Overview
Goal: what does this code DO at the top level?
- `code.source.module.describe` on the top-level modules / packages.
- `code.source.file.describe` on README.md, docs/index, top-level
  design docs.

### 2. Platform & Tech Stack
Goal: what language(s), runtime, frameworks?
- `code.source.file.describe` on the manifest(s): package.json, go.mod,
  pom.xml, Cargo.toml, requirements.txt, pyproject.toml.
- Cross-reference with Dockerfile / CI config to see runtime / OS.

### 3. Architecture & Design

Sub-areas:

  a. **Code Organization** -- `code.source.module.describe` on each
     top-level directory to understand how modules / packages are
     split. Look at depth (1-level vs deeply nested), naming patterns.

  b. **Coding Conventions** -- sample 2-3 representative files via
     `code.source.file.describe` (one each from a domain / service /
     util layer). Look for class style, error-handling pattern, log
     usage, naming.

  c. **Data Persistence design** -- `code.entity.locate-by-name` for
     repo / DAO / Manager / *Store / *Repository classes.
     `code.source.file.describe` on migration / schema definition
     files (sql / migrations/, models/). Look for ORM markers
     (SQLAlchemy, Hibernate, GORM, Sequelize).

  d. **Configuration framework** -- `code.source.file.describe` on
     config files (*.yaml / *.toml / *.properties / *.json /
     application.conf). `code.entity.locate-by-name` for *Config /
     *Settings / Properties classes. Identify how config loads
     (env vars / files / hierarchical).

### 4. Key Endpoints
Goal: how does the outside world interact with this code?
- HTTP: `code.entity.locate-by-name` for *Controller / *Handler /
  *Resource / *Servlet / *Endpoint.
- Messaging: locate *Producer / *Consumer / *Subscriber / *Listener
  / *Topic.
- CLI: locate `main` functions or argparse / commander / cobra entry
  points.
- gRPC / Thrift: locate .proto / .thrift definition files via
  `code.source.file.describe`.

### 5. Testing Framework
Goal: what's tested, how, with which framework?
- `code.source.module.describe` on top-level test / tests /
  __tests__ / spec dirs.
- `code.source.file.describe` on a build / test config file
  (gradle, pytest.ini, jest.config, vitest.config).
- `code.entity.locate-by-name` for test base classes (*TestBase /
  *Spec / Fixtures) or test utility modules.

### 6. Deployment
Goal: how does this code ship?
- `code.source.file.describe` on Dockerfile / docker-compose.yml.
- `code.source.file.describe` on k8s manifests (deploy / service /
  configmap) under deploy/ k8s/ helm/.
- `code.source.file.describe` on CI files (.github/workflows/,
  .gitlab-ci.yml, jenkinsfile).

### 7. External Dependencies
Goal: what does this code depend on outside its own tree?
- Read manifest (covered in item 2) for declared deps.
- Sample import statements from a few representative files; look
  for unusual / heavyweight imports (DBs, message brokers, AI SDKs).
- If applicable: `code.source.module.describe` on `vendor/` or
  `third_party/` for inline deps.

---

## Depth + stop signal (tier XL+)

A tier-XL+ section is a SUBSTANTIVE analysis of a slice of a large
codebase. Investigation expectations:

- **Minimum**: 4 substantive `skill_invoke` calls before you're allowed
  to emit `EVIDENCE_COMPLETE`. Less than that = you almost certainly
  haven't grounded the section.
- **Target**: 6-10 calls for a typical XL+ section -- enough to cover
  the menu items your objective requires, with cross-references where
  the topic is behavioural.
- **Hard cap**: 32 calls (enforced by the section-level budget). If you
  approach this, you're either over-investigating or your skill picks
  are not well-targeted.

A section investigated only via `code.source.module.describe` (zero
file or entity reads) is UNDER-RESEARCHED. Push past the directory
listing into actual files + entities.
