# Scope-tier prompts for the code-analyzer

## Motivation

Run #6 surfaced the problem clearly: in an XL request that decomposed into
12 sections, §1 (HDFS Architecture) invested **8 skill calls / 3 evidence
entries**; §2-§5 (NameNode, DataNode, Client, RPC) each managed **1 skill
call / 1 evidence entry**. The reviewer kept flagging unsupported claims;
the patch loop closed ~30% per round; ship reason fell back to
`citation-diversity` with `confidence=low`.

The generic "investigate 6 angles" guidance in
[sections/coverage-angles.md](../src/insrc/agent/tasks/code-analyzer/prompts/sections/coverage-angles.md)
doesn't carry enough force on its own to push the local LLM past
minimum-effort exploration. The same applies to the patch loop's coverage
hints.

Fix: **dispatch the exploration narrative by run-tier**. An XL run uses
the XL+ checklist (functional overview / tech stack / arch / code org /
coding conv / data persistence / config / endpoints / testing / deploy /
ext deps). An L run uses the L checklist. Same for M and S. Concrete,
prescriptive lists replace abstract angles.

## Decisions

Locked in from the design conversation:

| Decision | Choice |
|---|---|
| Dispatch axis | **Per-run tier** (`CodeAnalysisState.tier`), already classified by the local LLM |
| Tier collapse | XL / XXL / XXXL / XXXXL → all use the **XL+** checklist. S, M, L keep their own |
| `enhance` work-item kind | **Removed**; folded into `fix`. Schema kind enum becomes `fix \| add \| trim` |
| Cloud planner | Receives the per-tier checklist as context so it generates aligned sections |
| Local LLM | Receives the SAME per-tier checklist as a guideline for each section's gather / patch |
| Flows that get tier-aware narratives | **gather, fix, add** |
| Flows that stay tier-agnostic | write, review |
| Cloud planner architecture | Framework stays shared (`agent/content-gen/plan-actions.ts`); caller (code-analyzer orchestrator) injects code-analyzer-specific tier context as a planner-prompt fragment |

## Per-tier exploration checklists (content)

These become MD section files. Source content is the user's spec from the
design conversation, plus a few S-tier additions (config validation, DB
migration safety, shell-script discipline, secret-leak risk) that I'll
draft and the user will red-pen.

### XL+ — repo or large module

- Functional Overview
- Platform & Tech Stack
- Architecture & Design
  - Code Organization
  - Coding Conventions
  - Data Persistence design
  - Configuration framework
- Key Endpoints (service / messaging / CLI / etc.)
- Testing Framework
- Deployment
- External Dependencies

### L — medium to large module

- Module functionality
- Exposed endpoints
- Data Persistence details
- Dependencies — internal + external
- Test coverage specific to this module
- Deployment artifacts (relevant configs that affect this module)

### M — specific functionality

- Module functionality
- Detailed code analysis (graph + non-graph; analyze deps; persistence:
  cache / DB / file stores)
- Semantic / syntactic issues in the module
- Test coverage analysis
- Configuration analysis

### S — 2-3 files (code / config / deploy / DB scripts)

- In-depth review of the files (incl. nested deps, persistence touches)
- Semantic / syntactic checks (especially for python / shell scripts)
- Usage review (callers + risks: missing guards, arguments, etc.)
- Additions to draft (red-pen welcome):
  - **Config / env files**: verify referenced keys / env vars / paths
    are real (no dangling references)
  - **DB migration scripts**: forward-compatible vs breaking, transaction
    safety
  - **Shell scripts**: `set -e` / `set -u` discipline, quoted vars, exit
    codes propagating through pipelines
  - **Build / deploy scripts**: secret-leak risk (echo / `set -x` with
    secrets in scope)

## Drafted gather narratives (one per tier)

The following are the actual MD content that will land at
`sections/coverage-angles/{xl,l,m,s}.md`. Each one is what the local
LLM sees in its system prompt for a gather call at that tier. Red-pen
welcome -- the wording, skill picks, and depth floors are all in
play.

The tier narratives **assume the LLM has read the shared skill
glossary** (drafted next). Vocabulary used in the tier menus -- "module",
"file", "entity", "caller", "Chain A", "Chain B" -- maps to specific
catalog skills + arg names there. The glossary lives at
`sections/skill-glossary.md` and is wired into every gather + patch
flow alongside the per-tier coverage-angles section.

### `sections/skill-glossary.md` (shared across all gather + patch flows)

```markdown
## Skill primitives (term mapping for this catalog)

The menus below use plain-language terms ("module", "file", "entity",
"caller"). They map to SPECIFIC catalog skills with SPECIFIC argument
names. The catalog is strict (`additionalProperties: false`) -- using
the wrong arg name will be rejected with an invalid-input error and
that call wastes your tool-call budget.

ALWAYS call `skill_describe({ id })` for a skill the first time you
use it. Read the input schema. Then use the EXACT arg names from the
schema in your `skill_invoke` call.

### Vocabulary -> skill mapping

| What the menu says | Catalog skill | Required args | Returns |
|---|---|---|---|
| "the repo's module list" / "what directories are top-level" | `code.source.repo.describe` | (none; uses session repo) | module list sorted by file count |
| "summarise this **module**" (a directory of source files) | `code.source.module.describe` | `modulePath` (absolute dir), `repoPath` (absolute repo root) | files, entity ids, sub-modules |
| "summarise this **file**" / "enumerate its entities + imports" | `code.source.file.describe` | `file` (absolute path -- NOT `path`), `repoPath` | language, entity ids, imports |
| "**locate** an entity by name" (class / function / method / etc.) | `code.entity.locate-by-name` | `name` (string); optional `kinds` (array of strings), `repoPath`, `language` | entity ids of matches |
| "**read** an entity's body" / "what does this entity do" | `code.entity.summary` | `entityId` (32-char hex; from a prior lookup) | typed metadata + body excerpt |
| "**who calls** this entity" | `code.entity.callers` | `entityId` (32-char hex) | calling entities (1-hop CALLS in-edges) |
| "**semantic search** for entities" (when you don't know the name) | `code.entity.search-by-vector` | `query` (string); optional `limit`, `filter` | top-K semantically similar entities |

### Standard skill chains

`summary` / `callers` cannot be called standalone -- they need an
`entityId`, which is a 32-char hex string that ONLY `locate-by-name`,
`search-by-vector`, `file.describe`, or `module.describe` emit. Use
one of these two canonical chains:

**Chain A: name-known investigation** -- you have a class / function
name and want to read its actual body or find its callers:

  1. `locate-by-name({ name: "FooHandler" })` -- get entity ids
  2. `summary({ entityId: <id from step 1> })` -- read the body
  3. (optional) `callers({ entityId: <id> })` -- find who uses it

**Chain B: module-down investigation** -- you want to map a directory's
shape and pick interesting entities to read:

  1. `repo.describe()` -- get the module list (skip if you already
     know the modulePath you want)
  2. `module.describe({ modulePath, repoPath })` -- get the files +
     entity ids in the module
  3. For each interesting file: `file.describe({ file, repoPath })`
     -- get entity ids defined in that file
  4. For the most important entities: `summary({ entityId })` -- read
     body

### Common arg-shape mistakes (observed in prior runs)

- `code.source.file.describe` takes `file`, **not** `path`. Passing
  `path` fails with `unexpected property 'path'`.
- `code.source.module.describe` takes `modulePath` + `repoPath`,
  **both** required, **both** absolute paths.
- `code.entity.summary` takes `entityId` (32-char hex), **not**
  `name`. You cannot summarise an entity by its name -- locate it
  first.
- `kinds` on `code.entity.locate-by-name` is an ARRAY of strings
  (e.g. `["class", "function"]`), not a single string.

When in doubt, call `skill_describe({ id })` first. Once per skill
per section is enough; the orchestrator caches.
```

---

### `sections/coverage-angles/xl.md`

```markdown
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
```

### `sections/coverage-angles/l.md`

```markdown
## Investigation menu (tier L)

This analysis covers a medium-to-large module. You are working on ONE
section of this report -- pick the menu items YOUR section's objective
requires, then run the named skill sequence.

### 1. Module functionality
Goal: what does this module DO + what are its public entry points?
- `code.source.module.describe` on the module.
- `code.entity.locate-by-name` for the module's named exports /
  public classes / public functions.
- `code.entity.summary` on the most important 2-3 entities to read
  what they actually implement.

### 2. Exposed endpoints
Goal: how is this module called?
- `code.entity.locate-by-name` for *Controller / *Handler /
  *Endpoint / message receivers within the module.
- For internal-only modules: callers of the public surface --
  who imports it, how.

### 3. Data Persistence details
Goal: does the module touch a DB / cache / file store?
- `code.entity.locate-by-name` for repo / DAO / Manager / *Store /
  *Cache classes within the module.
- `code.source.file.describe` on migration / schema files for the
  module's tables, if any.
- Identify the persistence client (DB driver, ORM, redis client,
  S3 client) actually used.

### 4. Dependencies (internal + external)
Goal: what does this module depend on?
- Internal: which OTHER modules in this repo does it import?
  `code.source.module.describe` on the heavily-imported modules.
- External: which third-party packages? Sample 1-2 import-heavy
  files via `code.source.file.describe`.

### 5. Test coverage
Goal: how well-tested is this module's surface?
- `code.source.module.describe` on the module's test directory
  (or sibling `__tests__/` or `*_test.go`).
- `code.source.file.describe` on the test file(s) covering the
  module's main entry points.

### 6. Deployment artifacts (configs that affect this module)
Goal: how does this module get configured at deploy time?
- `code.source.file.describe` on any module-specific config files
  / env var docs.
- Identify which config keys the module actually reads
  (`code.entity.locate-by-name` for getEnv / config.get callers).

---

## Depth + stop signal (tier L)

A tier-L section explores ONE module in depth (not the whole repo).

- **Minimum**: 3 substantive `skill_invoke` calls before
  `EVIDENCE_COMPLETE`. Less = you haven't grounded the module's shape.
- **Target**: 4-7 calls -- a module's functionality + endpoints +
  persistence + tests can usually be covered in this range.
- **Hard cap**: 32 calls. Approach this only if the module spans many
  subsystems.

A section that hasn't called `code.entity.summary` at least once is
likely under-researched -- you've described directories but not read
actual code.
```

### `sections/coverage-angles/m.md`

```markdown
## Investigation menu (tier M)

This analysis covers a specific functionality / feature. Depth is the
priority -- read actual code, not just module summaries. You are
working on ONE section of this report; pick the relevant menu items +
run the named skill sequence.

### 1. Module functionality (the feature)
Goal: WHAT does this specific functionality do?
- `code.entity.locate-by-name` for the named class / function /
  module the feature lives in.
- `code.entity.summary` on the central entity -- you MUST read it,
  not just locate it.
- `code.source.file.describe` on the file holding it for line-range
  context.

### 2. Detailed code analysis (deps + persistence)

Sub-areas:

  a. **Dependencies** -- look at WHAT the central entity calls
     (outbound) and WHO calls it (inbound). Use whatever
     `code.entity.*` skills the catalog exposes for callers /
     callees. Surface both internal (this repo) and external
     (third-party package) deps.

  b. **Data persistence** -- if the feature touches storage:
     - DB: identify the table(s), the query layer, the migration
     - Cache: identify the cache client, key shape, TTL/invalidation
     - File stores: identify the storage client (S3 / fs), path
       convention, lifecycle
     `code.source.file.describe` on the persistence files involved.

### 3. Semantic / syntactic issues
Goal: are there code-quality problems in the feature?
- Look for missing error handling on critical paths.
- Look for ignored return values, swallowed exceptions.
- Look for type issues (Python: missing type hints in a typed
  codebase; TS: `any` leaks; Go: ignored errors via `_ = err`).
- These come from `code.entity.summary` on the file's main
  entities; you read the actual code and judge.

### 4. Test coverage
Goal: is THIS feature tested?
- `code.entity.locate-by-name` for `Test<FeatureName>` /
  `test_<feature>` / a spec file matching the feature.
- If not located: that's a finding ("no direct test coverage for
  this feature").
- If located: `code.source.file.describe` on the test file.

### 5. Configurations
Goal: what config affects this feature's behaviour?
- Identify env vars / settings keys the central entity reads.
- `code.source.file.describe` on the config file(s) declaring them.
- Surface default values + their conditions.

---

## Depth + stop signal (tier M)

A tier-M section is a DEEP analysis of a single feature. Quality >
breadth.

- **Minimum**: 3 substantive `skill_invoke` calls before
  `EVIDENCE_COMPLETE`, AT LEAST ONE of which is `code.entity.summary`
  (you've read code, not just located it).
- **Target**: 4-8 calls -- the feature itself + its primary
  callers/callees + its persistence + its tests + its config can
  usually be covered here.
- **Hard cap**: 32. M-tier rarely needs more than 10 if your picks
  are well-targeted.

A tier-M section that NEVER opens an actual code file (no
`code.entity.summary` and no `code.source.file.describe`) is a
hallucination risk -- you're working from module summaries alone.
PUSH PAST.
```

### `sections/coverage-angles/s.md`

```markdown
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
  entities (if the catalog exposes a callers skill).
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
```

## File layout

One new shared section + three new per-tier section trees:

```
src/insrc/agent/tasks/code-analyzer/prompts/sections/
  skill-glossary.md                  ← NEW: catalog vocabulary + canonical chains + arg-shape gotchas (shared across all gather + patch flows)
  coverage-angles/                   ← replaces existing coverage-angles.md (gather)
    xl.md
    l.md
    m.md
    s.md
  coverage-angles-patch/             ← replaces existing coverage-angles-patch.md (patch fix/add)
    xl.md
    l.md
    m.md
    s.md
  planner-context/                   ← NEW: cloud-planner-facing checklist + section-decomposition guidance
    xl.md
    l.md
    m.md
    s.md
```

The existing `coverage-angles.md` and `coverage-angles-patch.md` files
are **removed** as part of this work. `skill-glossary.md` is wired
into every gather + patch flow file (between `skill-usage` and
`coverage-angles/{{TIER}}`).

## Templating change

The flow files need to dispatch on `{{TIER}}` inside a section path:

```markdown
{{section:coverage-angles/{{TIER}}}}
```

The current loader resolves `{{section:...}}` first (BEFORE variable
substitution) and rejects nested `{{}}`. The change: **resolve `{{VAR}}`
placeholders inside the section directive's path before looking up the
file**. One loader-side edit, no schema impact for callers that don't use
the feature.

Variable contract update:
- Gather flow: existing `SKILL_CATALOG` + `REPO_CONTEXT` → add `TIER`
  (one of `xl`, `l`, `m`, `s` — caller normalizes XL/XXL/XXXL/XXXXL → `xl`)
- Patch flow: same — `SKILL_CATALOG` + `REPO_CONTEXT` + `TIER`
- Write + Review flows: unchanged (no tier dependency)

## Cloud-planner injection

`plan-actions.ts` is shared between code-analyzer and data-analyzer.
Don't bake code-analyzer-specific checklist content there. Instead:

1. Add a `tierContext?: string` parameter to the planner call (or to the
   `buildSystemPrompt` it uses).
2. The code-analyzer orchestrator loads
   `sections/planner-context/{tier}.md` and passes the rendered string in.
3. The planner's system prompt template gets a `{{TIER_CONTEXT}}`
   placeholder. Empty string when the caller doesn't supply (data-analyzer
   path stays untouched).

The planner-context content for each tier is similar in spirit to the
gather-side checklist but framed for the cloud planner's decomposition
task: "for a tier-XL analysis, decompose into sections aligned with the
following coverage menu: ...". The planner sees the same vocabulary the
local LLM will later see.

## `enhance` removal (bundled with this work)

Cleanup that lands alongside the tier dispatch:

- `agent/content-gen/schema.ts`: `kind` enum becomes `['fix', 'add', 'trim']`.
- `agent/content-gen/review-action.ts`:
  - `WorkItemKind` type drops `'enhance'`.
  - `validateReview` accepts `fix | add | trim` only.
  - `correctiveSuggestion` mapping retargets `"clarify" / "expand" /
    "elaborate" / "specify" → use **fix**` instead of `enhance`.
- `prompts/sections/review-rules.md`: drop the `enhance` bullet from
  "When to pick each work-item kind"; expand `fix` to cover "thin /
  under-cited" cases the old enhance kind handled.
- `prompts/loader.ts`: `PatchKind = 'fix' | 'add'`.
- Delete:
  - `prompts/flow/patch/enhance/system.md` (and the `enhance/` dir)
  - `prompts/sections/role-patch-enhance.md`
  - `prompts/sections/output-format/patch-enhance.md`
  - `__tests__/prompts-golden/patch-enhance.txt`
- `agent/tasks/code-analyzer/write-section.ts`:
  - `runItemWithSkills`: drop the `kind === 'enhance'` branches (intro,
    outputRule, flagHeader, replaces, target-paragraph header).
  - `patchSectionItemwise`: drop enhance-aware ordering / accounting.
- Test updates: snapshot tests + loader tests drop the enhance kind /
  golden / smoke assertions.

Implication for the picker: with `enhance` gone, ALL `needs-work` items
become `fix` items, which means EVERY needs-work item gates section
confidence. This is consistent with what we've already observed in
practice (the patch loop already routed enhance through `runItemWithSkills`
like fix), but the picker's `fixItemsUnaddressedFinal` threshold may
behave differently. Watch the next run's confidence distribution.

## Migration phases

### Phase A — loader + variable-in-section-path support (no behaviour change)

- Loader change: section directives accept `{{VAR}}` placeholders in
  their paths, substituted before file lookup. Add a depth guard around
  the new pass (same depth limit as section recursion).
- New unit tests:
  - `{{section:path/{{X}}}}` with `X = 'foo'` resolves to
    `sections/path/foo.md`.
  - Missing `X` throws with the same loud error as a missing top-level
    variable.
- No flow-file or production-code changes yet.

### Phase B — remove `enhance` (refactor, no scope dispatch)

- All edits listed under "enhance removal" above.
- Snapshot goldens regenerated (patch-fix, patch-add, review — patch-enhance
  golden deleted).
- All existing tests pass with `kind` enum reduced to three values.

### Phase C — per-tier section files (drafted; not yet dispatched)

- Land `sections/skill-glossary.md` (the shared vocabulary + chain
  reference). Wire it into the gather + patch flow files **before**
  any tier-specific section so the LLM has read the chain mechanics
  before it sees the per-tier menu.
- Land `sections/coverage-angles/{xl,l,m,s}.md` with the per-tier
  checklists from the "Drafted gather narratives" section above.
- Land `sections/coverage-angles-patch/{xl,l,m,s}.md` (same content
  as gather but reframed for "the reviewer asked you to revise this
  paragraph; here's how to investigate at this tier").
- Land `sections/planner-context/{xl,l,m,s}.md` for the cloud planner.
- Keep the existing `coverage-angles.md` + `coverage-angles-patch.md`
  files in place (still referenced by the flow files). No production
  behaviour change yet.
- Unit tests load each per-tier file + the glossary + assert non-empty.

### Phase D — flip gather + patch flows to tier dispatch

- `flow/gather/system.md`: replace `{{section:coverage-angles}}` with
  `{{section:coverage-angles/{{TIER}}}}`.
- `flow/patch/fix/system.md` + `flow/patch/add/system.md`: replace
  `{{section:coverage-angles-patch}}` with
  `{{section:coverage-angles-patch/{{TIER}}}}`.
- `gather-evidence.ts buildSystemPrompt`: pass `TIER` variable; the
  caller (orchestrator) supplies tier from state. Normalize XL+ tiers
  (XL/XXL/XXXL/XXXXL) → `xl`.
- `write-section.ts runItemWithSkills`: same pass-through.
- Orchestrator (`daemon/controllers/code-analyzer-orchestrator.ts`)
  threads `state.tier` into `GatherEvidenceInput` and
  `PatchSectionItemwiseInput`.
- Delete the now-orphaned `coverage-angles.md` + `coverage-angles-patch.md`
  files. Update snapshot tests + regenerate goldens.

### Phase E — cloud-planner tier context

- `agent/content-gen/plan-actions.ts`: add `tierContext?: string`
  parameter to the public planner entry point; system-prompt template
  gets a `{{TIER_CONTEXT}}` placeholder, defaulting to empty.
- Code-analyzer orchestrator loads
  `sections/planner-context/{tier}.md` via `loadPromptFile` and passes
  it in.
- Data-analyzer path: unchanged (doesn't pass `tierContext`).
- Test: planner output for a fixed tier-XL request includes the XL
  decomposition vocabulary (section names cover the XL menu).

### Phase F — empirical validation

- Run code-analyzer on the same Hadoop test repo at tier-XL.
- Compare against run #6 baseline:
  - Cumulative skill calls per section (target: every section ≥ 4,
    not §2-5's 1)
  - `confidence` distribution (target: more medium + high, fewer low)
  - `fixItemsUnaddressedFinal` (target: trending toward 0)
  - `shipDecisionReason` distribution (target: more
    `accept@roundN`, less `citation-diversity` fallback)

## Test strategy

- Loader unit tests cover variable-in-section-path resolution.
- Per-tier section files asserted non-empty + properly resolvable for
  each tier value.
- Flow snapshot tests run **once per tier** (gather + patch-fix +
  patch-add): 4 tiers × 3 flows = 12 new snapshot tests + 12 new golden
  files. The existing two-snapshot pattern (with vs without repo-context)
  collapses; per-tier snapshots cover both code paths in the section
  dispatch.
- Review + write snapshot tests unchanged (tier-agnostic).
- An integration smoke test: orchestrator loaded with each tier value
  in fixture state, builds a valid gather + patch prompt without
  throwing.

## Risks + open notes

- **Per-tier checklist mismatches the section's actual scope.** In an XL
  decomposed into 12 sub-system sections, "Functional Overview" applies
  to §1 but the rest are sub-system-specific. The XL checklist is the
  *menu* the model picks from; the prompt makes that explicit ("you're
  one section of an XL analysis; pick the menu items relevant to YOUR
  section's objective"). If the model still over-investigates we revisit.
- **Per-tier checklist conflicts with skill catalog.** The XL bullet
  "Data Persistence design" implies skills like `code.source.module.describe`
  on persistence layers + `code.entity.locate-by-name` for repository/DAO
  classes + `code.source.file.describe` on schema/migration files. The
  per-tier MDs should NAME the skill sequence concretely rather than
  describing the abstract goal, otherwise we're back where we started.
- **Cloud planner over-decomposes.** If the planner sees the XL menu and
  emits 15 sections for a typical XL repo (too granular), tier-XL runs
  get slower without obvious quality gain. Watch section count + total
  runtime in Phase F.
- **Loader change is the riskiest atomically.** It touches every flow's
  prompt resolution. Phase A lands isolated with unit tests so the
  variable-in-section-path feature is exercised before downstream
  phases depend on it.

## Out of scope

- Per-section scope (option (b) from the design conversation). If
  per-run tier proves insufficient after Phase F we revisit.
- Data-analyzer adopting the same scheme. It already has tier-aware
  prompts via `data-analyzer/prompts/analyzer-system.ts`; migrating to
  the shared MD loader is a separate effort.
- Reviewer becoming tier-aware (the user opted out).
