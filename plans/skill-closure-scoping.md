# Closure-scope the entity-lookup skills

## Motivation

Live run on 2026-05-25 against `insors/extraction` produced a report
with **cross-repo citations leaking in from a completely disconnected
repo** (`insors/hadoop`). The Task Processing section cited
`/Users/subhagho/work/projects/insors/hadoop/dev-support/bin/checkcompatibility.py`
when analysing `insors-extraction` — a repo that has no
`DEPENDS_ON` relationship to hadoop. Both happen to be indexed in
the same workspace.

Earlier in the same run a single `code.entity.locate-by-name({name:
"README.md"})` returned **95 matches**, 13 from hadoop and only 2 from
the active repo. The local writer then chained off these results and
wrote prose citing hadoop files as if they were part of the extraction
codebase.

Root cause traced to [code.entity.locate-by-name.ts:101-105](src/insrc/daemon/skills/built-ins/code.entity.locate-by-name.ts#L101-L105):

```ts
const baseOpts = { kinds, limit: Number.MAX_SAFE_INTEGER } as const;
const opts = input.repoPath !== undefined
    ? { ...baseOpts, repo: input.repoPath }
    : baseOpts;
const raw = await findEntitiesByName(null, [input.name], opts);
```

Three problems compound:

1. `repoPath` is **optional**; the LLM never passes it → global
   name-index scan across every indexed workspace repo.
2. Even when set, `repoPath` is a **single string**, not the
   transitive `DEPENDS_ON` closure — so genuinely-dependent sibling
   repos would be excluded.
3. No tag on returned matches identifying which repo each came from,
   so the writer can't deprioritize cross-repo evidence.

The closure machinery already exists ([search.ts:65](src/insrc/db/search.ts#L65)
`resolveClosure(repoPath)`) and is wired into the vector path
([search.ts:138](src/insrc/db/search.ts#L138) `searchEntities(_db,
queryVec, closureRepos, ...)`). It just isn't applied to the
name-lookup skills.

Per CLAUDE.md key rule #3:
> "Dependency-closure scoping — searches span only transitive
> `DEPENDS_ON` closure of active repo"

This rule is documented but not enforced by `code.entity.*` skills.

## Goals

- **Default-closure scoping** for every skill that takes a name or
  entityId arg. The closure of the active repo (which already includes
  genuine sibling/dependent repos via `DEPENDS_ON` edges) becomes the
  default search scope.
- **Hard cut** on out-of-closure matches — they don't appear in
  results. The skill can be opted into global scope explicitly via a
  new `scope: 'global'` arg for the rare case it's wanted.
- **Defensive check** on entityId-based skills (`code.entity.summary`,
  `code.entity.callers`): if the LLM somehow obtains an entityId from
  outside the closure (stale memory, manual paste, prior bad result),
  reject it with a typed refusal — don't silently resolve cross-repo
  entities.
- **No new arg required from the LLM** in the common case. The skill
  picks up the closure from `_deps.session.closureRepos` (already
  populated by `initSession` in [session.ts:140](src/insrc/agent/session.ts#L140)).

## Non-goals

- **Fixing closure correctness.** If hadoop is somehow in
  `insors-extraction`'s `DEPENDS_ON` closure (stray manifest edge,
  monorepo glob, indexer bug), that's a separate bug. Phase 0 audits
  this; if found, a follow-up plan tracks the indexer fix. This plan
  only enforces the closure that the graph currently reports.
- **`code.source.grep` arg-shape failures.** Tracked separately under
  the Plan 1 (tool-call-guard) follow-up. Grep is path-based, not
  name-based, so closure scoping doesn't apply.
- **Renderer changes.** The hard-cut at the skill layer means the
  renderer doesn't need to know about closure — results that arrive
  are already in-scope.

## Design

### Default scope behaviour

```ts
// Default: hard-cut to closure
locate-by-name({ name: "ManagedCursor" })
  → searches closure of active session repo
  → returns only matches whose entity.repo ∈ closureRepos

// Explicit: single-repo override
locate-by-name({ name: "ManagedCursor", repoPath: "/path/to/single/repo" })
  → searches that one repo (current behaviour, kept for parity)

// Explicit: global override (rare, opt-in)
locate-by-name({ name: "ManagedCursor", scope: "global" })
  → searches every indexed repo (today's accidental default)
```

`scope` is a new optional enum: `'closure' | 'global'`. When omitted,
it defaults to `'closure'`. When `repoPath` is set explicitly, it
wins over `scope` (single-repo override is more specific).

### Closure availability

`_deps.session.closureRepos` is already populated. No new plumbing
needed beyond reading it in the skill body. This is intentionally
lightweight: the closure resolution happens once at session init, not
per-skill-call.

### Match tagging

Each returned `MatchEntity` gains an explicit `repo: string` field so
the LLM sees where each match came from. Useful when the LLM does
opt into `scope: 'global'` and needs to disambiguate. For the default
(`closure`) path, every result is in-closure by definition, so the tag
is informational only.

### Defensive scope on entityId skills

`code.entity.summary` and `code.entity.callers` take an `entityId`
(deterministic SHA256 hash of repo + file + kind + name). The hash
encodes the repo, but the skill doesn't currently verify the entity
belongs to the closure. Add a one-line check after the lookup:

```ts
const entity = await getEntityById(...);
if (!closureRepos.includes(entity.repo)) {
  return { value: { found: false, reason: 'entity-out-of-scope' }, ... };
}
```

A typed refusal, not a silent dropthrough — the LLM should know it
asked for something outside scope so it can adjust.

## Phase breakdown

| Phase | Scope | Ship gate |
|---|---|---|
| **0. Audit closure** | One-shot diagnostic script: dump `resolveClosure('/Users/subhagho/work/projects/insors-ai/insors-extraction')`. If hadoop appears, file a follow-up bug for the indexer; do NOT block this plan on it. Closure-scoping the skills is correct either way. | We know what the closure currently contains; can predict the impact of Phase 2 |
| **1. SkillDeps surface** | `SkillDeps` already exposes `session`. No interface change needed — skills will read `_deps.session.closureRepos` directly. Add a `getClosureRepos(deps): readonly string[]` helper in `src/insrc/daemon/skills/scope-helpers.ts` (new file) so the read pattern is uniform across skills and tests can stub it. | Helper exists + unit-tested against a mock session |
| **2. `code.entity.locate-by-name`** | Schema: add `scope?: 'closure' \| 'global'` (default `'closure'`). Keep `repoPath?` for single-repo override. Add `repo: string` to each returned `MatchEntity`. Body: resolve scope → call `findEntitiesByName(..., { repos: closureRepos })` (multi-repo) or `{ repo: single }` (single override) or no filter (global). Update `findEntitiesByName` to accept `repos: readonly string[]` filter. | Skill returns in-closure results by default; `scope: 'global'` returns everything with `repo` tag; existing single-`repoPath` callers unchanged |
| **3. Class-locate skills** | `code.class.locate-references` and `code.class.extract-fields` both delegate to locate-by-name internally. Pass `scope` through if the caller sets it; default to closure via the inner skill. Schema gains the same `scope?` knob for parity. | Class lookups respect closure by default |
| **4. `code.orm.resolve-model`** | Already takes required `repoPath`. Relax to `repoPath?` so the closure default applies. Add `scope?` parity arg. Keep current behaviour when `repoPath` is passed explicitly. | ORM resolution scopes correctly without forcing the LLM to pass `repoPath` every time |
| **5. EntityId-based skills (summary, callers)** | `code.entity.summary` and `code.entity.callers`: after `getEntityById`, check `closureRepos.includes(entity.repo)`. If false, return typed refusal `{ found: false, reason: 'entity-out-of-scope' }` (mirrors existing not-found shape). Same `scope?: 'global'` opt-out for parity. | Cross-closure entityIds rejected with explicit reason; in-closure ones unchanged |
| **6. `findEntitiesByName` plumbing** | Update [db/entities.ts](src/insrc/db/entities.ts) `findEntitiesByName` to accept `{ repos: readonly string[] }` alongside the existing `{ repo: string }`. Multi-repo path filters the name-index lookup by repoId set. Backward-compat: existing `repo: single` callers unchanged. | Storage primitive supports multi-repo filtering |
| **7. Tests** | Multi-repo fixture: index two repos in test, no `DEPENDS_ON` between them. Cases: (a) `locate-by-name` default returns only active-repo matches; (b) `scope: 'global'` returns both with correct `repo` tags; (c) `entity.summary` rejects an entityId from the unrelated repo with `entity-out-of-scope`; (d) class skills inherit closure default. Update existing single-repo fixtures where they pass `repoPath` explicitly. | Tests pass; no regression in existing single-repo fixtures |
| **8. Live validation** | Re-run the `insors-extraction` analysis with the same prompt. Verify: zero hadoop citations in the final report; sections that used to drift (Task Processing, External Dependencies) now anchor on real extraction entities; the `Public API` section still finds genuine FastAPI routes (in-closure entities, not cross-repo). | Final report contains no `/Users/subhagho/work/projects/insors/hadoop/` paths anywhere |

Phases 1-6 can land in one PR (mechanical changes, ~300 lines).
Phase 7 lands with the tests. Phase 8 is the rollback gate.

## Open questions

1. **Closure of `insors-extraction` today** — Phase 0 dumps it. If hadoop is
   in the closure (e.g. stray `DEPENDS_ON` edge from manifest scanning), the
   skill-side fix still correctly enforces closure but doesn't address why
   hadoop is in there. The audit feeds a follow-up plan if needed.

2. **Backward-compat for callers passing `repoPath`** — the existing
   single-`repoPath` override is preserved as-is. No caller change needed.

3. **`scope: 'global'` discoverability** — the description text in
   each skill's schema needs to call out that `scope: 'global'` exists
   and when to use it (rare; mostly when investigating a name that
   might exist outside the active project's dependency tree). The
   default-closure behaviour should be transparent to the LLM in the
   normal case.

4. **What about read-by-vector?** `code.entity.search-by-vector`
   already takes `closureRepos` via the vector path (passed by
   caller). Two options: (a) leave alone — caller already scopes; (b)
   migrate to the same `scope` default as the other skills for
   consistency. Punt to a follow-up — vector path already works
   correctly; consistency is cosmetic.

## Risk

- **Hard-cut behaviour-change risk**: A skill caller relying on
  today's accidental global scope (and that result being useful
  cross-repo) silently sees results disappear. Mitigation: the
  `scope: 'global'` opt-out preserves the old behaviour for anyone
  who explicitly wants it. Phase 0 audit identifies if any current
  caller path depends on cross-repo results.
- **Closure-correctness assumption**: if the indexer wrote a wrong
  `DEPENDS_ON` edge (e.g. hadoop somehow linked), the skill-side fix
  inherits the bad closure. That's why Phase 0 dumps the closure
  before we change behaviour.

## Out of scope

- **Tool-loop substrate** mechanics. See `plans/tool-loop-substrate.md`.
- **Pre-dispatch tool-call guard**. See `plans/tool-call-guard-layer.md`
  — separate issue.
- **`code.source.grep` arg-shape failures**. Path-based skill, not
  name-based — closure scoping doesn't apply. Tracked under the
  Plan 1 arg-rename follow-up.
- **Renderer / writer prompt changes** to deprioritize cross-repo
  citations. With hard-cut at the skill layer, no out-of-closure
  citations reach the writer — no prompt change needed.
- **Indexer fix** if Phase 0 reveals a bad `DEPENDS_ON` edge. Tracked
  as a follow-up plan if needed.
