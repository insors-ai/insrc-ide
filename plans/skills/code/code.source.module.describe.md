# Skill plan: `code.source.module.describe`

**Status:** draft (2026-05-30)
**Owner:** subhagho@gmail.com
**Skill family:** `source-introspection`
**Tier:** L1 (capability skill, not agentic)
**Substrate owner id:** `skill:code.source.module.describe`

**Why this skill third:** per [`plans/code-analyzer-migration.md`](../../code-analyzer-migration.md) §"Code-analyzer L1 skill migrations (priority order)" — Priority #3 in the migration table. The note from that doc:

> Heavy LLM work today; full bootstrap to memory (module-summary builder) is high-value.

The skill itself doesn't call an LLM -- the "heavy LLM work" is downstream (writer + grounding-review consume the result). The substrate win is twofold:

1. **Module surface is stable per `(repoPath, modulePath)`.** Re-walking `listEntitiesForRepo` for every downstream LLM round-trip is wasted work; a substrate cache collapses it to one walk per index generation.
2. **Pre-warmable at indexing time.** The eventual win is a `contextBuilder` that walks every module at `repo-add` / `reindex` time and pre-populates the cache. **Deferred for this migration** -- the lazy-cache path covers most of the value; the builder is its own follow-up once we have a real bootstrap-trigger consumer.

**Depends on:**
- [`plans/memory-context-substrate.md`](../../memory-context-substrate.md) — D1–D15 + D5a.
- [`plans/agentic-skills-architecture.md`](../../agentic-skills-architecture.md) — A1–A6.
- [`plans/code-analyzer-migration.md`](../../code-analyzer-migration.md) — priority order.
- [`plans/skills/substrate-implementation-status.md`](../substrate-implementation-status.md) — P0–P5 done.
- Sibling: [`code.entity.locate-by-name.md`](code.entity.locate-by-name.md) — same migration recipe.

## What the skill does today

Walk the LMDB graph (`listEntitiesForRepo`), scope to entities whose `file` lives under `modulePath`, aggregate the public surface. On no-indexed-files, fall back to a directory listing.

**Inputs:**
```ts
interface ModuleDescribeInput {
  modulePath: string;   // absolute directory path
  repoPath:   string;   // absolute repo root
}
```

**Outputs:**
```ts
{ found: true, modulePath, fileCount, entityCount, publicCount,
  languages, files, entities, publicSurface, source, subdirs? }
| { found: false, reason: 'no-files-in-module' }
```

**Confidence:** `'high'` on graph hit, `'medium'` on disk-listing fallback, `'high'` on clean refusal.

## Failure modes the substrate cache addresses

1. **Re-walking `listEntitiesForRepo` per downstream LLM round-trip.** `listEntitiesForRepo` returns *every* entity in the repo (Hadoop = tens of thousands), then we filter. Cache hit skips both the LMDB walk and the in-memory filter.
2. **No negative cache for empty modules.** Today a planner that probes 5 dirs to find the "real" module makes 5 full LMDB walks. The miss-cache short-circuits the repeated empty probes.

The skill's external contract is unchanged. The substrate only reorders the cold path + caches the warm path.

## Substrate-facing declaration (target shape)

### contextSlots

```ts
contextSlots: [
  // 1. Cache hit path. Key is `<repoPath>::<modulePath>`.
  {
    name:      'cached-description',
    fromOwner: 'skill:code.source.module.describe',
    namespace: 'module-descriptions',
    query: (req) => {
      const task = req.task as ModuleDescribeInput;
      return { kind: 'byKey', key: cacheKey(task) };
    },
    limit: 1,
  },

  // 2. Recent-miss negative cache.
  {
    name:      'recent-misses',
    fromOwner: 'skill:code.source.module.describe',
    namespace: 'recent-misses',
    query: (req) => {
      const task = req.task as ModuleDescribeInput;
      return { kind: 'byKey', key: cacheKey(task) };
    },
    limit: 1,
  },
],
```

### memorySchema

```ts
memorySchema: [
  // Cache slot for hit results.
  { namespace:   'module-descriptions',
    valueType:   'ModuleDescribeOutput (found:true)',
    autoDistill: 'always-on-success',
    indexing:    { kind: 'never' },
    ttl:         '7d' },

  // Negative cache for no-files-in-module misses.
  { namespace:   'recent-misses',
    valueType:   '{ modulePath, repoPath, attemptedAt }',
    autoDistill: 'always-on-success',
    indexing:    { kind: 'never' },
    ttl:         '24h' },

  // Declared for the eventual L2 distillation path (observations
  // like "this module always returns 0 files due to gitignore");
  // no writes from this L1 today.
  { namespace:   'observations',
    valueType:   'WorkspacePatternObservation',
    autoDistill: 'never',
    indexing:    { kind: 'never' },
    ttl:         '30d' },
],
```

### assertionInterests (substrate P5 / D14)

```ts
assertionInterests: [
  // Future: user says "treat src/legacy as a single module, not three
  // subdirs". The classifier could route to this skill's namespace.
  // Declared for routing visibility; no consumer code yet.
  { subjectPattern: 'module-boundary',
    description:    'how a workspace defines what counts as a module' },
],
```

## Execute() flow after migration

```
1. Read deps.context.slots.cached-description
   └─ hit + not expired -> return value with note 'from cache'

2. Read deps.context.slots.recent-misses
   └─ hit + not expired -> return { found: false, reason: 'no-files-in-module' }
                            with note 'from miss cache'

3. Cold path: listEntitiesForRepo + filter by modulePath
   - On hit (files.length > 0): build ModuleDescribeOutput, pin to
     module-descriptions, return with confidence='high'.
   - On miss + disk-listing fallback succeeds: return disk-listing
     payload (medium confidence). NOT cached -- disk-listing is
     intentionally fresh per call (the disk might change between
     calls in ways the substrate can't track).
   - On miss + no fallback: pin to recent-misses, return clean
     refusal (high confidence).
```

## Cache key

```ts
function cacheKey(input: ModuleDescribeInput): string {
  return `${input.repoPath}::${input.modulePath}`;
}
```

## What's intentionally NOT in this migration

- **Bootstrap context builder.** A builder that walks every module in the repo at `repo-add` / `reindex` time and pre-populates the cache. The lazy cache covers the warm-path win; the builder adds indexer-time work that needs telemetry to size correctly. Lands when there's a real bootstrap-trigger consumer.
- **Disk-listing cache.** Disk listings are intentionally fresh per call -- the filesystem can change in ways the substrate can't track. The graph-backed hit is the cacheable shape.
- **Module-graph awareness (e.g. "this module depends on that one").** Out of scope for this migration; that's an aggregation skill that should compose on top of this one.
- **L2 wrapping.** This stays L1. The L2 pilot (`code.audit-module` / `code.answer-question`) will *call* this skill.

## Risks

- **Cache staleness when files are added/removed in a module.** The 7d TTL caps blast radius. A `reindex` trigger fires no auto-invalidation today; we accept that warm hits can lag fresh code by minutes-to-days. Production wiring (P3 lifecycle now has the trigger queue + DAG) can hook `reindex` to invalidate the right keys when the builder lands.
- **Empty `found:true` payload from disk-listing IS NOT cached.** That avoids the surprising "I told you it had files yesterday" -> "now it has different files" mid-session. Cold-path always for disk-listing.
