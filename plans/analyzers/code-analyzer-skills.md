# Plan: Code Analyzer Skills

Decomposes the code-analyzer's monolithic per-task analyzer runner into a
graph of fine-grained, registered skills. Sister plan to
[plans/analyzers/data-analyzer-skills.md](./data-analyzer-skills.md);
both ride the substrate in
[plans/analyzers/skills-core.md](./skills-core.md). Bakes in the lessons
from the 2026-04-30 hallucinated-class incident -- most directly because
**the fix for that class of bug lives on this side of the cutover**: the
data-analyzer's Phase 3 code-binding skills (which the post-incident
review identified as the structural fix) are blocked on the four
`code.<...>` skills this plan ships first.

## Why decompose?

Today the code-analyzer's per-task work is one bounded LLM tool loop with
one prompt that switches behaviour by `task.kind` (`locate`, `describe`,
`trace`, `compare`, `free-form`). The single-runner approach has two
structural failure modes that mirror the data-analyzer's:

1. **Behaviour leaks across kinds.** A `describe` task on a class
   ("describe `INPurchaseOrder`") and a `describe` task on a module
   ("describe the auth flow") share the same playbook, the same tool
   list, and the same review prompt. When the model can't find the
   class -- because the class is in a JAR, or in a sibling repo, or
   the user typo'd the name -- nothing in the runner forces it to
   say so. The 2026-04-30 incident hallucinated 28 fields for a
   class that didn't exist in the active workspace; the runner had
   no typed contract to refuse against.
2. **Cross-owner skills can't compose without typed contracts.**
   The data-analyzer needs four code-side capabilities (extract a
   class's fields, locate references to a class, resolve an ORM
   model, extract migration history) to ship its Phase 3 + Phase 4.
   Today every cross-owner call routes through the broad
   `code:locate` / `code:trace` / `code:describe` tools whose outputs
   are markdown blobs. The data-analyzer-side wrappers can't tell
   "class found, here are 14 fields" from "class not found, here's
   a near-match" without re-parsing the prose. A typed
   `code.class.extract-fields` skill returns
   `{ found: true, fields: Field[] } | { found: false, nearest: ... }`
   so the data-analyzer's wrapper can refuse cleanly.

Skills give every capability a typed contract (input / output /
preconditions / confidence calibration) and let the orchestrator compose
them. The model sees a small closed set of skill ids per question; the
runner enforces preconditions before any LLM call; the registry
calibrates confidence after the fact. Same structural fix
data-analyzer-skills.md ships, scoped to the code-analyzer.

## Related plans

- [plans/analyzers/skills-core.md](./skills-core.md) -- substrate.
  Required prerequisite. Every phase below assumes the registry,
  `runSkill`, `invoke_skill` meta-tool, `skill_describe` meta-tool, and
  feasibility infrastructure are landed (all shipped).
- [plans/analyzers/code-analyzer.md](./code-analyzer.md) -- existing
  code-analyzer. Orchestrator stays; per-task runner becomes a skill
  composer. The graph tools (`graph_search`, `graph_entity`,
  `graph_query`), `text_grep`, `fs_read`, `fs_list`, and the cross-agent
  tools (`code_locate`, `code_trace`, `code_describe`) stay as the
  primitive layer skills call into.
- [plans/analyzers/data-analyzer-skills.md](./data-analyzer-skills.md) --
  **consumer** of this plan's Phase 3 skills. The data-analyzer-side
  wrappers `data.code.class.extract-fields` /
  `data.code.class.locate-references` / `data.code.orm.resolve-model` /
  `data.code.migration.extract-history` are deferred on this plan's
  Phase 3 landing; ditto every Phase 4 drift / mapping composite that
  transitively depends on those wrappers.
- [plans/analyzers/data-analyzer.md](./data-analyzer.md) -- the
  data-analyzer's substrate / product surface plan. Its skills cutover
  ladder (step 4b shipped) routes through skills only when the
  feature flag is on; flipping the flag to default-on is gated on
  this plan's Phase 3 + 4 landing so schema-drift / class-binding
  questions stop falling back to the legacy data-analyzer runner.
- [plans/storage-migration-lmdb-lance.md](../storage-migration-lmdb-lance.md)
  -- shipped; the LMDB graph + LanceDB embeddings substrate every
  code-side skill reads from.
- [plans/repo-registry-strict-contract.md](../repo-registry-strict-contract.md)
  -- shipped; ensures every Entity carries a u32 `repoId` so
  cross-repo skill calls (closure traversal) can scope cleanly
  without path-string round-trips.

## Status

Pre-implementation. The code-analyzer's monolithic runner +
per-kind playbook is shipped on `release/1.96`. This plan is the
structural cleanup that decomposes it, with **Phase 3 prioritised**
because it unblocks the data-analyzer's Phase 3 + 4 deferred work.

> **Critical-path note.** Phase 3 of *this* plan
> (`code.class.extract-fields` / `code.class.locate-references` /
> `code.orm.resolve-model` / `code.migration.extract-history`) is the
> stated dependency in
> [data-analyzer-skills.md §3](./data-analyzer-skills.md) -- the four
> data-analyzer-side wrappers `data.code.<...>` are thin
> `runSkill('code.<...>', ...)` dispatches that hard-fail their
> `required-tools` precondition until the four code-side skills land.
> Recommend shipping Phase 3 BEFORE the rest of this plan's phases
> if the goal is to unblock data-analyzer-skills' default-on
> cutover.

| Phase | Slice | State | Notes |
|---|---|---|---|
| 0.1 | `code_class_locate` tool (typed class lookup over LMDB graph) | pending | New tool: `{ className, repoPath?, language? }` -> `{ found: true, entityId, path, line, package?, isAbstract?, kind: 'class' \| 'interface' \| 'record' \| ... } \| { found: false, nearest: [{ className, score }] }`. Wraps the existing `name_index` + `graph_entity` lookups. Phase 3 skills layer on top of this so the LLM's surface stays small (one tool call per question) |
| 0.2 | `code_class_fields` tool | pending | New tool: `{ entityId }` -> `{ fields: [{ name, type?, nullable?, default?, modifiers?, declaredAt: { path, line } }] }`. Walks the class's children (`DEFINES` edges in the graph) filtered to `kind: 'variable' \| 'field'` for Java/Scala/Python/TS/Go. Tool-side because the parser-specific extraction is per-language and brittle; encapsulating it once means each Phase 3 skill stays language-agnostic |
| 0.3 | `code_class_references` tool | pending | New tool: `{ entityId, kinds?: ('CALLS' \| 'INHERITS' \| 'IMPLEMENTS' \| 'REFERENCES')[] }` -> `{ references: [{ kind, fromEntityId, fromPath, fromLine, snippet?: string }] }`. Walks `in_edge` / `out_edge` filtered to the requested kinds. Caps at 200 references; surfaces `truncated: true` on overflow |
| 0.4 | `code_orm_scan` tool | pending | New tool: `{ orm: 'prisma' \| 'typeorm' \| 'sqlalchemy' \| 'hibernate' \| 'activerecord' \| 'auto', repoPath? }` -> `{ models: [{ name, table?, columns?: [{ name, type?, nullable? }], path, line, dialect }], detected: { orms: string[] } }`. Auto-detection scans the repo for ORM-fingerprints (`prisma/schema.prisma` files, `@Entity` annotations, `Column()` calls, `class < ApplicationRecord` patterns); explicit dialect skips detection. Per-ORM parsers live in `daemon/tools/builtins/code/orm/<dialect>.ts`; thin shims call the existing tree-sitter walker with ORM-specific entity-pattern matchers |
| 0.5 | `code_migration_walk` tool | pending | New tool: `{ tool?: 'flyway' \| 'liquibase' \| 'knex' \| 'prisma-migrate' \| 'alembic' \| 'rails' \| 'django' \| 'auto', repoPath? }` -> `{ tool, migrations: [{ id, label, path, appliedAt?: string, ddl: { kind, table?, column?, raw } [] }], detected: boolean }`. Auto-detection by directory layout (`db/migrate/*.rb` for Rails, `prisma/migrations/<timestamp>_<name>/migration.sql` for Prisma migrate, `migrations/*.sql` for Flyway, etc.). DDL extraction varies per tool: SQL-based (Flyway / Liquibase / Prisma migrate / Rails when `<<-SQL`) parses with the existing SQL-AST helper; DSL-based (Alembic / Django / Rails ActiveRecord migrations) parses ORM-specific call patterns. Falls back to `confidence: 'low'` + raw text on unparseable migrations |
| 1.1 | source-introspection: `code.source.file.describe` | pending | Atomic: `{ path }` -> `{ language, entities: [{ id, kind, name, line, signature? }], imports: string[] }`. Wraps `fs_read` + the parser's emitted entities for a single file. Used by free-form "what's in this file?" questions |
| 1.2 | source-introspection: `code.source.module.describe` | pending | Atomic: `{ packageName \| modulePath }` -> `{ files: string[], publicSurface: [{ kind, name, path }], dependencies: { internal: string[], external: string[] } }`. Composes per-file introspection over a package-shaped scope |
| 1.3 | source-introspection: `code.source.repo.describe` | pending | Atomic: `{ repoPath? }` -> `{ language: { name, fileCount }[], modules: string[], topLevelEntities: { kind, count }[] }`. Scoped to the active repo; reads from the shipped `RepoSummary` structure the orchestrator already builds |
| 2.1 | entity-lookup: `code.entity.locate-by-name` | pending | Atomic: `{ name, kind?: EntityKind, language?: Language }` -> `{ matches: [{ entityId, path, line, kind, signature? }], truncated: boolean }`. Wraps `code_class_locate` for class names and `graph_search` (vector + name-index) for everything else. Mirror of `data.source.rdbms.list-tables` but for code symbols |
| 2.2 | entity-lookup: `code.entity.summary` | pending | Atomic: `{ entityId }` -> full entity card: `{ name, kind, signature?, body?: string, language, path, lineRange, neighbours: { CALLS: ..., INHERITS: ..., DEFINES: ... } }`. Wraps the shipped `entity_summary` tool with a typed contract |
| 2.3 | entity-lookup: `code.entity.callers` | pending | Atomic: `{ entityId, depth?: number }` -> `{ callers: [{ entityId, path, line }], depth: number, truncated: boolean }`. Wraps `findCallers` from `db/search.ts` |
| 2.4 | entity-lookup: `code.entity.callees` | pending | Atomic: `{ entityId, depth?: number }` -> `{ callees: [{ entityId, path, line }], depth: number, truncated: boolean }`. Symmetric pair to 2.3 |
| **3.1** | **code-binding: `code.class.extract-fields`** ← **data-analyzer-skills §3.1 dependency** | **pending (priority)** | **Atomic. Input: `{ className, repoPath? }`. Output: `{ found: true, entityId, fields: [{ name, type?, nullable?, default?, modifiers?, declaredAt }] } \| { found: false, nearest: [{ className, score }] }`.** Wraps `code_class_locate` + `code_class_fields`. Hard-refuses with `found: false` (not throws) when the class doesn't resolve, surfacing the top-3 vector-similar candidates so the data-analyzer-side wrapper can either prompt the user for a clarification or downgrade its own confidence. **The 2026-04-30 hallucinated-class regression test must go green here before the data-analyzer-side wrapper can land** -- the structural fix is the typed `found: false` discriminator |
| **3.2** | **code-binding: `code.class.locate-references`** ← **data-analyzer-skills §3.2 dependency** | **pending (priority)** | **Atomic. Input: `{ className, kinds?: ('CALLS' \| 'INHERITS' \| 'IMPLEMENTS' \| 'REFERENCES')[], repoPath? }`. Output: `{ found: true, entityId, references: [{ kind, fromEntityId, fromPath, fromLine, snippet }] } \| { found: false, nearest: ... }`.** Wraps `code_class_locate` + `code_class_references`. Same `found:false` discriminator as 3.1 |
| **3.3** | **code-binding: `code.orm.resolve-model`** ← **data-analyzer-skills §3.3 dependency** | **pending (priority; largest of the four)** | **Atomic. Input: `{ orm: 'prisma' \| 'typeorm' \| 'sqlalchemy' \| 'hibernate' \| 'activerecord' \| 'auto', model: string, repoPath? }`. Output: `{ found: true, model: { name, table, columns: [{ name, type, nullable }], indexes: [{ name, columns, unique }], relations: [{ kind: 'belongs_to' \| 'has_many' \| 'has_one' \| 'many_to_many', target, through? }], path, line, dialect } } \| { found: false, nearest: ... }`.** Wraps `code_orm_scan` filtered by model name, normalising per-dialect output into a uniform shape. Per-dialect mapping helpers in `daemon/skills/built-ins/code.orm.<dialect>.algo.ts` (one per supported ORM) |
| **3.4** | code-binding: lineage call-sites (existing wrapper) | done (data-analyzer-skills §3.4) | Already shipped on the data-analyzer side as `data.lineage.read-write-callsites` over the `data_lineage` tool. This row exists to flag the asymmetry: data-side is shipped, code-side has no `code.lineage.*` skill -- and shouldn't need one (the existing tool is the right primitive; the skill wrapper lives where the consumer lives) |
| **3.5** | **code-binding: `code.migration.extract-history`** ← **data-analyzer-skills §3.5 dependency** | **pending (priority)** | **Atomic. Input: `{ tool?: 'flyway' \| 'liquibase' \| 'knex' \| 'prisma-migrate' \| 'alembic' \| 'rails' \| 'django' \| 'auto', repoPath? }`. Output: `{ found: true, tool, migrations: [{ id, label, path, appliedAt?, operations: [{ kind: 'create_table' \| 'drop_table' \| 'add_column' \| 'drop_column' \| 'alter_column' \| 'add_index' \| 'drop_index' \| 'rename_table' \| 'rename_column' \| 'execute_raw', table?, column?, type?, nullable?, default?, raw? }] }] } \| { found: false, reason: 'no-migrations-detected' \| 'unparseable-tool' }`.** Wraps `code_migration_walk` + per-tool DDL parsers |
| 4.1 | comparison-diff: `code.compare.signature` | pending | Composite: `{ entityIdA, entityIdB }` -> `{ identical: boolean, addedParams: string[], removedParams: string[], typeChanges: [{ param, before, after }], returnTypeChange?: { before, after } }`. Mirrors `data.mapping.json-vs-class` but symbol-to-symbol |
| 4.2 | comparison-diff: `code.compare.impl-vs-doc` | pending | Composite: `{ entityId, docPath?: string }` -> `{ entries: [{ kind: 'undocumented-method' \| 'doc-references-removed-method' \| 'param-mismatch', detail }] }`. Compares an entity's surface against a Markdown doc that mentions it |
| 4.3 | comparison-diff: `code.compare.entity-versions` | pending | Composite over two repo revisions (post-`code-analyzer.md` Phase 4.2). Skill ships once the diff substrate lands |
| 5.1 | quality: `code.quality.complexity` | pending | Atomic per-entity cyclomatic complexity + cognitive complexity. Math in `code.quality.complexity.algo.ts`. Walks the entity body via tree-sitter; counts branch-introducing nodes |
| 5.2 | quality: `code.quality.dead-code` | done (already shipped as `data.code.dead-code`) | One of the few code-side skills that already ships -- registered under the data-analyzer's owner column for historical reasons. Phase 6.x cleanup moves it under `code.quality.dead-code` (or an `owner: 'shared'` equivalent) and adds the missing fixture (`daemon/skills/__fixtures__/data.code.dead-code.json` is the single failure in the smoke gate today) |
| 5.3 | quality: `code.quality.duplication` | pending | Atomic: detects token-level duplication across entities. Math in `code.quality.duplication.algo.ts`; uses min-hash fingerprints over the entity body's tokens |
| 5.4 | quality: `code.quality.unused-exports` | pending | Atomic. Walks every `isExported` entity; checks whether `in_edge[IMPORTS \| CALLS \| REFERENCES]` is empty across the repo's closure. Output: `{ unused: [{ entityId, path, kind }] }` |
| 5.5 | quality: `code.quality.cyclic-deps` | pending | Atomic. Runs `scc()` from `db/graph/traversal.ts` over the file-level `IMPORTS` edges; surfaces SCCs of size > 1 as cycle findings |
| 6.1 | synthesis: `code.synth.entity-card` | pending | Renderer: stripped `EntitySummary` -> markdown card with signature / first-N-lines body / neighbour list. Parallel to `data.synth.profile-card` |
| 6.2 | synthesis: `code.synth.findings-table` | pending | Renderer: `Finding[]` -> markdown table grouped by severity. Parallel to `data.synth.field-table` |
| 6.3 | synthesis: `code.synth.callgraph-mermaid` | pending | Renderer: `{ root, callers \| callees, depth }` -> Mermaid `flowchart` block. Reuses the existing CFG renderer's escaping helpers |
| 6.4 | synthesis: `code.synth.module-tree` | pending | Renderer for L/XL/XXL tier reports: package -> file -> entity tree as nested markdown lists |
| 6.5 | synthesis: `code.synth.architecture-overview` | pending | Renderer for XXL tier: prose describing sub-system boundaries + dependency-edge list. Pairs with `code.entity.cyclic-deps` and `code.source.repo.describe` |
| 7.1 | meta: `code.meta.classify-question` | pending -- **needs design** | LLM-routed (cloud). Same design question shape as data-analyzer-skills §7.1: catalog format, prompt structure, model affinity, preconditions surfacing. The data-analyzer's design landed 2026-05-09; this skill mirrors the contract. Catalog excludes `code.meta.*` (no recursion) and `code.synth.*` (renderers); pre-filters by the active repo's primary languages + presence of an ORM (drops `code.orm.*` skills when no ORM is detected) |
| 7.2 | meta: `code.meta.select-scope` | pending -- **needs design** | LLM-routed (cloud). Same shape as data-analyzer-skills §7.2: takes classify-question's candidate list + question + the active repo's entity / file roster, fills `args` per candidate against its inputSchema. Surfaces ambiguity (multiple-matches when class name resolves in two repos under the closure; no-match when nothing in the index) explicitly. The 2026-04-30 hallucinated-class lesson is codified here too: never silently pick a default scope when the question is ambiguous |
| 7.3 | meta: `code.meta.feasibility-check` | done (shared with data-analyzer) | Already shipped as `data.meta.feasibility-check`; family is `meta`, owner is `shared` (effectively). One implementation serves both analyzers. No code-side variant required |
| 7.4 | meta: `code.meta.calibrate-confidence` | done (shared with data-analyzer) | Same as 7.3 -- shared. One copy of the calibration logic |
| 8.1 | planner rewrite | pending | Mirrors data-analyzer-skills §8.1: planner emits `SkillInvocation`s instead of `AnalysisTask`s. The orchestrator stays at [`daemon/controllers/code-analyzer-orchestrator.ts`](../../src/insrc/daemon/controllers/code-analyzer-orchestrator.ts); only the per-task contract changes |
| 8.2 | per-task runner rewrite | pending | Replaces the inline 8-call tool loop with `runSkill()` dispatch. The shipped JSON-parse retry / citations-invariant retry / runner-side confidence downgrade move into the registry's `runSkill` machinery (skills-core 3.1 / 3.7) |
| 8.3 | reviewer integration | pending | The reviewer LLM consumes `SkillResult` shapes instead of free-form analyzer results. Per-task review prompt updated for the new shape |
| 9.1 | legacy `AnalysisTask` shim | pending | Maps each legacy `AnalysisKind` (`locate` / `describe` / `trace` / `compare` / `free-form`) to a default skill invocation. Lets pre-cutover cached plans replay through the new runner |
| 9.2 | legacy cross-agent surface | pending | `code_locate` / `code_trace` / `code_describe` cross-agent tools become back-compat shims that forward to the matching skill. Deletion gated on telemetry showing zero non-shim callers (mirror of data-analyzer-skills §9.2) |
| 10.1 | telemetry / skill-trace | pending | Workbench inspector pane (mirror of data-analyzer-skills §10.1) |
| 10.2 | per-skill cache layer | pending | Mirror of data-analyzer-skills §10.2; shares the `~/.insrc/cache/skills/` layer once that lands |

## Goals (short)

1. **Every claim in a code-analyzer report grounds in a typed skill
   output.** The reviewer rejects findings that don't trace back to a
   skill -- mirrors the data-analyzer's invariant.
2. **Cross-owner code-binding is structurally hallucination-proof.**
   `code.class.extract-fields` returns `{ found: false, nearest }`
   when the class doesn't resolve; the data-analyzer's wrapper sees
   that discriminator and refuses to fabricate a field table. The
   2026-04-30 incident's regression test goes green BEFORE Phase 3
   ships.
3. **Statistical / quality / structural analysis is first-class.**
   Family 5 ships with deterministic algorithms over the LMDB graph
   (complexity, dead-code, duplication, cyclic-deps), so the
   analyzer's per-task runner stops trying to count branches in the
   LLM.
4. **Cross-analyzer reuse is real.** The data-analyzer's Phase 3
   ships as thin wrappers over Phase 3 of THIS plan; the
   test-agent + designer can call `code.entity.callers` / `code.
   compare.signature` via `runSkill`.
5. **Backward-compatible cutover.** The legacy `code:*` cross-agent
   tools stay as back-compat shims through Phase 9; existing data-
   analyzer / deploy-analyzer callers keep working.

## Non-goals (in this plan)

- **Cross-repo federation beyond the active repo's `DEPENDS_ON`
  closure.** Same architectural rule the code-analyzer plan ships
  with. Skills that read from the graph stay scoped via the closure.
- **Indexer rewrites.** The shipped LMDB graph + LanceDB embeddings
  layer + tree-sitter parsers are the substrate. Skills consume
  them; this plan does not change how entities get extracted.
- **A new ORM dialect catalogue.** Phase 3.3 starts with the five
  the data-analyzer-skills plan called out (Prisma / TypeORM /
  SQLAlchemy / Hibernate / ActiveRecord). Adding more (Sequelize /
  Mongoose / Ecto / Diesel / sqlx) is a follow-up that lands when
  a real user case justifies it.
- **An IDE-side skill picker UX.** Phase 7 ships server-side
  routing only. The IDE-side `meta.classify-question` toggle UX is
  a follow-up tracked under
  [data-analyzer-skills §7.1 implementation](./data-analyzer-skills.md#71-metaclassify-question).

## Phase 0 -- driver-tool substrate

Five new tools plus per-ORM / per-migration-tool parsers. These tools
are the primitive layer Phase 3 skills compose over; landing them
first means Phase 3 stays thin (~80 lines per skill) and the
language-specific complexity stays in one place.

### 0.1 `code_class_locate`

**Tool id**: `code_class_locate`. **Family**: `code`.

Locate a class / interface / record / trait / object by name. Wraps
the LMDB `name_index` lookup the indexer already populates, returning
typed entity refs.

```ts
interface CodeClassLocateInput {
  className:   string;          // unqualified or dotted; both accepted
  repoPath?:   string;          // defaults to the active repo
  language?:   Language;        // narrows when the same name exists in multiple langs
}

interface CodeClassLocateOutput {
  found:    boolean;
  entityId?: string;
  path?:     string;
  line?:     number;
  language?: Language;
  kind?:     'class' | 'interface' | 'record' | 'enum' | 'trait' | 'object';
  isAbstract?: boolean;
  package?:  string;
  /** Top-3 vector-similar candidates when found is false. */
  nearest?:  { className: string; score: number; entityId: string }[];
}
```

**Rationale for typing the failure case**: the 2026-04-30
hallucinated-class regression. When the class doesn't resolve, the
caller MUST see `found: false` -- not a markdown error blob -- so
the data-analyzer-side wrapper can pivot cleanly.

### 0.2 `code_class_fields`

**Tool id**: `code_class_fields`.

Walk a class entity's `DEFINES` edges filtered to `kind: 'variable'`
(or per-language equivalent: `field` in Java, `attr` in Python, etc.)
and return typed field metadata. Per-language extractors live behind
a uniform interface; the tool body dispatches on the entity's
`language`.

```ts
interface CodeClassFieldsInput {
  entityId: string;
}

interface CodeClassFieldsOutput {
  fields: {
    name:        string;
    type?:       string;          // when statically typed
    nullable?:   boolean;          // statically declared (Optional<>, ?Type, etc.)
    default?:    string;           // default-value snippet, ≤ 80 chars
    modifiers?:  readonly string[]; // 'static' / 'final' / 'private' / 'readonly' / ...
    declaredAt:  { path: string; line: number };
  }[];
}
```

### 0.3 `code_class_references`

**Tool id**: `code_class_references`.

Walk a class entity's `in_edge` filtered to the requested edge kinds
and return typed reference refs. Caps at 200 references; `truncated: true`
on overflow.

```ts
interface CodeClassReferencesInput {
  entityId: string;
  kinds?:   ('CALLS' | 'INHERITS' | 'IMPLEMENTS' | 'REFERENCES')[];
}

interface CodeClassReferencesOutput {
  references: {
    kind:          'CALLS' | 'INHERITS' | 'IMPLEMENTS' | 'REFERENCES';
    fromEntityId:  string;
    fromPath:      string;
    fromLine:      number;
    snippet?:      string;         // ≤ 200 chars
  }[];
  truncated: boolean;
}
```

### 0.4 `code_orm_scan`

**Tool id**: `code_orm_scan`. **Largest of the Phase 0 tools.**

Scan a repo for ORM-defined models. Auto-detection by repo
fingerprint:

| ORM | Fingerprint |
|---|---|
| Prisma | `prisma/schema.prisma` |
| TypeORM | TypeScript files containing `@Entity()` from `typeorm` |
| Sequelize | TypeScript / JavaScript files containing `sequelize.define(...)` or `class X extends Model` |
| SQLAlchemy | Python files containing `class X(Base):` + `Column(...)` calls |
| Django ORM | Python files containing `class X(models.Model):` |
| Hibernate | Java files containing `@Entity` from `jakarta.persistence` or `javax.persistence` |
| ActiveRecord | Ruby files containing `class X < ApplicationRecord` |

```ts
interface CodeOrmScanInput {
  orm:        'prisma' | 'typeorm' | 'sequelize' | 'sqlalchemy' | 'django'
            | 'hibernate' | 'activerecord' | 'auto';
  repoPath?:  string;
  /** When `auto`, return models from every detected ORM. */
}

interface CodeOrmScanOutput {
  detected: { orms: ('prisma' | 'typeorm' | ...)[] };
  models:   {
    name:      string;
    table?:    string;            // explicit @Table(...) / @@map(...) / __tablename__
    columns?:  { name: string; type?: string; nullable?: boolean }[];
    relations?: { kind: 'belongs_to' | 'has_many' | 'has_one' | 'many_to_many'; target: string; through?: string }[];
    path:      string;
    line:      number;
    dialect:   'prisma' | 'typeorm' | ...;
  }[];
}
```

Per-dialect parsers in `daemon/tools/builtins/code/orm/<dialect>.ts`.
Each is a thin walker over the existing tree-sitter entity output
filtering for the dialect's annotation / decorator / class pattern.
Phase 3.3's skill does the per-model lookup + uniform shape mapping;
this tool just extracts.

### 0.5 `code_migration_walk`

**Tool id**: `code_migration_walk`.

Walk a repo's migrations directory + parse the DDL. Auto-detect by
directory fingerprint:

| Tool | Fingerprint |
|---|---|
| Flyway | `**/db/migration/V*__*.sql` |
| Liquibase | `**/db/changelog/*.{xml,yaml,json,sql}` |
| Knex | `**/migrations/*.{ts,js}` exporting `up` / `down` |
| Prisma migrate | `**/prisma/migrations/<ts>_<name>/migration.sql` |
| Alembic | `**/alembic/versions/*.py` |
| Rails | `**/db/migrate/*.rb` |
| Django | `**/<app>/migrations/0*.py` |

```ts
interface CodeMigrationWalkInput {
  tool?:      'flyway' | 'liquibase' | 'knex' | 'prisma-migrate'
            | 'alembic' | 'rails' | 'django' | 'auto';
  repoPath?:  string;
}

interface CodeMigrationWalkOutput {
  detected:    boolean;
  tool?:       'flyway' | ...;
  migrations:  {
    id:          string;          // canonical id (e.g. `20240601120000_add_users`)
    label:       string;          // human-readable
    path:        string;
    appliedAt?:  string;           // when the tool exposes this
    operations:  {
      kind:      'create_table' | 'drop_table' | 'add_column' | 'drop_column'
               | 'alter_column' | 'add_index' | 'drop_index' | 'rename_table'
               | 'rename_column' | 'execute_raw';
      table?:    string;
      column?:   string;
      type?:     string;
      nullable?: boolean;
      default?:  string;
      raw?:      string;            // unparseable DDL falls through here
    }[];
  }[];
}
```

DDL extraction varies per tool. SQL-based tools (Flyway / Liquibase
/ Prisma migrate / Rails when `<<-SQL`) parse with the existing
SQL-AST helper from `daemon/db/drivers/sql-ast.ts`. DSL-based tools
(Alembic's `op.add_column(...)`, Django's `migrations.AddField(...)`,
Rails ActiveRecord's `add_column :users, :email, :string`) parse via
per-tool walkers in `daemon/tools/builtins/code/migration/<tool>.ts`.

## Phase 1 -- source-introspection skills (atomic)

Three skills that wrap `fs_read` + the indexer's parser output.
Mirror of data-analyzer-skills' Phase 1; the introspection layer the
runner consumes for "what's here?" questions.

- **1.1 `code.source.file.describe`** -- one file's entities + imports
- **1.2 `code.source.module.describe`** -- one package's public surface
- **1.3 `code.source.repo.describe`** -- whole-repo summary

Each is ~80 lines: thin precondition check + tool dispatch + typed
envelope.

## Phase 2 -- entity-lookup skills (atomic)

Four skills that wrap the shipped graph tools (`graph_search`,
`graph_entity`, `findCallers`, `findCallees`) with typed contracts.
The cross-agent `code:locate` / `code:trace` / `code:describe`
already exist as tools; these are the **owner-facing** skills the
code-analyzer's per-task runner calls when it needs structured
output.

- **2.1 `code.entity.locate-by-name`**
- **2.2 `code.entity.summary`**
- **2.3 `code.entity.callers`**
- **2.4 `code.entity.callees`**

## Phase 3 -- code-binding skills (cross-owner atomic) -- **CRITICAL PATH**

> **This phase unblocks data-analyzer-skills §3 + §4.** Ship this
> first. Skills 3.1 / 3.2 / 3.3 / 3.5 are the four prerequisites
> data-analyzer-skills.md called out as deferred. Each is structurally
> shaped to refuse cleanly when the code-side resolution fails -- the
> 2026-04-30 hallucinated-class lesson, codified.

### 3.1 `code.class.extract-fields`

```ts
{
  id: 'code.class.extract-fields',
  family: 'code-binding',
  owner: 'code-analyzer',
  toolDeps: ['code_class_locate', 'code_class_fields'],
  preconditions: [
    { kind: 'required-tools', tools: ['code_class_locate', 'code_class_fields'], reason: '...' },
  ],
  inputs:  { className, repoPath?, language? },
  outputs: { found: boolean, entityId?, fields?, nearest? },
}
```

Body:

1. Call `code_class_locate({ className, repoPath, language })`.
2. If `found: false`, return the typed refusal with the tool's
   `nearest` array threaded through. Confidence: `medium` (the
   refusal is structured + confident; the LLM-side caller decides
   how to react).
3. If `found: true`, call `code_class_fields({ entityId })`.
4. Return `{ found: true, entityId, fields }`. Confidence: `high`
   when fields.length > 0, `medium` when 0 (the class resolved but
   has no declared fields; e.g. an empty interface).

### 3.2 `code.class.locate-references`

Same shape; calls `code_class_locate` then `code_class_references`.

### 3.3 `code.orm.resolve-model`

Largest of the four -- per-dialect normalisation. Body:

1. Call `code_orm_scan({ orm, repoPath })`. When `orm: 'auto'`,
   the tool may return models from multiple dialects.
2. Filter to `model.name === input.model`. If zero matches, return
   `{ found: false, nearest }` with the closest model names by
   levenshtein distance.
3. If exactly one match, normalise to the uniform output shape and
   return `{ found: true, model }`.
4. If multiple matches across dialects, surface as `ambiguity: {
   kind: 'multiple-matches', alternatives: ['<dialect>:<name>'] }`
   per the data-analyzer-skills §7.2 ambiguity convention.

Per-dialect normaliser modules:
`daemon/skills/built-ins/code.orm.<dialect>.algo.ts`. Each takes the
tool's per-model output for that dialect and emits the uniform
`{ name, table, columns, indexes, relations, path, line, dialect }`
shape. Indexes + relations are the dialect-specific bit; ActiveRecord
`has_many :through` becomes `relations: [{ kind: 'many_to_many', target,
through }]`; SQLAlchemy `relationship('Order', back_populates='user')`
becomes `relations: [{ kind: 'has_many', target: 'Order' }]`; etc.

### 3.5 `code.migration.extract-history`

Body:

1. Call `code_migration_walk({ tool, repoPath })`.
2. If `detected: false`, return `{ found: false, reason:
   'no-migrations-detected' }`.
3. Otherwise pass through the tool's typed `migrations` array.
   Confidence: `high` when every migration has at least one parsed
   operation; `medium` when some fall through to `kind:
   'execute_raw'`; `low` when MOST fall through (the tool
   couldn't parse the DSL).

### 3.4 -- already shipped on the consumer side

Listed for completeness. The data-analyzer's
`data.lineage.read-write-callsites` skill wraps the existing
`data_lineage` tool; no `code.lineage.*` skill is required because
the lineage primitive lives at the tool layer (the cross-cutting
piece is "find code that reads / writes a DB target", not "find
code that calls a class method"; the latter is `code.entity.callers`).

## Phase 4 -- comparison / diff skills (composite)

Composite skills that orchestrate atomics. Mirror of
data-analyzer-skills' Phase 4. Sub-skill failure floors the
composite's confidence (per the registry contract in skills-core 4.3).

- **4.1 `code.compare.signature`** -- entity-to-entity signature diff
- **4.2 `code.compare.impl-vs-doc`** -- entity surface vs Markdown doc
- **4.3 `code.compare.entity-versions`** -- two repo revisions

## Phase 5 -- quality / metrics skills

Largest phase by skill count. Mirror of data-analyzer-skills' 5a-5g.

| Skill | Algo |
|---|---|
| 5.1 `code.quality.complexity` | cyclomatic + cognitive complexity per entity |
| 5.2 `code.quality.dead-code` | unreachable from any export root (already shipped as `data.code.dead-code`; rename + reparent in Phase 6.x cleanup) |
| 5.3 `code.quality.duplication` | min-hash fingerprint over entity bodies |
| 5.4 `code.quality.unused-exports` | exported entities with empty in_edge[IMPORTS \| CALLS \| REFERENCES] |
| 5.5 `code.quality.cyclic-deps` | SCC over file-level IMPORTS edges (the shipped traversal layer's `scc()` primitive) |

Each ships as `code.quality.X.algo.ts` (math) +
`code.quality.X.ts` (skill wrapper). No language-specific variants
needed -- the LMDB graph normalises across TS/Python/Java/Scala/Go,
so one skill covers every language.

Future `5.6 code.quality.api-surface` (count + churn of public
exports) lands as a follow-up.

## Phase 6 -- synthesis skills

Renderers analogous to data-analyzer-skills' Phase 6. No LLM call;
deterministic markdown templates per output shape.

- **6.1 `code.synth.entity-card`** -- one entity's signature + body + neighbours
- **6.2 `code.synth.findings-table`** -- per-severity finding table
- **6.3 `code.synth.callgraph-mermaid`** -- callers / callees Mermaid graph
- **6.4 `code.synth.module-tree`** -- tier-aware module hierarchy
- **6.5 `code.synth.architecture-overview`** -- XXL-tier sub-system prose

## Phase 7 -- meta skills

| 7.1 | `code.meta.classify-question` | LLM-routed (cloud). Pre-filter by active repo's primary languages + ORM presence |
| 7.2 | `code.meta.select-scope` | LLM-routed (cloud). Resolves entity / file / package refs; surfaces ambiguity (multiple-matches across closure repos; no-match) |
| 7.3 | `code.meta.feasibility-check` | shared with data-analyzer (already shipped) |
| 7.4 | `code.meta.calibrate-confidence` | shared with data-analyzer (already shipped) |

7.1 + 7.2 design questions (catalog format / prompt structure /
model affinity / preconditions surfacing) mirror data-analyzer-skills
§7.1 / §7.2 -- one design doc, two implementations. The catalog
prefilter is per-language instead of per-connection-family but the
mechanism is identical.

## Phase 8 -- planner / runner / reviewer rewrite

Mirrors data-analyzer-skills' Phase 8. The orchestrator
(`daemon/controllers/code-analyzer-orchestrator.ts`) stays. Its three
LLM tasks (`plan`, `analyzer-per-task`, `review`) gain a skill-shaped
contract. Per-task runner becomes a thin `runSkill(invocation.skillId,
invocation.args, deps)` dispatcher.

The legacy AnalysisKind enum (`locate` / `describe` / `trace` /
`compare` / `free-form`) maps to default skill invocations in the
shim (Phase 9.1).

## Phase 9 -- backward compatibility

### 9.1 Legacy `AnalysisTask` shim

Maps each `AnalysisKind` to a default skill invocation:

```
locate       -> code.entity.locate-by-name
describe     -> code.entity.summary OR code.source.module.describe (depends on scope shape)
trace        -> code.entity.callers + code.entity.callees (composite)
compare      -> code.compare.signature OR code.compare.impl-vs-doc
free-form    -> code.meta.classify-question + per-result skills
```

Lets pre-skill-cutover cached plans replay through the new runner.
Kept for one daemon release.

### 9.2 Legacy `code:*` cross-agent tools

`code_locate` / `code_trace` / `code_describe` become back-compat
shims forwarding to the matching skill via cross-owner depth-cap
mechanism. Deletion gated on telemetry showing zero non-shim callers.

## Phase 10 -- caching + telemetry

Mirror of data-analyzer-skills' Phase 10. `code.X.*` skills share the
`~/.insrc/cache/skills/` per-skill cache layer with `data.X.*` skills.

## Sequencing recommendation

**For unblocking data-analyzer-skills' default-on cutover** (which
is the stated motivator for this plan):

1. **Phase 0.1 / 0.2 / 0.3** -- the three class-related tools.
   Smallest substrate. ~3 commits.
2. **Phase 3.1 / 3.2** -- class-binding skills. ~80 lines each.
   2 commits. Ship the regression test from the 2026-04-30
   incident as part of 3.1's acceptance.
3. **Phase 0.4** -- `code_orm_scan` tool with Prisma + TypeORM
   parsers (the two most common ORMs in the wild). 1 commit.
4. **Phase 3.3** -- `code.orm.resolve-model` with Prisma + TypeORM
   dialects. SQLAlchemy / Hibernate / ActiveRecord land as
   follow-up dialect parsers. 1 commit for the skill, N follow-up
   commits for additional dialects.
5. **Phase 0.5** -- `code_migration_walk` with Prisma migrate +
   Rails parsers. 1 commit.
6. **Phase 3.5** -- `code.migration.extract-history`. 1 commit.

That's ~9 commits to unblock data-analyzer-skills' Phase 3 +
Phase 4 (which transitively unblocks the data-analyzer's flag-on
cutover). The remaining phases (1, 2, 4, 5, 6, 7, 8, 9, 10) round
out the code-analyzer's own skills story but aren't on the critical
path for the data-analyzer.

**For the rest of the plan**, the natural order:

7. **Phase 1 + 2** -- substrate skills (introspection, entity-
   lookup). ~7 skills total. Sets up the closed catalog for 7.1 /
   7.2 to pick from.
8. **Phase 5** -- quality skills. 5 atomic, deterministic, no LLM.
9. **Phase 4** -- comparison composites.
10. **Phase 6** -- renderers.
11. **Phase 7** -- meta skills (LLM-routed). Same design landing
    pattern as data-analyzer-skills §7.1 / §7.2.
12. **Phase 8** -- orchestrator wiring (mirrors data-analyzer-
    skills step 4b).
13. **Phase 9 / 10** -- back-compat shims + cache + telemetry.

## LLM routing -- per-skill provider affinity

Mirrors the data-analyzer-skills affinity table, scoped to code-side
skills.

| Skill family | Affinity | Why |
|---|---|---|
| source-introspection (1) | `auto` | thin tool wrapper |
| entity-lookup (2) | `auto` | thin tool wrapper |
| code-binding (3) | `auto` | dispatches to tools; depth-cap handles cross-owner |
| comparison-diff (4) | `auto` | composite; some need cloud for prose |
| 5 quality | `local` | post-processing; deterministic |
| synthesis (6) | n/a | no LLM call |
| meta (7) | `cloud` | classifier + scope picker; judgment-heavy |

## Open questions

1. **Should `code.quality.dead-code` move from `data.code.dead-code`
   in this plan, or stay where it is?** Today it's registered under
   the data-analyzer's owner column for historical reasons (it
   shipped before the code-analyzer-skills plan existed). Phase 6.x
   cleanup of data-analyzer-skills already flagged it as the missing
   fixture in the smoke gate. **Default**: rename to
   `code.quality.dead-code` here; the data-analyzer-side caller
   becomes a `runSkill('code.quality.dead-code', ...)` cross-owner
   call. Lets the plan ownership stay clean. Same fixture file
   ships under the new id.

2. **Per-language skill variants?** Data-analyzer split skills like
   `data.profile.numeric.{rdbms,file}` because the underlying tool
   surface differs (SQL vs DuckDB-over-files). For code, the LMDB
   graph is uniform across languages (the indexer normalises).
   **Default**: skills don't take a `.{ts,python,...}` suffix.
   Pre-filtering happens at the catalog layer in `code.meta.classify-
   question` (drops `code.orm.resolve-model` when no ORM detected;
   drops Python-specific quality skills when the repo has no Python).

3. **Does `code.orm.resolve-model` need a typed-identifier fast
   path?** When the data-analyzer-side caller has a Prisma schema
   pointer, it could short-circuit `code_orm_scan` and parse the
   schema file directly. **Default**: not in v1; v1 always goes
   through the tool. A direct parser shows up if telemetry shows
   the tool's auto-detect is the bottleneck on Prisma-heavy repos.

4. **Migration-history confidence floors.** When >50% of an
   ActiveRecord project's migrations fall through to
   `execute_raw`, the skill returns `confidence: 'low'`. Should it
   instead refuse with `found: false`? **Default**: keep
   `confidence: 'low'` -- partial information is still useful for
   the data-analyzer's drift tasks (the migrations that DID parse
   are real signal); the calibrate-confidence skill rolls them in
   downstream.

## Lessons baked in from prior incidents

1. **No fabrication of code-side facts.** `code.class.extract-
   fields` and the ORM / migration siblings hard-fail with
   `{ found: false, nearest }` when the target doesn't resolve.
   The 2026-04-30 hallucinated 28-row INPurchaseOrder field table
   is structurally impossible.

2. **No statistical / structural computation in the LLM.** Phase 0
   tools + Phase 5 deterministic algos own the math; quality
   skills consume tool output, never compute SCCs or duplication
   from prose.

3. **Default-enabled list / registry agreement.** Mirrors the
   skills-core 2.4 fix for the cross-agent-tool oversight. Every
   `code` family declared in skills-core's validator is in
   `enabledSkillFamilies` defaults; CI gate enforces.

4. **Confidence floors enforced server-side.** A skill that claims
   `high` confidence with one tool error in its trace gets clamped
   down by the registry. The skill body cannot lie its way past
   this. Mirrors the runner-side downgrade lever from 2026-05-01.

5. **Tool-error gate inheritance.** Skills calling tools that
   error inherit the tool-error gate the code-analyzer's runner
   shipped. The skill body's `deps.runTool` calls are the same
   dispatch path; user gets the same Continue / Abort prompt;
   abort propagates as `confidence: 'low'` plus a `notes` entry up
   through composite skills.
