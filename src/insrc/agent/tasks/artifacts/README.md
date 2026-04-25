# Artifact kinds — contributor guide

This directory implements the artifact-task pipeline (see
[`plans/artifact-tasks.md`](../../../../../plans/artifact-tasks.md)).
Each artifact **kind** is an in-tree TypeScript module that turns a
typed input into an embeddable HTML snippet (rendered Mermaid diagram
or inline SVG).

> **No runtime plugin loader.** New kinds land as PR-reviewed code.
> The trust model is "did this code pass review?" — there is no
> sideloaded extension surface, no `~/.insrc/plugins/...`, no
> sandbox. See plans/artifact-tasks.md §4.3.

## Adding a new kind — three edits

To add a kind with id `'mykind'`:

1. **Extend the closed `ArtifactKind` union** in
   [`shared/artifacts.ts`](../../../shared/artifacts.ts):
   ```ts
   export type ArtifactKind =
     | 'er' | 'sequence' | 'flow' | 'deployment' | 'wireframe'
     | 'mykind';
   ```
   The union is the contract for every consumer (tool registration,
   template loader, chat widget, browser-side guards). Extending it
   here is what makes the kind discoverable everywhere.

2. **Implement the kind module** at `kinds/mykind.ts`:
   ```ts
   import type { ArtifactResult } from '../../../../shared/artifacts.js';
   import type { KindRunOpts } from '../registry.js';

   export interface MykindInput {
     readonly source?: string;
     // ... kind-specific options ...
   }

   export interface RunMykindOpts extends KindRunOpts {
     readonly input: MykindInput;
   }

   export async function runMykind(
     opts: RunMykindOpts,
   ): Promise<ArtifactResult> {
     // 1. Resolve the source from the highest-priority branch
     //    available (caller-supplied verbatim source > structured
     //    fetch > free-text scaffold).
     // 2. Bind the template (use `runMermaidArtifact` from
     //    ./shared-mermaid.js for diagram kinds, or call the
     //    template-binder directly for SVG / custom kinds).
     // 3. Return a fully-formed `ArtifactResult` (id, kind, source,
     //    renderedHtml, metadata, warnings, confidence).
   }
   ```
   Mermaid-rendered kinds (er / sequence / flow / deployment) reuse
   `kinds/shared-mermaid.ts`'s `runMermaidArtifact` helper so they're
   ~80 LoC each; the wireframe kind owns its SVG-renderer pipeline
   in full.

3. **Register the kind** in [`registry.ts`](./registry.ts):
   ```ts
   const REGISTRATIONS: readonly ArtifactKindRegistration<never>[] = [
     // ... existing rows ...
     {
       id: 'mykind',
       run: (opts => runMykind({ ...opts, input: opts.input as MykindInput })) as KindRunner,
     },
   ];
   ```
   And import the runner at the top of the file.

## Required + optional artefacts

| Item | Required | Where |
|---|---|---|
| `ArtifactKind` union member | Required | `shared/artifacts.ts` |
| `kinds/<id>.ts` runner module | Required | this directory |
| `REGISTRATIONS` row | Required | `registry.ts` |
| Tool registration | Required | `daemon/tools/builtins/artifact/index.ts` |
| Bundled template | Required | `assets/artifacts/templates/<id>.html` |
| Per-kind input options type (`ArtifactOpts` discriminant) | Required | `shared/artifacts.ts` |
| Unit + golden tests | Required | `__tests__/<id>-kind.test.ts` |
| Smoke test cases | Required | `__tests__/smoke.ts` |
| Companion design doc | Recommended for kinds with non-trivial heuristics | `design/artifacts/<id>.html` |
| Per-format / per-library JSON dictionary directory | Optional (only when the kind has multiple input formats) | `kinds/<id>-formats/` |

## Conventions

### Source priority

Every kind resolves the source-of-truth through the same priority
ordering:

1. **Caller-supplied verbatim source** (`opts.input.source`) — the
   highest-fidelity path, used by tests / scripted callers.
2. **Structured data source** — the kind's primary value-add (Prisma
   for ER, Kuzu CALLS for sequence/flow, compose/k8s/Terraform for
   deployment, etc.). Optional per-kind; on parse failure, falls
   through.
3. **Free-text + LLM stage-2** — the broadest fallback. Uses
   `opts.provider` (defaults to local Ollama via the tool layer)
   and a strict-output prompt with a runtime shape guard. On LLM
   failure, falls through to the default scaffold + a warning.
4. **Default scaffold** — a tiny hand-coded fallback so the kind
   *always* returns something. Marks `confidence: 'low'`.

The `confidence` field on `ArtifactResult` reflects which branch ran:
`'high'` for caller-supplied + most structured paths, `'medium'` for
LLM stage-2, `'low'` for the default scaffold.

### Template binding

Use the shared helpers in `template-binder.ts` rather than emitting
raw HTML:

- Diagram kinds: `runMermaidArtifact` (in `kinds/shared-mermaid.ts`)
  binds the kind's `<id>.html` template + the Mermaid source +
  metadata/warnings/title.
- Wireframe / custom kinds: call `bindTemplate(kind, payload, meta)`
  directly. The binder runs the template loader (which honours
  repo / user / bundled override layers), substitutes `@@NAME@@`
  slots, and emits both `embedded` + `standalone` rendering modes
  in one pass.

### Template-author safety

The template loader rejects any template that contains `<script>`,
`on*=` attributes, or `javascript:` URLs *outside* the
`@@RENDERER_SCRIPT@@` slot. The binder HTML-escapes every slot value
except `@@SOURCE@@` (Mermaid reads raw text) and
`@@RENDERER_SCRIPT@@` (trusted, bundled). Don't bypass these — if a
new kind needs an unusual template feature, extend the
loader/binder.

### Naming

- **Tool ids**: `artifact:<kind>` (colon, lowercase). Matches
  `notify:*`, `graph:*` repo convention. Some early prose used
  `artifact.<kind>` (dot); colon is canonical.
- **Module names**: `kinds/<id>.ts`, `kinds/<id>-sources.ts` (when
  the source-fetching helpers warrant their own file).
- **Type names**: `<Pascal>Input`, `Run<Pascal>Opts`. Match the
  pattern across existing kinds for consistency.
- **Template basename**: defaults to `<id>.html`. Override the
  `templateName` field on the registration record only if you have
  a real reason (kinds that share or sub-path another template).

## Testing

Each kind's tests live in `__tests__/`:

- **Unit + golden tests** at `__tests__/<id>-kind.test.ts` cover
  per-source-branch behaviour. Use Node's stdlib `node:test` +
  `node:assert`; no vitest or other test framework dependency. Run
  with `npm run test:artifacts --prefix src/insrc`.
- **Smoke cases** at `__tests__/smoke.ts` exercise the full
  pipeline (fetch → render → bind) against fixture inputs and
  validate the rendered HTML markers + Mermaid grammar. Add at
  least one case per kind. Run with
  `npm run test:artifacts:smoke --prefix src/insrc` (gated; do not
  run in CI without explicit approval per the project rule).

## Where to ask

Implementation questions: surface them on the PR.

Design questions (new kinds, fidelity targets, source priorities):
land a design doc under `design/artifacts/<id>.html` first and link
it from the §4.3 plan section in `plans/artifact-tasks.md`.
