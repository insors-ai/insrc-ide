# Skill plan: `code.entity.summary`

**Status:** draft (2026-05-31)
**Owner:** subhagho@gmail.com
**Skill family:** `source-introspection`
**Tier:** L1 (capability skill, not agentic)
**Substrate owner id:** `skill:code.entity.summary`

**Why this skill:** per [`plans/code-analyzer-migration.md`](../../code-analyzer-migration.md) priority #7 -- "cacheable per-entity". Pure-graph computation (single `getEntity` LMDB read + body excerpt build). The cache target is the entityId itself; output is stable per `(entityId, excerptMaxChars, scope)`. Recipe mirrors `code.source.file.describe`.

## What the skill does today

Wrap `getEntity(entityId)` with a typed summary card: metadata + a length-capped body excerpt. Returns `{ found:true, entityId, name, kind, ..., excerpt }` or `{ found:false, reason }` where reason is `'entity-not-found'` or `'entity-out-of-scope'` (closure-scope check). On empty body (config files tree-sitter doesn't parse), falls back to a disk read -- confidence drops to `'medium'`.

## Substrate-facing declaration

### contextSlots

```ts
contextSlots: [
  { name: 'cached-summary', fromOwner: 'skill:code.entity.summary',
    namespace: 'entity-summaries',
    query: (req) => ({ kind: 'byKey', key: cacheKey(req.task as SummaryInput) }),
    limit: 1 },
  { name: 'recent-misses', fromOwner: 'skill:code.entity.summary',
    namespace: 'recent-misses',
    query: (req) => ({ kind: 'byKey', key: (req.task as SummaryInput).entityId }),
    limit: 1 },
],
```

### memorySchema

```ts
memorySchema: [
  { namespace: 'entity-summaries', valueType: 'SummaryOutput (found:true, confidence:high)',
    autoDistill: 'always-on-success', indexing: { kind: 'never' }, ttl: '7d' },
  { namespace: 'recent-misses', valueType: 'MissRecord',
    autoDistill: 'always-on-success', indexing: { kind: 'never' }, ttl: '24h' },
],
```

## Execute() flow

```
1. Cache hit -> return
2. Miss-cache hit -> return entity-not-found
3. Cold: getEntity
4. found + in-scope + body.length > 0 -> pin to entity-summaries
5. found + disk-fallback (medium confidence) -> NOT cached
6. not-found -> pin to recent-misses
7. out-of-scope -> NOT cached (scope changes per session)
```

## Cache key

```ts
function cacheKey(input: SummaryInput): string {
  const max   = input.excerptMaxChars ?? 800;
  const scope = input.scope ?? 'closure';
  return `${input.entityId}::${max}::${scope}`;
}
```
