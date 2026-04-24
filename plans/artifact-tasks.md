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
| 2     | Iteration: regenerate tool, Artifacts Pane, template-override commands       | done -- `artifact:regenerate` + `artifact:list_templates` tools, `TodosApi.updateItemMeta` extension, `persistence.appendRevision` with last-5 eviction, Artifacts editor pane (durable) + `insrc.artifacts.open` command, template-override palette commands (edit / reset / list) backed by a new `IInsrcArtifactsService` + three daemon RPCs. Tests: 78/78 unit + 11/11 smoke (all green), IDE compile + precommit clean. |
| 3     | Deeper data sources: live DB ER, Terraform deployment, offline mode          | partial -- Terraform plan parser + offline mode (SRI-verified download-on-demand) done; live-DB ER stays blocked on code-analyzer phase 3. |
| 4     | Advanced: React introspection, CFG-based flow, plugin contract               | todo |

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
5. Iterable via `artifact.regenerate`.
6. Callable by any tool-capable LLM turn (chat, agent families) from
   natural-language requests -- no slash dispatcher in phase 1.

## Non-goals

See design §2. Summary: no free-form "artifact generator" agent, no
high-fidelity mockups, no third-party hosting, no new agent family.

---

## Module layout

Daemon-side (new files, unless noted):

```
src/insrc/shared/artifacts.ts                 # shared types -- ArtifactKind, ArtifactResult,
                                              # WireframeSpec, TemplateInfo, etc.

src/insrc/agent/tasks/artifacts/
  types.ts                                    # internal types (source-fetch models,
                                              # ArtifactItemMeta, RevisionRecord)
  registry.ts                                 # kind registry + invocation dispatch
  prompts.ts                                  # per-kind stage-2 prompts (source-render)
  sanitise.ts                                 # slot-value sanitiser (HTML-escape subset)
  template-loader.ts                          # three-layer template resolution
  template-binder.ts                          # slot substitution + mode switch
  persistence.ts                              # TodoItem read/write + revisions
  kinds/
    er.ts                                     # ER task: Prisma/Kuzu/DB/free-text fetch + render
    sequence.ts                               # sequence task: Kuzu CALLS traversal + render
    flow.ts                                   # flow task: code-flow OR process sub-kinds
    deployment.ts                             # deployment: compose/k8s/free-text
    wireframe.ts                              # wireframe task: free-text -> spec -> SVG
  wireframe/
    spec.ts                                   # WireframeSpec type (mirrored in shared/)
    render.ts                                 # SVG generator, pure + deterministic

src/insrc/daemon/tools/artifacts/
  index.ts                                    # registers artifact.* tools
  er.ts          sequence.ts  flow.ts         # thin tool wrappers -> kinds/
  deployment.ts  wireframe.ts
  regenerate.ts                               # artifact.regenerate tool (phase 2)
  list_templates.ts                           # artifact.list_templates (phase 2)

src/insrc/assets/artifacts/templates/
  er.html   sequence.html   flow.html         # bundled defaults
  deployment.html   wireframe.html
  _renderer.html                              # shared standalone-mode <script> snippet
```

Browser-side:

```
src/vs/workbench/contrib/insrc/common/
  artifactsService.ts                         # IInsrcArtifactsService interface (phase 1)

src/vs/workbench/contrib/insrc/browser/
  artifacts/                                  # phase 2
    artifactsInput.ts                         # EditorInput keyed by sessionId
    artifactsPane.ts                          # InsrcEditorPaneBase subclass
    artifactsListWidget.ts                    # list of artifacts with preview + regen
    media/artifacts.css
  chat/
    chatArtifactWidget.ts                     # phase 1 -- mirrors chatTodosWidget
    chatView.ts                               # edit: instantiate widget, wire event stream
```

No slash-command dispatcher in phase 1 (dropped by design). Natural-
language requests flow through the existing classifier + chat path and
the LLM picks the right `artifact:*` tool from the registry.

---

## Phase 0 -- Prerequisites

### 0.1 Mermaid dependency

- **Decision (design §8.1):** pin Mermaid at a v10 release. Exact
  version: `10.9.1` (latest in the v10 line at plan-write time).
  Confirm the pin is still current at the start of phase 0.
- Add `"mermaid": "10.9.1"` to `vscode-insrc/package.json`
  dependencies (the native workbench contrib is where the widget
  runs).
- Bundle into the browser artifact via the existing esbuild config
  (`vscode-insrc/esbuild.config.mjs`). Confirm the bundle size delta
  and that the esbuild build passes.
- Add the matching CDN `<script>` + SRI hash constants for
  standalone-mode templates. Script:
  `https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js`.
  Compute the SRI hash locally (`openssl dgst -sha384 -binary ... |
  openssl base64 -A`) and check it into
  `src/insrc/assets/artifacts/mermaid-cdn.json` so the template
  binder reads it at runtime rather than baking it into a string
  constant.

### 0.2 Shared types + asset pipeline

- New `src/insrc/shared/artifacts.ts` exports:
  - `ArtifactKind = 'er' | 'sequence' | 'flow' | 'deployment' | 'wireframe'`
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
  - `name`: `artifact.er`, `artifact.sequence`, `artifact.flow`,
    `artifact.deployment`, `artifact.wireframe`.
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
  an active agent controller). `meta.suppressComments: true` on the
  list (framework suppression flag from code-analyzer design §10.1)
  -- artifacts are not a comment surface.
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
- Subscribes to the chat event stream for `'artifact'` events and
  renders each artifact into a DOM node keyed by `artifactId`.
  Updates (regenerate from phase 2) mutate the node in place.
- Bootstraps Mermaid once per widget lifetime:
  `import('mermaid').then(m => m.default.initialize({ startOnLoad: false, theme: 'dark' }))`.
  On each new artifact: `mermaid.run({ nodes: [el] })`. Wireframe
  artifacts ship with SVG already inline -- no Mermaid call needed.
- Kebab menu per card:
  - "Copy snippet (standalone)" -> clipboard.
  - "Open in Artifacts Pane" -> phase 2 affordance, hidden until
    phase 2 ships.
  - "Regenerate with edits..." -> phase 2 affordance, hidden until
    phase 2 ships.
- Wire-up in `chatView.ts`: instantiate the widget in the DI
  constructor alongside `ChatTodosWidget` (see
  `chatView.ts:259`); subscribe via `IInsrcArtifactsService`
  (added in this phase -- see §1.7).
- Honour the workbench-hygiene feedback from memory: curly braces
  on single-line `if`s, hoisted union types. Run `npm run precommit`
  before staging.

### 1.7 Browser service

- New file
  `src/vs/workbench/contrib/insrc/common/artifactsService.ts`:
  `IInsrcArtifactsService` interface exposing `onDidEmitArtifact:
  Event<ArtifactEvent>` plus a `openArtifact(id)` hook that's a
  no-op in phase 1 (phase 2 points at the Artifacts Pane).
- Implementation in
  `src/vs/workbench/contrib/insrc/browser/artifactsServiceImpl.ts`
  subscribes to the daemon's artifact RPC event channel and
  re-fires in the browser.
- Register DI contribution in `insrc.contribution.ts` alongside the
  todos service.

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

**Reminder (user memory):** do not run the smoke test without
explicit approval.

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

### 2.1 `artifact.regenerate` tool

- `src/insrc/daemon/tools/artifacts/regenerate.ts` registers
  `artifact.regenerate`.
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
- `artifact.list_templates` daemon tool (same data, callable by
  agents) -- thin wrapper around `template-loader.listAll()`.
- File watcher: the template loader already invalidates its cache
  on mtime change (§1.4); the override commands need only write
  files -- the loader picks up changes on next resolution.

### 2.4 Regenerate UX -- natural-language only

No slash wrapper in phase 2; same policy as phase 1. The user asks
"regenerate the ER with a different orientation" (or references the
artifact by title, "the user/orders ER"), the LLM picks the last-
created artifact on the session's Artifacts list -- or asks for
clarification when ambiguous -- and calls
`artifact:regenerate({ artifactId, edits })`. Artifact id resolution
is the LLM's job, informed by the artifact list the tool registry
exposes through `artifact:list_templates` or a companion lookup
tool.

### 2.5 Tests

- `regenerate` unit test: prior source + edits -> new source
  differs; revisions accumulate; last-5 eviction.
- Artifacts Pane smoke: open pane for a session with three
  artifacts, confirm all render, confirm regenerate button path
  round-trips through the daemon.
- Template-override command tests: edit creates user override,
  reset deletes it, list reports correct layer.

### 2.6 Blocks

- Phase 3 -- classifier NL routing uses the `list_templates`
  output to build its disambiguation prompt.

---

## Phase 3 -- Deeper data sources

### 3.1 Live DB ER via `db.sql.*`

- Depends on code-analyzer phase 3 (DB driver). Wait for it.
- Wire `kinds/er.ts`'s live-DB branch to call
  `db.sql.describe(connection, table)` per requested table and
  assemble the SchemaDescription list into a Mermaid
  `erDiagram`.
- Provenance metadata: `metadata.provenance = "live DB: <connectionId>"`.

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

- New setting `insrc.artifacts.offline: boolean` (default
  `false`).
- When on, the template binder replaces the CDN
  `<script src=...>` in standalone mode with an inline
  `<script>...</script>` containing the bundled Mermaid source
  (read from `node_modules/mermaid/dist/mermaid.min.js` at
  daemon boot, cached).
- Snippet size goes up by ~200 KB in standalone mode. Offline
  mode ALSO changes the bundled-mermaid embed target to avoid
  network for any render.

### 3.4 Tests

- Live DB ER: fixture Postgres (docker-compose'd test DB) with a
  known schema -> assert ER output.
- Terraform: plan JSON fixture -> assert deployment flowchart.
- Offline mode: standalone snippet parses without a network
  connection during test.

### 3.5 Blocks

- Phase 4 -- React introspection builds on the Kuzu entity graph,
  unrelated to phase 3 but sequenced after it for scope control.

---

## Phase 4 -- Advanced sources + extensibility

### 4.1 React component introspection for wireframes

- `kinds/wireframe.ts` gains a Kuzu-backed branch when
  `opts.component` is provided.
- Walk the component's JSX/TSX subtree via the parser's CST
  output (already captured during indexing) and infer a
  `WireframeSpec` from the structural shape.
- Free-text path remains the default; React path is opt-in via
  explicit `opts.component`.

### 4.2 CFG-based flow diagrams

- `kinds/flow.ts`'s code-flow branch upgrades from "read the
  function body + LLM" to "walk Kuzu `BRANCHES` edges" when the
  parser emits them.
- Requires the indexer to populate `BRANCHES` relations on control
  flow -- may be its own prior work; tracked in the indexer plan.
- Falls back to the phase-1 LLM path when `BRANCHES` isn't
  available for a function.

### 4.3 Plugin contract for third-party kinds

- Define a small plugin shape that lets a community author
  contribute a new `ArtifactKind`:
  ```ts
  interface ArtifactKindPlugin {
    id: string;                     // kind id
    sourceFetch: (opts) => Promise<SourceModel>;
    sourceRender: (model, opts) => Promise<RenderPayload>;
    templatePath: string;           // within the plugin package
    slashCommand?: string;
  }
  ```
- Plugin loader lives in
  `src/insrc/daemon/tools/artifacts/plugins.ts`, discovers
  plugins at daemon boot from
  `~/.insrc/plugins/artifacts/*/plugin.json`, validates, registers.
- Out of scope for phase 4: signing, marketplace, auto-updates.

### 4.4 Tests

- React component introspection: fixture component tree -> known
  spec.
- CFG flow: fixture function with known branching -> flowchart
  matches golden.
- Plugin loader: stub plugin loads and produces an artifact.

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
   mode until the hash is re-computed. Mitigation: the embedded-
   mode path doesn't depend on the CDN, so the default chat-view
   UX is unaffected. Phase 3's offline mode removes the CDN
   dependency entirely for users who opt in.

---

## Status table (per-phase, for filling in during implementation)

### Phase 0
| Item                              | Status | Notes |
|-----------------------------------|--------|-------|
| Mermaid 10.9.1 in `package.json`  | not needed (by design) | The chat widget renders artifacts in a sandboxed `<iframe srcdoc=…>` carrying the standalone-mode HTML (CDN `<script>` + SRI-pinned integrity hash). Mermaid loads inside the iframe document -- no main-doc import, no npm dep in root `package.json`. |
| CDN SRI hash json                 | done (uncommitted) | `src/insrc/assets/artifacts/mermaid-cdn.json` — pinned v10.9.1, jsdelivr URL, SRI `sha384-WmdflGW…` computed locally from the CDN bundle. `MermaidCdnMeta` type in shared/artifacts.ts. |
| `shared/artifacts.ts` types       | done (uncommitted) | `ArtifactKind`, `ArtifactResult`, `RenderedArtifactHtml`, `ArtifactItemMeta`, `ArtifactRevisionRecord`, `TemplateInfo`, `TemplateLayer`, `WireframeSpec`/`Row`/`Cell`, tagged-union `ArtifactOpts`, `MermaidCdnMeta`, `ArtifactEvent`, kind guards. Zero runtime deps. |
| Asset-copy pipeline verified      | done (uncommitted) | `scripts/build.sh` `build_daemon()` extended to `cp -a src/insrc/assets/. out/insrc/assets/` after tsc. Build confirmed: `[insrc-build] copying daemon assets` in log, `out/insrc/assets/artifacts/{mermaid-cdn.json,templates/*}` all present. |

### Phase 1
| Item                                      | Status | Notes |
|-------------------------------------------|--------|-------|
| `artifact:*` tool registrations           | done (uncommitted) | All 5 tool ids (`artifact:er`, `:sequence`, `:flow`, `:deployment`, `:wireframe`) registered in `daemon/tools/builtins/artifact/index.ts` with per-kind JSON schemas (common props + `source` + kind-specific options). `artifact` category in `ALL_CATEGORIES`, bootstrap wired. All 5 dispatch to a real runner. Tool-id convention: `artifact:<kind>` (colon, matches `notify:*`, `graph:*`). |
| Kind registry + dispatcher                | done (uncommitted) | `agent/tasks/artifacts/registry.ts`. `dispatch(kind, opts, input) -> ArtifactResult`. `listRunnableKinds()` for introspection. All 5 kinds now wired to real runners; no stubs remaining. |
| `kinds/er.ts` (Prisma + Kuzu + text)      | done (uncommitted) | Four-branch source priority: caller-supplied Mermaid -> auto-detected `schema.prisma` (hand-rolled regex parser at `kinds/er-sources.ts`; no `@prisma/internals` dep) -> Kuzu entity-graph traversal via `findEntitiesByName` + REFERENCES Cypher -> default scaffold. Live-DB introspection remains phase 3. |
| `kinds/sequence.ts`                       | done (uncommitted) | Three-branch source priority: caller-supplied Mermaid -> Kuzu CALLS traversal from `entry` (id or name) via the new `kinds/call-graph.ts` helper, rendered as a `sequenceDiagram` with autonumbered messages -> two-actor scaffold. Depth capped at 6; participants capped at 20 to keep diagrams legible. |
| `kinds/flow.ts` (both sub-kinds)          | done (uncommitted) | Code sub-kind uses the same `call-graph.ts` helper as sequence, rendered as `flowchart LR` with the entry node stylised. Process sub-kind stays free-text. True CFG (BRANCHES-edge traversal) is a phase-4 upgrade; the call-graph approximation is marked with `(CFG approximation)` in provenance. |
| `kinds/deployment.ts` (compose + k8s)     | done (uncommitted) | Auto-detects docker-compose vs k8s via first-doc shape (`apiVersion`+`kind` vs. `services:`) and emits Mermaid `flowchart LR`. Compose branch walks services + `depends_on`. K8s branch covers Deployment/StatefulSet/DaemonSet/Job/CronJob/Service/Ingress/ConfigMap/Secret, drawing Service selectors -> workloads and Ingress -> Service backends, plus dotted `-.->` edges for ConfigMap/Secret refs. Terraform stays phase 3. |
| `kinds/wireframe.ts` + SVG renderer       | done (uncommitted) | SVG renderer pure + deterministic. Source priority: caller-supplied `WireframeSpec` -> LLM stage-2 synthesis (local Ollama by default via `deps.session.ollamaProvider`, with strict JSON prompt + runtime shape guard + fenced-JSON extraction) -> default scaffold. LLM failures emit a warning and fall back to the default. Confidence bands high/medium/low reflect the branch taken. |
| `kinds/*` shared source helpers           | done (uncommitted) | `kinds/er-sources.ts` + `kinds/deployment-sources.ts` + `kinds/call-graph.ts` keep each kind's module focused on input-resolution + metadata while fetchers live in their own files. `db/entities.ts` gained a small `findEntitiesByName(db, names, opts)` helper reused by ER (Kuzu branch) + call-graph (sequence/flow). |
| Shared Mermaid-kind helper                | done (uncommitted) | `kinds/shared-mermaid.ts`: `runMermaidArtifact(inv, opts)` binds the template + packages the `ArtifactResult`. `cleanOneLine` + `truncate` helpers used by each kind's label sanitisation. Cuts the four Mermaid kinds to ~80 LoC each. |
| Template loader + binder + sanitiser      | done (uncommitted) | `template-loader.ts`: 3-layer resolution (repo -> user -> bundled), mtime-keyed cache, pre-load lint (rejects raw `<script>`, `on*=` attrs, `javascript:` URLs) with degrade-to-bundled on failure. `template-binder.ts`: plain string-replace on `@@NAME@@` tokens, emits both `embedded` + `standalone` in one pass, SRI-pinned CDN `<script>` injected in standalone mode only, wireframe kind gets empty renderer script regardless of mode. `sanitise.ts`: HTML-escape + control-char strip + `javascript:` neutraliser; narrow `escapeMermaidSource` for the `@@SOURCE@@` slot on diagram kinds. |
| Five bundled templates                    | done (uncommitted) | `src/insrc/assets/artifacts/templates/{er,sequence,flow,deployment,wireframe}.html` + shared `_renderer.html`. Each template: VS Code theme-token-aware CSS, kind-specific CSS class, data attributes for DOM attribution. Lint passes. |
| TodoItem-backed persistence               | done (uncommitted) | `persistence.ts`: auto-creates session's `Artifacts` list on first write, persists each artifact as a completed `TodoItem` with the full `ArtifactItemMeta` on `meta`, rides the existing `todos` stream for live updates (no new stream kind). Caller-family routing + module-boundary cleanup landed: `ToolDeps.todos?: TodosApi` added to the unified tool-deps type; controller task path (`daemon/task.ts`) propagates `deps.todos` through to the executor; LLM tool-loop path (`agent/tools/executor.ts` `buildDeps`) pre-builds a `'chat'`-scoped `TodosApi` from `getDb()` when a real session is present. `persistence.ts` no longer imports `makeTodosApi` -- it takes an injected `TodosApi`. The artifact builtin fails loudly when `deps.todos` is unexpectedly absent (daemon-wiring bug signal). |
| `chatArtifactWidget` + chatView wire-up   | done (uncommitted) | `browser/chat/chatArtifactWidget.ts` + `browser/chat/media/chatArtifacts.css`. One card per artifact item (not per list); rendered payload lives inside a `<iframe sandbox="allow-scripts">` with `srcdoc` bound to the `renderedHtml.standalone` string -- isolates the Mermaid runtime from the main workbench document and avoids a root-level `mermaid` npm dep. Subscribes directly to `IInsrcTodosService`, filters via `isArtifactList`/`isArtifactItem`. Header shows kind badge + title + "Copy snippet" action (uses `IClipboardService`); footer shows provenance + warning count with hover tooltip. Wired into `chatView.ts` beside `ChatTodosWidget`. |
| `IInsrcArtifactsService` + DI             | skipped (by design) | The widget reads everything it needs from the todos-service payload (`TodoList.items`, `item.meta`). A dedicated service would re-expose the same data without new capability. Decision: **no separate service** in phase 1. If phase-2 regenerate or a future pane surface needs kind-specific browser-side helpers, revisit. |
| Slash commands `/erd` .. `/wireframe`     | skipped (by design) | **Dropped from phase 1.** Users issue NL requests ("draw an ER diagram for users and orders") and the LLM picks up the right `artifact:*` tool with no dispatcher / no prefix parsing. The tool registry (`artifact` category) already carries all five tools, so this works end-to-end once the user is in a chat with tool access. Revisit only if usage telemetry shows a real-world need for a fast shortcut. |
| `chatTodosWidget` partitioning            | done (uncommitted) | Added `isArtifactList` check to the widget's `_shouldRenderInline` so artifact lists are routed exclusively to `chatArtifactWidget`. Every list renders in exactly one surface. |
| `common/insrcArtifacts.ts` browser types  | done (uncommitted) | Mirrors the daemon-side `ArtifactItemMeta` subset the workbench needs (`kind`, `renderedHtml`, `metadata`, `warnings`, `confidence`). Ships `isArtifactItem`, `isArtifactItemMeta`, `isArtifactList` guards + `ARTIFACTS_LIST_TITLE` constant. Duplication matches the pattern already used between `src/insrc/shared/todos.ts` and `browser/common/todosService.ts` -- the wire format is the contract. |
| IDE build + precommit                     | done (uncommitted) | `npm run precommit` (`build/hygiene.js`) clean. `scripts/build.sh ide` full compile green: `Finished compilation with 0 errors` across `compile-src`, `compile-extensions`, and `compile-client`. |
| Unit + golden tests per kind              | done (uncommitted) | 7 `.test.ts` files under `src/insrc/agent/tasks/artifacts/__tests__/` covering sanitise, wireframe SVG renderer, template binder + loader (with tmp-dir lint fixtures), Prisma regex parser, docker-compose + k8s YAML parsers, and wireframe kind's four-branch fallback chain with a mock LLM provider. Uses Node's built-in `node:test` module -- no vitest dep added. `npm run test:artifacts --prefix src/insrc` runs them. |
| Smoke script                              | done (uncommitted) | `src/insrc/agent/tasks/artifacts/__tests__/smoke.ts`: 11 cases exercising the full pipeline per kind (wireframe with caller-supplied spec / LLM mock / no-provider scaffold; sequence scaffold; flow process + code scaffolds; ER Prisma auto-detect + scaffold; deployment docker-compose + k8s + scaffold). Validates `source`, `embedded`/`standalone` HTML markers, and Mermaid grammar. `npm run test:artifacts:smoke --prefix src/insrc` runs it. Lives under `__tests__/` so the daemon tsconfig excludes it from the build + workbench hygiene leaves it alone. |
| Build verified via `scripts/build.sh`     | done (uncommitted) | `scripts/build.sh daemon` + `scripts/build.sh ide` both pass clean; `out/insrc/` has all compiled modules + asset copy confirmed. |

### Phase 2
| Item                                      | Status | Notes |
|-------------------------------------------|--------|-------|
| `artifact:regenerate` tool                | done (uncommitted) | New `agent/tasks/artifacts/regenerate.ts` + tool registration in the `artifact` category. Same-kind LLM source rewrite: Mermaid kinds return updated Mermaid text, wireframe returns a new `WireframeSpec` JSON that the SVG renderer repaints. Strips markdown fences, runs the wireframe shape guard, throws when the LLM output is unparseable. `deps.session.ollamaProvider` by default; `@mention` overrides still apply. |
| Revision history (last 5)                 | done (uncommitted) | `persistence.appendRevision` pushes the prior source + the user's edit text + an ISO timestamp onto `meta.revisions`, trims to `MAX_REVISIONS = 5`. `updateItemMeta` wraps through to `db.updateItem({ meta })` + emits `itemUpdated`. Framework addition: `TodosApi.updateItemMeta(itemId, meta)` -- the first generic meta setter. |
| Artifacts Pane (Input + Pane + widget)    | done (uncommitted) | `browser/artifacts/{artifactsInput.ts, artifactsPane.ts, artifactsCommands.ts, media/artifacts.css}`. Per-session durable editor pane extending `InsrcEditorPaneBase`. Renders every artifact item on the session's Artifacts list as a card with iframe preview + kind badge + Copy-standalone action + provenance/revisions/warnings footer. Opens via `insrc.artifacts.open` (palette, `f1: true`). Browser `ArtifactItemMeta` gained optional `revisions: ArtifactRevisionRecord[]` to mirror the daemon shape. |
| Template-override commands                | done (uncommitted) | Three palette actions (`insrc.editArtifactTemplate`, `insrc.resetArtifactTemplate`, `insrc.listArtifactTemplates`) backed by a new `IInsrcArtifactsService` + three daemon RPCs (`artifacts.listTemplates`, `artifacts.ensureUserTemplate`, `artifacts.resetUserTemplate`). Ensure-template seeds from the bundled default when the user file is missing; reset confirms via `IDialogService` before deleting; list surfaces layer + path in a quick pick with an "open" action per kind. `artifacts-rpc.ts` exposes test-only `(params, userDir)` entry points so the suite targets a tmp dir without polluting `~/.insrc`. |
| `artifact:list_templates` tool            | done (uncommitted) | Thin wrapper around `template-loader.listTemplates(opts)`. Returns a markdown table for LLM consumption + the full `TemplateInfo[]` on `ToolResult.data`. Honors `session.repoPath` for the repo-override layer. |
| Phase 2 unit tests                        | done (uncommitted) | `__tests__/regenerate.test.ts`: 6 cases with a stubbed `TodosApi` (no DB) covering Mermaid + wireframe kind round-trips, markdown-fence stripping, empty-LLM rejection, shape-invalid wireframe rejection, last-5 revision eviction. 67/67 unit tests total after addition. |
| Phase 2 smoke re-run                      | done (uncommitted) | 11/11 cases still green after the refactor. |

### Phase 3
| Item                                      | Status | Notes |
|-------------------------------------------|--------|-------|
| Live DB ER via `db.sql.*`                 | todo   | blocks on code-analyzer phase 3 |
| Terraform plan parser                     | done (uncommitted) | `kinds/terraform-source.ts` parses `terraform show -json` output: walks `planned_values.root_module` + `child_modules` recursively, extracts managed resources and `depends_on` edges, assigns Mermaid node shapes from a SHAPE_CATALOG (aws_instance / aws_lb / aws_db_instance / kubernetes_deployment / gcp / azurerm families + generic fallback rect). Emits `flowchart LR`. Auto-detected in `parseDeploymentSource` via a JSON fast-path (`trimmed.startsWith('{')` -> `tryParseTerraformPlan`) before the YAML branch, so the deployment tool dispatches Compose / k8s / Terraform by content shape with no user flag. |
| Offline mode                              | done (uncommitted) | Cache-file-presence detection (no config flag): `agent/tasks/artifacts/offline-bundle.ts` + `template-binder.ts` inline the cached Mermaid bundle into standalone HTML when `~/.insrc/cache/artifacts/mermaid-<version>.min.js` exists and its SHA-384 matches the pinned SRI in `mermaid-cdn.json`. Three daemon RPCs (`artifacts.getOfflineBundleStatus`, `.downloadOfflineBundle`, `.removeOfflineBundle`) + three palette commands (`insrc.downloadArtifactsOfflineBundle`, `insrc.removeArtifactsOfflineBundle`, `insrc.artifactsOfflineBundleStatus`) wire it end-to-end. Download uses `undici` + SRI verify before writing. Falls back to CDN when the cache is missing or tampered. |

### Phase 4
| Item                                      | Status | Notes |
|-------------------------------------------|--------|-------|
| React introspection for wireframes        | todo   |       |
| CFG-based flow                            | todo   | blocks on indexer `BRANCHES` |
| Plugin contract                           | todo   |       |
