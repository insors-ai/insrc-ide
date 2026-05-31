# Skill plan: `code.source.file.describe`

**Status:** draft (2026-05-30)
**Owner:** subhagho@gmail.com
**Skill family:** `source-introspection`
**Tier:** L1 (capability skill, not agentic)
**Substrate owner id:** `skill:code.source.file.describe`

**Why this skill fourth:** per [`plans/code-analyzer-migration.md`](../../code-analyzer-migration.md) priority #4. Same pattern as #3 (`code.source.module.describe`) -- a per-file pure-graph aggregator that gets re-walked once per downstream LLM round-trip. The substrate cache collapses the repeats. Recipe transferred from #3 verbatim.

**Depends on:** same as the other code-skill migrations -- substrate P0-P5 complete; mirrors [`code.source.module.describe.md`](code.source.module.describe.md).

## What the skill does today

Resolve a file entity by deterministic id (`SHA256(repo + file + 'file' + file)`), then walk DEFINES + IMPORTS out-edges. Returns `{ found:true, entities, imports }` or `{ found:false, reason:'file-not-indexed' }`. When the graph row exists but has zero parsed children (config / shell / SQL / Dockerfile, etc.), read the file head from disk so the caller has something to cite -- confidence drops from `'high'` to `'medium'` for disk-fallback.

## Substrate-facing declaration (target shape)

### contextSlots

```ts
contextSlots: [
  // 1. Cache hit. Key is `<repoPath>::<file>`.
  {
    name:      'cached-description',
    fromOwner: 'skill:code.source.file.describe',
    namespace: 'file-descriptions',
    query: (req) => {
      const task = req.task as FileDescribeInput;
      return { kind: 'byKey', key: cacheKey(task) };
    },
    limit: 1,
  },

  // 2. Recent-miss negative cache for file-not-indexed.
  {
    name:      'recent-misses',
    fromOwner: 'skill:code.source.file.describe',
    namespace: 'recent-misses',
    query: (req) => {
      const task = req.task as FileDescribeInput;
      return { kind: 'byKey', key: cacheKey(task) };
    },
    limit: 1,
  },
],
```

### memorySchema

```ts
memorySchema: [
  { namespace:   'file-descriptions',
    valueType:   'FileDescribeOutput (found:true, confidence:high)',
    autoDistill: 'always-on-success',
    indexing:    { kind: 'never' },
    ttl:         '7d' },

  { namespace:   'recent-misses',
    valueType:   '{ file, repoPath, attemptedAt }',
    autoDistill: 'always-on-success',
    indexing:    { kind: 'never' },
    ttl:         '24h' },

  // Declared for future L2 distillation; no writes today.
  { namespace:   'observations',
    valueType:   'WorkspacePatternObservation',
    autoDistill: 'never',
    indexing:    { kind: 'never' },
    ttl:         '30d' },
],
```

## Execute() flow after migration

```
1. Cache hit -> return
2. Miss-cache hit -> return file-not-indexed
3. Cold path: getEntity + findDefinedIn + findImports (parallel LMDB reads, no LLM)
4. found:true + confidence:high -> pin to file-descriptions
5. found:true + bodyExcerpt fallback (medium/low confidence) -> NOT cached
   (disk content can change between calls; intentionally fresh)
6. file-not-indexed -> pin to recent-misses
```

## What's intentionally NOT in this migration

- **Disk-fallback caching.** Same rationale as `code.source.module.describe`'s disk-listing -- the filesystem can mutate outside the substrate's knowledge.
- **Per-entity caching.** A file's children are aggregated into the file's cache entry; per-entity caches live on `code.entity.summary` (priority #7).
- **Bootstrap context builder.** Pre-walking every file in the repo at indexing time is expensive; the lazy cache covers the warm-path win.

## Cache key

```ts
function cacheKey(input: FileDescribeInput): string {
  return `${input.repoPath}::${input.file}`;
}
```
