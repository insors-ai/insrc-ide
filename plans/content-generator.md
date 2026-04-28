# Plan: Multi-pass content generator

A reusable module for generating long-form content (markdown reports,
design docs, RFCs, brainstorm specs) on models with short output
context windows. Decomposes generation into two passes -- structure
first, then per-section bodies -- so each pass fits comfortably
inside the model's `num_predict` ceiling.

---

## Why this exists

The Phase 2.A code-analyzer test surfaced a recurring failure mode:
the synthesise step produced ~13 KB of report markdown before
devstral hit its 4000-token ceiling and emitted an unterminated
string mid-sentence (`"Unterminated string in JSON at position
13186"`, F10 diagnostic). Local models in the 4-32 GB range have
output windows of roughly 4-8 K tokens after their tool-loop
overhead -- enough for short prose, not enough for full reports.

Today's single-pass approach ("here's the prompt + accepted
findings; emit the whole markdown") is structurally fragile:

  - **Hard truncation on long output.** No graceful degradation;
    the parser sees a half-cooked doc and fails the whole turn.
  - **No partial salvage.** A model that runs out of budget
    mid-section loses everything generated up to that point
    because the framework expects a complete document.
  - **No streaming UX.** The user sees a long silent gap, then a
    document dump. Worse than seeing the doc build up section by
    section.
  - **No section caching.** A re-run of the same prompt regenerates
    the entire doc from scratch even if 80% of the sections would
    have produced the same content.

The two-pass shape solves all four:

  - Pass 1's output (an outline) is small and bounded -- always
    fits.
  - Pass 2 per section is small and bounded -- each fits.
  - Sections are independent at write time -- we can stream them
    as they complete and cache each by its content hash.

---

## Goals

1. One reusable `generateMultiPass({ outline, section }, provider)`
   module any agent can call.
2. Strict pass-1 output via JSON Schema constraint (Ollama native;
   instructor-style retry on failure).
3. Bounded pass-2 outputs (sections cap at a configurable token
   budget; the model is told the budget up front).
4. Fail-soft per section: if section K fails, sections 1..K-1 +
   K+1..N still ship; the user gets a doc with one "(unable to
   generate)" placeholder rather than no doc.
5. Optional parallel pass-2 (sections independent by default;
   serial when dependencies are declared).
6. Streaming: each completed section emits a progress event the
   caller can render live.
7. Section-level caching: stable cache keys derived from outline
   + section context.

Non-goals:

- Replacing the single-pass synthesise wholesale. For S/M-tier
  prompts the single-pass is faster and cheaper; multi-pass is
  for L/XL/XXL+ tiers where the doc is long enough to truncate.
- Producing arbitrary document formats. Markdown only in the
  first cut. JSON / HTML / structured-data outputs are deferred.

---

## The two-pass flow

```
+----------------------------------------------------------------------+
|  Pass 1 -- OUTLINE                                                   |
|                                                                       |
|  Input:  user request + context (what's the doc about?)              |
|  Output: { sections: [ { id, title, intent, budgetTokens? } ... ] }  |
|  Provider: typically the cloud model (small output, structural).    |
|  Bounded: max ~12 sections; max ~1500 tokens output.                 |
+-----------------------------+----------------------------------------+
                              |
              for each section (in order, or parallel)
                              |
+-----------------------------v----------------------------------------+
|  Pass 2 -- SECTION BODY                                              |
|                                                                       |
|  Input:  section.intent + user request +                             |
|          earlier-section bodies (for dependency-aware sections)      |
|  Output: markdown body string                                        |
|  Provider: typically the local model (cheap; bounded budget).        |
|  Bounded: section.budgetTokens (default 1500).                       |
+-----------------------------+----------------------------------------+
                              |
                              v
+----------------------------------------------------------------------+
|  STITCH                                                              |
|                                                                       |
|  Compose: <doc-title>                                                |
|           <section[0].title>                                         |
|           <section[0].body>                                          |
|           ... (in outline order)                                     |
|                                                                       |
|  Optionally sanitize via existing sanitizeMarkdownReport().          |
+----------------------------------------------------------------------+
```

---

## Public interface

### Location

`src/insrc/agent/content-gen/index.ts` (new module). Sibling to
`agent/classify/` which has the same "small reusable LLM helper"
shape.

### Module surface

```ts
import type { LLMProvider } from '../../shared/types.js';

export interface SectionPlan {
  /** Stable id used for caching + cross-section refs. */
  readonly id: string;
  /** Markdown heading text (no leading `#`s -- caller chooses depth). */
  readonly title: string;
  /** One-sentence brief telling the section writer what to produce. */
  readonly intent: string;
  /**
   * Token budget for the section body. Defaults to `defaultSectionTokens`
   * from the call options. The pass-2 prompt is told this so it
   * self-regulates length.
   */
  readonly budgetTokens?: number | undefined;
  /**
   * Section ids whose bodies must be drafted before this section.
   * Forces serial ordering. Default: independent (parallel-safe).
   */
  readonly dependsOn?: readonly string[] | undefined;
}

export interface OutlineResult {
  /** Doc-level title (may be empty if the caller already has one). */
  readonly title: string;
  /** Ordered section list. */
  readonly sections: readonly SectionPlan[];
}

export interface SectionResult {
  readonly id: string;
  /** Markdown body. Empty string when generation failed and no salvage. */
  readonly body: string;
  /** True when the model errored / hit budget / produced unparseable output. */
  readonly fallback: boolean;
  /** Free-form error / fallback reason. */
  readonly note?: string | undefined;
}

export interface GenerateMultiPassInput {
  /** Caller-supplied prompt builders -- the module is content-agnostic. */
  readonly outline: {
    /** System prompt for pass 1. */
    readonly system: string;
    /** User prompt for pass 1 (the actual content brief). */
    readonly user: string;
    /** Cap on the number of sections the outline may produce. Default 12. */
    readonly maxSections?: number;
    /** Cap on outline-pass output tokens. Default 1500. */
    readonly maxTokens?: number;
  };
  readonly section: {
    /**
     * Build the system + user pair for a given section.
     * Receives the section plan, the outline (full), the previously-
     * completed sections (when dependsOn is set), and any caller-supplied
     * context bundle.
     */
    build(args: {
      readonly section: SectionPlan;
      readonly outline: OutlineResult;
      readonly prior: ReadonlyMap<string, SectionResult>;
    }): { system: string; user: string };
    /** Default budget when SectionPlan.budgetTokens is unset. Default 1500. */
    readonly defaultBudgetTokens?: number;
  };
  /** Optional progress stream -- one event per section completion. */
  readonly onSectionComplete?: ((r: SectionResult) => void) | undefined;
  /** Optional cancellation signal -- aborts in-flight passes. */
  readonly signal?: AbortSignal | undefined;
  /**
   * Run independent (no-deps) sections in parallel. Default true.
   * Set false when the local provider can't sustain N concurrent
   * generations cleanly.
   */
  readonly parallel?: boolean;
}

export interface GenerateMultiPassResult {
  readonly outline: OutlineResult;
  readonly sections: readonly SectionResult[];
  /** Stitched final markdown -- title + sections in outline order. */
  readonly markdown: string;
  /** True if any pass failed (outline OR a section). */
  readonly degraded: boolean;
}

export async function generateMultiPass(
  input: GenerateMultiPassInput,
  provider: LLMProvider,
): Promise<GenerateMultiPassResult>;
```

The module is content-agnostic: it doesn't know about findings or
brainstorm or RFCs. Callers supply the pass-1 + pass-2 prompts;
the module owns the call orchestration, retry, schema enforcement,
parallelism, stitching, and streaming.

---

## Pass 1: outline

### Output schema (Ollama JSON Schema constraint)

```ts
const OUTLINE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    sections: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1 },
          intent: { type: 'string', minLength: 1 },
          budgetTokens: { type: 'number' },
          dependsOn: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['id', 'title', 'intent'],
      },
    },
  },
  required: ['title', 'sections'],
} as const;
```

### Prompt shape

The caller's `outline.system` is used verbatim as the system
prompt; the module appends a stricter rules block that locks the
output to the schema:

```
${caller.system}

# Output rules

You will produce ONLY a JSON object matching the OutlineResult shape.
Required fields: title, sections (array, 1-${maxSections}).
Each section: { id, title, intent, budgetTokens?, dependsOn? }.
`id` is a stable slug (letters / digits / `-`); used for caching.
`intent` is a SHORT (1-2 sentence) brief telling the section writer
what to produce -- not the section body itself.
`dependsOn` lists `id`s that must be drafted first; default is empty
(sections independent + parallel-safe).

Do NOT write any section bodies in this pass. Reply with the outline
JSON only -- no prose, no fences.
```

### Schema enforcement + retry

Outline pass uses Ollama's native `format: <OUTLINE_SCHEMA>`
constraint (when the provider supports it; falls back to
prompt-only on cloud providers that don't). On schema_violation:
the module retries once with the validation error fed back as a
correction message (Instructor pattern, mirroring what
`agent/classify/index.ts` does). Failure of the retry returns a
synthesised single-section outline (`{ title: 'Generated content',
sections: [{ id: 'body', title: '', intent: caller.user.slice(0,200) }] }`)
so the caller still gets *something*.

### Provider choice

By default the outline pass uses the same provider as the call
context (caller's resolved provider). Outlines benefit from
cloud-grade reasoning (12-section structural plans are where models
differ); a future opt-in could pin pass-1 to the cloud default and
pass-2 to local, but the first cut keeps it caller-driven.

---

## Pass 2: per-section body

### Inputs per section

```ts
{
  section: SectionPlan,                 // the section being drafted
  outline: OutlineResult,               // full outline (for context)
  prior: Map<string, SectionResult>,    // dependency outputs
}
```

The caller's `section.build(args)` returns the system + user
prompt pair. Typical pattern:

  - System prompt re-states the doc's purpose + rules.
  - User prompt enumerates: doc title, full outline list, this
    section's title + intent, dependent sections' bodies (when
    declared), and the budget.

### Body output

Markdown text. No schema enforcement; the model writes prose. The
caller's prompt should specify "no leading `#` heading" because
the module prepends the heading from `section.title` when
stitching -- avoids the model emitting `# Title` and then us
prepending another `#` and producing `## #`.

### Budget enforcement

The section pass uses `maxTokens: section.budgetTokens ??
defaultBudgetTokens`. When the model hits the cap, the partial
output is captured and used as the section body (truncated mid-
sentence is rare at section-scale; if it happens the caller's
`onSectionComplete` callback can re-emit a "[truncated]" tag).

### Per-section retry

Pass-2 has no schema (free-form markdown), so there's no
"unparseable" failure mode. The only retry path is:

  - Provider error mid-stream -> retry once with the same prompt.
  - Aborted via `signal` -> bail; mark section as `fallback: true,
    note: 'aborted'`.

Other failure modes (empty body, all-whitespace) are accepted as-is
and surfaced via `body.length === 0` -> `fallback: true`.

---

## Stitching

```ts
function stitch(outline: OutlineResult, results: readonly SectionResult[]): string {
  const lines: string[] = [];
  if (outline.title.trim().length > 0) {
    lines.push(`# ${outline.title.trim()}`);
    lines.push('');
  }
  const byId = new Map(results.map(r => [r.id, r]));
  for (const section of outline.sections) {
    const result = byId.get(section.id);
    lines.push(`## ${section.title.trim()}`);
    lines.push('');
    if (result === undefined || result.body.trim().length === 0) {
      lines.push(`_Section unable to render${result?.note ? ` (${result.note})` : ''}._`);
    } else {
      lines.push(result.body.trim());
    }
    lines.push('');
  }
  return lines.join('\n').trim() + '\n';
}
```

Doc-level `# Title` + per-section `## Title` headings keep the
outline's structure visible even when one section degrades. The
caller can override the heading depth via the `section.title`
content (e.g. include explicit `### subhead` for nested
structures).

---

## Parallelism

Sections without `dependsOn` run concurrently. The module groups
into "independent" + "dependent" sets:

```ts
async function runSections(...): Promise<SectionResult[]> {
  const independent = outline.sections.filter(s => !s.dependsOn?.length);
  const dependent   = outline.sections.filter(s => s.dependsOn?.length);

  // Parallel: fire all independent sections at once, await all.
  const indepResults = await Promise.all(independent.map(s => runSection(s, ...)));

  // Serial topological pass for dependents.
  const map = new Map(indepResults.map(r => [r.id, r]));
  for (const s of dependent) {
    const result = await runSection(s, { prior: map });
    map.set(result.id, result);
  }

  // Re-order to outline order.
  return outline.sections.map(s => map.get(s.id)!);
}
```

Wall-clock for an N-section doc is `max(independent_pass) +
sum(dependent_passes)` instead of `sum(all)`. For a typical
8-section doc with no deps that's a 5-8x speedup vs serial.

`parallel: false` opt-out forces serial -- useful when the local
model is GPU-throughput-bound and N concurrent generations would
swamp it.

---

## Streaming (live progress)

`onSectionComplete(result)` fires once per section as it finishes.
Caller composes a stream event from each:

```ts
input.onSectionComplete = (r) => {
  send({ stream: 'progress', data: { message: `[content-gen] section "${r.id}" done (${r.body.length} chars${r.fallback ? '; degraded' : ''})` }});
};
```

For real "live" rendering (tokens streaming into the section while
it's being drafted) the module would have to plumb token-by-token
streaming through the provider abstraction -- that's a future
upgrade. First cut is per-section granularity.

---

## Caching (Phase 5.C / Phase 2.5 integration)

Section-level cache:

  - Key: `SHA256(outline.title + section.id + section.intent + dependsOn-bodies-hash + repoSnapshotId)`.
  - Value: `SectionResult.body`.
  - Lookup: before invoking the provider, check the cache. Hit ->
    skip the LLM call entirely; emit `onSectionComplete` with
    `note: 'cache hit'` for transparency.
  - Write: on every successful generation (`fallback: false`).

This integrates cleanly with the per-task cache landing in Phase
2.5 (same on-disk LRU shape; same eviction policy). Caller passes
an optional `cache?: ContentCache` -- when unset, no caching.

The cache key INCLUDES `dependsOn-bodies-hash` so a stale
dependency invalidates the dependent section automatically.

---

## Failure modes

| Stage | Failure | Behaviour |
|---|---|---|
| Outline -- provider error | Retry once. | Fall back to single-section outline `{ id: 'body', title: '', intent: caller.user[:200] }`. `result.degraded = true`. |
| Outline -- schema_violation | Retry once with validation error fed back. | Same fallback as above. |
| Outline -- aborted | Bail immediately. | Throw `AbortError` to caller. |
| Section -- provider error | Retry once. | On second failure: `body: '', fallback: true, note: 'provider error: <msg>'`. |
| Section -- token cap | Use the partial body. | `body: <partial>, fallback: true, note: 'budget exceeded; truncated'`. |
| Section -- aborted | Bail. | `body: '', fallback: true, note: 'aborted'`. |
| Section -- empty body | Accept. | `body: '', fallback: true, note: 'empty response'`. |

`result.degraded` is true if EITHER the outline fell back OR any
section's `fallback` is true. Caller decides how to surface this
to the user (warning banner / silent / hard-fail).

---

## Adoption plan (which agents migrate first)

| Agent | Today | Next |
|-------|-------|------|
| **code-analyzer synthesise** (Phase 5.C) | Single-pass markdown. Hits maxTokens at L/XL/XXL+ tiers. | Migrate first -- highest pain, biggest win. The Phase 5.C plan slots multi-pass in as the synthesise step's implementation. |
| **brainstorm assembly** | Single-pass HTML report assembly via `agent/tasks/brainstorm/assembly.ts`. | Phase-2 candidate (this plan, not the analyzer plan). Brainstorm specs at the upper-tier scale benefit from per-theme sections. |
| **designer detail step** | Single-pass markdown. | Phase-3 candidate. Lower priority -- designer outputs are typically smaller. |
| **planner draft** | Single-pass JSON. | NOT a candidate -- structured output, schema-bound, length is task-count-bounded. Multi-pass would over-engineer. |

The first migration (code-analyzer synthesise) IS the proving
ground. Brainstorm + designer adopt only if 5.C validates the
approach.

---

## Module-level details

### File layout

```
src/insrc/agent/content-gen/
  index.ts                  -- public surface (generateMultiPass)
  outline.ts                -- pass-1 helper (schema, prompt-build, retry)
  section.ts                -- pass-2 helper (parallel scheduler, retry, abort)
  stitch.ts                 -- stitch() pure function
  schema.ts                 -- OUTLINE_SCHEMA
  cache.ts                  -- optional ContentCache interface (LRU disk)
```

Mirrors the `agent/classify/` shape: thin index.ts re-exporting
named functions; one file per stage.

### Tests

Smoke scripts (one per shape):

  - `scripts/test-content-gen-outline.ts` -- pass 1 only against a
    fixture prompt; assert the outline schema. Fast (single LLM
    call).
  - `scripts/test-content-gen-section.ts` -- pass 2 only with a
    canned outline; assert section bodies are non-empty.
  - `scripts/test-content-gen-end-to-end.ts` -- full multi-pass
    run; assert stitched markdown has all section headings.
  - `scripts/test-content-gen-fallback.ts` -- inject a
    deliberately-bad model; assert the module returns a degraded
    result instead of throwing.

---

## Sequencing

Three commits:

1. **Module + outline pass.** `agent/content-gen/index.ts` +
   `outline.ts` + `schema.ts` + the public interface. No section
   pass yet -- exposes `generateOutline()` only. Single test
   script. Build green.

2. **Section pass + stitching.** Adds `section.ts` (parallel
   scheduler) + `stitch.ts` + the full `generateMultiPass()`
   entry point. Caching deferred. Smoke scripts wired up.

3. **Caching layer.** `cache.ts` + cache-key derivation. Optional
   ContentCache interface -- caller opts in. Integration with
   Phase 2.5's `~/.insrc/cache/code-analyzer/` LRU storage.

Phase 5.C (per-tier synthesise + drill-down footer) consumes the
finished module:

  - `M` tier and below: single-pass synthesise (existing
    `agent/tasks/code-analyzer/prompts/synthesise.ts`). Multi-pass
    is overhead for small docs.
  - `L`/`XL`/`XXL+`: multi-pass via `generateMultiPass()`. The
    caller's outline + section prompts are tier-aware (already
    designed in Phase 5.C).

---

## Acceptance

```
1. generateOutline returns a SectionPlan[] of length 1-12 against
   a representative content prompt. Build green.
2. generateMultiPass produces a non-empty stitched markdown for an
   8-section outline. Each section heading appears once in the
   output.
3. Parallel section pass completes in under (sum-of-individual *
   0.4) wall-clock for an 8-section independent doc.
4. Dependent section receives the prior section's body in the
   `prior` map at build-time.
5. Provider error on section K -> sections 1..K-1 + K+1..N still
   render; section K has a "_Section unable to render_" placeholder.
6. AbortSignal cancellation mid-section produces an AbortError at
   the public surface; no orphaned LLM calls.
7. Cache hit on section K skips the provider call and emits
   onSectionComplete with note='cache hit'.
8. scripts/build.sh green; npm run precommit green.
9. Code-analyzer's L-tier synthesise (Phase 5.C consumer) produces
   a stitched report with no truncation on a fixture run that
   PRE-multi-pass produced an "Unterminated string" failure.
```

---

## Out of scope

- **Token-by-token streaming inside a section.** Module's
  granularity is per-section; live in-section rendering needs
  provider-level token streaming wired through the abstraction.
  Future polish.
- **Cross-document sharing of sections.** Each call is an
  independent doc; the cache is keyed on outline + section, not
  cross-doc reusable.
- **Conditional section emission.** Outline always renders all
  sections; conditional sections (e.g. "only emit Schema findings
  if cross-agent results exist") are handled at the caller's
  outline-build step, not the module.
- **Provider-specific output budgets.** Caller specifies
  `budgetTokens` directly; the module doesn't auto-detect the
  active model's `num_predict` ceiling. Caller can probe via the
  provider's metadata if it cares.
- **Non-markdown formats.** JSON / HTML / RFC-style document
  shapes are deferred until a concrete consumer asks.

---

## Open questions

1. **Should pass 1 and pass 2 default to different providers?**
   Cloud planner + local writer is a common pattern (the
   code-analyzer already does plan / review on cloud, analyzer +
   synthesise on local). Currently the module accepts ONE
   provider; threading separate ones in is a small interface
   addition (`outlineProvider?` + `sectionProvider?` defaulting to
   `provider`). Defer until a consumer asks.

2. **Should sections support nested outlines?**
   A section's body could itself be a multi-pass sub-doc -- useful
   for very long sections. The first cut keeps sections flat (one
   pass = one body); recursion is a follow-up if any tier needs
   60+ section-scale docs.

3. **Should the module emit progress for outline-pass tokens?**
   Outline is small (< 1500 tokens) so probably not worth the
   complexity. Skip.

4. **Section dependency cycles.**
   The dependency graph could have cycles in malformed outlines.
   First cut: detect cycle in topological sort, drop dependents
   to independent (treat dependsOn as empty), warn. Don't fail.
