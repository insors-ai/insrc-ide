# Externalize code-analyzer LLM prompts to MD files (section-based composition)

## Goal

Move the four code-analyzer / content-gen system prompts out of TypeScript
string literals into composable Markdown files under a `prompts/` tree. The
new layout uses **sectional** markers (one section = one reusable block of
instruction text) rather than per-prompt monoliths -- the same block (e.g.
the compliance directive, the anti-hallucination contract, citation rules)
can then be assembled into different prompts that correspond to different
flow steps (Gather / Write / Review / Patch).

This is a **structural refactor with intentional content upgrades**: we
keep current behavior, but bake in the patterns observed in
`insors-ai/insors-extraction/insors/**/prompts/` that we currently lack
(worked error catalogs, gap-paragraph templates, citation-format rules,
prohibition-forward language, field tables).

## Why externalize

1. **The same block is duplicated in 3-4 files.** The compliance directive
   we just added lives verbatim in [gather-evidence.ts:358-369](src/insrc/agent/tasks/code-analyzer/gather-evidence.ts#L358),
   [write-from-evidence.ts:109-120](src/insrc/agent/tasks/code-analyzer/write-from-evidence.ts#L109),
   [write-section.ts:1393-1404](src/insrc/agent/tasks/code-analyzer/write-section.ts#L1393),
   [review-action.ts:433-444](src/insrc/agent/content-gen/review-action.ts#L433). The
   anti-hallucination contract has the same 3-way duplication. Touching
   any of these is a 4-file find-replace today.
2. **TS string literals fight prompt editing.** Escaping single quotes,
   newline juggling, and array-of-strings concatenation make the actual
   prose hard to read in review. Insors-extraction handles this with raw
   `.md` files loaded by name.
3. **Prompts are content, not code.** Treating them as build artifacts
   (loaded once, cached) lets us version, diff, and snapshot-test them
   independently. Prompt regressions become detectable in git diff.
4. **Section reuse maps the actual flow.** Phase G (gather), Phase W
   (write), Phase R (review), Phase P (patch) share large overlapping
   instruction surfaces -- compliance always, anti-hallucination almost
   always, citation rules whenever prose is produced, skill-usage
   whenever tools are enabled. Sectional composition matches the flow.

## Current state audit

| File | Builder | Used in flow phase | Has skills? | Has citations? |
|------|---------|--------------------|-------------|----------------|
| [gather-evidence.ts](src/insrc/agent/tasks/code-analyzer/gather-evidence.ts) | `buildSystemPrompt` | G | yes | no (ledger is collected) |
| [write-from-evidence.ts](src/insrc/agent/tasks/code-analyzer/write-from-evidence.ts) | `buildSystemPrompt` | W | no | yes (carried from ledger) |
| [write-section.ts](src/insrc/agent/tasks/code-analyzer/write-section.ts) | `runItemWithSkills` (fix/enhance/add) | P | yes | yes |
| [review-action.ts](src/insrc/agent/content-gen/review-action.ts) | `SYSTEM_PROMPT` const | R | no | scores against |
| [plan-actions.ts](src/insrc/agent/content-gen/plan-actions.ts) | `buildSystemPrompt` | (cloud planner, pre-G) | no | no | 

Five system prompts total. The first four are the focus -- they all share
the compliance + anti-hallucination directives we just standardized. The
planner (Phase 0) is structurally simpler; include it in the same scheme
but lower priority.

Dead code to remove during this work:
- `src/insrc/agent/tasks/code-analyzer/prompts/analyzer-system.ts`
- `src/insrc/agent/tasks/code-analyzer/prompts/synthesise.ts`
- `src/insrc/agent/tasks/code-analyzer/prompts/synthesise-multipass.ts`

(Grep confirms these have no live importers -- only the mirror files in
`data-analyzer/prompts/` reference them in comments.)

## Section taxonomy

Twelve reusable blocks identified by walking the current four prompts:

| Section ID | Purpose | Used by |
|------------|---------|---------|
| `compliance` | "follow EVERY instruction without deviation" preamble | G, W, R, P |
| `role-gather` | "You are GATHERING evidence ..." opening | G |
| `role-write` | "You are writing ONE section ..." opening | W |
| `role-review` | "You review ONE section ..." opening | R |
| `role-patch-fix` | "Correcting this issue is NOT optional ..." | P (kind=fix) |
| `role-patch-enhance` | "You are ENHANCING ..." | P (kind=enhance) |
| `role-patch-add` | "You are ADDING ONE new paragraph ..." | P (kind=add) |
| `anti-hallucination-investigator` | tools-side contract (skill_invoke is the only evidence) | G, P |
| `anti-hallucination-writer` | ledger-side contract (no fact off the ledger) | W |
| `anti-hallucination-reviewer` | gate-side contract (flag unsupported claims) | R |
| `citation-rules` | "carry `[label](path:...)` verbatim; valid shapes; never compose URLs" | W, P, R |
| `coverage-angles` | 6-7 angles for skill calls (file / entity / tests / docs / xref / module) | G, P |
| `skill-usage` | "Use `skill_describe` once, then `skill_invoke`"; tool-call accounting | G, P |
| `output-format` | per-flow output rule (sentinel for G, prose for W/P, JSON for R) | G, W, R, P |
| `gap-paragraph-template` (**NEW**) | literal shape of an honest gap paragraph | W, P |
| `error-catalog` (**NEW**) | ❌/✅ paragraph examples (one fabricated, one grounded) | W, P, R |
| `repo-context` | repo-size summary anchor (variable substitution slot) | all |

NEW sections are the changes ported from insors-extraction patterns -- not
present in our current prompts.

## File layout

```
src/insrc/agent/tasks/code-analyzer/prompts/
  README.md                              # how the loader works + how to edit
  loader.ts                              # loadPrompt(name, vars) -> string
  index.ts                               # PromptName / PromptVars types
  sections/                              # reusable building blocks
    compliance.md
    anti-hallucination/
      investigator.md
      writer.md
      reviewer.md
    citation-rules.md
    coverage-angles.md
    skill-usage.md
    gap-paragraph-template.md
    error-catalog.md
    output-format/
      gather.md
      write.md
      review.md
      patch-fix.md
      patch-enhance.md
      patch-add.md
  flow/                                  # one folder per flow phase
    gather/
      system.md                          # composes sections via {{section:...}} markers
    write/
      system.md
    review/                              # used by content-gen/review-action.ts
      system.md
    patch/
      system.md                          # one file; intro/output vary by kind via vars
__tests__/
  prompts/
    snapshot.test.ts                     # asserts composed prompt matches golden file
    sections.test.ts                     # asserts each section loads + has no stray markers
```

Mirror layout for `src/insrc/agent/content-gen/prompts/` if the reviewer
prompt deserves to live with `review-action.ts`. Alternatively, hoist all
analyzer prompts into `code-analyzer/prompts/` since the reviewer is
analyzer-specific in practice. **Recommend the hoisted layout** -- one
home for the section library, one import path for downstream code.

## Templating mechanics

Two operations, in order:

### 1. Section markers (compose-time)

Insors uses `<!-- BEGIN SECTION: X --> ... <!-- END SECTION: X -->` as the
section boundary. Adopt the same convention, but extend with a single
include directive:

```markdown
<!-- BEGIN SECTION: compliance -->
{{section:compliance}}
<!-- END SECTION: compliance -->

<!-- BEGIN SECTION: role -->
You are CORRECTING ONE paragraph the reviewer flagged ...
<!-- END SECTION: role -->

<!-- BEGIN SECTION: anti-hallucination -->
{{section:anti-hallucination/investigator}}
<!-- END SECTION: anti-hallucination -->
```

The `{{section:path}}` directive is resolved by the loader (reads
`sections/path.md`, splices content). The BEGIN/END comments are
**preserved in the final prompt** -- they:
- aid grep + debug (`grep "SECTION: citation-rules" $log`),
- give the model a clear top-of-block signal,
- echo insors-extraction's pattern (the team confirms this aids
  multi-section prompts in practice).

### 2. Variable substitution (call-time)

`{{VAR_NAME}}` placeholders are filled in at the call site:

| Placeholder | Filled from |
|-------------|-------------|
| `{{REPO_SUMMARY}}` | `formatRepoSizeSummary(input.repoSizeSummary, 'detailed')` |
| `{{SKILL_CATALOG}}` | `formatAnalyzerSkillCatalog(catalog)` |
| `{{ACTION_TITLE}}` | `input.action.title` |
| `{{ACTION_OBJECTIVE}}` | `input.action.objective` |
| `{{REVIEW_CRITERIA}}` | `input.action.reviewCriteria.map(...).join('\n')` |
| `{{TARGET_PARAGRAPH}}` | the resolved paragraph (patch-fix / patch-enhance only) |
| `{{REVIEWER_ISSUE}}` | `item.issue` |
| `{{REVIEWER_ACTION}}` | `item.action` |
| `{{EVIDENCE_LEDGER}}` | rendered ledger block (writer only) |
| `{{JSON_SCHEMA}}` | `JSON.stringify(REVIEW_ACTION_SCHEMA, null, 2)` |

Strict mode: a missing variable throws (loud failure beats silent
`undefined` in a prompt).

## Loader sketch

```ts
// src/insrc/agent/tasks/code-analyzer/prompts/loader.ts

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROMPTS_ROOT = join(dirname(fileURLToPath(import.meta.url)));
const cache = new Map<string, string>();

function readMd(relPath: string): string {
  if (!cache.has(relPath)) {
    cache.set(relPath, readFileSync(join(PROMPTS_ROOT, relPath), 'utf8'));
  }
  return cache.get(relPath)!;
}

function expandSections(text: string, depth = 0): string {
  if (depth > 8) throw new Error('section include cycle');
  return text.replace(/\{\{section:([\w/\-]+)\}\}/g, (_, name) =>
    expandSections(readMd(`sections/${name}.md`), depth + 1));
}

function expandVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{([A-Z_][A-Z0-9_]*)\}\}/g, (_, key) => {
    if (!(key in vars)) throw new Error(`prompt var missing: ${key}`);
    return vars[key];
  });
}

export function loadPrompt(flow: PromptFlow, vars: PromptVars[PromptFlow]): string {
  const raw      = readMd(`flow/${flow}/system.md`);
  const composed = expandSections(raw);
  return expandVars(composed, vars as Record<string, string>).trim();
}
```

Notes:
- **Sync FS reads at module init** match how `formatAnalyzerSkillCatalog`
  already works -- daemon, not browser; allowed.
- **Cache by relPath** so we read each MD once per daemon lifetime.
- **No I/O in hot path** after first call -- composition is in-memory.
- Build copy: `tsc` does not copy non-`.ts` files (verified empirically).
  Add a single **generic recursive `*.md` mirror** to `scripts/build.sh`
  that runs after the daemon compile -- see "Build pipeline change"
  below. One-time edit; no further build.sh changes when prompt files
  are added or moved.

## Build pipeline change (`scripts/build.sh`)

Add a generic glob-based mirror after the `tsc` step in `build_daemon()`,
right alongside the existing `src/insrc/assets/` copy. Prompts live next
to their callers (`agent/tasks/code-analyzer/prompts/`), not under
`assets/` -- path structure is preserved, so filenames don't need to be
globally unique.

```bash
# In build_daemon(), after the existing assets cp -a block:
echo "[insrc-build] copying daemon prompts (.md)"
( cd src/insrc \
  && find . -type f -name '*.md' \
       -not -path './node_modules/*' \
       -not -path '*/__tests__/*' \
       -print0 \
  | cpio -pdm0 ../../out/insrc/ 2>/dev/null )
```

Properties:
- Drop a new `*.md` anywhere under `src/insrc/` and it lands in the
  mirrored spot in `out/insrc/`. No build.sh edit per new prompt
  directory.
- Path preserves uniqueness, so `code-analyzer/prompts/sections/compliance.md`
  and `data-analyzer/prompts/sections/compliance.md` can coexist later if
  they ever diverge.
- Excludes `node_modules/` and `__tests__/` so stray library READMEs and
  test fixtures don't pollute `out/`.

## Composition map (what each flow's `system.md` includes)

```
flow/gather/system.md
  {{section:compliance}}
  {{section:role-gather}}
  {{section:anti-hallucination/investigator}}
  {{section:coverage-angles}}
  {{section:skill-usage}}
  {{section:output-format/gather}}      # sentinel + soft-stop guidance
  {{section:repo-context}}              # consumes {{REPO_SUMMARY}}

flow/write/system.md
  {{section:compliance}}
  {{section:role-write}}
  {{section:anti-hallucination/writer}}
  {{section:citation-rules}}
  {{section:error-catalog}}             # NEW
  {{section:gap-paragraph-template}}    # NEW
  {{section:output-format/write}}
  {{section:repo-context}}

flow/review/system.md
  {{section:compliance}}
  {{section:role-review}}
  {{section:anti-hallucination/reviewer}}
  {{section:citation-rules}}
  {{section:error-catalog}}             # NEW (shared bait/switch examples)
  {{section:output-format/review}}      # JSON-schema-pinned

flow/patch/system.md
  {{section:compliance}}
  {{section:role-patch-{{KIND}}}}        # kind dispatched at compose time
  {{section:anti-hallucination/investigator}}
  {{section:citation-rules}}
  {{section:coverage-angles}}
  {{section:skill-usage}}
  {{section:error-catalog}}             # NEW
  {{section:gap-paragraph-template}}    # NEW
  {{section:output-format/patch-{{KIND}}}}
  {{section:repo-context}}
```

A single included section per flow keeps the system.md files **short and
readable** -- each is essentially a table of contents.

## Learnings from insors-extraction (baked into the externalized prompts)

These are content upgrades, not just structural changes. Apply each as we
externalize the corresponding section so we ship the refactor + the
content-upgrade together.

### A. Worked error catalog (❌/✅ pairs) -- `sections/error-catalog.md`

Insors classification + mapping prompts include "COMMON CONFUSION PATTERNS"
or "NEVER DO THESE" blocks with annotated wrong/right examples. We have no
equivalent today -- our anti-hallucination rules are abstract. Draft:

```markdown
## Common failure patterns (read before drafting)

❌ FABRICATED PARAGRAPH (do NOT write this)
   "The `DistributedFileSystem` class extends `FileSystem` and provides
    block-level read/write with strong consistency guarantees."
   Why this is wrong: the evidence ledger contains no entry for
   `DistributedFileSystem`. The writer pulled the class name + behavior
   from prior Hadoop knowledge.

✅ GROUNDED PARAGRAPH (write this shape instead)
   "The file submodule contains 12 Python classes ([`fs/__init__.py:1-40`](path:.../fs/__init__.py#L1-L40))
    anchored by `LocalFileSystem`, which the ledger surfaces at
    [`fs/local.py:18-220`](path:.../fs/local.py#L18-L220). No evidence
    entry covers distributed-mode classes, so this section does not
    discuss them."
   Why this is right: every named class + behavior trace to an evidence
   citation; the absent topic is acknowledged explicitly.

❌ HAND-ROLLED CITATION
   "`HDFSNamenode` orchestrates the journal ([hadoop-hdfs/.../namenode](path:hadoop-hdfs/src/main/java))"
   Why this is wrong: the path points at a DIRECTORY, with no line range.
   The writer composed the URL from prior knowledge -- the ledger never
   surfaced this class.

✅ EVIDENCE-BACKED CITATION
   "Lookup happens in `resolve_module` ([`paths.py:88-104`](path:.../paths.py#L88-L104))."
   Why this is right: the link points to a file + a specific line range
   that appears in an evidence entry.
```

### B. Gap-paragraph template -- `sections/gap-paragraph-template.md`

Today we say "honest gaps are better than fabrications" but never show the
literal shape. Insors gives concrete sentence templates. Draft:

```markdown
## When the evidence does not cover a topic

If the section's objective or a reviewer flag asks about something the
evidence ledger does not surface, write a SHORT honest gap paragraph
following this shape:

  "The available evidence does not surface <topic>; the gather phase
   opened <files / entities the ledger DOES cover> but did not reach
   <the path / kind of code that would have surfaced the topic>. This
   is a gap in the section, not a claim about the codebase."

Do NOT pad the gap with general knowledge. Do NOT cite paths that were
not surfaced in the ledger to make the gap look researched. A short
honest gap (50-80 words) is preferred over a long plausible
fabrication.
```

### C. Citation-format rules -- `sections/citation-rules.md`

Current prompts say "carry citations verbatim". Insors mapping prompts go
further -- they teach the *shape* of a valid path. Draft:

```markdown
## Citation format rules (NON-NEGOTIABLE)

A valid citation has the shape:
    [<short label>](path:<file>#L<startLine>-L<endLine>)

For example:
    [`fs/local.py:18-220`](path:insors/extraction/fs/local.py#L18-L220)

NEVER:
  - Cite a directory: `path:src/main/java` (no `#L` suffix).
  - Cite a path that was not surfaced by a `skill_invoke` result in
    THIS gather call OR the evidence ledger in front of you.
  - Compose a line range you did not see (e.g. `#L1-L500` to fake a
    "whole file" citation).
  - Re-label a citation to claim it points at a class when the
    surrounding evidence shows it pointed at a different entity.

ALWAYS:
  - Carry the `[label](path:...)` markdown link verbatim from the
    source the orchestrator gave you.
  - Embed citations INLINE in sentences, after the claim they support
    (not as a trailing reference list).
  - When the same fact is supported by two citations, put both:
    "... ([`a.py:1-10`](path:a.py#L1-L10), [`b.py:20-30`](path:b.py#L20-L30))".
```

### D. Field tables for ledger entries -- inside `flow/write/system.md`

Insors uses Markdown tables for required-field specs. Our writer-side
ledger rendering is currently bulleted prose. A table is more compact
and easier for the model to follow. (Lower priority -- structural; can
land later.)

### E. Prohibition-forward language

Insors repeats "NEVER X" rather than "you should avoid X". Audit each
externalized section and tighten passive phrasings into imperatives.

## Test strategy

1. **Section unit tests** (`__tests__/prompts/sections.test.ts`)
   - Every file under `sections/` loads without throwing.
   - Every file has matching BEGIN/END pairs (if it declares any internal
     ones).
   - No file leaks unresolved `{{section:...}}` includes (sections may
     include other sections; depth-limit applies).
   - No file contains unresolved `{{VAR}}` placeholders that the
     composer doesn't declare.

2. **Composition snapshot tests** (`__tests__/prompts/snapshot.test.ts`)
   - For each flow phase, render `system.md` with a fixed set of
     placeholder values and assert the rendered output matches a
     committed golden file (`__tests__/prompts/golden/{flow}.txt`).
   - First run: golden file is the existing TS-generated prompt
     (captured before the refactor). Forces the externalized version
     to be byte-equivalent on day 1.
   - After day 1: golden files become the source of truth; any
     section edit must be reviewed against the resulting prompt
     diff.

3. **Existing test coverage** (gather-evidence + write-from-evidence +
   patch-section-itemwise + review-action) keeps working as-is --
   the entry-point shapes don't change. The TS builder becomes a
   thin call to `loadPrompt(...)`.

## Migration phases

### Phase 1: scaffolding (no behavior change)
- Create `prompts/` directory, loader, types.
- Add the generic `*.md` mirror line to `scripts/build.sh` (see
  "Build pipeline change" above). Verify a stub `.md` under
  `src/insrc/agent/tasks/code-analyzer/prompts/` shows up in
  `out/insrc/...` after `scripts/build.sh daemon`.
- Land empty section files (everything is one-line stubs).
- Add unit tests that pass against the stubs.

### Phase 2: lift-and-shift Gather (Phase G)
- Externalize gather-evidence.ts buildSystemPrompt verbatim into
  `flow/gather/system.md` + needed section files.
- Snapshot the current prompt as the golden. After refactor, snapshot
  test must produce byte-equivalent output.
- Replace the TS `parts.push(...)` builder with `loadPrompt('gather', vars)`.
- Same for the user prompt builder.

### Phase 3: lift-and-shift Write (Phase W)
- Same pattern as Phase 2 for write-from-evidence.ts.
- This is the prompt with the most overlap with patch -- after this
  lands, `anti-hallucination/writer.md` and `citation-rules.md` are
  exercised by the snapshot tests.

### Phase 4: lift-and-shift Patch (Phase P)
- Externalize the kind-dispatch (`role-patch-fix.md`, `-enhance.md`,
  `-add.md`) under one composition file with `{{KIND}}` substitution.
- Reuse: `anti-hallucination/investigator`, `coverage-angles`,
  `skill-usage`, `citation-rules` -- already landed in earlier phases.

### Phase 5: lift-and-shift Review (Phase R)
- Externalize review-action.ts SYSTEM_PROMPT.
- The reviewer's anti-hallucination gate becomes
  `sections/anti-hallucination/reviewer.md`.

### Phase 6: content upgrades from insors learnings
- Add `sections/error-catalog.md` (❌/✅ pairs). Wire into write/patch/review.
- Add `sections/gap-paragraph-template.md`. Wire into write/patch.
- Tighten `citation-rules.md` with the explicit format-shape rules.
- Re-run live code-analyzer tests on Hadoop/Linux test repos; compare
  hallucination-flag rate vs. pre-upgrade baseline (we have run #11
  + run #12 logs as anchor).

### Phase 7: cleanup
- Delete the unused TS prompt files:
  - `code-analyzer/prompts/analyzer-system.ts`
  - `code-analyzer/prompts/synthesise.ts`
  - `code-analyzer/prompts/synthesise-multipass.ts`
- Document the new system in `prompts/README.md`.

Phases 1-5 are pure refactors with snapshot-test guarantees. Phase 6 is
where the user-visible improvements land.

## Risks + open questions

- **Build-time vs runtime FS reads.** Sync read at module init is the
  simple path; if the daemon ever ships as a single bundled JS this
  needs a bundler step that inlines MD files. Defer; not a problem
  today.
- **`{{REPO_SUMMARY}}` and `{{SKILL_CATALOG}}` are multi-line.** The
  variable substitutor must handle multi-line replacement cleanly
  (it does -- string `replace` doesn't care).
- **Snapshot tests are noisy.** Every prompt tweak forces a golden-
  file update commit. Trade-off accepted: the noise IS the value;
  it's the diff we want to see in PR.
- **Should the data-analyzer migrate too?** Out of scope here. Its
  `prompts/` dir mirrors the code-analyzer one and uses the same
  `analyzer-system.ts` pattern. Once this lands, the data-analyzer
  can adopt the same loader on its own timeline.
- **Where do the planner prompts live?** `plan-actions.ts` builds a
  prompt for the cloud planner (pre-Phase-G). Externalize as
  `flow/plan/system.md` in a later pass -- structurally trivial,
  doesn't share many sections with the other four.

## Out of scope

- Translating prompts to other LLMs / providers (e.g. Anthropic vs.
  Ollama-tuned variants). The MD layout makes this possible later
  (a `flow/write/system.anthropic.md` override file is a small
  loader change) but no current need.
- Per-region / per-language variants. Insors uses region markers
  heavily; we don't have a region axis in code-analysis.
- Hot-reload of prompts during a running daemon. Loader cache is
  per-process; daemon restart picks up MD edits.
