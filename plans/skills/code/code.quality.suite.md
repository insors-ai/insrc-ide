# Skill plans: `code.quality.*` suite

**Status:** draft (2026-05-31)
**Owner:** subhagho@gmail.com
**Skill family:** `quality-profile`
**Tier:** L1 (capability skill, not agentic)

**Why a shared plan:** the four quality skills migrate identically. Each is a pure-graph aggregator over `(repoPath, file?)` that returns histograms / scores. They share the cache key and miss-cache shape. One plan doc per skill would be 80% boilerplate.

**Skills covered:**

| # | Skill | Migration plan target |
|---|---|---|
| 8  | `code.quality.complexity`      | priority #8 per code-analyzer-migration.md |
| 9  | `code.quality.cyclic-deps`     | priority #9 |
| 10 | `code.quality.duplication`     | priority #10 |
| 11 | `code.quality.unused-exports`  | priority #11 |

**Depends on:** substrate P0-P5 complete (status: done).

## Shared shape

Each skill:
- Takes `(repoPath, file?)` input (plus skill-specific flags like `dupMinLines`).
- Walks `listEntitiesForRepo` or `findEntitiesByFile`.
- Runs a deterministic pure-CPU computation (cyclomatic, SCC over CALLS edges, token-hash duplication, exported-but-uncalled).
- Returns a sorted entries list + histogram / score.

The compute is expensive on large repos (e.g. complexity walks every function body). Cache target: full output keyed by request fingerprint.

## Substrate-facing declaration (per skill)

### contextSlots

```ts
contextSlots: [
  { name: 'cached-report', fromOwner: 'skill:code.quality.<X>',
    namespace: '<X>-reports',
    query: (req) => ({ kind: 'byKey', key: cacheKey(req.task as Input) }),
    limit: 1 },
],
```

No miss-cache: these skills never refuse with `{found:false}`. The "miss" is just an empty entries list, which is itself a valid cacheable output.

### memorySchema

```ts
memorySchema: [
  { namespace: '<X>-reports',
    valueType: '<X>Output',
    autoDistill: 'always-on-success',
    indexing: { kind: 'never' },
    ttl: '24h' },     // shorter than 7d because quality data drifts with edits
],
```

**24h TTL** instead of 7d -- code edits invalidate complexity / duplication / unused-exports faster than module surfaces do. Trade-off: more cache misses for active development; absolute correctness via TTL while we wait for indexer-driven invalidation (deferred).

## Execute() flow

```
1. Read cache slot
   └─ hit -> return value with note 'from cache'
2. Cold path: existing computation
3. Pin to <X>-reports namespace
4. Return result
```

## Cache key (per skill)

```ts
// All four:
function cacheKey(input: Input): string {
  const file = input.file ?? '*';
  // duplication adds dupMinLines; unused-exports adds includeTests; complexity has no extras
  const extra = <skill-specific suffix>;
  return `${input.repoPath}::${file}${extra ? '::' + extra : ''}`;
}
```

## What's intentionally NOT in this migration

- **Bootstrap context builder** to pre-compute reports at indexing time. Defer until indexer-driven invalidation lands (the 24h TTL covers correctness in the interim).
- **Cross-skill report aggregation** (e.g. a single "quality dashboard"). That's an L2 concern.
- **Per-entity granularity cache** for complexity / unused-exports. The full report is the cache unit; sub-entity queries can be served by intersecting the report client-side.

## Risks

- **Cache staleness after edits.** 24h TTL bounds the blast radius. A `reindex` trigger fires no auto-invalidation today; we accept that warm hits can lag by up to 24h on active dirs. Production wiring (P3 lifecycle has the trigger queue) can hook `reindex` to invalidate when bootstrap builders land.
- **Memory pressure from full-report caching.** Complexity/duplication reports can be large (hundreds of entries × multi-KB each). 24h TTL + per-workspace scoping caps total disk usage; substrate's eviction story (currently TTL-only) is good enough.
