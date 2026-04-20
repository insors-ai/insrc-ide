# Requirements agent -- implementation plan

Split by subsystem. Read the design doc first:
[`design/requirements-agent.html`](../../design/requirements-agent.html).

## Files

| File | Stages | Scope |
|---|---|---|
| [`agent-core.md`](agent-core.md) | 1-3 | Config + types + hash/IO helpers + agent skeleton + intent reroute |
| [`editor-pane.md`](editor-pane.md) | 4 | Requirements EditorPane (list-review accordion + tree-browse + sub-section handoff) |
| [`llm-steps.md`](llm-steps.md) | 5 | LLM calls for the 9 steps, prompts, NFR consolidation |
| [`brainstorm-handoff.md`](brainstorm-handoff.md) | 6 | Brainstorm `finalize` gate gains "Hand off to Requirements" action |
| [`github-push.md`](github-push.md) | 7 | Schema reconciliation + issue creation + new gh tools + Delegate plan |
| [`docs-polish.md`](docs-polish.md) | 8 | CLAUDE.md, README, keyboard shortcuts, release notes |

## Implementation order

1. `agent-core` -- puts the skeleton in place so subsequent stages have
   somewhere to plug into. Intent reroute is live but the agent is a
   no-op that just produces placeholder files so it's safe to ship.
2. `editor-pane` -- the UI is needed before LLM steps produce lists to
   review. Lands as a minimal pane that renders whatever the agent
   emits; gate payloads are designed in this stage but consumed in
   stage 5.
3. `llm-steps` -- wires actual LLM generation + review for each step.
   Reuses `buildProvider({ provider, model }, cfg)` from the multi-
   provider work. Knowledge-graph queries in `scope-analyze` reuse
   `searchEntities` from existing tools.
4. `brainstorm-handoff` -- small focused change (one new gate action,
   one session-start payload shape).
5. `github-push` -- the reconciliation logic + new gh tools. Delegate
   runs the actual push. Each new gh tool is a separate commit inside
   the stage for bisect-ability.
6. `docs-polish` -- ships alongside the last feature commit.

Each file ends with a verification checklist and a "commit boundary"
section noting which commits to land in the stage.

## Shared conventions (applies to every stage)

### Locked design decisions

From the design doc §2:

| # | Decision |
|---|---|
| 1 | 2 tiers only: Epic (main doc) -> Story (detailed doc). Tasks are post-design. |
| 2 | Hash IDs: REQ = 6-hex SHA-256(normalized title); STR = 12-hex SHA-256(parent-id + \| + title). |
| 3 | Default doc format: HTML; configurable to MD. |
| 4 | Completely separate from Designer; `requirements` intent reroutes. |
| 5 | Brainstorm handoff at `finalize` gate; passes `input.brainstormSpec`. |
| 6 | List drafts -> dedicated EditorPane accordion; detail drafts -> chat-view gate. |
| 7 | Flat ID scheme regardless of nesting; parent/child in `parent` / `children` fields. |
| 8 | Sub-section in new chat: manual (user clicks a "Start chat" button per row). |
| 9 | GitHub push: Issues + Projects v2 with reconciliation. Jira design-only. |

### Cross-stage code conventions

- **Module root**: `src/insrc/agent/tasks/requirements/`.
- **IDE root**: `src/vs/workbench/contrib/insrc/browser/requirements/`.
- **Follow existing agent patterns**: brainstorm (step-based state
  machine, gates, EditorPane) and delegate (plan-driven execution
  via tools). Don't re-invent anything that already exists.
- **Provider construction**: always via
  `buildProvider({ provider, model }, cfg)` from
  `agent/providers/factory.ts`. Never call `new OllamaProvider(...)`
  or `new AnthropicProvider(...)` directly.
- **Logging**: `getLogger('requirements')` at module top; never
  `console.log`.
- **Types**: live in `agent/tasks/requirements/types.ts`. Shared
  workspace-level types go in `shared/types.ts`.

### Cross-cutting invariants

- **`<repoPath>/requirements/_index.json` is the single source of
  truth** for the requirements tree shape. Every write to a REQ file
  MUST update the index atomically (write the REQ file, then write the
  index). File creation happens in the `scaffold` step so `_index.json`
  is always consistent with the files on disk.
- **Idempotence**: re-running the agent on an existing tree must never
  corrupt it. The hash-based IDs make this possible; add a
  `reqId(title)` collision check before writing a new file, and
  preserve the existing entry if the hash matches.
- **Project config takes precedence**: `requirements.dir` and
  `requirements.format` resolve via project config (`<repo>/.insrc/
  config.json`) -> global config -> defaults. This depends on project
  config being implemented (see `plans/config-management.md`); until
  that lands, project-level override is a no-op and the agent reads
  only global.

### New gh tools

Reconciliation (`github-push.md`) introduces new gh tools:

- `gh:label:create`
- `gh:milestone:create`
- `gh:project:create`
- `gh:project:field-create`
- `gh:project:field-update` (to add options to an existing single-select)
- `gh:project:view-list`
- `gh:project:view-create`

Existing tools we reuse: `gh:project:list`, `gh:project:field-list`,
`gh:label:list`, `gh:milestone:list`, `gh:project:item-add`,
`gh:project:item-update`, `gh:issue:create`, `gh:issue:edit`.

### Open questions (to revisit per stage)

- Project-level config (`<repo>/.insrc/config.json`) merge -- blocked
  on `plans/config-management.md`. Until it ships, `requirements.dir`
  / `requirements.format` come only from the global config.
- Jira push -- whole Jira connector module is a future project.
  Design doc §12 captures the mapping; no plan file here.
- Story dependency DAG visualization in the EditorPane -- design punts
  on this. Track dependencies as text only for MVP.
- Attachments in story docs (design mockups, flow diagrams) -- not in
  MVP; leave a section in the story template but don't wire the
  upload/inline behavior yet.
