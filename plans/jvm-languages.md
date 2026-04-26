# JVM languages -- Java + Scala support

## Mission

Extend the insrc indexer + downstream artifact / analyzer surfaces to
treat **Java** and **Scala** as first-class languages alongside the
existing TypeScript / JavaScript / Python / Go set. The work is
largely additive: new tree-sitter parsers, new manifest formats,
new import-path resolvers, and per-language branches in the existing
multi-language switches (CFG walker, Language union). No graph schema
changes; no IPC contract changes.

Scope: production code on the JVM is overwhelmingly Java + Scala (with
Kotlin a future follow-up). Both ship via tree-sitter grammars and
both have well-understood entity / relation extraction patterns. The
two share JVM build systems (Maven / Gradle / SBT / Mill) so manifest
parsing covers both at once.

## Related plans

- [`artifact-tasks.md`](artifact-tasks.md) -- once the parsers land,
  the `flow:code` artifact's CFG walker (§4.2) gains Java + Scala
  support, and the wireframe-introspection branch (§4.1) ignores
  them by design (React-only).
- [`data-driver.md`](data-driver.md) -- unrelated; mentioned only
  because Java code commonly hits JDBC / JPA / Hibernate, and
  surfacing those access patterns is a future analyzer concern not
  covered by this plan.
- [`requirements/`](requirements/) -- if a code-analyzer phase grows
  Java-specific findings (Spring annotations, JPA `@Entity`,
  Lombok-generated members), the requirements work product hooks
  there land alongside this plan's parser passes.

## Status

| Phase | Scope                                                                            | Status |
|-------|----------------------------------------------------------------------------------|--------|
| 0     | Prerequisites: tree-sitter pins, `Language` union extension, asset pipeline      | todo   |
| 1     | Java parser: entities + relations + tests against fixture                        | done (uncommitted) |
| 2     | Scala parser: entities + relations + tests; Scala 2 + 3 cross-version handling   | todo   |
| 3     | Manifests + import resolution: pom.xml / build.gradle(.kts) / build.sbt / build.sc | todo |
| 4     | CFG walkers in `kinds/cfg.ts` so `flow:code` artifacts work for Java + Scala     | todo   |
| 5     | Cross-cutting integration: language-hint heuristics, fixtures, doc updates       | todo   |

**Legend** for per-task status cells: `todo`, `in-progress`, `done`
(with commit sha or "uncommitted"), `partial` with deferred scope
called out (see
[`feedback_plan_status`](../../../.claude/projects/-home-subho-work-dev-insors-insrc-ide/memory/feedback_plan_status.md)).

---

## Goals

1. **Parity with the existing language set.** Java + Scala produce the
   same entity kinds (`function`, `method`, `class`, `interface`,
   `type`, `module`) and relations (`DEFINES`, `IMPORTS`, `CALLS`,
   `INHERITS`, `IMPLEMENTS`, `REFERENCES`) the indexer already
   captures for TS / Python / Go.
2. **Manifest-driven dependency closure.** Maven / Gradle / SBT / Mill
   manifests feed the same `DEPENDS_ON` registry the analyzer's
   transitive-closure search relies on -- so a Java repo's analyzer
   queries scope correctly to its own modules + declared
   dependencies, not the whole filesystem.
3. **CFG artifact parity.** `flow:code` walks Java + Scala function
   bodies just like it walks TS / Python / Go today. Shared step-tree
   IR + Mermaid renderer; per-language walker is the only new piece.
4. **No graph schema growth.** The existing `EntityKind` /
   `RelationKind` unions cover both languages without new members.
   Java / Scala specifics (annotations, traits, case classes) map
   onto existing kinds with disambiguating fields where useful (e.g.
   `signature` field carries `case class` / `sealed trait` /
   `@Service` so consumers can filter).

## Non-goals

- **Kotlin / Groovy / Clojure / other JVM languages.** Future
  additions; this plan deliberately scopes to Java + Scala only.
- **Bytecode / classfile parsing.** Source-only. Pre-built JARs in
  the dependency tree don't get indexed -- the dependency edge is
  recorded but the contents stay opaque.
- **Type resolution / signature matching across the codebase.** The
  parser captures local declarations + raw imports; cross-file type
  resolution (e.g. distinguishing `List` as `java.util.List` vs
  `scala.collection.immutable.List`) is left to the analyzer's
  follow-up work, not the parser pass.
- **Lombok / annotation-processor expansion.** A Lombok `@Data`
  class doesn't surface its synthesized getters/setters in the
  graph -- only the source-visible class + fields.
- **Build-script execution.** Manifest parsing is regex / shallow
  AST only. We don't run Gradle / SBT to evaluate dynamic
  dependencies.

---

## Module layout

Daemon-side:

```
src/insrc/indexer/parser/
  java.ts                   # NEW -- Java parser (tree-sitter-java)
  scala.ts                  # NEW -- Scala parser (tree-sitter-scala)
  base.ts                   # unchanged: shared CodeParser + makeEntityId
  registry.ts               # unchanged: registerParser() side-effect

src/insrc/indexer/
  index.ts                  # +2 side-effect imports for the two new parsers
  manifest.ts               # extend with parsePom / parseGradle / parseSbt /
                            # parseMill helpers + the parseManifest dispatch
  resolver.ts               # extend resolveImportPath with package-to-path
                            # logic for Java + Scala source roots

src/insrc/agent/tasks/artifacts/kinds/
  cfg.ts                    # +'java' / +'scala' WalkLang variants;
                            # +walkStatementJava / walkStatementScala;
                            # +findBodyBlock fn-types per language

src/insrc/shared/
  types.ts                  # +'java' | +'scala' on the Language union

src/insrc/__tests__/
  parsers/
    java-parser.test.ts     # NEW -- entity + relation extraction fixtures
    scala-parser.test.ts    # NEW -- Scala 2 + Scala 3 fixtures
  manifest/
    pom-parser.test.ts      # NEW -- multi-pom + parent / properties
    gradle-parser.test.ts   # NEW -- groovy + kotlin DSL variants
    sbt-parser.test.ts      # NEW -- libraryDependencies + cross-build syntax
```

Tree-sitter packages (added to `src/insrc/package.json`):

- `tree-sitter-java` (mature; Java 21 syntax coverage)
- `tree-sitter-scala` (covers Scala 2.x + 3.x; some Scala 3 edge
  cases surface as syntax errors -- handled per §2.4 below)

---

## Phase 0 -- Prerequisites

### 0.1 `Language` union

Extend [`src/insrc/shared/types.ts`](../src/insrc/shared/types.ts)
line 240 to include `'java' | 'scala'`. Single-line change; every
downstream consumer that branches on language gets a TypeScript
exhaustiveness signal pointing at the missing branches.

### 0.2 tree-sitter package pins

Add to `src/insrc/package.json` (the daemon's package, not the
workbench root):

```jsonc
{
  "dependencies": {
    "tree-sitter-java":  "^0.23.0",
    "tree-sitter-scala": "^0.23.0"
  }
}
```

Both packages are CJS native addons; load via the same
`createRequire` pattern existing parsers use. Confirm versions at the
start of phase 0 -- pick the latest that targets at least
Java 21 + Scala 3.3.x.

### 0.3 Asset / dist pipeline

No new asset copying needed. The parsers are pure TypeScript +
runtime CJS imports of tree-sitter native modules; the existing
build copies daemon assets but native node addons live in
`node_modules` and are picked up by the daemon's normal import path.

### 0.4 Blocks

- Phase 1 + 2 -- both parsers depend on the `Language` union
  extension landing first.

---

## Phase 1 -- Java parser

### 1.1 Entity extraction

[`indexer/parser/java.ts`](../src/insrc/indexer/parser/java.ts)
mirrors `python.ts` / `typescript.ts` in shape. Extracted entities:

| Entity kind | Tree-sitter node                                                  | Notes |
|-------------|-------------------------------------------------------------------|-------|
| `class`     | `class_declaration`                                               | `isExported` = `public` modifier present. `signature` carries `class` / `abstract class` / `final class` / `sealed class` (Java 17+) / `record` (Java 14+). |
| `interface` | `interface_declaration`                                           | `signature` carries `interface` / `sealed interface`. |
| `class`     | `enum_declaration`                                                | Mapped to `class` kind with `signature: 'enum'`. |
| `class`     | `annotation_type_declaration`                                     | Mapped to `class` kind with `signature: 'annotation interface'`. |
| `method`    | `method_declaration`                                              | `signature` includes return type + parameter types + `static` / `abstract` / `final` modifiers. |
| `method`    | `constructor_declaration`                                         | `name` is the enclosing class name; `signature` includes parameter types. |
| `function`  | `lambda_expression` (when bound to a `field_declaration`)         | Treated as function kind for searchability. |
| `module`    | `package_declaration`                                             | One per file; the package becomes the file's containing module. |

Decorators (annotations) are recorded as a `signature` suffix
(`@Service public class Foo` -> `signature: '@Service class Foo'`)
rather than as separate entities. This keeps the schema flat while
making annotation-driven filtering Cypher-trivial:
`MATCH (e:Entity) WHERE e.signature CONTAINS '@Service'`.

### 1.2 Relation extraction

| Relation kind | Source                                                                |
|---------------|------------------------------------------------------------------------|
| `DEFINES`     | `file -> class/interface/enum/annotation` and `class -> method`        |
| `IMPORTS`     | `import_declaration` -- `import com.example.Foo;` and wildcard imports |
| `CALLS`       | `method_invocation` (resolution best-effort; raw method name + receiver type when available) |
| `INHERITS`    | `extends` clause on a class                                            |
| `IMPLEMENTS`  | `implements` clauses on a class (one per interface)                    |
| `REFERENCES`  | static field references, class literals (`Foo.class`)                  |

Resolution is local-only: `CALLS` records the raw method name + the
receiver expression's text. The analyzer's later type-resolution
pass (out of scope here) closes the loop to the actual target
entity.

### 1.3 Java-specific quirks

- **Records** (Java 14+): treat as `class` with `signature: 'record'`
  + emit `field`-shaped entities for each record component (currently
  no `field` kind in the union; defer to a sub-decision -- map to
  `variable` kind). See §1.5 below for the `variable`-kind
  decision.
- **Sealed types** (Java 17+): `signature` carries `sealed`. The
  `permits` clause is parsed but not turned into an extra
  relation in v1; revisit if analyzers ask for it.
- **Pattern matching `switch`** (Java 21): handled by the CFG
  walker (phase 4). Parser ignores branch-specific pattern
  expressions in entity / relation extraction.
- **Inner classes**: nested `class_declaration` nodes inside another
  class produce their own `class` entity, parented via `DEFINES`
  to the outer class entity (not the file).
- **Anonymous classes** (`new Runnable() { ... }`): not
  separately captured as entities -- the methods inside an
  anonymous class are emitted as functions but with synthesized
  names (`<anon>$run`); the enclosing method retains a `DEFINES`
  edge.

### 1.4 `field` vs `variable` kind decision

The `EntityKind` union has `'variable'` but no `'field'`. Java
fields (instance variables) and Scala `val` / `var` declarations
both map to `variable`. The `signature` field carries the
distinguishing modifier (`public final int counter`,
`private static final String NAME`).

### 1.5 Tests

[`__tests__/parsers/java-parser.test.ts`](../src/insrc/__tests__/parsers/java-parser.test.ts)
ships fixture cases:

- Plain class with public + private methods (entity + relation
  shape).
- Interface with default methods.
- Generic class (`class Box<T>`).
- Abstract / sealed / record syntax.
- Nested class.
- Lambda assigned to a field (function-kind extraction).
- Annotation-decorated class (signature carries the annotation).
- Static nested class.
- Anonymous class inside a method body.

### 1.6 Blocks

- Phase 3 -- import resolution needs Java's package-to-path map.
- Phase 4 -- CFG walker needs the `function` / `method` entities
  surfaced here.
- Phase 5 -- documentation refresh references this phase's
  shipped parser.

---

## Phase 2 -- Scala parser

### 2.1 Entity extraction

[`indexer/parser/scala.ts`](../src/insrc/indexer/parser/scala.ts)
follows the Java parser's shape but with Scala-specific node types.
Extracted entities:

| Entity kind | Tree-sitter node                                              | Notes |
|-------------|--------------------------------------------------------------|-------|
| `class`     | `class_definition`                                            | `signature` carries `class` / `case class` / `abstract class` / `sealed class` / `final class`. |
| `class`     | `object_definition`                                           | Scala singletons. `signature: 'object'`. Companion-object discrimination via name match on a sibling class entity in the same file (recorded in `signature`). |
| `interface` | `trait_definition`                                            | `signature` carries `trait` / `sealed trait`. |
| `type`      | `type_definition`                                             | Type aliases (`type Foo = Bar`). |
| `method`    | `function_definition` inside a class / trait / object body    | `signature` includes parameter list (curried + by-name params noted) + return type + `def` / `def[T]` form. |
| `function`  | top-level `function_definition` (Scala 3 toplevel `def`)      | When not enclosed in a class/object/trait. |
| `variable`  | `val_definition` / `var_definition`                           | `signature` carries `val` / `var` + type when annotated. |
| `module`    | `package_clause`                                              | One per file. Scala's nested packages (`package a.b.c`) emit a single module entity for the deepest declared package. |

### 2.2 Relation extraction

| Relation kind | Source                                                          |
|---------------|------------------------------------------------------------------|
| `DEFINES`     | `file -> class/object/trait/type` and `class -> method`         |
| `IMPORTS`     | `import_declaration` -- handles wildcards (`._`), grouped       |
|               | imports (`{Foo, Bar}`), and renames (`{Foo => F}`).             |
| `CALLS`       | `call_expression` (raw method name + receiver text)              |
| `INHERITS`    | `extends` clause on a class -- the *first* parent is class       |
|               | inheritance (per Scala's "one extends, many withs").             |
| `IMPLEMENTS`  | `with` clauses (mixin trait composition; one edge per trait).    |
| `REFERENCES`  | qualified type references in val/var/method signatures.          |

### 2.3 Scala 2 vs Scala 3

`tree-sitter-scala` covers both versions. Parser handles both:

- **Scala 2 implicits** (`implicit val` / `implicit class` /
  `implicit def`): `signature` carries `implicit`. No separate
  entity kind.
- **Scala 3 `given` / `using`**: `given_definition` parsed as a
  variable-kind entity with `signature: 'given'`. `using` parameter
  clauses are noted in the method's signature but don't produce
  extra entities.
- **Scala 3 toplevel definitions**: `function_definition` /
  `val_definition` outside a class produce `function` / `variable`
  entities directly under the file.
- **Scala 3 enums** (`enum Foo { ... }`): map to `class` with
  `signature: 'enum'`, mirroring Java's mapping.
- **Scala 3 extension methods** (`extension (x: Foo) def bar = ...`):
  the inner `def` becomes a `method` entity whose owning entity is
  the extension's target type (best-effort name match) plus a
  `signature: 'extension method'` marker.

### 2.4 Parser-error tolerance

Some Scala 3 code (especially heavy use of optional braces +
significant indentation) trips `tree-sitter-scala`'s grammar. The
parser:

- Catches `tree.rootNode.hasError` and emits a warning entity-kind
  `module` with `signature: 'parse-error'` so the file isn't
  silently dropped from the graph.
- Falls back to recording at minimum the `package_clause` + any
  successfully-parsed top-level entities.
- Reported in the indexer's per-repo health summary so users see
  which files didn't fully index.

### 2.5 Companion object handling

`object Foo` declared next to `class Foo` in the same file is
Scala's "companion object" pattern. The parser:

- Emits both as separate entities (one `class`, one `class` with
  `signature: 'object'`).
- The object's `signature` gets a `(companion of Foo)` suffix when
  a same-named class entity exists in the file.
- No separate `COMPANIONS` relation -- the suffix carries the
  signal; analyzer queries can grep on it.

### 2.6 Tests

[`__tests__/parsers/scala-parser.test.ts`](../src/insrc/__tests__/parsers/scala-parser.test.ts)
ships:

- Plain class + companion object pair.
- Trait with abstract members.
- Mixin composition (`class A extends B with C with D`) -- INHERITS
  + IMPLEMENTS edges.
- Case class (case-class signature suffix).
- Type alias.
- Implicit conversion (Scala 2 syntax).
- `given` / `using` (Scala 3 syntax).
- Extension method (Scala 3).
- Pattern-match expression body (parser ignores match arms; just
  records the surrounding method).
- File with a parse error (verify graceful degradation per §2.4).

### 2.7 Blocks

- Phase 3 -- import resolution needs Scala's package-to-path map +
  wildcard/grouped/renamed import handling.
- Phase 4 -- CFG walker needs the `method` / `function` entities.
- Phase 5 -- documentation refresh.

---

## Phase 3 -- Manifests + import resolution

### 3.1 Maven `pom.xml`

[`indexer/manifest.ts`](../src/insrc/indexer/manifest.ts) gains a
`parsePom(text)` helper:

- Parse with a small XML reader (the standard `htmlparser2` or
  hand-rolled regex over `<dependency>` blocks). Avoid pulling in
  a full XML library -- pom.xml's dependency syntax is regular
  enough.
- Extract `groupId / artifactId / version` triples for each
  `<dependency>` (skip `<dependencyManagement>`-only declarations).
- Resolve property substitution (`<version>${spring.version}</version>`)
  against `<properties>` table when both are present in the same
  pom; multi-pom inheritance / parent resolution deferred to v2.
- Multi-module poms (a parent with `<modules>` + child poms): the
  parent doesn't declare runtime deps but each child does. The
  manifest pass walks every `pom.xml` it finds and aggregates.

### 3.2 Gradle (`build.gradle` / `build.gradle.kts`)

Two flavours:

- **Groovy DSL** (`build.gradle`): `dependencies { implementation
  'group:artifact:version' }` -- regex over `'group:artifact:version'`
  string literals + the surrounding `implementation` /
  `api` / `testImplementation` / `compileOnly` / etc. configuration
  name.
- **Kotlin DSL** (`build.gradle.kts`): same shape, but Kotlin
  string syntax with `"..."`. Same regex with adjusted quote
  matching.

Defer Gradle's full DSL evaluation (variable substitution,
`subprojects { }` blocks, version catalogs) to a v2 follow-up.
v1 captures the explicit dep declarations + ignores everything
else with a one-line warning per build script that has variable
references.

### 3.3 SBT (`build.sbt`) + Mill (`build.sc`)

- **SBT** uses `libraryDependencies += "group" %% "artifact" % "version"`
  syntax. Two operators: `%` (Java-style, exact artifact name) +
  `%%` (Scala-style, appends the Scala binary version suffix).
  Regex matcher records the triple; `%%` form gets a `_<scala-major>`
  hint stored as metadata so analyzer queries that know the build's
  Scala version can resolve to the actual artifact.
- **Mill** (`build.sc`) uses `ivy"group::artifact:version"`. Same
  shape, different DSL marker. Single-line regex.

### 3.4 Import resolution

[`indexer/resolver.ts`](../src/insrc/indexer/resolver.ts)
`resolveImportPath` gains language-aware branches:

- **Java**: `import com.example.foo.Bar;` -> probe candidate paths
  under detected source roots:
  - `<repo>/src/main/java/com/example/foo/Bar.java`
  - `<repo>/<module>/src/main/java/com/example/foo/Bar.java` for each
    discovered Maven / Gradle module
  - Wildcard imports (`import com.example.foo.*;`) resolve to the
    package directory; entities under it are linked individually
    (same shape as Python's `from x import *`).
- **Scala**: source roots default to `src/main/scala`, plus
  `src/main/scala-2.13` / `src/main/scala-3` cross-build directories.
  Grouped imports (`import a.b.{Foo, Bar}`) resolve as multiple
  individual imports; renames (`import a.b.{Foo => F}`) record `F`
  as the local alias but resolve to `Foo`.

Source-root detection: the manifest pass populates a per-repo
`SourceRoots` map (e.g. `{ java: ['src/main/java', 'subprj/src/main/java'],
scala: ['src/main/scala'] }`); the resolver consumes that map.
When no manifest is found, fall back to convention defaults
(`src/main/java`, `src/main/scala`).

### 3.5 Tests

- `__tests__/manifest/pom-parser.test.ts` -- single pom, multi-module
  parent / child, property substitution, `<dependencyManagement>`
  exclusion.
- `__tests__/manifest/gradle-parser.test.ts` -- groovy + kotlin DSL,
  configuration disambiguation, Maven coordinates inside
  `dependencies { }`, version-catalog warning surface.
- `__tests__/manifest/sbt-parser.test.ts` -- `%` vs `%%`
  cross-build, multi-line `libraryDependencies ++= Seq(...)`,
  inline scala version detection.
- `__tests__/resolver-jvm.test.ts` -- Java + Scala import
  resolution, wildcard expansion, grouped/rename imports,
  cross-build dir resolution.

---

## Phase 4 -- CFG walkers

### 4.1 `cfg.ts` extension

[`agent/tasks/artifacts/kinds/cfg.ts`](../src/insrc/agent/tasks/artifacts/kinds/cfg.ts)
extends in three places:

1. `WalkLang` union: add `'java' | 'scala'`.
2. `pickLanguageGrammar`: add the new grammars.
3. `findBodyBlock`: per-language fn-types (Java's
   `method_declaration` / `constructor_declaration`; Scala's
   `function_definition` -- but wrapped in the body of a
   class / object / trait).
4. `walkStatement` dispatch: two new branches calling
   `walkStatementJava` / `walkStatementScala`.

### 4.2 Java walker

Recognised CST nodes (tree-sitter-java grammar):

- **Branches**: `if_statement` / `else`, `switch_statement` (legacy)
  + `switch_expression` (Java 14+), `case` / `default`.
- **Loops**: `for_statement` (C-style + enhanced for-each),
  `while_statement`, `do_statement`.
- **Exception flow**: `try_statement` + `catch_clause` (multi-catch
  via `|` collapses into one branch with combined types) +
  `finally_clause` + `try_with_resources_statement` (renders the
  resources init as a fan-out call step before the body).
- **Synchronized**: `synchronized_statement` -- inlines the body
  as a column under the parent; emits a `note` step indicating the
  lock object.
- **Terminators**: `return_statement` / `break_statement` /
  `continue_statement` / `throw_statement` / `yield_statement`
  (switch-expression yield).

### 4.3 Scala walker

Scala uses expression-style `if` / `match` / `try` -- they all
return values. The walker treats them as control-flow steps
regardless of whether the result is consumed:

- **Branches**: `if_expression` (with `then` / `else` field names),
  `match_expression` (`case_clauses` -> switch step).
- **Loops**: `while_expression`, `for_expression` (handles `<-`
  generators + `if` guards + `yield` body), `do_while_expression`
  (Scala 2 only).
- **Exception flow**: `try_expression` -> tryBody + multi-`case`
  catch arms (rendered as branch steps inside the catch body) +
  optional finally.
- **Terminators**: `return_expression` (rare in idiomatic Scala),
  `throw_expression`. No `break` / `continue` -- early exit via
  `return` or refactoring.

### 4.4 Scala-specific shapes

- **For-yield comprehensions** -- treated as a loop step with
  `predicate` set to the first generator's text. Multi-generator
  forms (`for (a <- as; b <- bs) yield ...`) collapse into a
  single nested loop diagram.
- **Pattern match** -- mapped to a switch step. Each `case_clause`
  becomes a switch case with the pattern text as the case label
  (truncated). Guards (`case x if x > 0 =>`) appended to the label.
- **Implicit conversions / extension methods** -- not visualised;
  walking treats them as plain method calls.

### 4.5 Tests

`__tests__/cfg-jvm.test.ts` (or extend `cfg.test.ts`):

- Java: straight-line, if/else, enhanced for, switch (legacy +
  expression), try/catch/finally, try-with-resources,
  synchronized block, throw + return.
- Scala: if-expression, match-expression with case + guard, for-yield
  with multiple generators, while, try/catch/finally, throw.
- Scala 3 specifics: `if cond then` vs `if (cond) {` syntax both
  parse to the same step tree.

---

## Phase 5 -- Cross-cutting integration

### 5.1 Indexer registration

[`indexer/index.ts`](../src/insrc/indexer/index.ts) gains two
side-effect imports near the existing TS / Python / Go
registration site:

```ts
import './parser/java.js';
import './parser/scala.js';
```

The registry pattern (registry.ts) needs no changes -- parsers
self-register at module-load via `registerParser()`.

### 5.2 Language-hint heuristics

A few places in the agent / artifact stack use language as a
filter or routing signal. None require changes for Java / Scala
specifically -- the runtime `Language` value flows from the
indexer's parser through the entity records, and any UI / tooling
that enumerates languages renders the new variants automatically.
Worth a sweep for `'typescript' | 'javascript' | 'python' | 'go'`
literal-union checks; the agent above already produced the punch
list (cfg.ts is the only one that requires per-language code).

### 5.3 Wireframe introspection (§4.1 of artifact-tasks)

Java + Scala don't have JSX; the wireframe React-introspection
branch ignores them by design. No code changes needed -- the
existing `entity.language !== 'typescript' && ... !== 'javascript'`
check rejects the call cleanly with the existing error message.

### 5.4 Doc refresh

- [`CLAUDE.md`](../CLAUDE.md) line 15: `**Parsing**: tree-sitter
  (TypeScript, Python, Go)` -> `(TypeScript, Python, Go, Java,
  Scala)`.
- Repo-level `README.md` if it mentions the language set.
- [`design/code-analyzer/index.html`](../design/code-analyzer/index.html)
  if it lists supported languages -- spot-check + extend.

### 5.5 Smoke + integration tests

- **Smoke**: a small Java + Scala fixture project under
  `test/fixtures/jvm/` (one Maven multi-module + one SBT project).
  The smoke driver runs the full indexer pass against the fixture,
  asserts entity / relation counts, and that import resolution
  closes the dependency edges.
- **End-to-end**: `flow:code` artifact request against a fixture
  Java function -> assert Mermaid output shape. Same for Scala.
- Per the project rule: do not run smoke / integration tests
  without explicit approval.

---

## Testing strategy

### Per-parser

- Unit tests with fixtures, colocated under
  `src/insrc/__tests__/parsers/`. Uses Node's stdlib `node:test`
  + `node:assert` (no test-framework dep).
- Each parser asserts:
  - Expected entities + their kinds + signatures from a hand-
    crafted fixture file.
  - Expected relations between those entities.
  - Annotation / generic / Scala-implicit signature suffix
    handling.
  - Graceful degradation on a syntactically-broken file.

### Manifest

- Pure-function tests on representative manifest fixtures
  (real-world poms / build.gradle / build.sbt files captured under
  `test/fixtures/manifests/`).
- Each parser asserts the expected `{ groupId, artifactId, version,
  scope }` triples.

### CFG walkers

- Extend the existing `cfg.test.ts` style (entity-fixture builder
  per language; assert step-tree shape from a hand-written body
  string).
- Cover language-specific shapes: Java try-with-resources, Scala
  for-yield, both `if` / `match` styles, multi-catch, extension
  methods.

### End-to-end smoke

- Fixture project under `test/fixtures/jvm/` exercises the full
  indexer pass + at least one artifact (`flow:code`) per language.

---

## Open risks

1. **Scala 3 grammar coverage.** `tree-sitter-scala` lags Scala 3
   syntax around significant whitespace + `given` / `using` /
   extension methods. Files using bleeding-edge syntax may fail
   to parse cleanly. Mitigation: §2.4's parse-error fallback keeps
   the file in the graph with a marker rather than dropping it
   silently. If the parse-error rate exceeds ~10% on a real Scala 3
   repo, revisit -- might need a custom grammar fork.
2. **Maven property substitution + parent inheritance.** Real-world
   poms inherit version pins from a parent pom (or BOM-imported
   dependency-management blocks). v1 only handles same-pom
   property substitution; multi-pom inheritance is a v2 follow-up.
   Risk: dependencies in inherited poms render with `${var}`-style
   placeholders rather than versions. Acceptable for v1 (the
   artifact name is still correct).
3. **Gradle DSL evaluation.** Version catalogs (`libs.versions.toml`)
   + dynamic `subprojects {}` blocks aren't statically extractable
   without running Gradle. v1 surfaces a warning per build script
   with these patterns; analyzer queries treat the dependency tree
   as best-effort.
4. **Anonymous + lambda explosion in entity extraction.** A heavily
   functional Java codebase may push the per-file entity count
   higher than the indexer expects. Cap anonymous-class / lambda
   entity emission at 50 per file (record a warning at the file
   level beyond that) so the graph stays bounded.
5. **Lombok / annotation processors.** Generated members
   (`@Data` -> getters / setters / equals / hashCode) don't appear
   in the source tree, so they're invisible to the parser.
   Documented as a known limitation; revisit if real-world Java
   analyzer queries demand it (the fix is non-trivial -- either
   bytecode parsing or annotation-processor execution).

---

## Deferred / follow-ups

1. **Kotlin support.** Tree-sitter grammar is solid; the entity
   schema overlap with Java is high. Would slot in as a phase 6 or
   spawn a sibling plan.
2. **Bytecode / classfile parsing for JAR dependencies.** Indexes
   the *contents* of declared dependencies, not just the edges.
   Significant scope -- separate plan.
3. **JVM dependency-version conflict detection.** Once manifests
   are parsed, surfacing version conflicts across the closure
   becomes a query the analyzer can answer.
4. **Spring / Hibernate / JPA annotation-aware queries.** If the
   analyzer wants to answer "which classes are Spring beans?" or
   "which entities map to which DB tables?", the parser's
   annotation-suffix capture is the foundation; the queries
   themselves are an analyzer-side follow-up.
5. **Scala 3 macros.** Inline / quoted code emitted by macros
   doesn't appear in the source. Same shape as Lombok -- documented
   limitation.

---

## Status tracking

### Phase 0 -- Prerequisites

| Item                                       | Status | Notes |
|--------------------------------------------|--------|-------|
| `Language` union extension                 | done (65bb72b95c5) |       |
| `tree-sitter-java` pin                     | done (65bb72b95c5) | `^0.23.5` |
| `tree-sitter-scala` pin                    | done (65bb72b95c5) | `^0.23.4` |
| Build pipeline confirmation                | done (65bb72b95c5) | smoke-loaded both grammars + parsed minimal fixtures |

### Phase 1 -- Java parser

| Item                                       | Status | Notes |
|--------------------------------------------|--------|-------|
| Class / interface / enum extraction        | done (uncommitted) | `class_declaration` / `interface_declaration` / `enum_declaration` / `annotation_type_declaration` / `record_declaration` -- all map to `class` kind (interfaces use `interface` kind), with `kindWord` distinguisher in the signature. |
| Method + constructor extraction            | done (uncommitted) | `method_declaration` -> method (or function at file-top); constructors get the qualified name `<Class>.<init>`. CALLS extracted from the body subtree. |
| Annotation suffix capture                  | done (uncommitted) | `marker_annotation` + `annotation` children of the `modifiers` node fold into the entity's `signature` prefix. |
| Sealed / record / nested-class handling    | done (uncommitted) | `sealed` keyword captured via the modifiers walker; record syntax via `record_declaration`; nested types qualify their name with the outer class (`Outer.Inner`). |
| Lambda field extraction                    | done (uncommitted) | When a `field_declaration` has a `lambda_expression` value, a separate `function`-kind entity (`<Field>$lambda`) is emitted alongside the field's `variable` entity. |
| Imports + CALLS + INHERITS + IMPLEMENTS    | done (uncommitted) | IMPORTS for `import_declaration` (with `static` meta + wildcard suffix), package decl as own-package edge, CALLS from `method_invocation` + `object_creation_expression` (with `isConstructor` meta), INHERITS for class `extends` + interface `extends`, IMPLEMENTS for class `implements`. |
| Unit tests (10+ fixtures)                  | done (uncommitted) | 17 cases at `indexer/parser/__tests__/java.test.ts`: top-level class with method, extends, implements, interface, enum, record, annotation interface, sealed, package, single + wildcard + static imports, CALLS (invocation + constructor), constructor `<init>` qualifier, fields, lambda lifting, annotations on classes + methods, nested-class qualifier. |

### Phase 2 -- Scala parser

| Item                                       | Status | Notes |
|--------------------------------------------|--------|-------|
| Class / object / trait extraction          | todo   |       |
| Companion-object signature suffix          | todo   |       |
| Case class + sealed trait suffixes         | todo   |       |
| Mixin (`with`) IMPLEMENTS edges            | todo   |       |
| Scala 3 `given` / `using` handling         | todo   |       |
| Scala 3 extension method handling          | todo   |       |
| Wildcard / grouped / renamed imports       | todo   |       |
| Parse-error degradation                    | todo   |       |
| Unit tests (10+ fixtures)                  | todo   |       |

### Phase 3 -- Manifests + import resolution

| Item                                       | Status | Notes |
|--------------------------------------------|--------|-------|
| `parsePom` (single + multi-module)         | todo   |       |
| `parseGradle` (groovy + kotlin DSL)        | todo   |       |
| `parseSbt` (`%` + `%%` + cross-build)      | todo   |       |
| `parseMill` (`build.sc`)                   | todo   |       |
| `parseManifest` dispatch update            | todo   |       |
| Java import path resolution                | todo   |       |
| Scala import path resolution + cross-build | todo   |       |
| Source-root detection from manifests       | todo   |       |
| Manifest unit tests                        | todo   |       |
| Resolver unit tests                        | todo   |       |

### Phase 4 -- CFG walkers

| Item                                       | Status | Notes |
|--------------------------------------------|--------|-------|
| `WalkLang` extension                       | todo   |       |
| Java grammar wiring                        | todo   |       |
| Scala grammar wiring                       | todo   |       |
| `findBodyBlock` per-language               | todo   |       |
| `walkStatementJava`                        | todo   |       |
| `walkStatementScala`                       | todo   |       |
| Scala for-yield + match handling           | todo   |       |
| Java try-with-resources handling           | todo   |       |
| CFG unit tests for both languages          | todo   |       |

### Phase 5 -- Cross-cutting integration

| Item                                       | Status | Notes |
|--------------------------------------------|--------|-------|
| Indexer side-effect imports                | todo   |       |
| Sweep for hard-coded language unions       | todo   |       |
| `CLAUDE.md` doc refresh                    | todo   |       |
| `README.md` doc refresh                    | todo   |       |
| Code-analyzer design refresh (if needed)   | todo   |       |
| JVM smoke fixtures                         | todo   |       |
| End-to-end `flow:code` smoke               | todo   |       |
