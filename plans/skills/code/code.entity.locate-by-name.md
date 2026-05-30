# Skill plan: `code.entity.locate-by-name`

**Status:** draft (2026-05-30)
**Owner:** subhagho@gmail.com
**Skill family:** `source-introspection`
**Tier:** L1 (capability skill, not agentic)
**Substrate owner id:** `skill:code.entity.locate-by-name`

**Why this skill next:** per [`plans/code-analyzer-migration.md`](../../code-analyzer-migration.md) §"Code-analyzer L1 skill migrations (priority order)" this is the explicit #1 target. Three reasons:

1. **Most-called skill in the code-analyzer pipeline.** Every classify-then-narrow flow hits it; warm-path latency dominates the per-question budget.
2. **Pure LMDB read with a stable cache key.** Inputs are `(name, kinds, repoPath|scope, language)`; output is a list of `Entity` rows. No LLM round-trips, no tool fan-out, no embedding step. A substrate cache slot collapses cold + warm into the same call.
3. **Recipe is proven.** `code.class.extract-fields` (P1) already migrated the substrate-facing pattern: cache hit short-circuit / cold-path pin / alias resolve / miss persistence. This skill is a strict subset of that flow (no tool composition, no field extraction), so the work transfers almost verbatim.

**Depends on:**
- [`plans/memory-context-substrate.md`](../../memory-context-substrate.md) — D1–D15 + D5a.
- [`plans/agentic-skills-architecture.md`](../../agentic-skills-architecture.md) — A1–A6 (L1 skill, so A1 self-grounding doesn't apply; the others do).
- [`plans/code-analyzer-migration.md`](../../code-analyzer-migration.md) — overall migration plan; this skill is Phase 1 item 1.
- [`plans/skills/substrate-implementation-status.md`](../substrate-implementation-status.md) — substrate phase tracker. **P0–P5 are all done**, so this skill's migration can declare the full target shape and have every slot actually live.

## Implementation phase status

Unlike `code.class.extract-fields` (which landed during substrate P1 with many slots inert), this skill arrives **after the substrate is complete**. Every declared slot is wired the same day the skill registers.

| Item | Status | Notes |
|---|---|---|
| `contextSlots.cached-locate` | live | substrate P1 |
| `contextSlots.name-aliases` | live | substrate P1 (read path), substrate P5 wires the classifier write path |
| `contextSlots.recent-misses` | live | substrate P1 |
| `contextSlots.active-closure` | live | substrate P4 (`provider:active-session`) |
| `contextSlots.preferred-repo-for-name` | live | substrate P5 (assertion-index) |
| `memorySchema.located-entities` | live | substrate P1 |
| `memorySchema.name-aliases` | live | substrate P1 |
| `memorySchema.recent-misses` | live | substrate P1 |
| `memorySchema.preferred-repo-for-name` | live | substrate P5 |
| `assertionInterests.name-aliases` | live | substrate P5 (D14 routing); see "Assertion routing" below |
| `assertionInterests.preferred-repo-for-name` | live | substrate P5 |
| `applyFeedback` hook | live | substrate P5 (feedback bus); fires when a user assertion lands |
| `contextBuilders.prewarm-top-names` | deferred | needs an entity-name index over the LMDB graph + a "top-N" heuristic; not on the critical path for the latency win |

## What the skill does today

Find every entity matching an exact name across the requested kinds, scoped to the active repo's dependency closure by default. Pure LMDB walk over the `name_index` sub-DB, returns `MatchEntity[]`.

**Inputs:**
```ts
interface LocateInput {
  name:     string;
  kinds?:   readonly EntityKind[];
  repoPath?: string;             // single-repo override; wins over scope
  scope?:   'closure' | 'global';
  language?: Language;           // optional post-filter
}
```

**Outputs:**
```ts
interface LocateOutput {
  name:    string;
  matches: readonly MatchEntity[];   // empty if no hits
}
```

**Confidence:** `'high'` on hit, `'medium'` on miss.

## Failure modes the substrate cache addresses

1. **Repeated lookups of the same name in the same closure** — current code re-queries LMDB every time. Substrate cache short-circuits.
2. **Cold-cache "obvious miss" loops** — the planner asks for `UserModel`, then `User`, then `User Model` in the same turn; today's skill walks `name_index` for each, returns three empty lists. Substrate caches the misses so the second + third resolve instantly.
3. **User-asserted aliases get lost** — today the planner can be told "use `UserService` for the auth flow", but `locate-by-name('User')` ignores it. After migration the classifier persists the alias and the cold-path resolution walks the alias slot first.
4. **Workspace-preferred repos** — when `Configuration` exists in both `hadoop-common` and `hadoop-yarn-services`, today the call returns both. A user assertion "prefer hadoop-common's Configuration" lands as a `preferred-repo-for-name` constraint that ranks the matches.

None of these change the skill's external contract. They reorder the cold path and cache the warm path.

## Substrate-facing declaration (target shape)

### contextSlots

```ts
contextSlots: [
  // 1. Cache hit path. Key is the canonical request fingerprint.
  {
    name:      'cached-locate',
    fromOwner: 'skill:code.entity.locate-by-name',
    namespace: 'located-entities',
    query:     (req) => ({
      kind: 'byKey',
      key:  cacheKey(req.task as LocateInput),
    }),
    limit:     1,
  },

  // 2. User-asserted aliases for the requested name.
  {
    name:      'name-aliases',
    fromOwner: 'skill:code.entity.locate-by-name',
    namespace: 'name-aliases',
    query:     (req) => ({
      kind: 'byKey',
      key:  aliasKey((req.task as LocateInput).name),
    }),
    limit:     1,
  },

  // 3. Recent misses (don't re-walk LMDB for a known nonexistent name).
  {
    name:      'recent-misses',
    fromOwner: 'skill:code.entity.locate-by-name',
    namespace: 'recent-misses',
    query:     (req) => ({
      kind: 'byKey',
      key:  (req.task as LocateInput).name,
    }),
    limit:     1,
  },

  // 4. Active closure -- substrate P4 provider:active-session.
  // Lets the skill avoid touching deps.session directly for the
  // closure list; cleaner separation. Cold path still calls
  // resolveSearchScope as a fallback.
  {
    name:      'active-closure',
    fromOwner: 'provider:active-session',
    namespace: '_',
    query:     { kind: 'byKey', key: 'closureRepos' },
    limit:     1,
  },

  // 5. Preferred repo for an ambiguous name -- substrate P5.
  // Read by the cold path after match list is built; used to
  // re-rank when multiple repos contain the same name.
  {
    name:      'preferred-repo-for-name',
    fromOwner: 'skill:code.entity.locate-by-name',
    namespace: 'preferred-repo-for-name',
    query:     (req) => ({
      kind: 'byKey',
      key:  (req.task as LocateInput).name,
    }),
    limit:     1,
  },
],
```

### memorySchema

```ts
memorySchema: [
  // Cache slot for hit results. Keyed by request fingerprint so
  // different scopes / kinds for the same name don't collide.
  { namespace: 'located-entities',
    valueType: 'LocateOutput + meta',
    autoDistill: 'on-pin',
    indexing: { kind: 'never' },   // exact-match cache; no semantic search
    ttl: '7d' },

  // Aliases: 'User' -> 'UserModel'. Populated by the D6 classifier
  // (substrate P5) when a user says "use X for Y".
  { namespace: 'name-aliases',
    valueType: '{ requestedName, canonical, scopeHint? }',
    autoDistill: 'on-pin',
    indexing: { kind: 'derived', from: (e) => (e.value as { requestedName: string }).requestedName },
    ttl: undefined /* permanent until contradicted */ },

  // Recent-miss negative cache.
  { namespace: 'recent-misses',
    valueType: '{ name, attemptedAt, scope }',
    autoDistill: 'on-pin',
    indexing: { kind: 'never' },
    ttl: '24h' },

  // Preferred repo for an ambiguous name (assertions land here).
  { namespace: 'preferred-repo-for-name',
    valueType: '{ name, preferredRepo, reason? }',
    autoDistill: 'never',          // only the classifier writes here
    indexing: { kind: 'never' },
    ttl: undefined },

  // Future: observations about which kinds typically resolve for
  // this name (e.g. 'NameNode is always a class, not a method').
  // Schema declared now so the skill's owner identity doesn't
  // change later.
  { namespace: 'observations',
    valueType: '{ subject, claim, tier, confidence, seenCount }',
    autoDistill: 'never',          // distilled by the L2 pilot, not this L1
    indexing: { kind: 'derived', from: (e) => (e.value as { subject: string }).subject },
    ttl: undefined },
],
```

### assertionInterests (substrate P5 / D14)

```ts
assertionInterests: [
  // The classifier routes "use X for Y" -> name-aliases here.
  { subjectPattern: 'name-alias',
    description:    'workspace-level alias from a user-stated name to its canonical entity name' },

  // The classifier routes "prefer repo R for name N" -> preferred-repo-for-name.
  { subjectPattern: 'preferred-repo-for-name',
    description:    'when multiple repos contain the same entity name, prefer this one' },
],
```

### applyFeedback hook (substrate P5)

On `user-correction` event whose payload is an alias: write to `name-aliases` namespace. On `preferred-repo-for-name`: write to that namespace. The runtime's `classifyAssertion` already persists the constraint to `user-assertions`, so this hook only mirrors the assertion into the skill's domain-specific namespace where the cold-path read happens.

## Execute() flow after migration

```
1. Read deps.context.slots.cached-locate
   └─ hit + not expired -> return value.matches with confidence=high + note 'from cache'

2. Read deps.context.slots.name-aliases
   └─ hit -> rewrite input.name to alias.canonical for subsequent steps

3. Read deps.context.slots.recent-misses (only if no kinds-narrowing in input)
   └─ hit + not expired -> return { matches: [] } with confidence=medium + note 'from miss cache'

4. Read deps.context.slots.active-closure (substrate P4 provider:active-session)
   └─ if present: use as closureRepos
   └─ if absent: fall back to resolveSearchScope(deps, input.scope ?? 'closure')

5. Cold path: findEntitiesByName(null, [input.name], opts)
   - opts merges kinds + (repos|repo) + limit
   - language filter applied post-hoc

6. Re-rank using deps.context.slots.preferred-repo-for-name
   - matches in the preferred repo float to the front
   - others keep their original order

7. Pin to working state:
   - On hit: pin LocateOutput to extracted-classes... no wait,
     to 'located-entities' under the request-fingerprint key.
     ttl from namespace spec (7d).
   - On miss: pin { name, attemptedAt: Date.now(), scope } to
     'recent-misses' under name key. ttl from namespace (24h).

8. Return {value: { name, matches }, confidence, notes}.
```

## Cache key

```ts
function cacheKey(input: LocateInput): string {
  const kinds = input.kinds === undefined || input.kinds.length === 0
    ? '*'
    : [...input.kinds].sort().join(',');
  const scope = input.repoPath !== undefined
    ? `repo:${input.repoPath}`
    : `scope:${input.scope ?? 'closure'}`;
  const lang  = input.language ?? '*';
  return `${input.name}::${kinds}::${scope}::${lang}`;
}
```

Closure-repos isn't in the key because changing the active workspace's closure is a strong invalidation signal — but TTL (7d) catches that, and the cache is per-workspace-id by construction (substrate scoping). A new session with a different repo activates against the same workspace's cache and gets warm hits for any entity that's still in the indexed closure.

## Migration tests

### Substrate-aware unit tests (`__tests__/code.entity.locate-by-name.substrate.test.ts`)

| # | Test | Asserts |
|---|---|---|
| 1 | cache hit short-circuit | second call to same `(name, kinds, scope)` returns from cache, doesn't touch `findEntitiesByName` |
| 2 | cold path pins to `located-entities` | first call writes the hit to the substrate cache |
| 3 | alias resolves before LMDB | pre-seeded alias `User -> UserModel`; call with `name='User'` queries LMDB for `UserModel` |
| 4 | miss persists to `recent-misses` | first call with nonexistent name writes to miss cache |
| 5 | miss cache short-circuits second call | second call to the same nonexistent name returns from miss cache without LMDB query |
| 6 | preferred-repo re-ranks ambiguous results | with two matches across repos + a preferred-repo assertion, the preferred match floats to the front |
| 7 | legacy compatibility | skill works without a substrate -- existing tests stay green |

### Hadoop integration tests (`__tests__/code.entity.locate-by-name.hadoop.test.ts`)

| # | Test | Assertion |
|---|---|---|
| 1 | `NameNode` resolves with real graph data | found, kind='class', file path contains 'NameNode' |
| 2 | second call to `NameNode` is a cache hit | notes include 'from cache' |
| 3 | nonexistent name returns empty + populates miss cache | confidence='medium', recent-misses entry created |
| 4 | second call to nonexistent name returns from miss cache | second call has 'from miss cache' note |
| 5 | `Configuration` multi-match returns 2+ entities (hadoop-common + hadoop-yarn-services) | matches.length >= 2; each match's `repo` differs |
| 6 | kind filter prunes results | `kinds: ['interface']` returns only interfaces |

## What's intentionally NOT in this migration

- **Vector-similarity fallback** for fuzzy name match. The skill stays exact-match. `code.entity.search-by-vector` is the right hammer for fuzzy lookup; chaining is the caller's choice.
- **Cross-name aliases** (e.g. "any class ending in `Service`"). Patterns aren't user-assertions; they belong in a different skill.
- **Pre-warm builder.** No `contextBuilders` declared. The cache populates lazily on first call. A builder that pre-walks the LMDB name-index for the active closure's top-N entities is plausible but premature without telemetry on what "top-N" actually means.
- **L2 wrapping.** This stays L1. The L2 pilot (`code.answer-question` per code-analyzer-migration.md) will *call* this skill, not subsume it.

## Risks

- **Cache staleness when the indexer re-runs.** A rebuild that changes entity IDs leaves stale cache rows pointing at gone entities. Mitigations: 7d TTL caps the blast radius; hit resolution checks the entity still exists (cheap LMDB read by id); future P3+ wiring could hook the substrate to the indexer's `reindex` trigger to invalidate. **Accepted for now -- the failure mode is "warm hit returns a deleted entity," which is a graceful empty/refuse from downstream, not a crash.**
- **Alias collision.** Two assertions both claim `User` aliases differently. D4 + D7 supersession handles it: newest + highest-confidence wins. Audit trail in the classifier's `decisions` namespace records the supersession. **Acceptable.**
- **`preferred-repo-for-name` is mutually-exclusive with multi-match listing.** A consumer that *wants* all matches across repos but happens to have a preference set might be surprised when re-rank changes the order. The skill emits an explicit note when re-ranking is applied so the consumer can detect it. **Acceptable.**
