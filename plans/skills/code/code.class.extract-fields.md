# Skill plan: `code.class.extract-fields`

**Status:** draft (2026-05-29)
**Owner:** subhagho@gmail.com
**Skill family:** `code-binding`
**Tier:** L1 (capability skill, not agentic)
**Substrate owner id:** `skill:code.class.extract-fields`

**Why this skill first:** of the 30 `code.*` skills, this one has the highest combined complexity along three axes: language surface (6 languages with distinct extraction strategies), tool composition (two underlying tools + fallback paths), and downstream-stake (it's the cross-owner binding skill that data-analyzer Phase 4 rides on). Getting the substrate migration right here exercises the most of the framework.

**Depends on:**
- [`plans/memory-context-substrate.md`](../../memory-context-substrate.md) — D1–D15 + D5a.
- [`plans/agentic-skills-architecture.md`](../../agentic-skills-architecture.md) — A1–A6 (this is an L1 skill, so A1's self-grounding doesn't apply; the others do).
- [`plans/code-analyzer-migration.md`](../../code-analyzer-migration.md) — overall migration plan (this skill is the highest-priority migration in Phase 1).
- [`plans/skills/substrate-implementation-status.md`](../substrate-implementation-status.md) — implementation phasing. **This skill's narrow wiring lands in P1; full wiring fills in across P3–P5.**

## Implementation phase status

The full design below declares 7 context slots, 5 memory namespaces, 2 `assertionInterests`, and 1 `contextBuilder`. The substrate phases land these incrementally. The skill's **substrate-facing declaration matches the eventual target shape from P1 onward**; deferred slots are inert (return empty / fall through) until the substrate phase that activates them lands.

| Item | Lands in | What happens in earlier phases |
|---|---|---|
| `contextSlots.cached-extraction` | **P1** | — |
| `contextSlots.class-aliases` | **P1** (read path); P5 (auto-populate from D6 classifier) | P1 tests write directly to populate |
| `contextSlots.recent-misses` | **P1** | — |
| `contextSlots.active-closure` | **P4** (when `provider:active-session` lands) | P1: fall back to inline `resolveSearchScope` |
| `contextSlots.language-by-file` | **P3** (when async indexer + `language-detection` builder land) | P1: read language from entity record returned by `code_class_locate` |
| `contextSlots.workspace-patterns` | **P5** (when observation distillation wires into skill body) | P1: slot returns empty; skill body doesn't emit Pydantic-shape observations yet |
| `contextSlots.user-assertions` | **P5** (when D6 classifier writes to namespace) | P1: slot returns empty (or populated by tests directly) |
| `memorySchema.extracted-classes` | **P1** | — |
| `memorySchema.class-aliases` | **P1** | — |
| `memorySchema.recent-misses` | **P1** | — |
| `memorySchema.observations` | **P5** | Schema declared in P1; no writes |
| `memorySchema.user-assertions` | **P5** | Schema declared in P1; no writes |
| `assertionInterests.class-aliases` | **P5** | Declared in P1; routing inert until classifier lands |
| `assertionInterests.preferred-repo-for-class` | **P5** | Declared in P1; routing inert until classifier lands |
| `contextBuilders.prewarm-top` | **P3** (when DAG + `entity-name-index` land) | P1: builder not registered; cache populates lazily on first call |
| `applyFeedback` hook | **P5** (when feedback bus lands) | P1: hook registered; never fires |

This is intentional: the skill declares its full target shape once. New substrate phases wire up the deferred items without re-touching the skill registration.

## What the skill does today

Locate a class / interface / type by name in the active workspace; return its typed field metadata.

**Inputs:**
```ts
interface ExtractFieldsInput {
  className: string;
  repoPath?: string;
  scope?: 'closure' | 'global';                                      // SCS Phase 3
  language?: 'typescript' | 'javascript' | 'python' | 'go' | 'java' | 'scala';
}
```

**Outputs (discriminated):**
```ts
type ExtractFieldsOutput =
  | { found: true; entityId: string; className: string; language: string;
      path: string; line: number; kind: string; isAbstract?: boolean;
      source: 'graph' | 'body' | 'mixed' | 'none';
      fields: FieldInfo[]; fileHead?: string; }
  | { found: false; nearest: NearestCandidate[]; }
  | { found: false; ambiguity: { kind: 'multiple-matches'; alternatives: string[] } };
```

**Today's flow:**
1. `code_class_locate({ className, scope, repoPath })`
   - Exact-match across `class | interface | type` kinds in the resolved scope.
   - On miss → `nearest` candidates by Levenshtein + prefix overlap.
2. If found, `code_class_fields({ entityId })`
   - Java/Scala: graph walk over `DECLARED_IN` / `HAS_FIELD` edges (LMDB graph).
   - TS/JS/Python/Go: per-language body regex against the entity's source range.
3. If fields are empty after extraction (decorator-heavy Pydantic, opaque definition, etc.) → fallback to `tryReadFileForFallback(path)` which returns head-of-file as text for the caller / LLM to interpret.
4. Source provenance recorded: `'graph' | 'body' | 'mixed' | 'none'`.

**Why this is hard:**
- **Six language extraction strategies**, two distinct mechanisms (graph traversal vs body regex).
- **Three-way fallback ladder**: structured extraction → text head-of-file → not-found-with-nearest.
- **Two-tool composition** with distinct error modes per step.
- **Closure-aware scope** — search may span the active session's DEPENDS_ON closure of repos, not just one repo.
- **Stake on downstream** — data-analyzer's class-to-table mapping depends on this skill returning consistent results. The discriminated output type is a structural fix for a prior hallucinated-class regression.

## Failure modes today

| # | Symptom | Why | What substrate + L2 model fixes |
|---|---|---|---|
| 1 | Same class re-extracted on every call | Skill is stateless; no caching | Memory namespace `extracted-classes` keyed by `(repoPath, className)`; warm hit returns in ms |
| 2 | Closure scope re-resolves per call | `resolveSearchScope` walks repos every time | Context slot `active-closure` assembled by substrate from session state |
| 3 | Nearest-candidate computation re-runs | Levenshtein + prefix scan on every miss | Memory namespace `recent-misses` for the same `className`; pre-computed by context builder at indexing |
| 4 | "User says `User`, repo has `UserModel`" misses | Alias not learned; user-correction lost between turns | Memory namespace `class-aliases` populated by user-assertion classifier (D6 → D14 routing) |
| 5 | Java field walk works; Pydantic falls through to head-of-file every time | No `pattern` learned about Pydantic shapes per-workspace | Observation distillation: skill notices "this repo's Python classes use Pydantic" → `kind: hint`, tier `pattern` (D13) → future runs adjust extraction strategy |
| 6 | Multi-repo `User` class hits ambiguity on every call | No record of "user typically meant the one in repo X" | Pinned context entry: `repo-preference-for-className` learns from user disambiguation |
| 7 | Language detection re-runs from `entityId` lookup | Cold | Static-scan context builder `language-detection` (D15) pre-populates per-file language |

## Substrate-facing declaration

```ts
registerSkill({
  id: 'code.class.extract-fields',
  ownerId: 'skill:code.class.extract-fields',
  schemaVersion: 1,
  family: 'code-binding',
  owner: 'code-analyzer',          // legacy field; kept for back-compat

  interestedTriggers: ['repo-add', 'reindex', 'connection-add', 'manual'],

  contextSlots: [
    // Warm-hit cache: prior successful extraction for this (repo, class).
    { name: 'cached-extraction',
      fromOwner: 'skill:code.class.extract-fields',
      namespace: 'extracted-classes',
      query: (req) => ({ kind: 'byKey',
                          key: `${req.task.repoPath ?? '*'}::${req.task.className}` }),
      limit: 1 },

    // Learned aliases: user said `User` meant `UserModel`.
    { name: 'class-aliases',
      fromOwner: 'skill:code.class.extract-fields',
      namespace: 'class-aliases',
      query: (req) => ({ kind: 'prefix',
                          prefix: `${req.task.repoPath ?? '*'}::` }) },

    // Active closure roster (session-derived).
    { name: 'active-closure',
      fromOwner: 'provider:active-session',
      namespace: 'closure',
      query: () => ({ kind: 'byKey', key: 'current' }),
      required: true },

    // Per-file language tags from the indexer's static-scan builder.
    { name: 'language-by-file',
      fromOwner: 'skill:language-detection',
      namespace: 'by-file',
      query: () => ({ kind: 'prefix', prefix: '' }) },

    // Workspace-level observations (e.g., "this repo's Python uses Pydantic").
    { name: 'workspace-patterns',
      fromOwner: 'skill:code.class.extract-fields',
      namespace: 'observations',
      query: (req) => ({ kind: 'byKey', key: `${req.task.repoPath ?? '*'}::python-shape` }) },

    // User-asserted preferences (e.g., "always prefer the User in repo X").
    { name: 'user-assertions',
      fromOwner: 'skill:code.class.extract-fields',
      namespace: 'user-assertions',
      query: () => ({ kind: 'prefix', prefix: '' }) },
  ],

  memorySchema: [
    { namespace: 'extracted-classes',
      valueType: 'ExtractedClassRecord',
      autoDistill: 'always-on-success',                       // cache
      indexing: { kind: 'never' },                            // lookup by key
      ttl: '7d' },

    { namespace: 'class-aliases',
      valueType: 'ClassAlias',
      autoDistill: 'on-pin',                                  // constraint only
      indexing: { kind: 'derived',
                   from: (entry) => (entry.value as ClassAlias).userTerm },
      ttl: 'until-contradicted' },

    { namespace: 'observations',
      valueType: 'WorkspacePatternObservation',
      autoDistill: 'on-pin',
      indexing: { kind: 'derived',
                   from: (entry) => (entry.value as WorkspacePatternObservation).subject },
      ttl: '30d' },                                            // pattern-tier observation lifecycle

    { namespace: 'user-assertions',
      valueType: 'UserAssertion',
      autoDistill: 'on-pin',
      indexing: { kind: 'always' },                            // user assertions are semantic-recall heavy
      ttl: 'until-contradicted' },

    { namespace: 'recent-misses',
      valueType: 'MissRecord',
      autoDistill: 'always-on-success',
      indexing: { kind: 'derived',
                   from: (entry) => (entry.value as MissRecord).attemptedName },
      ttl: '24h' },                                            // short — keep misses recent
  ],

  assertionInterests: [
    { subjectPattern: 'class-aliases',
      description: 'Workspace-specific class name aliases (e.g., "User means UserModel here").' },
    { subjectPattern: 'preferred-repo-for-class',
      description: 'Which repo wins when a class name is ambiguous across the closure.' },
  ],

  contextBuilders: [
    // Static-scan: pre-warm class-name embeddings + locate-cache for top-N most-referenced classes.
    { id: 'code.class.extract-fields:prewarm-top',
      ownerId: 'skill:code.class.extract-fields',
      triggers: ['repo-add', 'reindex'],
      dependsOn: ['entity-name-index'],   // depends on the indexer's entity-vec builder
      build: prewarmTopClasses,
    },
  ],

  applyFeedback: async (events, deps) => {
    // accepted / refined / rejected feed confidence updates on cached entries
    // user-correction events that landed via the classifier are already
    // routed here as user-assertions namespace writes — no additional work.
    for (const e of events) {
      if (e.kind === 'accepted' && e.memoryRefs.length > 0) {
        // bump confidence on cited entries
        for (const ref of e.memoryRefs) { await deps.boostConfidence(ref, 0.05); }
      }
    }
  },

  execute: extractFieldsExecute,
});
```

## Updated execute() flow

```ts
async function extractFieldsExecute(input, deps): Promise<SkillResult<ExtractFieldsOutput>> {
  // 1. Apply learned aliases — user said `User` but workspace has `UserModel`.
  const aliases = deps.context.slots.get('class-aliases') ?? [];
  const resolvedClassName = resolveAlias(input.className, input.repoPath, aliases) ?? input.className;

  // 2. Hot cache hit?
  const cached = deps.context.slots.get('cached-extraction')?.[0];
  if (cached && !isStale(cached, input)) {
    return { value: cached.value as ExtractFieldsOutput, confidence: 'high', notes: ['from cache'] };
  }

  // 3. Resolve scope using the substrate-assembled closure slot.
  const closure = deps.context.slots.get('active-closure')?.[0]?.value as ResolvedScope | undefined;
  const scope = closure ?? await fallbackResolveScope(input, deps);

  // 4. Tool round-trip 1: code_class_locate.
  const locate = await deps.runTool({ name: 'code_class_locate',
                                       input: { className: resolvedClassName, scope } });
  if (locate.isError) return errorResult(locate);

  const locateData = locate.data;
  if (!locateData?.found) {
    // 4a. Persist the miss for nearest-candidate warmth + observation.
    const ref = deps.workingState.append({ source: { kind: 'tool', toolId: 'code_class_locate' },
                                            payload: locateData, claims: [`miss:${resolvedClassName}`],
                                            confidence: 0.9 });
    deps.workingState.pin(ref, { owner: 'skill:code.class.extract-fields',
                                  namespace: 'recent-misses', key: resolvedClassName,
                                  kind: 'fact', ttlMs: 24 * 3600_000 });
    return { value: { found: false, nearest: locateData.nearest },
             confidence: 'high', notes: ['miss; nearest persisted'] };
  }

  // 5. Multi-match ambiguity check + per-user-assertion repo preference.
  if (locateData.alternatives && locateData.alternatives.length > 1) {
    const userPref = pickPreferredRepo(locateData.alternatives, deps.context.slots.get('user-assertions') ?? []);
    if (!userPref) {
      return { value: { found: false, ambiguity: { kind: 'multiple-matches',
                                                     alternatives: locateData.alternatives.map(a => a.entityId) } },
                confidence: 'high', notes: ['ambiguous; awaiting user disambiguation'] };
    }
    locateData.entityId = userPref;
  }

  // 6. Tool round-trip 2: code_class_fields.
  const fields = await deps.runTool({ name: 'code_class_fields', input: { entityId: locateData.entityId } });
  if (fields.isError) return errorResult(fields);

  const fieldsData = fields.data;
  let extraction: ExtractFieldsOutput = { found: true, ...locateData, ...fieldsData };

  // 7. Empty-fields fallback: head-of-file text for opaque definitions.
  if (fieldsData.fields.length === 0) {
    const fb = await tryReadFileForFallback(locateData.path);
    if (fb !== null) extraction = { ...extraction, source: 'none', fileHead: fb };

    // 8. Observation: if Python + Pydantic decorators in head, distill the pattern.
    if (isPythonPydanticShape(fb, locateData.path)) {
      const ref = deps.workingState.append({ source: { kind: 'observation' },
                                              payload: { subject: 'python-shape', claim: 'pydantic-decorators' },
                                              claims: ['python-shape:pydantic-decorators'],
                                              confidence: 0.6 });
      deps.workingState.pin(ref, { owner: 'skill:code.class.extract-fields',
                                    namespace: 'observations',
                                    key: `${input.repoPath}::python-shape`,
                                    kind: 'hint',
                                    ttlMs: 30 * 24 * 3600_000 });
    }
  }

  // 9. Pin successful extraction → distilled to cache namespace per autoDistill: 'always-on-success'.
  const extractionRef = deps.workingState.append({
    source: { kind: 'tool', toolId: 'code_class_fields' },
    payload: extraction,
    claims: [`extracted:${locateData.entityId}`],
    confidence: 0.95,
  });
  deps.workingState.pin(extractionRef, { owner: 'skill:code.class.extract-fields',
                                          namespace: 'extracted-classes',
                                          key: `${input.repoPath ?? '*'}::${resolvedClassName}`,
                                          kind: 'fact',
                                          ttlMs: 7 * 24 * 3600_000 });

  return { value: extraction, confidence: 'high', notes: [] };
}
```

## Context builder: `prewarm-top`

Runs at indexing time per D15 (depends on the indexer's `entity-name-index` builder being done first).

```ts
async function prewarmTopClasses(input: BuilderInput, deps: BuilderDeps): Promise<void> {
  // Pull top-N most-referenced classes from the entity graph (using in-edge count).
  const top = await deps.runTool({ name: 'code_graph_top_classes_by_inrefs',
                                    input: { limit: 100, scope: 'global' } });
  if (top.isError) return;

  // For each, fetch fields + write to extracted-classes cache as bootstrap entries.
  for (const c of top.data.classes) {
    const fields = await deps.runTool({ name: 'code_class_fields', input: { entityId: c.entityId } });
    if (fields.isError) continue;

    await deps.memory
      .scope('skill:code.class.extract-fields', 'extracted-classes')
      .put(`${c.repoPath}::${c.className}`, { found: true, ...c, ...fields.data },
            { kind: 'fact',
              source: { kind: 'bootstrap', trigger: { kind: input.triggerKind } },
              confidence: 0.95,
              ttlMs: 7 * 24 * 3600_000 });
  }
}
```

Bootstrap cost: ~100 graph + body extractions per repo at indexing time. Acceptable for a one-time cost; reads dominate after.

## What gets distilled vs not

| Working-state entry | Distilled to memory? | Namespace | Reason |
|---|---|---|---|
| Successful extraction | Yes (auto) | `extracted-classes` | Cache; future calls hit warm |
| Miss + nearest | Yes (auto) | `recent-misses` | Short TTL; helps when same name re-attempted |
| Pydantic-shape observation | Yes (pinned) | `observations` | Pattern-tier per D13; influences future extraction strategy |
| Alias from user correction | Routed via classifier (D6 → D14) | `class-aliases` | Constraint tier per D7 |
| Tool error | No | (none) | Errors are transient; don't pollute memory |
| Ambiguity report | No | (none) | Ambiguity is per-question; resolved by user, not cached |

## Tests

Per A6 — live local-LLM testing applies only when the LLM is involved. This skill has no LLM call (composition of two structured tools); fake-provider unit tests are fine.

**Unit tests (with fake tools):**
- Cache hit → cached value returned; no tool calls.
- Cache miss → tool calls → cache write on success.
- Locate miss → `found: false, nearest` + miss persisted.
- Multi-match without user preference → `found: false, ambiguity`.
- Multi-match with user-assertion preference → resolves to preferred repo's class.
- Empty-fields path → head-of-file populated.
- Alias resolution → `className: 'User'` + alias `User → UserModel` → tool called with `UserModel`.
- Pydantic-shape observation distilled when head matches the pattern.

**Integration tests (live tools, real LMDB graph):**
- Full extraction round-trip on a fixture repo with Java + TS classes.
- Closure-scope walk across two registered repos.

**Substrate-level tests:**
- Bootstrap builder populates `extracted-classes` for top-100 classes at repo-add.
- Schema bump (`schemaVersion: 1 → 2`) wipes the namespace, triggers re-bootstrap per D9.
- User assertion "the User class lives in repo X" routes to this skill's `user-assertions` namespace via D6+D14.

No live LLM tests for this skill — it doesn't reason. The downstream L2 skills that consume it (`code.audit-module`, `code.answer-question`) carry the live-LLM testing burden.

## Migration steps

1. **Add substrate-facing declarations** to the existing skill registration. Existing `execute()` body stays.
2. **Wire `deps.context` reads** to short-circuit on cache hit. Existing tool-call path remains as cold-path fallback.
3. **Wire `deps.workingState.pin`** for successful extractions. Substrate's `autoDistill: 'always-on-success'` policy persists them.
4. **Implement `prewarm-top` context builder.** Register it; indexer dispatches on next `repo-add` / `reindex`.
5. **Declare `assertionInterests`.** User assertions about class aliases route here.
6. **Implement `applyFeedback`.** Confidence updates on cited entries.
7. **Add observation distillation** for the Pydantic shape (and any other pattern observations the migration surfaces).
8. **Migrate tests** — existing unit tests work; add substrate-aware tests.

Each step is independently shippable. After all steps, the skill is fully substrate-resident with no fallback path being load-bearing for normal operation.

## Open questions

- **`prewarm-top` budget.** Top-100 classes × 2 tool calls × ~5ms each = ~1s per repo. Acceptable. But for large monorepos with 10k+ classes, top-100 may miss most of what users ask about. Should the builder pick by repo's "user-recent" instead of "globally most-referenced"? Probably yes once the daemon tracks per-user query history; for now, top-100 by in-references is a reasonable default.
- **Multi-tool atomic locking.** `code_class_locate` returns `entityId`; `code_class_fields` uses it. Between the two calls, an indexer re-run could invalidate the entity. Substrate transactional guarantees are per-entry only (D8 fire-and-forget for events; no cross-tool atomicity). On race, the second call returns `not-found`; skill returns error. Acceptable but worth flagging.
- **Observation merging across repos.** Today's design has `observations` keyed by `(repoPath, subject)`. If the user's monorepo has a uniform Python shape across modules, the observation should generalize. Defer until we see a real case where it bites.

## What this doc is NOT committing to

- Exact substrate API shapes (illustrative; aligned with the framework docs).
- The `code_graph_top_classes_by_inrefs` tool — that's a hypothetical helper for the prewarm builder; if it doesn't exist, the builder either calls existing graph traversal helpers or skips prewarm.
- Specific confidence-update math in `applyFeedback`.

Each implementation iteration may refine these. The shape locked here is: the skill's substrate-facing declarations + its execute() flow against the substrate.
