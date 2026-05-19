# code-analyzer prompts

This directory holds the LLM system prompts for the code-analyzer's four
flow phases (Gather, Write, Patch, Review) as composable Markdown files.
Loaded at daemon startup via [loader.ts](loader.ts); see
[plans/code-analyzer-externalize-prompts.md](../../../../../../plans/code-analyzer-externalize-prompts.md)
for the design rationale.

## Layout

```
prompts/
  loader.ts                          ← read these MD files, compose, substitute vars
  sections/                          ← reusable instruction blocks
    compliance.md                    ← shared across all flows
    role-{gather, write, review,
          patch-fix, patch-enhance,
          patch-add}.md              ← per-flow opening framing
    anti-hallucination/
      investigator.md                ← gather
      writer.md                      ← write
      patch.md                       ← patch
      reviewer.md                    ← review
    coverage-angles.md               ← gather's 7 angles
    coverage-angles-patch.md         ← patch's 6 angles + skill-usage footer
    skill-usage.md                   ← gather's how-to-investigate framing
    citation-rules.md                ← writer's "how citations work" tutorial
    review-rules.md                  ← reviewer's verdicts / kinds / workflow / citation preservation
    error-catalog.md                 ← ❌/✅ paired examples (Phase 6)
    gap-paragraph-template.md        ← honest-gap sentence shape (Phase 6)
    output-format/
      {gather, write, review,
       patch-fix, patch-enhance,
       patch-add}.md                 ← per-flow output rules
  flow/                              ← one composition file per flow phase
    gather/system.md
    write/system.md
    review/system.md
    patch/
      fix/system.md
      enhance/system.md
      add/system.md
```

Flow files use HTML-comment markers to group sections:

```markdown
<!-- BEGIN SECTION: anti-hallucination -->
{{section:anti-hallucination/writer}}
<!-- END SECTION: anti-hallucination -->
```

The `<!-- BEGIN SECTION: ... -->` / `<!-- END SECTION: ... -->` markers
are **preserved in the composed output** -- they aid `grep` on logged
prompts when debugging an LLM run.

## How the loader works

Two substitution passes on each call:

1. **Section includes** -- `{{section:path/under/sections}}` directives in
   a flow file are recursively replaced with the contents of the matching
   MD file (cycle-guarded at depth 8).
2. **Variable substitution** -- `{{VAR_NAME}}` placeholders are replaced
   from a caller-supplied `Record<string, string>`. A missing variable
   throws (loud failure beats a silently-empty prompt).

Read order:

- `loadFlowPrompt('gather', vars)` -> `flow/gather/system.md`
- `loadFlowPrompt('write', vars)`  -> `flow/write/system.md`
- `loadFlowPrompt('review', vars)` -> `flow/review/system.md`
- `loadPatchPrompt('fix' | 'enhance' | 'add', vars)` -> `flow/patch/<kind>/system.md`

Each file is read once per daemon lifetime (file cache by relative path).

## Variable contract (per flow)

| Flow      | Required vars                          |
|-----------|----------------------------------------|
| `gather`  | `SKILL_CATALOG`, `REPO_CONTEXT`        |
| `write`   | `REPO_CONTEXT`                         |
| `review`  | (none)                                 |
| `patch`   | `SKILL_CATALOG`, `REPO_CONTEXT`        |

`REPO_CONTEXT` is either an empty string (no repo summary available) or a
leading-newline-prefixed block carrying `## Repository under analysis`
plus the formatted summary -- the caller assembles this string.

`SKILL_CATALOG` is the output of `formatAnalyzerSkillCatalog(catalog)`
verbatim (including its own `## Available skills` heading).

## How to edit a prompt

1. Find the section file under `sections/`. Sections live in one file
   each so you can edit a single rule without spelunking through a
   1000-line flow.
2. Save your edits.
3. Run the snapshot tests:
   ```
   npx tsx --test src/insrc/agent/tasks/code-analyzer/__tests__/{gather,write,patch,review}-prompt-snapshot.test.ts
   ```
   They will FAIL because the golden file no longer matches.
4. Eyeball the diff in the failure. If the change is intentional,
   regenerate the goldens:
   ```
   INSRC_PROMPT_SNAPSHOT_UPDATE=1 npx tsx --test \
     src/insrc/agent/tasks/code-analyzer/__tests__/<flow>-prompt-snapshot.test.ts
   ```
5. The regenerated golden files (`__tests__/prompts-golden/*.txt`) are
   checked in -- commit them alongside your section edits.

## Build pipeline

`scripts/build.sh daemon` mirrors all `*.md` from `src/insrc/` to
`out/insrc/` preserving paths, after the `tsc` step. Generic glob --
no per-directory edits when new prompt files are added. Daemon reads
MDs via `import.meta.url` from `out/insrc/.../prompts/`; tests + tsx
read directly from `src/insrc/.../prompts/`.

## Section content style

Conventions inherited from the analysis of
`insors-ai/insors-extraction/insors/**/prompts/` (see the plan for the
full survey):

- **Prohibition-forward** ("NEVER X", not "you should avoid X").
- **Hyper-specific over general** -- concrete decision trees beat
  adjectives. Worked examples beat abstract rules.
- **❌/✅ paired examples** for failure patterns (see
  [error-catalog.md](sections/error-catalog.md)).
- **Section sizes scale with risk** -- compliance is short; anti-
  hallucination + error-catalog earn their length because they catch
  the failure mode the architecture exists to prevent.
- **Markdown headings** structure the prompt for the LLM the same way
  they'd structure it for a human reader.
