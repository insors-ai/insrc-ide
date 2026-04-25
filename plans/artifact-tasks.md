# Plan: Artifact Tasks

Implementation plan for the pre-defined tasks that generate software-
development artifacts (ER / sequence / flow / deployment / wireframe)
as embeddable HTML snippets.

Design: [`design/artifacts/index.html`](../design/artifacts/index.html).
Every question raised in the design is resolved; this plan turns the
decisions into concrete file-level work.

## Related plans

- [`todo-framework.md`](todo-framework.md) -- artifacts persist as
  `TodoItem`s on an auto-created Artifacts list, so phase 1 of this
  plan depends on todos Phase 5a (editor pane) + Phase 5b (inline
  chat widget) being landed. Both are complete as of the status
  snapshot in that plan.
- [`../design/code-analyzer/index.html`](../design/code-analyzer/index.html)
  -- code analyzer is the primary phase-1 consumer of
  `artifact.*` tools; analyzer work and artifact work proceed in
  parallel but neither blocks the other.
- [`../design/brainstorm-agent.html`](../design/brainstorm-agent.html)
  -- brainstorm is the second phase-1 consumer; its theme-spec
  assembly step picks up `artifact.*` once phase 1 lands.

## Status

| Phase | Scope                                                                        | Status |
|-------|------------------------------------------------------------------------------|--------|
| 0     | Prerequisites: Mermaid dep pinned, asset pipeline, shared types scaffolding  | done -- Mermaid CDN SRI + metadata shipped, shared types + asset pipeline done. No `npm install mermaid` needed: iframe-srcdoc widget renders artifacts inside a sandboxed document that loads Mermaid from the pinned CDN URL (SRI-verified). |
| 1     | Core tools + five bundled kinds + chat widget                                | done -- daemon-side + browser-side complete: templates, loader, binder, sanitiser, wireframe renderer + LLM synthesis, kind registry, shared Mermaid helper, **all 5 kinds runnable with structured-source branches** (Prisma / Kuzu / compose / k8s / LLM wireframe spec), 5 tool registrations with per-kind schemas + category bootstrap, chat widget with iframe-sandboxed rendering, `ToolDeps.todos` + caller-family routing landed, unit tests + smoke script written (`node:test` based, no new deps). `IInsrcArtifactsService` + slash commands dropped by design. |
| 2     | Iteration: regenerate tool, Artifacts Pane, template-override commands       | partial -- `artifact:regenerate` + `artifact:list_templates` tools, `TodosApi.updateItemMeta` extension, `persistence.appendRevision` with last-5 eviction, Artifacts editor pane (durable) + `insrc.artifacts.open` command, template-override palette commands (edit / reset / list) backed by a new `IInsrcArtifactsService` + three daemon RPCs. Tests: 78/78 unit + 11/11 smoke (all green), IDE compile + precommit clean. **Outstanding:** `artifact:list` tool (gap surfaced during plan review -- the NL regenerate UX needs an artifact-discovery surface; `artifact:list_templates` lists templates, not artifacts). |
| 3     | Deeper data sources: live DB ER, Terraform deployment, offline mode          | partial -- Terraform plan parser + offline mode (SRI-verified download-on-demand) done; live-DB ER unblocked (data-driver phases 0--5 landed, `db:sql:describe` available) but not yet wired. |
| 4     | Advanced: React introspection, CFG-based flow, in-tree kind contract, cross-service callflow kind | todo |

**Legend** for per-task status cells further down: `todo` (not
started), `in-progress`, `done` with commit sha, or `partial` with
deferred scope called out (see
[`feedback_plan_status`](../../../.claude/projects/-home-subho-work-dev-insors-insrc-ide/memory/feedback_plan_status.md)).

---

## Goals

Carried from the design doc (§2). Not restated here; the short list:

1. Deterministic, pre-defined tasks -- one tool per artifact kind.
2. Embeddable HTML snippets -- portable, self-contained-or-
   host-rendered.
3. Standard templates shipped with the tool, three-layer override
   (repo -> user -> bundled).
4. Data-source-first per kind, free-text fallback always available.
5. Iterable via `artifact:regenerate`.
6. Callable by any tool-capable LLM turn (chat, agent families) from
   natural-language requests -- no slash dispatcher in phase 1.

## Non-goals

See design §2. Summary: no free-form "artifact generator" agent, no
high-fidelity mockups, no third-party hosting, no new agent family.

---

## Module layout

Daemon-side:

```
src/insrc/shared/artifacts.ts                 # shared types -- ArtifactKind, ArtifactResult,
                                              # WireframeSpec, TemplateInfo, etc.

src/insrc/agent/tasks/artifacts/
  registry.ts                                 # kind registry + invocation dispatch
  sanitise.ts                                 # slot-value sanitiser (HTML-escape subset)
  template-loader.ts                          # three-layer template resolution
  template-binder.ts                          # slot substitution + mode switch
  persistence.ts                              # TodoItem read/write + revisions
  regenerate.ts                               # phase 2 -- regen runner + tool wrapper
  offline-bundle.ts                           # phase 3 -- offline-mode cache helper
  kinds/
    er.ts             er-sources.ts           # ER task + Prisma/Kuzu helpers
    sequence.ts       call-graph.ts           # sequence + shared call-graph helper
    flow.ts                                   # flow task: code (Kuzu) or process (text)
    deployment.ts     deployment-sources.ts   # compose / k8s parsers
                      terraform-source.ts     # phase 3 -- Terraform plan parser
    wireframe.ts                              # wireframe task: text/spec -> SVG
    shared-mermaid.ts                         # shared Mermaid-kind runner helper
    callflow.ts       callflow-sources.ts     # phase 4 (§4.4) -- distributed-trace artifact
    wireframe-classifiers/                    # phase 4 (§4.1) -- per-library JSON dictionaries
    callflow-formats/                         # phase 4 (§4.4) -- per-format JSON dictionaries
  wireframe/
    render.ts                                 # SVG generator, pure + deterministic

src/insrc/daemon/tools/builtins/artifact/
  index.ts                                    # all 5 phase-1 `artifact:*` tool registrations +
                                              # phase-2 `artifact:regenerate` +
                                              # `artifact:list_templates` + `artifact:list` (§2.4) +
                                              # phase-4 `artifact:callflow` (§4.4) in one file

src/insrc/assets/artifacts/
  mermaid-cdn.json                            # pinned CDN URL + SRI sha384
  templates/
    er.html   sequence.html   flow.html       # bundled defaults (phase 1)
    deployment.html   wireframe.html
    callflow.html                             # bundled default (phase 4 §4.4)
    _renderer.html                            # shared standalone-mode <script> snippet
```

Browser-side:

```
src/vs/workbench/contrib/insrc/common/
  insrcArtifacts.ts                           # ArtifactItemMeta browser mirror + guards
                                              # (no service in phase 1; service lands phase 2)

src/vs/workbench/contrib/insrc/browser/
  artifacts/                                  # phase 2
    artifactsInput.ts                         # EditorInput keyed by sessionId
    artifactsPane.ts                          # InsrcEditorPaneBase subclass
    artifactsCommands.ts                      # `insrc.artifacts.open`
    templateCommands.ts                       # edit / reset / list template overrides
    insrcArtifactsServiceImpl.ts              # IInsrcArtifactsService impl (phase 2)
    media/artifacts.css
  chat/
    chatArtifactWidget.ts                     # phase 1 -- iframe-srcdoc per-card render
    chatView.ts                               # edit: instantiate widget, wire todos stream
```

Tool-id convention: **`artifact:<kind>`** (colon, matching `notify:*`,
`graph:*`). Some early plan / design prose used `artifact.<kind>`;
the colon form is canonical.

No slash-command dispatcher in phase 1 (dropped by design). Natural-
language requests flow through the existing classifier + chat path
and the LLM picks the right `artifact:*` tool from the registry.

---

## Phase 0 -- Prerequisites

### 0.1 Mermaid dependency

- **Decision (design §8.1):** pin Mermaid at a v10 release. Exact
  version: `10.9.1` (latest in the v10 line at plan-write time).
  Confirm the pin is still current at the start of phase 0.
- **No npm dep, no esbuild bundling.** The chat widget renders each
  artifact inside a sandboxed `<iframe srcdoc=…>` carrying the
  standalone-mode HTML; Mermaid loads from the pinned CDN URL
  *inside the iframe document*. The main workbench document never
  imports `mermaid`, so neither `vscode-insrc/package.json` nor any
  esbuild config needs the dependency. (Decision shaped by deferred
  follow-up #1 in the original plan; iframe-srcdoc was the chosen
  rendering strategy.)
- CDN `<script>` + SRI hash for standalone-mode templates: script
  is `https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js`.
  Compute the SHA-384 SRI hash locally (`openssl dgst -sha384 -binary
  ... | openssl base64 -A`) and check it into
  `src/insrc/assets/artifacts/mermaid-cdn.json` so the template
  binder reads it at runtime rather than baking it into a string
  constant.

### 0.2 Shared types + asset pipeline

- New `src/insrc/shared/artifacts.ts` exports:
  - `ArtifactKind = 'er' | 'sequence' | 'flow' | 'deployment' | 'wireframe'` (phase 1)
    -- extends with `| 'callflow'` in phase 4 (§4.4) via the in-tree kind-extension contract
  - `ArtifactResult`, `ArtifactItemMeta`, `RevisionRecord`,
    `TemplateInfo`, `WireframeSpec`, `WireframeRow`, `WireframeCell`
- Asset pipeline: the daemon `scripts/build.sh` path (user memory:
  always build via `scripts/build.sh`, never raw `tsc`) must copy
  `src/insrc/assets/artifacts/templates/*.html` into the distributed
  bundle. Confirm existing asset-copy step in `scripts/build.sh`
  already globs `assets/**/*`; extend if not.

### 0.3 Blocks

- Phase 1 -- everything downstream imports from
  `shared/artifacts.ts` and reads templates from the bundled asset
  path.

---

## Phase 1 -- Core tools + five bundled kinds + chat widget

The meat of the design. Phase 1 ships the whole menu end-to-end: five
tool invocations, five bundled templates, one chat widget, and
TodoItem-backed persistence. Users drive artifact generation through
natural-language chat; the LLM picks the right `artifact:*` tool
from the registry with repo context, no slash dispatcher.

### 1.1 Tool registrations

- `src/insrc/daemon/tools/artifacts/index.ts` registers five tools
  via `registerTool` (daemon tool registry pattern from
  `src/insrc/daemon/tools/registry.ts`). Each tool:
  - `name`: `artifact:er`, `artifact:sequence`, `artifact:flow`,
    `artifact:deployment`, `artifact:wireframe`.
  - `input schema`: JSON Schema matching the design's `opts` shape
    per kind (§4).
  - `handler`: delegates to
    `agent/tasks/artifacts/registry.dispatch(kind, opts)`.
- Tool access scope: the artifact tools are callable by any tool-
  calling LLM turn that has the `artifact` category enabled (default
  on). Registration happens at daemon boot, same phase as other
  builtin tools.

### 1.2 Kind registry + dispatcher

- `src/insrc/agent/tasks/artifacts/registry.ts` owns a closed
  in-process registry keyed by `ArtifactKind`. Each entry is
  `{ sourceFetch, sourceRender, templateName }`. `dispatch(kind,
  opts)` walks the three-stage pipeline (§6 in design):
  1. `sourceFetch(opts) -> SourceModel`
  2. `sourceRender(sourceModel, opts) -> RenderPayload`
     (Mermaid text or wireframe spec)
  3. `templateBinder.bind(kind, renderPayload, meta) -> { embedded, standalone }`
- Each kind module (`kinds/er.ts`, etc.) exports
  `sourceFetch` + `sourceRender` so the registry stays thin.

### 1.3 Per-kind modules

All five follow the same shape:

- `sourceFetch(opts)` tries the kind's priority-ordered sources
  (design §4) and short-circuits on first hit. Returns a typed
  structured model. Falls back to free-text when no data source is
  applicable.
- `sourceRender(model, opts)` emits the renderer source:
  - For diagram kinds (er/sequence/flow/deployment): Mermaid text.
    Deterministic for structured models (Prisma / Kuzu / compose /
    k8s inputs); LLM pass (local default, `@mention` overridable)
    for free-text inputs and for label/layout polish on structured
    inputs.
  - For wireframe: `WireframeSpec` JSON, always from LLM on
    free-text; unconstrained layout (design §15 resolved -- let the
    model propose).
- Wireframe spec -> SVG happens in `wireframe/render.ts`, called by
  the template binder after `sourceRender` returns the spec. SVG
  generator is pure + deterministic.

Per-kind implementation notes:

- **`kinds/er.ts`**:
  - Priority: live DB (only when `opts.connection` provided AND
    phase-3 driver available -- in phase 1 this branch errors with
    `"live-DB source not yet wired"`) -> `schema.prisma` parse
    (use `@prisma/internals` -- schema parser only, no client) ->
    Kuzu entity graph (`entities.kind IN ('table', 'class')` with
    `REFERENCES` edges) -> free-text.
  - Phase-1 ships Prisma + Kuzu + free-text branches; live-DB
    branch is a placeholder stub until phase 3.
- **`kinds/sequence.ts`**:
  - Priority: Kuzu `CALLS` traversal from `opts.entry` with
    `opts.depth` (default 3) -> free-text.
  - Traversal reuses the daemon's existing `graph.neighbours` tool
    path.
- **`kinds/flow.ts`**:
  - Two sub-kinds resolved by `opts.kind`:
    - `'code'`: Kuzu + a light tool-loop (reuses investigate-style
      helper) to read the function body and emit a flowchart.
    - `'process'`: free-text only.
  - If `opts.kind` is omitted, infer: `opts.entity` present ->
    `'code'`, else `'process'`.
- **`kinds/deployment.ts`**:
  - Priority: `docker-compose.yml` parse -> k8s manifest parse ->
    free-text.
  - Compose parser: `js-yaml` (already available) + a small
    services/networks/volumes walker.
  - k8s parser: `js-yaml` (multi-doc) + filter on
    `kind IN ('Deployment', 'Service', 'Ingress', 'StatefulSet',
    'ConfigMap')` with edges from selector/port references.
  - Terraform deferred to phase 3.
- **`kinds/wireframe.ts`**:
  - Only free-text source in phase 1.
  - Stage-2 LLM pass produces `WireframeSpec` JSON with no layout
    constraints; regenerate-with-edits is the iteration path
    (phase 2).

### 1.4 Template loader + binder

- `template-loader.ts`: three-layer resolution (design §7.2):
  `<repo>/.insrc/artifacts/templates/<kind>.html` ->
  `~/.insrc/artifacts/templates/<kind>.html` -> bundled default.
  - Cache resolved templates in a `Map<kind, { path, text,
    mtimeMs }>` invalidated on file-watcher hit for either override
    path.
  - Template lint at load time: reject if any `on*` attribute or
    `<script>` appears outside the `@@RENDERER_SCRIPT@@` slot.
- `template-binder.ts`: plain string substitution on `@@NAME@@`
  tokens. Slot value sanitisation via `sanitise.ts` for every slot
  except `@@SOURCE@@` (which gets HTML-escaped: `&`, `<`, `>` only
  -- Mermaid reads the raw text node) and
  `@@RENDERER_SCRIPT@@` (trusted, bundled from `_renderer.html`).
  - Binder returns both modes in one pass:
    - `embedded`: `@@RENDERER_SCRIPT@@` -> empty string.
    - `standalone`: `@@RENDERER_SCRIPT@@` ->
      `<script src="..." integrity="..." crossorigin="anonymous"></script>`
      from `mermaid-cdn.json`; wireframe kind gets empty (no
      external renderer needed for SVG).

### 1.5 Persistence -- TodoItem backing

- `persistence.ts` wraps the existing todos RPC
  (`deps.todos.createList` + `addItem` + `updateItem`).
- On first invocation per session, auto-creates an `Artifacts` list
  owned by the calling family (from `ControllerInput.callerFamily`,
  or `'chat'` when the tool is invoked from an NL chat turn without
  an active agent controller). The list carries title + description
  only -- no `meta.suppressComments` flag in phase 1, since nothing
  in the active code path attaches comments to artifact lists. If a
  future surface starts doing so, revisit per code-analyzer
  design §10.1.
- Each artifact is a `TodoItem`:
  - `title`: kind + short summary (e.g. "ER: users + orders").
  - `description`: the user's original prompt / opts.
  - `meta`: `ArtifactItemMeta` (design §9).
  - `status`: always `completed` at creation time (no lifecycle
    for artifacts -- they're output, not tasks).
- `findByArtifactId(id)` / `appendRevision(id, oldSource, edits)`
  -- phase-2 callers (§2.1 below).

### 1.6 Chat widget (`chatArtifactWidget`)

- New file
  `src/vs/workbench/contrib/insrc/browser/chat/chatArtifactWidget.ts`.
  Mirrors `chatTodosWidget.ts` (same repo, same folder).
- Subscribes (via `IInsrcTodosService`) to the existing todos
  stream, filters for the auto-created Artifacts list / artifact
  items, and renders one card per artifact item keyed by
  `artifactId`. Updates (regenerate, phase 2) mutate the card in
  place.
- **Rendering**: each card hosts a `<iframe sandbox="allow-scripts">`
  whose `srcdoc` is the artifact's `renderedHtml.standalone` string.
  Mermaid loads from the SRI-pinned CDN inside the iframe document;
  the main workbench document neither imports nor bootstraps
  Mermaid. Wireframe artifacts carry their SVG inline, so the
  iframe needs no script execution for that kind. (Replaces the
  earlier plan to bundle `mermaid` and call `mermaid.run` on
  main-doc nodes -- iframe-srcdoc was chosen for isolation + zero
  npm dep; see §0.1 + deferred follow-up #1.)
- Header / footer affordances:
  - Header: kind badge + title + "Copy snippet (standalone)" action
    via `IClipboardService`.
  - Footer: provenance + warning count with hover tooltip.
  - "Open in Artifacts Pane" + "Regenerate with edits..." land in
    phase 2.
- Wire-up in `chatView.ts`: instantiate alongside `ChatTodosWidget`.
  No new browser service -- the widget reads everything it needs
  from the todos service payload (see §1.7 for the rationale).
- Honour the workbench-hygiene feedback from memory: curly braces
  on single-line `if`s, hoisted union types. Run `npm run precommit`
  before staging.

### 1.7 Browser service -- skipped by design

A dedicated `IInsrcArtifactsService` was scoped here originally, but
phase 1 ships **without** one. The chat widget reads everything it
needs (`TodoList.items`, `item.meta`) from the existing
`IInsrcTodosService` payload, filtered through the
`isArtifactList` / `isArtifactItem` guards in
`browser/common/insrcArtifacts.ts`. A separate service would
re-expose the same data without adding capability.

A browser-side artifact service *does* land in phase 2 (see §2.3 --
template-override commands need three daemon RPCs that don't fit on
the todos-service surface). At that point it provides the
`openArtifact` hook the original §1.7 sketched, plus the template
RPCs.

If a future phase needs kind-specific browser-side helpers in chat-
view scope, revisit; for now the smaller surface is the right call.

### 1.8 Slash commands -- dropped by design

Not implemented in phase 1. The user interaction model settled on
**natural-language requests only**: the user types "draw an ER
diagram for users and orders" (or any phrasing), the classifier
routes to a chat/agent with tool access, and the LLM picks
`artifact:er` from the registry with arguments it assembles from
the prompt + repo context. No shortcut-style dispatcher.

The five tools are registered regardless, so any NL path that has
tool access -- including future agent integrations -- can invoke
them. If fast shortcuts become valuable later (usage telemetry
pointing at repeated phrasings, or a power-user ask), revisit; the
design/artifacts/index.html section on slash commands remains as
an implementation sketch for that revisit.

### 1.9 Tests

- Unit tests per kind module: `*.test.ts` alongside each module.
  - Each kind ships a fixture-based test: a known Prisma schema /
    compose file / Kuzu graph snapshot -> assert the Mermaid text
    output matches a golden file.
  - Wireframe SVG generator: deterministic pure function, snapshot
    test on a handful of `WireframeSpec` inputs.
- Template binder unit test: every required slot populated, every
  optional slot empty/omitted, sanitiser catches
  `<script>alert(1)</script>` in `@@TITLE@@`, `@@SOURCE@@` is
  escaped not stripped, `@@RENDERER_SCRIPT@@` differs between
  embedded + standalone.
- Template lint test: a malicious template with `onclick` is
  rejected at load time.
- Smoke test: `npm run test:artifacts:smoke --prefix src/insrc`
  invokes each of the five tools against fixture inputs and
  confirms `renderedHtml.embedded` parses as valid HTML (use a
  lightweight html parser).

### 1.10 Blocks

- Phase 2 -- regenerate, Artifacts Pane, template-override
  commands.
- Code-analyzer phase 2 (Analysis Report Pane + findings) -- once
  the analyzer's tool loop includes `artifact.*`, findings can
  embed diagrams.
- Brainstorm theme-spec assembly step integration.

---

## Phase 2 -- Iteration surfaces

Wire up editing + the dedicated pane + user template overrides.

### 2.1 `artifact:regenerate` tool

- `src/insrc/daemon/tools/builtins/artifact/index.ts` registers
  `artifact:regenerate` (the runner lives in
  `agent/tasks/artifacts/regenerate.ts`).
- Handler:
  1. Load the `TodoItem` by `artifactId` via `persistence.ts`.
  2. Build the stage-2 prompt with
     `{ priorSource, edits, kind }`.
  3. Re-run `sourceRender` for the kind. `sourceFetch` is
     **not** re-run -- regeneration works on the last-known
     source, not by re-pulling from the data source. (If the user
     wants a fresh pull from the DB / graph they re-invoke the
     kind tool with the same opts.)
  4. Re-run the template binder.
  5. `persistence.appendRevision` pushes the prior source onto
     `meta.revisions` (keep last 5; evict oldest).
  6. Emit `itemUpdated` via the todos stream -- the chat widget,
     artifacts pane, and any other consumer re-render in place.

### 2.2 Artifacts Pane

- New files in
  `src/vs/workbench/contrib/insrc/browser/artifacts/`:
  - `artifactsInput.ts` -- `ArtifactsEditorInput extends EditorInput`,
    keyed by `sessionId`. URI:
    `insrc-artifacts:///session/<id>`. `matches()` on sessionId
    so reopen focuses the existing tab.
  - `artifactsPane.ts` -- extends `InsrcEditorPaneBase<ArtifactsEditorInput>`.
    Lists all artifacts on the session's Artifacts list; each
    row shows kind + title + preview (mini embedded render) +
    actions.
  - `artifactsListWidget.ts` -- per-row widget. Reuses
    `MarkdownWidget`'s Mermaid bootstrap. Actions: copy
    embedded / copy standalone / edit-and-regenerate (opens a
    small prompt panel same pattern as brainstorm card widget) /
    view revisions.
  - `media/artifacts.css`.
- Register the editor input in `insrc.contribution.ts`.
- Pane is **not** ephemeral (unlike the Analysis Report Pane). It
  restores on window reload because the list of artifacts for a
  session is a durable audit trail, not a one-shot run output.

### 2.3 Template-override commands

- `insrc.editArtifactTemplate <kind>`:
  - If `~/.insrc/artifacts/templates/<kind>.html` does not exist,
    copy the bundled default there first.
  - Open the user-override file via `vscode.window.showTextDocument`.
- `insrc.resetArtifactTemplate <kind>`:
  - Delete the user-override file (confirm first via
    `showWarningMessage`).
  - No action if it doesn't exist.
- `insrc.listArtifactTemplates`:
  - Quick pick showing each kind, which layer it's resolving from
    (repo / user / bundled), and a "reveal in explorer" action per
    entry.
- `artifact:list_templates` daemon tool (same data, callable by
  agents) -- thin wrapper around `template-loader.listAll()`.
- File watcher: the template loader already invalidates its cache
  on mtime change (§1.4); the override commands need only write
  files -- the loader picks up changes on next resolution.

### 2.4 `artifact:list` tool

Required so the LLM can resolve artifact ids by name / kind / recency
without scrolling chat history. Phase 1 left a real gap here:
`artifact:list_templates` lists *templates*, not *artifacts on a
session*, and there was no other discovery surface.

- `src/insrc/daemon/tools/builtins/artifact/index.ts` registers
  `artifact:list` alongside the existing five.
- Input: `{}` -- always operates on the active session's Artifacts
  list (resolved from `deps.todos.caller`'s session).
- Output: array of
  `{ artifactId, kind, title, createdAt, revisionsCount }`,
  newest-first, capped at 50.
- LLM markdown surface: a one-line table of recent artifacts +
  ids; full payload on `ToolResult.data` for downstream tool calls.
- Implementation: thin wrapper around
  `persistence.listSessionArtifacts(deps.todos)`.

### 2.5 Regenerate UX -- natural-language only

No slash wrapper in phase 2; same policy as phase 1. The user asks
"regenerate the ER with a different orientation" or references the
artifact by title ("the user/orders ER"). The LLM:

1. Calls `artifact:list` to enumerate the session's artifacts.
2. Picks an `artifactId` -- by recency for unqualified asks, by
   title-fuzzy-match for named ones; asks for clarification when
   multiple plausibly match.
3. Calls `artifact:regenerate({ artifactId, edits })`.

`artifact:list_templates` (phase 2) covers the *template*-discovery
half of this UX (e.g. "use the user-overridden ER template").

### 2.6 Tests

- `regenerate` unit test: prior source + edits -> new source
  differs; revisions accumulate; last-5 eviction.
- Artifacts Pane smoke: open pane for a session with three
  artifacts, confirm all render, confirm regenerate button path
  round-trips through the daemon.
- Template-override command tests: edit creates user override,
  reset deletes it, list reports correct layer.

### 2.7 Blocks

- Phase 3 -- classifier NL routing uses the `list_templates`
  output to build its disambiguation prompt.

---

## Phase 3 -- Deeper data sources

### 3.1 Live DB ER via `db:sql:describe`

- **Unblocked.** The data-driver plan (formerly "code-analyzer phase 3")
  has shipped phases 0--5; `db:sql:describe` is registered across all
  RDBMS dialects (postgres / mysql / sqlite / mssql / oracle /
  cockroachdb / clickhouse). See [`plans/data-driver.md`](data-driver.md)
  status tracking.
- Wire `kinds/er.ts`'s live-DB branch to call
  `db:sql:describe(connectionId, table)` per requested table (one
  call per `opts.tables` entry; or `db:list_connections` first when
  the user names a connection by label) and assemble the
  `SchemaDescription` list into a Mermaid `erDiagram`. Foreign keys
  on the `SchemaDescription` columns become the relationship lines.
- Connection selection: **explicit-only via `opts.connection`** (the
  id surfaced by `db:list_connections`). No auto-default-to-single,
  because the kind has no signal that the user actually wants a
  live-DB pull -- a default would hit the DB on every ER request in a
  repo with a single connection configured. The LLM is expected to
  call `db:list_connections` first and pass the chosen id explicitly.
- `opts.tables` is required whenever `connection` is set (there is no
  `db:sql:list_tables` tool, and dumping the entire schema is
  hostile). When `connection` is set without `tables`, the branch
  surfaces a warning + falls through to Prisma / Kuzu / scaffold.
- Provenance metadata: `metadata.provenance = "live DB: <connectionId> · N/M tables"`,
  with the failed-table list appended when partial success.
- Failure modes: when the connection probe fails (host down,
  credentials expired, family mismatch) the branch falls through to
  the existing Prisma / Kuzu / free-text priority chain rather than
  erroring. Partial success (some tables describe, some fail) returns
  the successful subset and surfaces the failures via warnings; it
  doesn't fall through.

### 3.2 Terraform deployment

- `kinds/deployment.ts` gains a Terraform branch.
- Input: path to a Terraform plan JSON dump
  (`terraform show -json plan.tfplan`). We do not shell out to
  `terraform` ourselves -- the user pre-generates the plan and
  points us at the file.
- Parse resources (`aws_instance`, `aws_lb`, `aws_ecs_service`,
  `kubernetes_deployment`, etc.) + their `depends_on` chains into
  a deployment flowchart.
- Scope: a small catalog of common resource kinds (10-15).
  Beyond-catalog resources render as generic nodes.

### 3.3 Offline mode

- **Cache-file-presence detection** -- no config flag. The template
  binder inlines the cached Mermaid bundle into standalone HTML
  when `~/.insrc/cache/artifacts/mermaid-<version>.min.js` exists
  *and* its SHA-384 matches the pinned SRI in `mermaid-cdn.json`.
  Otherwise the standalone HTML uses the CDN `<script>` as in
  phase 1. (No npm-bundled Mermaid -- there is no `node_modules/mermaid`
  to copy from; the cache file is downloaded explicitly via the
  command below.)
- New module `agent/tasks/artifacts/offline-bundle.ts` owns cache
  read + SRI verification.
- Three daemon RPCs:
  - `artifacts.getOfflineBundleStatus()` -> `{ present, version, integrity }`
  - `artifacts.downloadOfflineBundle()` -> downloads via `undici`,
    verifies SRI, writes cache file
  - `artifacts.removeOfflineBundle()` -> deletes the cache file
- Three palette commands wire the RPCs:
  `insrc.downloadArtifactsOfflineBundle`,
  `insrc.removeArtifactsOfflineBundle`,
  `insrc.artifactsOfflineBundleStatus`.
- Snippet size goes up by ~200 KB in standalone mode when offline
  mode is active. Falls back to CDN if the cache is missing or
  tampered. (Embedded mode is unaffected -- the chat widget renders
  via iframe-srcdoc and inherits whichever script source the
  binder chose.)

### 3.4 Tests

- Live DB ER: fixture Postgres (docker-compose'd test DB) with a
  known schema -> assert ER output.
- Terraform: plan JSON fixture -> assert deployment flowchart.
- Offline mode: standalone snippet parses without a network
  connection during test.

### 3.5 Blocks

- Phase 4 -- unrelated to phase 3 but sequenced after it for scope
  control. No further phase-4 prereqs on phase-3 work; §4.1's
  earlier indexer-prereq concern was resolved (read files on
  demand instead of extending the graph schema).

---

## Phase 4 -- Advanced sources + extensibility

### 4.1 React component introspection for wireframes

`kinds/wireframe.ts` gains a code-backed branch when `opts.component`
is provided -- pulls the named component's JSX/TSX subtree, walks it,
and emits a `WireframeSpec` that the existing SVG renderer paints.
Free-text remains the default; the React path is opt-in via explicit
`opts.component`.

**Fidelity target -- layout sketch, not faithful render.** A reader
sees `[header][sidebar | main][footer]` and recognisable element
blocks (button / input / list / image / table). Pixel positions,
colours, fonts, hover/animation states, prop-driven content -- all
explicitly out of scope. This is what makes the heuristics
tractable.

**Three-layer JSX node classification:**

1. **Layout container** -- creates rows / columns / grid for its
   children:
   - `<Stack>` / `<HStack>` / `<VStack>` (Chakra, MUI) -> flex row/column
   - `<Grid>` / `<SimpleGrid>` (MUI, Chakra) -> grid
   - `<Row>` / `<Col>` (AntD, Bootstrap) -> grid cells
   - `<Flex>` / `<Box display="flex">` (Chakra, MUI) -> flex container
   - `<div className="grid grid-cols-3">` (Tailwind) -> grid; the
     classifier reads className tokens against a fixed dictionary
   - Native `<header>` / `<main>` / `<aside>` / `<footer>` /
     `<nav>` -> semantic regions
2. **Semantic element** -- a leaf (or near-leaf) with known visual
   identity:
   - `<button>` / `<Button>` -> button block
   - `<input>` / `<TextField>` / `<Select>` -> input block
   - `<img>` / `<Image>` -> image block
   - `<table>` / `<DataGrid>` -> table block
   - `<ul>` / `<ol>` / `<List>` -> list block
   - `<a>` / text-only `<span>` -> text/link block
3. **Unknown component** -- classification fallback:
   - Recurse into the component's own JSX when in-tree (deeper
     sketch).
   - Otherwise emit a single labeled placeholder block (e.g.
     `[<UserCard/>]`). Never errors; never blocks.

**Conditional rendering** (`{cond && <X/>}`, ternaries, early
returns): render *all* branches stacked, marked `(alt)`. Captures the
visual surface area without making fidelity claims about which
branch shows when.

**List rendering** (`.map()` over arrays): detect the pattern, emit
`N=3` placeholder children of the mapped child element.

**Style hint extraction** -- only what affects layout:
- `style={{...}}` / `sx={{...}}`: pull `flexDirection`,
  `gridTemplateColumns`, `width`, `height` when explicit + round
  (`'200px'`, `'50%'`).
- `className` (Tailwind): map a small fixed dictionary of layout
  utilities (`flex`, `grid`, `grid-cols-N`, `flex-row`, `w-full`,
  `h-screen`).
- Colours, padding, borders, fonts, hover/focus -- ignored.

**Library coverage**:
- Built-in classifiers for native HTML, MUI, Chakra, AntD, shadcn/ui,
  Tailwind utilities ship in v1.
- New libraries land via in-tree JSON dictionaries (one per library)
  -- same model as §4.3's "PR to add a kind." No runtime loading.

**Source-of-truth: read the file on demand, do not extend the
indexer.** The indexer is a knowledge graph (entities +
relations), not a code-content cache. For JSX subtree walking the
flow is:

1. Look up the component entity in Kuzu by name (via the existing
   `findEntitiesByName` helper, the same one ER and call-graph
   already use).
2. Resolve its `file` + byte range from the entity record.
3. Read the file off disk and run a fresh tree-sitter pass scoped
   to the component's byte range -- the same `typescript.ts`
   parser the indexer uses, just invoked on a single function /
   class body instead of the whole repo.
4. Walk the resulting CST with the three-layer classifier above.

No indexer changes. No graph schema changes. No "retain JSX
subtree blobs" work item. The indexer's job stays "where is X
defined + what does X relate to"; subtree analysis is a content
operation that belongs in the artifact runner.

Caveat: when a component imports primitives from another in-tree
file (`<Header/>` defined in `./components/Header.tsx`), the
recursive descent in step 4 follows the import via the indexer
(import edge -> file path) and re-parses the imported file the
same way. Bounded depth (e.g. 3 levels) prevents runaway recursion
on deeply nested design-system component trees.

**Output**: a `WireframeSpec` matching the phase-1 free-text path's
shape, so the existing SVG renderer handles it unchanged.

**Failure mode**: components built from purely custom primitives
with no in-tree subtree fall back to a single labeled placeholder
block. Always returns *something*.

**Companion design doc**: `design/artifacts/react-introspection.html`
captures the per-library classifier dictionaries (which prop / class
names map to which wireframe primitive) when the work picks up.
The plan-side commitment is the algorithm + the v1 library set; the
dictionary contents live in the design doc + a JSON config dir
under `agent/tasks/artifacts/kinds/wireframe-classifiers/`.

### 4.2 CFG-based flow diagrams

`kinds/flow.ts`'s code-flow branch upgrades from "phase-1 call-graph
approximation" to a real intra-function control-flow walk -- on
demand, off the source file. Mirrors §4.1's "indexer is a graph,
not a content cache" principle: control-flow data isn't cross-
entity-queryable in the way the graph schema serves, and a fresh
tree-sitter parse of one function body is cheap (~ms).

**Flow** (per call):

1. Look up the target function entity in Kuzu by name (existing
   `findEntitiesByName`).
2. Resolve file + byte range from the entity record.
3. Read the file off disk and run a scoped tree-sitter pass on the
   function body using the same `typescript.ts` / `python.ts` /
   `go.ts` parser the indexer uses.
4. Walk the body's CST and emit a Mermaid `flowchart TD` from a
   small fixed set of structural nodes (no full SSA, no basic-
   block analysis -- this is "AST-shaped flowchart", not a real
   compiler CFG).

**Recognised CST nodes** (per language):

- **Branches**: `if` / `else if` / `else`, `switch` / `case` /
  `default`, `match` (Python 3.10+), Go `switch` / `select`.
- **Loops**: `for`, `while`, `do-while`, Python `for ... else`,
  Go `for { }` infinite, range loops.
- **Exception flow**: `try` / `catch` / `finally`, Python `except`
  / `else` / `finally`, Go `defer` (rendered as a fan-out edge
  to the deferred call from the surrounding scope).
- **Terminators**: `return`, `break`, `continue`, `throw` /
  `raise` / `panic`. Each becomes a labelled exit node.
- **Function calls** are rendered as plain rectangles -- no
  cross-function descent here; cross-function flow is what
  `sequence` and `flow:process` cover.

**Rendering rules**:

- Mermaid `flowchart TD`. Entry node stylised the same way as
  phase 1's call-graph rendering.
- Branch labels carry the predicate text (truncated to ~40 chars)
  -- e.g. `--|user.isAdmin|-->`.
- Multi-arm switches collapse onto a single diamond node with one
  arrow per case label.
- Loops render as a back-edge from body-tail to the loop header.
- `try` blocks group into a subgraph so the catch path is visually
  distinct.

**Per-language v1 coverage**: TypeScript / TSX, Python, Go --
matches the indexer's existing language set. Adding a language
later is a new walker entry in the kind module + per-language
node-name dictionary; same shape as §4.4 callflow's per-format
dictionaries.

**Caps + failure modes**:

- 200-node cap per function (Mermaid gets unreadable beyond that).
  Functions over the cap fall through to the phase-1 LLM
  approximation with a `(truncated)` note.
- Tree-sitter parse error -> fall through to the phase-1 LLM
  approximation; emit a `metadata.warnings` entry.
- Function entity resolves but file is missing on disk -> typed
  error pointing at the entity's `file` field.

**No indexer changes.** No `BRANCHES` relation. No graph schema
extension. The runner re-parses what it needs, when it needs it.

### 4.3 Stable in-tree kind-extension contract

**No runtime plugin loader. No `~/.insrc/plugins/...` path. No
sideloaded code.** New artifact kinds land as normal in-tree
modules under `agent/tasks/artifacts/kinds/`, reviewed via PR --
the same path phase 1 used to add the original five. Trust model
collapses to "did this code pass review?" -- there is no
out-of-band attack surface to design.

What §4.3 *does* deliver: formalise the contract a new kind module
must satisfy, so contributors have a clear template instead of
copying an existing kind by hand.

- Lift the implicit shape used by phase-1 kinds into a typed
  contract on `shared/artifacts.ts`:
  ```ts
  interface ArtifactKindRegistration<TOpts, TSource> {
    id:           ArtifactKind;            // narrowed via the closed union
    sourceFetch:  (opts: TOpts, deps: KindDeps) => Promise<TSource>;
    sourceRender: (model: TSource, opts: TOpts) => Promise<RenderPayload>;
    templateName: string;                  // resolved by template-loader
  }
  ```
  `KindDeps` carries the existing per-call surface (`session`,
  `todos`, `getDb`, `provider`); no fs / net access beyond what
  phase 1 already exposes.
- The closed `ArtifactKind` union stays closed. Adding a kind is
  three edits: extend the union, add a `kinds/<id>.ts` module,
  register it in `registry.ts`. The plan + a short contributor
  note in `agent/tasks/artifacts/README.md` documents the
  template + sanitiser conventions.
- Bundled-template assets follow the same shape: `assets/artifacts/templates/<id>.html`,
  picked up by the existing asset-copy step.
- **No marketplace, no signing, no discovery, no sandboxing**
  because none are needed for in-tree code. Out-of-band plugin
  loading was the original §4.3 sketch; dropped because the
  attack surface (arbitrary code execution at daemon boot from
  user-writable paths) was disproportionate to any concrete
  ask. If a real "third-party kinds without recompiling" use case
  ever surfaces, it gets its own design doc with a real trust
  model -- not slipped in as a phase-4 bullet.

### 4.4 Cross-service callflow kind (`callflow`)

A **new sixth artifact kind** that visualises distributed call flows
from production trace data. Distinct from `sequence` (in-process
Kuzu CALLS, time-ordered messages) and `flow:code` (in-process call
graph, topology-only) -- callflow operates on **cross-service
spans**, where the data source is a real trace, not a static graph.

**Use cases**:
- Code-analyzer's report pane embedding a trace when explaining a
  cross-service performance issue.
- Brainstorm agent's spec building referencing a current trace when
  designing a new endpoint.
- Manual onboarding / runbook docs: "here's how a checkout request
  flows through our services."

**Source priority** (auto-detected from JSON shape):

1. **OpenTelemetry / OTLP JSON** (`resourceSpans[]` envelope) --
   the de-facto standard. Primary supported format.
2. **Jaeger JSON** (`data[].spans[]` envelope) -- common via
   Jaeger UI export.
3. **Zipkin JSON v2** (flat array of spans with
   `traceId / parentId / localEndpoint.serviceName`) -- shares
   most of the parser shape with Jaeger.
4. **Free-text fallback** -- LLM stage-2 pass produces a
   `sequenceDiagram` from a written description (same pattern as
   the other kinds' free-text branches).

Vendor-specific exports (Datadog, Honeycomb, New Relic) **out of
v1 scope**; users normalise to OTLP first.

**Input shape**:

```ts
interface CallflowOpts {
  // Source: file path OR inline JSON. One required (unless free-text).
  tracePath?: string;
  traceJson?: string;

  // When the input has multiple traces, pick one. Falls back to the
  // first trace when omitted + only one is present.
  traceId?: string;

  // Filtering
  serviceFilter?: readonly string[];   // include only these services
  showInternal?: boolean;              // include INTERNAL spans (default false)

  // Layout
  layout?: 'sequence' | 'flowchart';   // default 'sequence'

  // Free-text fallback prompt
  description?: string;
}
```

**Rendering** (default `layout: 'sequence'`):

- Mermaid `sequenceDiagram`. Participants = unique `service.name`
  values from the resource attributes. Messages = client/server
  span pairs, ordered by start time. Arrow labels carry the
  span name (operation) + duration (`getUser  120ms`).
- Failed spans (`status.code = ERROR`) render with `--x` arrows
  + a `note over` annotation carrying the error message.
- Async / messaging detected via `span.kind = PRODUCER / CONSUMER`
  -- rendered with dotted `-->>` arrows + a `Note` indicating the
  queue / topic.
- Sync vs async: regular `->>` for client/server pairs, dotted
  `-->>` for fire-and-forget producer spans.
- `layout: 'flowchart'` falls back to a topology-only Mermaid
  `flowchart LR` grouping spans into per-service nodes with
  edge counts -- useful when a trace has dozens of repeated
  calls and the timeline reads as noise.

**Filtering / caps**:

- Default: only **cross-service spans** (drop `INTERNAL` span.kind
  to keep the diagram readable). `showInternal: true` for full
  detail.
- Service cap: 20 distinct services per diagram. Beyond that,
  truncate + emit a `Note` listing the dropped services.
- Span cap: 50 rendered spans. Beyond that, truncate + collapse
  consecutive same-service spans into a count badge
  (`UserService  ×7`).
- Wall-clock guard: a 5 s parse timeout on `tracePath` reads
  (large traces can be hundreds of MB).

**Failure modes**:

- Unparseable JSON -> typed error pointing at the offending byte
  range (auto-format detection happens after a permissive parse).
- Empty trace -> empty `sequenceDiagram` with a single
  `Note over (no spans)` row.
- Span cap hit -> truncate + annotate, never error.

**v1 deferred**:

- Live OTLP collector queries (`opts.collectorUrl` + `traceId`)
  -- file-only input in v1.
- Trace-comparison diagrams ("this trace vs that one") --
  separate kind if it ever lands.
- W3C Trace Context propagation graph -- niche.

**No indexer dependency.** Trace data is external; the graph DB
isn't consulted at all on this path. The `kind` registers via the
§4.3 in-tree contract like every other artifact kind.

**Companion design doc**: `design/artifacts/callflow.html` carries
the per-format parser dictionaries (OTLP / Jaeger / Zipkin field
mappings, status-code conventions, span-kind enum interpretation)
when the work picks up. Plan-side commitment is the algorithm +
the v1 format set; the dictionaries live in the design doc +
`agent/tasks/artifacts/kinds/callflow-formats/` (one JSON per
format).

### 4.5 Tests

- React component introspection: fixture component tree -> known
  spec.
- CFG flow: fixture function with known branching -> flowchart
  matches golden.
- Callflow: per-format fixtures (OTLP + Jaeger + Zipkin
  exemplars from open-source samples) -> assert sequenceDiagram
  output. One golden file per format. Plus failure-mode tests:
  unparseable JSON, empty trace, > 50 spans (truncation), an
  error span (status = ERROR rendering).
- (No "plugin loader" test -- there's no loader. The five existing
  in-tree kinds collectively exercise the registration contract.)

---

## Companion design docs (pending)

Two HTML design docs sit alongside `design/artifacts/index.html` to
capture per-library / per-format dictionaries that the kind modules
reference. The dictionaries themselves are **also** kept as JSON
under `agent/tasks/artifacts/kinds/wireframe-classifiers/` and
`agent/tasks/artifacts/kinds/callflow-formats/` so the runtime can
read them; the design docs cover the *why* (mapping rationale,
edge cases, vendor quirks) the JSON can't carry.

Both docs follow the existing `design/artifacts/index.html` style:
HTML with embedded CSS, dark theme, anchored sections, code
blocks for shape examples. No JavaScript, no external assets.

### A. `design/artifacts/react-introspection.html`

**Purpose**: per-library classifier dictionaries for §4.1's
JSX-to-WireframeSpec walker. Maps tag names + import sources to
wireframe primitives (rows / cells / element kinds), explains the
heuristic decisions, and gives contributors a recipe for adding a
new design system.

**Scope split** (doc vs code):
- **In the doc**: the *catalog* of recognised tags per library,
  the rationale for each mapping, edge cases (re-exported
  primitives, polymorphic `as` props, Tailwind utility-class
  tokens), conditional / list rendering rules.
- **In code** (`kinds/wireframe.ts` once §4.1 lands): the walker
  itself; pure JSON config under
  `kinds/wireframe-classifiers/<library>.json` carrying the
  literal tag → primitive map.

**Section outline**:

1. **Mission + fidelity target** -- restated from plan §4.1 so the
   doc reads standalone. Layout sketch, not faithful render.
2. **Three-layer JSX node classification** -- the core algorithm
   sketch (layout container / semantic element / unknown).
3. **Library catalog** -- one section per supported library:
   - **Native HTML** -- `<header>`/`<main>`/`<aside>`/`<footer>`/
     `<nav>` regions, `<button>`/`<input>`/`<form>`/`<textarea>`/
     `<select>` element kinds, `<table>`/`<ul>`/`<ol>`/`<dl>` list
     primitives, `<a>`/`<img>` link/image kinds.
   - **MUI** (`@mui/material`) -- `Stack`, `Grid`, `Box`,
     `Container`, `Paper`, `AppBar` for layout; `Button`,
     `TextField`, `Select`, `Autocomplete`, `IconButton`, `Avatar`,
     `Card` for elements. `sx` prop layout extraction conventions.
   - **Chakra UI** (`@chakra-ui/react`) -- `HStack`/`VStack`/`Stack`,
     `SimpleGrid`/`Grid`, `Box`/`Flex`/`Center`, plus `Button`,
     `Input`, `Select`, `Textarea`, `IconButton`. `as` polymorphism
     handling.
   - **Ant Design** (`antd`) -- `Layout`, `Layout.Sider`,
     `Layout.Header`, `Layout.Content`, `Row`/`Col`, `Space`;
     `Button`, `Input`, `Form`, `Table`, `Card`.
   - **shadcn/ui** (`@/components/ui/*` and friends) -- treat as a
     proxy layer over Radix; the catalog covers `Button`, `Input`,
     `Card`, `Dialog`, `Sheet`, `Tabs`, `Form` field wrappers.
     Note re-export aliasing (paths vary per repo; classifier
     dictionaries match the `@/components/ui/<file>` slug rather
     than node_modules path).
   - **Tailwind utilities** -- a separate dictionary keyed on
     `className` tokens, recognising `flex`/`grid`/`grid-cols-N`/
     `flex-row`/`flex-col`/`w-*`/`h-*` for layout. Non-layout
     utilities (color / padding / border / typography) are
     ignored.
4. **Conditional rendering** -- `cond && <X/>` / ternary / early
   returns. Render *all* branches with `(alt)` markers. Rationale
   why this beats picking a winner (honest about uncertainty,
   captures full visual surface area).
5. **List rendering** -- `.map(item => <X/>)` pattern detection;
   N=3 placeholder children of the mapped child kind. Rare-case
   handling for non-`.map()` iteration shapes (e.g. `forEach`,
   `Array.from`).
6. **Style hint extraction** -- table of recognised props /
   classes that affect layout (`flexDirection`,
   `gridTemplateColumns`, explicit `width`/`height`); everything
   else explicitly ignored. Rationale for the cutoff.
7. **Indexer interaction** -- the file-lookup-then-on-demand-parse
   flow (find entity in Kuzu -> read file -> tree-sitter scoped
   pass). No graph schema changes, no JSX subtree retention.
   Bounded recursive descent depth (default 3) for in-tree
   imports.
8. **Failure modes + fallback** -- when no recognisable structure
   exists (purely custom primitives, no in-tree subtree). Always
   returns *something*; never errors.
9. **Adding a new library** -- contributor recipe:
   - Drop a new `<library>.json` under
     `kinds/wireframe-classifiers/`.
   - Optionally add a parser hook in `kinds/wireframe.ts` if the
     library has unusual props (`as` polymorphism, theme-token
     resolution).
   - Add a section to this design doc with mapping rationale.
   - Add fixture-driven tests under
     `__tests__/wireframe-<library>.test.ts`.

**Authoring trigger**: write this doc *before* §4.1 implementation
starts. The mapping decisions for v1 (which libraries, which tags)
shape the JSON dictionaries the runtime consumes.

### B. `design/artifacts/callflow.html`

**Purpose**: per-format parser dictionaries + rendering decisions
for §4.4's distributed-trace artifact. Captures the field-by-field
mapping each format → canonical span shape, the auto-detection
rules, and the layout-selection heuristics.

**Scope split** (doc vs code):
- **In the doc**: format-specific field mapping tables, span-kind
  enum mappings (across all three sources), the multiple ways each
  format flags errors, layout selection rationale (`sequence` vs
  `flowchart`), edge-aggregation rules for the topology view.
- **In code** (`kinds/callflow-formats/*.ts`): the parsers; the
  shape sniffers (`isOtlp`/`isJaeger`/`isZipkin`); the layouts in
  `kinds/callflow.ts`.

**Section outline**:

1. **Use cases** -- restate from plan §4.4 (analyzer report-pane
   embedding, brainstorm spec building, runbook docs).
2. **Canonical span shape (IR)** -- field-by-field documentation
   of `CanonicalSpan` + `CanonicalTrace`. Every parser normalises
   into this; the renderer consumes it without caring about the
   input format.
3. **OpenTelemetry / OTLP** -- format spec reference + field
   mapping table:
   - `resourceSpans[].resource.attributes[]` -> `service.name`
     resolution (with fallback to `'unknown'`).
   - `scopeSpans[].spans[].traceId` / `.spanId` /
     `.parentSpanId` -> ids.
   - `.kind` (0-5 enum) -> `CanonicalSpanKind` (UNSPECIFIED 0
     and INTERNAL 1 collapse to INTERNAL per spec).
   - `.startTimeUnixNano` / `.endTimeUnixNano` (string or number)
     -> `startMicros` / `durationMicros`. BigInt division to stay
     in safe-integer range up to ~285 years from epoch.
   - `.status.code` (0/1/2) -> UNSET/OK/ERROR;
     `.status.message` -> `statusMessage`.
4. **Jaeger** -- field mapping table:
   - `data[].traceID` -> trace bucket key.
   - `data[].spans[].traceID` / `.spanID` -> ids;
     `.references[refType=CHILD_OF].spanID` -> `parentSpanId`.
   - Service name: embedded `process.serviceName` first, lookup-
     table `data[].processes[processID].serviceName` second.
   - `tags[key=span.kind].value` (string) -> kind enum.
   - Error signals (in order of precedence):
     - `tags[key=error].value === true` (or string `'true'`)
     - `tags[key=otel.status_code].value === 'ERROR'`
   - `tags[key=otel.status_description].value` -> `statusMessage`.
   - `startTime` (microseconds since epoch) + `duration`
     (microseconds) used directly.
5. **Zipkin v2** -- field mapping table:
   - Top-level array; group by `traceId`.
   - `id` / `parentId` -> ids.
   - `kind` field as canonical string;
     `null` / undefined -> INTERNAL (Zipkin convention).
   - `localEndpoint.serviceName` -> service name.
   - `tags['error']` -> ERROR status; non-`'true'` value
     preserved as `statusMessage`.
   - `timestamp` + `duration` (both microseconds) used directly.
6. **Auto-detection ordering** -- the mutual-exclusivity rules
   the auto-detection switch relies on:
   - OTLP: top-level `.resourceSpans` is an array.
   - Jaeger: top-level `.data` is an array of objects with
     `.spans` arrays.
   - Zipkin v2: top-level value is an array, first element has
     `.traceId` + `.id` + (`.localEndpoint` or `.kind`).
7. **Span-kind enum cross-reference** -- a single table mapping
   each format's kind representation to the canonical enum, so
   contributors adding a new format have a clear template.
8. **Layout selection rules** -- when to pick `sequence` vs
   `flowchart`:
   - **Sequence**: timeline view, services as columns, spans as
     time-ordered messages with duration. Good when the trace
     has < ~30 spans and the order matters.
   - **Flowchart**: topology view, services as nodes, calls
     aggregated into edges. Good when the trace has lots of
     repeated calls (microservice meshes; mid-burst windows)
     and the timeline reads as noise.
   - **Default**: `sequence` (matches what most users expect).
9. **Edge-aggregation rules (flowchart)** -- self-loops within a
   service skipped; calls aggregated by `(fromService,
   toService)` with count badge; error counts surface separately;
   first 2 operation names included as edge label samples;
   dotted edge when any aggregated span errored, solid otherwise.
10. **Caps + truncation** -- `SERVICE_CAP=20`, `SPAN_CAP=50`,
    file-read timeout 5s. Truncation is order-preserving (drop
    spans on services beyond cap by first-appearance order; drop
    excess spans by start-time order).
11. **Vendor-specific exports out of scope** -- Datadog /
    Honeycomb / New Relic exports vary too much in shape. Users
    are expected to normalise to OTLP first (commonly via
    `otelcol` or vendor-specific OTLP exporters).
12. **Adding a new format** -- contributor recipe:
    - Drop a new `kinds/callflow-formats/<format>.ts` exporting
      `is<Format>(parsed)` + `parse<Format>(parsed)`. Both
      normalise into `CanonicalSpan` / `CanonicalTrace`.
    - Add a row to the `autoDetectAndParse` switch in
      `kinds/callflow.ts`, ordered after the more-specific
      sniffers.
    - Add a row to the `CallflowSourceFormat` union in
      `callflow-formats/types.ts`.
    - Add a section to this design doc covering the format's
      field mapping + error-flagging conventions.
    - Add fixture-driven tests under
      `__tests__/callflow-<format>.test.ts`.

**Authoring trigger**: write this doc opportunistically. The code
is already canonical for the three v1 formats; the doc is mostly
useful when a contributor wants to add a new format or
understand the historical decision shape (e.g. why Jaeger has two
process-resolution paths).

---

## Testing strategy (overall)

1. **Unit tests** per module, colocated under
   `src/insrc/agent/tasks/artifacts/__tests__/`. Uses Node's built-in
   `node:test` + `node:assert` -- no vitest dep needed. (The existing
   `agent/framework/__tests__/*.test.ts` files import from vitest but
   aren't wired to any runner today; rather than pull in a test
   framework just for phase 1, the artifact tests stick to the stdlib.
   Convertible later if the repo decides on vitest globally.) Run:

       npm run test:artifacts --prefix src/insrc

2. **Smoke script** at `src/insrc/agent/tasks/artifacts/__tests__/smoke.ts`: exercises
   the full three-stage pipeline per kind against fixtures + a mock
   LLM provider. No Kuzu DB required. Run:

       npm run test:artifacts:smoke --prefix src/insrc

   Not auto-run; require explicit invocation (user memory: do not
   run tests without approval).

3. **Template lint** runs at load time inside the template loader
   (rejects raw `<script>`, `on*=` attrs, `javascript:` URLs), plus
   a unit test (`template-loader.test.ts`) that asserts the lint
   fires on each category. The main workbench `npm run precommit`
   pass continues to cover browser-side hygiene.

4. **Build verification** via `scripts/build.sh` (user memory:
   always use this, never raw `tsc`). The build must succeed with
   asset copy working for the templates directory.

5. **No UI test automation** for the chat widget or Artifacts Pane
   in this plan -- manual verification in phase 1 and phase 2
   respectively (matches the workbench contrib conventions used
   elsewhere).

---

## Migration concerns

None net-new -- this is all additive. The existing chat view gains
a new widget instantiation; no existing paths change behaviour.

The only wrinkle: the code-analyzer design (§10.4) mentions a future
"artifact" tool surface that this plan provides. The two plans are
independent -- code analyzer can land phase 1 without artifacts,
and vice versa -- but they land together in production when phase 2
of the code-analyzer lands (which wants the report-pane to be able
to show diagrams).

---

## Deferred / follow-ups captured during phase-1 MVP

These were identified while implementing the daemon-side core and
are worth addressing before or alongside the remaining phase-1 work.

1. **Widget rendering strategy (blocks phase 1.6).** Decide between
   iframe `srcdoc` rendering (isolated per artifact, uses the
   standalone-mode HTML the binder already emits, no main-doc
   `mermaid` import needed) vs. bundling Mermaid as a workbench
   asset and calling `mermaid.run` on main-doc elements. Iframe is
   the leaning choice. This decision determines whether
   `"mermaid"` needs to land in root `package.json`.
2. **`ToolDeps.todos?: TodosApi` extension.** ~~Scheduled.~~
   **Landed.** `ToolDeps.todos` added; controller task path
   propagates the controller's family-scoped `TodosApi`, LLM
   tool-loop builds a `'chat'`-scoped one from `getDb()`.
   `persistence.ts` consumes the injected instance and no longer
   imports from `daemon/todos-api.js`.
3. **Caller-family routing.** ~~Hardcoded.~~ **Landed via the
   `ToolDeps.todos` injection above.** The artifact builtin reads
   `deps.todos.caller` for attribution; the caller family flows
   through automatically when a controller runs the tool (its
   family-scoped `TodosApi` is propagated). LLM tool-loop turns
   default to `'chat'`, which is the right call for session-level
   chat without an active controller.
4. **Slash commands dropped from phase 1.** Users drive artifact
   generation by typing natural-language requests; the classifier
   routes to a chat/agent with tool access and the LLM picks
   `artifact:*` from the registry using repo context. No dispatcher,
   no `/erd` / `/seq` / ... shortcuts. If a real need for fast
   shortcuts shows up in usage, design doc §10 remains as an
   implementation sketch to revisit.
5. **LLM stage-2 spec synthesis for wireframe.** ~~Deferred.~~
   **Landed.** `kinds/wireframe.ts` now calls
   `deps.session.ollamaProvider` with a strict-JSON prompt, extracts
   the first balanced `{...}` block, runs a runtime shape guard, and
   falls back to the deterministic default scaffold on parse /
   validation failure (with a warning). `KindRunOpts.provider` is
   the plumbing seam the tool fills from the session.
6. **Tool-id naming correction.** Design / early plan drafts
   occasionally said `artifact.er` (dot). Implementation uses
   `artifact:er` (colon) matching the repo convention
   (`notify:slack`, `graph:search`, etc.). The design doc still
   uses dot in a few places; harmless documentation drift.
7. **Structured data-source fetchers descoped within phase 1.**
   ~~Deferred.~~ **Landed.** Per-kind structured branches now live:
   (a) wireframe LLM synthesis, (b) docker-compose + k8s manifest
   parse (auto-detected), (c) Prisma `schema.prisma` regex parse
   with auto-discovery of the conventional path + a
   `/prisma/` hint in description, (d) Kuzu CALLS traversal for
   sequence + flow (code sub-kind -- CFG approximation pending
   `BRANCHES` relation in the indexer, phase 4), (e) Kuzu entity-
   graph traversal for ER. Tests + caller-family routing remain the
   two structural follow-ups.

---

## Open risks

1. **Mermaid v10 theme integration with VS Code dark theme.**
   Mermaid v10's dark theme is serviceable but not perfectly
   colour-matched to the insrc palette. Phase 1 ships with
   `theme: 'dark'` + a small CSS override pack in the bundled
   templates; if users find the contrast off, phase 2 can add
   theme-token integration.
2. **Prisma schema dialect coverage.** `@prisma/internals` parses
   Prisma's modern schema syntax cleanly; older schemas (pre-2022)
   may need a config override. If a user's schema fails to parse,
   the ER task falls through to the Kuzu graph branch (already
   ordered as a fallback).
3. **Compose / k8s manifest variations.** docker-compose has
   multiple schema versions; k8s has many `kind`s. Phase 1 covers
   the common cases; edge cases fall through to free-text with a
   warning.
4. **Slot substitution on user-overridden templates.** If a user's
   template is missing a required slot, load-time lint rejects it
   and falls back to the bundled default with a one-shot warning
   notification. Non-blocking for the user, but worth flagging so
   overridden-template authors see it.
5. **SRI hash drift.** The CDN hash for a pinned Mermaid version
   shouldn't change, but a CDN re-publish would break standalone
   mode until the hash is re-computed. Mitigation: the chat widget
   renders via iframe-srcdoc (§1.6) and inherits whichever script
   source the binder chose -- so any user who has run
   `insrc.downloadArtifactsOfflineBundle` once never hits the CDN
   regardless of drift. The remaining exposure is users who copy
   the standalone snippet to an external host without the offline
   bundle on hand; a single hash recompute + plan / asset bump
   resolves that. Embedded mode (no `<script>` tag at all) is
   unaffected.

---

## Status table (per-phase, for filling in during implementation)

### Phase 0
| Item                              | Status | Notes |
|-----------------------------------|--------|-------|
| Mermaid 10.9.1 in `package.json`  | not needed (by design) | The chat widget renders artifacts in a sandboxed `<iframe srcdoc=…>` carrying the standalone-mode HTML (CDN `<script>` + SRI-pinned integrity hash). Mermaid loads inside the iframe document -- no main-doc import, no npm dep in root `package.json`. |
| CDN SRI hash json                 | done (3ca8a7200f5) | `src/insrc/assets/artifacts/mermaid-cdn.json` — pinned v10.9.1, jsdelivr URL, SRI `sha384-WmdflGW…` computed locally from the CDN bundle. `MermaidCdnMeta` type in shared/artifacts.ts. |
| `shared/artifacts.ts` types       | done (3ca8a7200f5) | `ArtifactKind`, `ArtifactResult`, `RenderedArtifactHtml`, `ArtifactItemMeta`, `ArtifactRevisionRecord`, `TemplateInfo`, `TemplateLayer`, `WireframeSpec`/`Row`/`Cell`, tagged-union `ArtifactOpts`, `MermaidCdnMeta`, `ArtifactEvent`, kind guards. Zero runtime deps. |
| Asset-copy pipeline verified      | done (3ca8a7200f5) | `scripts/build.sh` `build_daemon()` extended to `cp -a src/insrc/assets/. out/insrc/assets/` after tsc. Build confirmed: `[insrc-build] copying daemon assets` in log, `out/insrc/assets/artifacts/{mermaid-cdn.json,templates/*}` all present. |

### Phase 1
| Item                                      | Status | Notes |
|-------------------------------------------|--------|-------|
| `artifact:*` tool registrations           | done (3ca8a7200f5) | All 5 tool ids (`artifact:er`, `:sequence`, `:flow`, `:deployment`, `:wireframe`) registered in `daemon/tools/builtins/artifact/index.ts` with per-kind JSON schemas (common props + `source` + kind-specific options). `artifact` category in `ALL_CATEGORIES`, bootstrap wired. All 5 dispatch to a real runner. Tool-id convention: `artifact:<kind>` (colon, matches `notify:*`, `graph:*`). |
| Kind registry + dispatcher                | done (3ca8a7200f5) | `agent/tasks/artifacts/registry.ts`. `dispatch(kind, opts, input) -> ArtifactResult`. `listRunnableKinds()` for introspection. All 5 kinds now wired to real runners; no stubs remaining. |
| `kinds/er.ts` (Prisma + Kuzu + text)      | done (3ca8a7200f5) | Four-branch source priority: caller-supplied Mermaid -> auto-detected `schema.prisma` (hand-rolled regex parser at `kinds/er-sources.ts`; no `@prisma/internals` dep) -> Kuzu entity-graph traversal via `findEntitiesByName` + REFERENCES Cypher -> default scaffold. Live-DB introspection remains phase 3. |
| `kinds/sequence.ts`                       | done (3ca8a7200f5) | Three-branch source priority: caller-supplied Mermaid -> Kuzu CALLS traversal from `entry` (id or name) via the new `kinds/call-graph.ts` helper, rendered as a `sequenceDiagram` with autonumbered messages -> two-actor scaffold. Depth capped at 6; participants capped at 20 to keep diagrams legible. |
| `kinds/flow.ts` (both sub-kinds)          | done (3ca8a7200f5) | Code sub-kind uses the same `call-graph.ts` helper as sequence, rendered as `flowchart LR` with the entry node stylised. Process sub-kind stays free-text. True CFG (BRANCHES-edge traversal) is a phase-4 upgrade; the call-graph approximation is marked with `(CFG approximation)` in provenance. |
| `kinds/deployment.ts` (compose + k8s)     | done (3ca8a7200f5) | Auto-detects docker-compose vs k8s via first-doc shape (`apiVersion`+`kind` vs. `services:`) and emits Mermaid `flowchart LR`. Compose branch walks services + `depends_on`. K8s branch covers Deployment/StatefulSet/DaemonSet/Job/CronJob/Service/Ingress/ConfigMap/Secret, drawing Service selectors -> workloads and Ingress -> Service backends, plus dotted `-.->` edges for ConfigMap/Secret refs. Terraform stays phase 3. |
| `kinds/wireframe.ts` + SVG renderer       | done (3ca8a7200f5) | SVG renderer pure + deterministic. Source priority: caller-supplied `WireframeSpec` -> LLM stage-2 synthesis (local Ollama by default via `deps.session.ollamaProvider`, with strict JSON prompt + runtime shape guard + fenced-JSON extraction) -> default scaffold. LLM failures emit a warning and fall back to the default. Confidence bands high/medium/low reflect the branch taken. |
| `kinds/*` shared source helpers           | done (3ca8a7200f5) | `kinds/er-sources.ts` + `kinds/deployment-sources.ts` + `kinds/call-graph.ts` keep each kind's module focused on input-resolution + metadata while fetchers live in their own files. `db/entities.ts` gained a small `findEntitiesByName(db, names, opts)` helper reused by ER (Kuzu branch) + call-graph (sequence/flow). |
| Shared Mermaid-kind helper                | done (3ca8a7200f5) | `kinds/shared-mermaid.ts`: `runMermaidArtifact(inv, opts)` binds the template + packages the `ArtifactResult`. `cleanOneLine` + `truncate` helpers used by each kind's label sanitisation. Cuts the four Mermaid kinds to ~80 LoC each. |
| Template loader + binder + sanitiser      | done (3ca8a7200f5) | `template-loader.ts`: 3-layer resolution (repo -> user -> bundled), mtime-keyed cache, pre-load lint (rejects raw `<script>`, `on*=` attrs, `javascript:` URLs) with degrade-to-bundled on failure. `template-binder.ts`: plain string-replace on `@@NAME@@` tokens, emits both `embedded` + `standalone` in one pass, SRI-pinned CDN `<script>` injected in standalone mode only, wireframe kind gets empty renderer script regardless of mode. `sanitise.ts`: HTML-escape + control-char strip + `javascript:` neutraliser; narrow `escapeMermaidSource` for the `@@SOURCE@@` slot on diagram kinds. |
| Five bundled templates                    | done (3ca8a7200f5) | `src/insrc/assets/artifacts/templates/{er,sequence,flow,deployment,wireframe}.html` + shared `_renderer.html`. Each template: VS Code theme-token-aware CSS, kind-specific CSS class, data attributes for DOM attribution. Lint passes. |
| TodoItem-backed persistence               | done (3ca8a7200f5, c372441bf84) | `persistence.ts`: auto-creates session's `Artifacts` list on first write, persists each artifact as a completed `TodoItem` with the full `ArtifactItemMeta` on `meta`, rides the existing `todos` stream for live updates (no new stream kind). Caller-family routing + module-boundary cleanup landed: `ToolDeps.todos?: TodosApi` added to the unified tool-deps type; controller task path (`daemon/task.ts`) propagates `deps.todos` through to the executor; LLM tool-loop path (`agent/tools/executor.ts` `buildDeps`) pre-builds a `'chat'`-scoped `TodosApi` from `getDb()` when a real session is present. `persistence.ts` no longer imports `makeTodosApi` -- it takes an injected `TodosApi`. The artifact builtin fails loudly when `deps.todos` is unexpectedly absent (daemon-wiring bug signal). |
| `chatArtifactWidget` + chatView wire-up   | done (d3a5313d1b0) | `browser/chat/chatArtifactWidget.ts` + `browser/chat/media/chatArtifacts.css`. One card per artifact item (not per list); rendered payload lives inside a `<iframe sandbox="allow-scripts">` with `srcdoc` bound to the `renderedHtml.standalone` string -- isolates the Mermaid runtime from the main workbench document and avoids a root-level `mermaid` npm dep. Subscribes directly to `IInsrcTodosService`, filters via `isArtifactList`/`isArtifactItem`. Header shows kind badge + title + "Copy snippet" action (uses `IClipboardService`); footer shows provenance + warning count with hover tooltip. Wired into `chatView.ts` beside `ChatTodosWidget`. |
| `IInsrcArtifactsService` + DI             | skipped (by design) | The widget reads everything it needs from the todos-service payload (`TodoList.items`, `item.meta`). A dedicated service would re-expose the same data without new capability. Decision: **no separate service** in phase 1. If phase-2 regenerate or a future pane surface needs kind-specific browser-side helpers, revisit. |
| Slash commands `/erd` .. `/wireframe`     | skipped (by design) | **Dropped from phase 1.** Users issue NL requests ("draw an ER diagram for users and orders") and the LLM picks up the right `artifact:*` tool with no dispatcher / no prefix parsing. The tool registry (`artifact` category) already carries all five tools, so this works end-to-end once the user is in a chat with tool access. Revisit only if usage telemetry shows a real-world need for a fast shortcut. |
| `chatTodosWidget` partitioning            | done (d3a5313d1b0) | Added `isArtifactList` check to the widget's `_shouldRenderInline` so artifact lists are routed exclusively to `chatArtifactWidget`. Every list renders in exactly one surface. |
| `common/insrcArtifacts.ts` browser types  | done (d3a5313d1b0) | Mirrors the daemon-side `ArtifactItemMeta` subset the workbench needs (`kind`, `renderedHtml`, `metadata`, `warnings`, `confidence`). Ships `isArtifactItem`, `isArtifactItemMeta`, `isArtifactList` guards + `ARTIFACTS_LIST_TITLE` constant. Duplication matches the pattern already used between `src/insrc/shared/todos.ts` and `browser/common/todosService.ts` -- the wire format is the contract. |
| IDE build + precommit                     | done (verified across phase-1 commits) | `npm run precommit` (`build/hygiene.js`) clean. `scripts/build.sh ide` full compile green: `Finished compilation with 0 errors` across `compile-src`, `compile-extensions`, and `compile-client`. |
| Unit + golden tests per kind              | done (2b60347efb5) | 7 `.test.ts` files under `src/insrc/agent/tasks/artifacts/__tests__/` covering sanitise, wireframe SVG renderer, template binder + loader (with tmp-dir lint fixtures), Prisma regex parser, docker-compose + k8s YAML parsers, and wireframe kind's four-branch fallback chain with a mock LLM provider. Uses Node's built-in `node:test` module -- no vitest dep added. `npm run test:artifacts --prefix src/insrc` runs them. |
| Smoke script                              | done (2b60347efb5) | `src/insrc/agent/tasks/artifacts/__tests__/smoke.ts`: 11 cases exercising the full pipeline per kind (wireframe with caller-supplied spec / LLM mock / no-provider scaffold; sequence scaffold; flow process + code scaffolds; ER Prisma auto-detect + scaffold; deployment docker-compose + k8s + scaffold). Validates `source`, `embedded`/`standalone` HTML markers, and Mermaid grammar. `npm run test:artifacts:smoke --prefix src/insrc` runs it. Lives under `__tests__/` so the daemon tsconfig excludes it from the build + workbench hygiene leaves it alone. |
| Build verified via `scripts/build.sh`     | done (verified across phase-1 commits) | `scripts/build.sh daemon` + `scripts/build.sh ide` both pass clean; `out/insrc/` has all compiled modules + asset copy confirmed. |

### Phase 2
| Item                                      | Status | Notes |
|-------------------------------------------|--------|-------|
| `artifact:regenerate` tool                | done (c372441bf84) | New `agent/tasks/artifacts/regenerate.ts` + tool registration in the `artifact` category. Same-kind LLM source rewrite: Mermaid kinds return updated Mermaid text, wireframe returns a new `WireframeSpec` JSON that the SVG renderer repaints. Strips markdown fences, runs the wireframe shape guard, throws when the LLM output is unparseable. `deps.session.ollamaProvider` by default; `@mention` overrides still apply. |
| Revision history (last 5)                 | done (c372441bf84) | `persistence.appendRevision` pushes the prior source + the user's edit text + an ISO timestamp onto `meta.revisions`, trims to `MAX_REVISIONS = 5`. `updateItemMeta` wraps through to `db.updateItem({ meta })` + emits `itemUpdated`. Framework addition: `TodosApi.updateItemMeta(itemId, meta)` -- the first generic meta setter. |
| Artifacts Pane (Input + Pane + widget)    | done (64a5853134b) | `browser/artifacts/{artifactsInput.ts, artifactsPane.ts, artifactsCommands.ts, media/artifacts.css}`. Per-session durable editor pane extending `InsrcEditorPaneBase`. Renders every artifact item on the session's Artifacts list as a card with iframe preview + kind badge + Copy-standalone action + provenance/revisions/warnings footer. Opens via `insrc.artifacts.open` (palette, `f1: true`). Browser `ArtifactItemMeta` gained optional `revisions: ArtifactRevisionRecord[]` to mirror the daemon shape. |
| Template-override commands                | done (65cfb619cfd) | Three palette actions (`insrc.editArtifactTemplate`, `insrc.resetArtifactTemplate`, `insrc.listArtifactTemplates`) backed by a new `IInsrcArtifactsService` + three daemon RPCs (`artifacts.listTemplates`, `artifacts.ensureUserTemplate`, `artifacts.resetUserTemplate`). Ensure-template seeds from the bundled default when the user file is missing; reset confirms via `IDialogService` before deleting; list surfaces layer + path in a quick pick with an "open" action per kind. `artifacts-rpc.ts` exposes test-only `(params, userDir)` entry points so the suite targets a tmp dir without polluting `~/.insrc`. |
| `artifact:list_templates` tool            | done (c372441bf84) | Thin wrapper around `template-loader.listTemplates(opts)`. Returns a markdown table for LLM consumption + the full `TemplateInfo[]` on `ToolResult.data`. Honors `session.repoPath` for the repo-override layer. |
| `artifact:list` tool                      | todo   | Required for the NL regenerate UX (§2.5). Lists session artifacts (newest-first, cap 50) with `artifactId` / `kind` / `title` / `createdAt` / `revisionsCount`. Wraps a new `persistence.listSessionArtifacts(deps.todos)`. |
| Phase 2 unit tests                        | done (36cd5fa6aa7) | `__tests__/regenerate.test.ts`: 6 cases with a stubbed `TodosApi` (no DB) covering Mermaid + wireframe kind round-trips, markdown-fence stripping, empty-LLM rejection, shape-invalid wireframe rejection, last-5 revision eviction. 67/67 unit tests total after addition. |
| Phase 2 smoke re-run                      | done (36cd5fa6aa7) | 11/11 cases still green after the refactor. |

### Phase 3
| Item                                      | Status | Notes |
|-------------------------------------------|--------|-------|
| Live DB ER via `db:sql:describe`          | todo   | data-driver dependency landed (phases 0--5 done); `db:sql:describe` available across all RDBMS dialects. Wire `kinds/er.ts` live-DB branch + connection-id resolution. |
| Terraform plan parser                     | done (0d5fb40730f) | `kinds/terraform-source.ts` parses `terraform show -json` output: walks `planned_values.root_module` + `child_modules` recursively, extracts managed resources and `depends_on` edges, assigns Mermaid node shapes from a SHAPE_CATALOG (aws_instance / aws_lb / aws_db_instance / kubernetes_deployment / gcp / azurerm families + generic fallback rect). Emits `flowchart LR`. Auto-detected in `parseDeploymentSource` via a JSON fast-path (`trimmed.startsWith('{')` -> `tryParseTerraformPlan`) before the YAML branch, so the deployment tool dispatches Compose / k8s / Terraform by content shape with no user flag. |
| Offline mode                              | done (0d5fb40730f, c32c3248801, 89ae1b9b82e) | Cache-file-presence detection (no config flag): `agent/tasks/artifacts/offline-bundle.ts` + `template-binder.ts` inline the cached Mermaid bundle into standalone HTML when `~/.insrc/cache/artifacts/mermaid-<version>.min.js` exists and its SHA-384 matches the pinned SRI in `mermaid-cdn.json`. Three daemon RPCs (`artifacts.getOfflineBundleStatus`, `.downloadOfflineBundle`, `.removeOfflineBundle`) + three palette commands (`insrc.downloadArtifactsOfflineBundle`, `insrc.removeArtifactsOfflineBundle`, `insrc.artifactsOfflineBundleStatus`) wire it end-to-end. Download uses `undici` + SRI verify before writing. Falls back to CDN when the cache is missing or tampered. |

### Phase 4
| Item                                      | Status | Notes |
|-------------------------------------------|--------|-------|
| React introspection for wireframes        | todo   | Layout-sketch fidelity (not faithful render). Three-layer JSX classifier (layout container / semantic element / unknown), v1 library set: native HTML + MUI + Chakra + AntD + shadcn + Tailwind. Per-library classifier dictionaries land in JSON under `kinds/wireframe-classifiers/`. **No indexer extension needed**: the runner looks up the component's file + byte range via the existing `findEntitiesByName`, then re-parses the JSX subtree on demand with the same `typescript.ts` tree-sitter pass. Companion design doc: `design/artifacts/react-introspection.html`. |
| CFG-based flow                            | done   | TS / TSX / JS + Python + Go all done via on-demand tree-sitter walks on the entity's `body`. Recognised nodes per language: TS `if/switch/for/for-in/for-of/while/do-while/try/catch/finally/return/break/continue/throw`; Python `if/elif/else/match/for/while/try/except/finally/return/break/continue/raise/with`; Go `if/else if/for (all three variants)/expression_switch/type_switch/select/defer/go/return/break/continue/goto` plus `panic()` as a `throw` step. Python `with` and Go `defer/go` use specialised renderings (with body inlines, defer/go become prefixed call steps). Mermaid `flowchart TD` with branch true/false labels + loop back-edges + dotted throw arrows. 200-node cap per function; overflow falls through to the phase-1 Kuzu CALLS approximation. **No indexer changes.** |
| In-tree kind-extension contract           | todo   | Formalise `ArtifactKindRegistration<TOpts, TSource>` in `shared/artifacts.ts` + write a contributor README. No runtime plugin loader; new kinds land via PR. |
| Cross-service callflow kind (`callflow`)  | done   | New 6th artifact kind for distributed call traces. Source priority: caller-supplied Mermaid -> inline `traceJson` -> off-disk `tracePath` -> free-text scaffold. Auto-detects OTLP / Jaeger / Zipkin v2 by JSON shape (mutually exclusive shapes). **Sequence layout** renders services as participants + spans as duration-labelled messages with `--x` for ERROR + dotted `-->>` for PRODUCER + autonumber. **Flowchart layout** renders services as nodes + cross-service calls as count-aggregated edges (`auth -.->\|getUser ×3 (1 err)\| orders`); self-loops within a service are skipped as noise. Caps: 20 services / 50 spans / 5s file-read timeout. **No indexer dependency.** Companion design doc `design/artifacts/callflow.html` not yet authored (pending). |
