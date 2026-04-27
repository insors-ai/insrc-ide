/**
 * Cross-file resolver pass -- the second pass over the graph.
 * See plans/cross-file-references.md §3.
 *
 * Runs after the per-file index settles. Two responsibilities:
 *
 *   1. Rewire IMPORTS edges that currently point at module-stub entities
 *      to the in-tree file entity instead, when one exists. Module stubs
 *      stay in the graph for external deps.
 *
 *   2. Walk the UnresolvedRelation table and resolve INHERITS / IMPLEMENTS
 *      rows by name (filtered by import scope -- same-file or imported).
 *      Resolved rows get promoted into the typed REL table; ambiguous
 *      rows record `meta.candidates` and stay in UnresolvedRelation;
 *      no-match rows just stay (the next pass retries).
 *
 * CALLS resolution lives in Phase 4. This module skips CALLS rows.
 */

import { existsSync, statSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { getLogger } from '../shared/logger.js';
import type { DbClient } from '../db/client.js';
import type { Entity, EntityKind, Language } from '../shared/types.js';
import { listEntitiesForRepo, getEntity } from '../db/entities.js';
import {
  listUnresolvedRelations,
  promoteResolvedBatch,
  updateUnresolvedMetaBatch,
  type UnresolvedRelation,
} from '../db/relations.js';
import type { SourceRoots } from './source-roots.js';

const log = getLogger('cross-file-resolver');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CrossFileResolveOpts {
  readonly db:          DbClient;
  readonly repoRoot:    string;
  readonly sourceRoots: SourceRoots;
  /** Limit unresolved-row scanning to rows whose `fromFile` matches.
   *  Used by the incremental settle path (Phase 5). Omit for a bulk
   *  pass over the whole repo. */
  readonly scopeFile?:  string | undefined;
}

export interface CrossFileResolveResult {
  readonly importsRewired:   number;
  readonly resolved:         number;
  readonly ambiguous:        number;
  readonly stillUnresolved:  number;
  readonly elapsedMs:        number;
}

export async function runCrossFileResolver(
  opts: CrossFileResolveOpts,
): Promise<CrossFileResolveResult> {
  const t0 = Date.now();
  log.info({ repo: opts.repoRoot }, 'cross-file resolver starting');

  // -- setup: load entities + build in-memory index --
  const tLoad = Date.now();
  const entities = await listEntitiesForRepo(opts.db, opts.repoRoot);
  log.info(
    { repo: opts.repoRoot, entities: entities.length, elapsedMs: Date.now() - tLoad },
    'cross-file: loaded entities',
  );

  const tIdx = Date.now();
  const index = buildEntityIndex(entities);
  log.info(
    { repo: opts.repoRoot, elapsedMs: Date.now() - tIdx },
    'cross-file: built entity index',
  );

  // Pass 1: rewire module-stub IMPORTS to file-target IMPORTS for in-tree
  // matches. INHERITS resolution below relies on these to compute scope.
  const tPass1 = Date.now();
  const importsRewired = await rewireModuleStubImports(opts, index);
  log.info(
    { repo: opts.repoRoot, importsRewired, elapsedMs: Date.now() - tPass1 },
    'cross-file Pass 1 (IMPORTS rewire) complete',
  );

  // Pass 2: walk UnresolvedRelation rows for INHERITS / IMPLEMENTS / CALLS.
  const tList = Date.now();
  const unresolved = await listUnresolvedRelations(
    opts.db, opts.repoRoot, opts.scopeFile,
  );
  log.info(
    { repo: opts.repoRoot, rows: unresolved.length, elapsedMs: Date.now() - tList },
    'cross-file Pass 2 (relation resolution) starting',
  );
  const tPass2 = Date.now();

  // Pass 2 intents are accumulated and batch-flushed at the end (one
  // UNWIND per chunk, one fsync per chunk, vs the pre-fix one fsync per
  // row). Holds at most a few KB per intent; bounded by total unresolved
  // row count.
  const promotes: { unresolved: UnresolvedRelation; targetEntityId: string }[] = [];
  const ambiguousUpdates: { id: string; meta: Record<string, unknown> }[] = [];

  let resolved        = 0;
  let ambiguous       = 0;
  let stillUnresolved = 0;
  let processed       = 0;
  for (const row of unresolved) {
    let intent: ResolveIntent;
    if (row.kind === 'INHERITS' || row.kind === 'IMPLEMENTS') {
      intent = await resolveInheritance(opts, row, index);
    } else if (row.kind === 'CALLS') {
      intent = await resolveCall(opts, row, index);
    } else {
      // Everything else stays unresolved.
      processed++;
      continue;
    }
    if (intent.kind === 'resolved') {
      promotes.push({ unresolved: row, targetEntityId: intent.targetId });
      resolved++;
    } else if (intent.kind === 'ambiguous') {
      ambiguousUpdates.push({ id: row.id, meta: intent.meta });
      ambiguous++;
    } else {
      stillUnresolved++;
    }
    processed++;
    // Log every 100 rows (or every 25 once a row count is known to be
    // small) so a stall here is visible from the outside without
    // re-instrumenting per debugging trip.
    if (processed % 100 === 0) {
      log.info(
        { repo: opts.repoRoot, processed, total: unresolved.length, resolved, ambiguous },
        'cross-file Pass 2 progress',
      );
    }
  }

  // Batch-flush. promoteResolvedBatch handles per-kind UNWIND grouping
  // + the final UnresolvedRelation DETACH DELETE; updateUnresolvedMetaBatch
  // UNWINDs the meta SET. Both chunk at KUZU_BATCH internally.
  if (promotes.length > 0 || ambiguousUpdates.length > 0) {
    log.info(
      { repo: opts.repoRoot, promotes: promotes.length, ambiguousUpdates: ambiguousUpdates.length },
      'cross-file Pass 2 batch-flushing writes',
    );
    const tPromote = Date.now();
    await promoteResolvedBatch(opts.db, promotes);
    log.info(
      { repo: opts.repoRoot, count: promotes.length, elapsedMs: Date.now() - tPromote },
      'cross-file Pass 2: promoted batch flushed',
    );
    const tAmb = Date.now();
    await updateUnresolvedMetaBatch(opts.db, ambiguousUpdates);
    log.info(
      { repo: opts.repoRoot, count: ambiguousUpdates.length, elapsedMs: Date.now() - tAmb },
      'cross-file Pass 2: ambiguous-meta batch flushed',
    );
  }

  const elapsedMs = Date.now() - t0;
  log.info(
    {
      repo: opts.repoRoot,
      importsRewired, resolved, ambiguous, stillUnresolved,
      pass2ElapsedMs: Date.now() - tPass2,
      elapsedMs,
    },
    'cross-file resolver pass complete',
  );
  return { importsRewired, resolved, ambiguous, stillUnresolved, elapsedMs };
}

// ---------------------------------------------------------------------------
// Entity index -- in-memory lookup tables built once per pass
// ---------------------------------------------------------------------------

interface EntityIndex {
  /** key: `<lang>:<kind>:<name>` -> entities matching that triple */
  readonly byNameKindLang: Map<string, Entity[]>;
  /** key: file path -> entities defined in that file */
  readonly byFile:         Map<string, Entity[]>;
  /** key: file path -> the file entity itself */
  readonly fileEntities:   Map<string, Entity>;
  /** all module-stub entities, keyed by entity id */
  readonly modules:        Map<string, Entity>;
  /** O(1) entity-id -> entity lookup. Used by find*ById helpers that
   *  used to do an O(N) linear scan -- pre-fix Pass 2 was hitting these
   *  per-row, blowing up to O(N*rows) just for in-memory lookups. */
  readonly byId:           Map<string, Entity>;
  /** O(1) file-entity-id -> path lookup. Replaces another linear scan
   *  in findFilePathByEntityId / getResolvedImportTargets. */
  readonly fileIdToPath:   Map<string, string>;
  /** Per-pass memoization cache for getResolvedImportTargets keyed by
   *  the from-entity id. Pass-2 rows from the same function/file share
   *  imports; without memoization each row re-issues an identical Kuzu
   *  MATCH and two O(N) scans. Built lazily; one bucket per unique
   *  from-entity. */
  readonly importTargetsCache: Map<string, Set<string>>;
}

function buildEntityIndex(entities: readonly Entity[]): EntityIndex {
  const byNameKindLang = new Map<string, Entity[]>();
  const byFile         = new Map<string, Entity[]>();
  const fileEntities   = new Map<string, Entity>();
  const modules        = new Map<string, Entity>();
  const byId           = new Map<string, Entity>();
  const fileIdToPath   = new Map<string, string>();

  for (const e of entities) {
    byId.set(e.id, e);
    if (e.kind === 'file') {
      fileEntities.set(e.file, e);
      fileIdToPath.set(e.id, e.file);
      continue;
    }
    if (e.kind === 'module') {
      modules.set(e.id, e);
      continue;
    }
    const key = entityKey(e.language, e.kind, e.name);
    let arr = byNameKindLang.get(key);
    if (arr === undefined) { arr = []; byNameKindLang.set(key, arr); }
    arr.push(e);

    let fileArr = byFile.get(e.file);
    if (fileArr === undefined) { fileArr = []; byFile.set(e.file, fileArr); }
    fileArr.push(e);
  }

  return {
    byNameKindLang, byFile, fileEntities, modules,
    byId, fileIdToPath,
    importTargetsCache: new Map(),
  };
}

function entityKey(lang: Language, kind: EntityKind, name: string): string {
  return `${lang}:${kind}:${name}`;
}

// ---------------------------------------------------------------------------
// Pass 1 -- module-stub IMPORTS rewiring
// ---------------------------------------------------------------------------

/**
 * Walk every `(file)-[r:IMPORTS]->(module-stub)` edge. When the module
 * name maps to an in-tree file (via the per-language source-root rules),
 * delete the stub edge and replace it with one targeting the file
 * entity. External-dep stubs (no in-tree match) stay untouched.
 */
async function rewireModuleStubImports(
  opts:  CrossFileResolveOpts,
  index: EntityIndex,
): Promise<number> {
  // -- Step 1: opening MATCH (one full IMPORTS-rel scan, property-filtered) --
  const tMatch = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stmt = `MATCH (f:Entity)-[r:IMPORTS]->(m:Entity)
                WHERE m.kind = 'module'
                RETURN f.id AS fromId, m.id AS moduleId`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await execGraph<any>(opts.db, stmt);
  log.info(
    { repo: opts.repoRoot, rows: rows.length, elapsedMs: Date.now() - tMatch },
    'cross-file Pass 1: opening MATCH done',
  );

  // -- Step 2: in-memory grouping by from-file --
  // Resolve every row and group by from-file. The Kuzu writes happen in
  // a separate pass below so we can batch the DELETEs (one query per
  // from-file instead of one per edge).
  const tGroup = Date.now();
  interface Rewire { readonly oldModuleId: string; readonly targetEntityId: string }
  const groups = new Map<string, Rewire[]>();

  for (const row of rows) {
    const fromId   = row['fromId']   as string;
    const moduleId = row['moduleId'] as string;
    // Module stubs are repo-agnostic (created with `repo: ''`) so they
    // don't show up in listEntitiesForRepo. Pull the full entity by id.
    let moduleEntity = index.modules.get(moduleId);
    if (moduleEntity === undefined) {
      const fetched = await getEntity(opts.db, moduleId);
      if (fetched === null || fetched.kind !== 'module') continue;
      moduleEntity = fetched;
    }

    // The from-side of an IMPORTS edge is always a file entity.
    const fromFile = findFilePathByEntityId(fromId, index);
    if (fromFile === null) continue;

    const targetFile = locateInTreeFile(
      moduleEntity.name, moduleEntity.language, opts.sourceRoots,
    );
    if (targetFile === null) continue;
    const targetEntity = index.fileEntities.get(targetFile);
    if (targetEntity === undefined) continue;

    let bucket = groups.get(fromId);
    if (bucket === undefined) { bucket = []; groups.set(fromId, bucket); }
    bucket.push({ oldModuleId: moduleId, targetEntityId: targetEntity.id });
  }
  log.info(
    { repo: opts.repoRoot, groups: groups.size, elapsedMs: Date.now() - tGroup },
    'cross-file Pass 1: in-memory grouping done',
  );

  // -- Step 3: DELETE phase (one query per from-file) --
  // Batched DELETE: one round-trip per from-file regardless of how many
  // module-stub IMPORTS that file has. Pattern matches eeae2ef7ac7's
  // `WHERE n.id IN $ids` approach.
  const tDelete = Date.now();
  for (const [fromId, rewires] of groups) {
    const moduleIds = rewires.map(r => r.oldModuleId);
    await execGraph(opts.db,
      `MATCH (f:Entity {id: $from})-[r:IMPORTS]->(m:Entity)
       WHERE m.id IN $modules
       DELETE r`,
      { from: fromId, modules: moduleIds },
    );
  }
  log.info(
    { repo: opts.repoRoot, queries: groups.size, elapsedMs: Date.now() - tDelete },
    'cross-file Pass 1: DELETE phase done',
  );

  // -- Step 4: MERGE phase (UNWIND batches of KUZU_BATCH) --
  // Collapse the per-edge MERGEs into UNWIND batches of KUZU_BATCH (500).
  // One Cypher statement per chunk -> one auto-commit transaction ->
  // one fsync at the disk. Pre-fix this was N sequential MERGEs each
  // paying ~11 ms fsync wait on the local NVMe, which alone gated
  // Pass 1 to ~90 edges/sec (confirmed via iostat).
  const tMerge = Date.now();
  const allPairs: { from: string; target: string }[] = [];
  let rewired = 0;
  for (const [fromId, rewires] of groups) {
    for (const r of rewires) {
      allPairs.push({ from: fromId, target: r.targetEntityId });
      rewired++;
    }
  }
  const batches = Math.ceil(allPairs.length / KUZU_BATCH);
  for (let i = 0; i < allPairs.length; i += KUZU_BATCH) {
    const chunk = allPairs.slice(i, i + KUZU_BATCH);
    await execGraph(opts.db,
      `UNWIND $pairs AS p
       MATCH (f:Entity {id: p.from}), (t:Entity {id: p.target})
       MERGE (f)-[:IMPORTS]->(t)`,
      { pairs: chunk },
    );
  }
  log.info(
    { repo: opts.repoRoot, pairs: allPairs.length, batches, elapsedMs: Date.now() - tMerge },
    'cross-file Pass 1: MERGE phase done',
  );

  return rewired;
}

/**
 * Chunk size for UNWIND-batched writes against Kuzu. Matches
 * eeae2ef7ac7's choice for batched DETACH DELETE: large enough to amortise
 * the fsync-per-statement cost (each chunk = one auto-commit txn = one
 * fsync), small enough to bound prepared-statement parameter memory.
 */
const KUZU_BATCH = 500;

function findFilePathByEntityId(id: string, index: EntityIndex): string | null {
  return index.fileIdToPath.get(id) ?? null;
}

/**
 * Map a module name (e.g. `com.example.Foo`, `foo.bar.baz`,
 * `github.com/repo/pkg`, `@/lib/x`) to an in-tree file path using the
 * per-language source-root rules. Returns null when no in-tree file
 * matches (i.e. an external dep).
 */
function locateInTreeFile(
  moduleName: string,
  language:   Language,
  sourceRoots: SourceRoots,
): string | null {
  switch (language) {
    case 'java':   return locateJvm(moduleName, sourceRoots.java,  '.java');
    case 'scala':  return locateJvm(moduleName, sourceRoots.scala, '.scala');
    case 'python': return locatePython(moduleName, sourceRoots.python);
    case 'go':     return locateGo(moduleName, sourceRoots.go);
    case 'typescript':
    case 'javascript':
      return locateTs(moduleName, language === 'typescript' ? sourceRoots.typescript : sourceRoots.javascript);
    default:       return null;
  }
}

/**
 * Java/Scala: a dotted name like `com.example.Foo` maps to
 * `<root>/com/example/Foo.<ext>` under any source root.
 */
function locateJvm(
  moduleName: string,
  roots:      readonly string[],
  ext:        '.java' | '.scala',
): string | null {
  const parts = moduleName.split('.');
  if (parts.length < 2) return null;
  const relPath = parts.join(sep) + ext;
  for (const root of roots) {
    const candidate = join(root, relPath);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Python: `foo.bar.baz` -> `<root>/foo/bar/baz.py` or
 * `<root>/foo/bar/baz/__init__.py`.
 */
function locatePython(
  moduleName: string,
  roots:      readonly string[],
): string | null {
  const parts = moduleName.split('.').filter(p => p !== '');
  if (parts.length === 0) return null;
  const relStem = parts.join(sep);
  for (const root of roots) {
    const direct = join(root, relStem + '.py');
    if (existsSync(direct)) return direct;
    const pkgInit = join(root, relStem, '__init__.py');
    if (existsSync(pkgInit)) return pkgInit;
  }
  return null;
}

/**
 * Go: import paths are full URLs (`github.com/foo/bar/pkg`). Strip
 * the module prefix from go.mod and check `<repoRoot>/<remainder>`
 * for any .go file.
 */
function locateGo(
  importPath: string,
  go:         SourceRoots['go'],
): string | null {
  if (go === null) return null;
  const prefix = go.modulePath + '/';
  if (!importPath.startsWith(prefix) && importPath !== go.modulePath) return null;
  const rel = importPath === go.modulePath ? '' : importPath.slice(prefix.length);
  const dir = rel === '' ? go.repoRoot : join(go.repoRoot, rel);
  if (!existsSync(dir)) return null;
  // Pick the first .go file in the package directory; the parser
  // creates one file entity per file, so any of them serves as a
  // representative target. Prefer non-test files when both exist.
  let entries: string[];
  try {
    if (!statSync(dir).isDirectory()) return dir.endsWith('.go') ? dir : null;
    entries = readdirSync(dir);
  } catch { return null; }
  const goFiles = entries.filter(n => n.endsWith('.go') && !n.endsWith('_test.go'));
  if (goFiles.length === 0) return null;
  return join(dir, goFiles[0]!);
}

/**
 * TS / JS: rewrite `paths` mappings (e.g. `@/foo` -> `./foo`), then
 * probe under baseUrl with the standard extension candidates.
 */
function locateTs(
  specifier: string,
  ts:        SourceRoots['typescript'],
): string | null {
  if (ts === null) return null;
  const candidates = expandTsPaths(specifier, ts);
  const exts = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
  for (const c of candidates) {
    for (const ext of exts) {
      const probe = join(ts.baseUrl, c + (ext.startsWith('/') ? ext : ext));
      if (existsSync(probe)) return probe;
    }
  }
  return null;
}

function expandTsPaths(specifier: string, ts: NonNullable<SourceRoots['typescript']>): readonly string[] {
  const out: string[] = [specifier];
  for (const [pattern, targets] of ts.paths) {
    const star = pattern.indexOf('*');
    if (star === -1) {
      if (pattern === specifier) out.push(...targets);
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (specifier.startsWith(prefix) && specifier.endsWith(suffix) && specifier.length >= prefix.length + suffix.length) {
      const captured = specifier.slice(prefix.length, specifier.length - suffix.length);
      for (const t of targets) {
        out.push(t.replace('*', captured));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pass 2 -- INHERITS / IMPLEMENTS / CALLS resolution
//
// resolveInheritance / resolveCall do all the in-memory matching but do
// NOT issue Kuzu writes themselves; they return a ResolveIntent that the
// outer loop accumulates and flushes via promoteResolvedBatch /
// updateUnresolvedMetaBatch at the end of Pass 2. This collapses what
// used to be 1-2 fsync-bound writes per row into a handful of UNWIND
// statements -- the iostat investigation showed the per-row writes were
// the dominant cost (~95% disk util at ~11 ms fsync each, capping the
// resolver at ~90 writes/sec).
// ---------------------------------------------------------------------------

type ResolveIntent =
  | { readonly kind: 'resolved';   readonly targetId: string }
  | { readonly kind: 'ambiguous';  readonly meta: Record<string, unknown> }
  | { readonly kind: 'unresolved' };

const UNRESOLVED: ResolveIntent = { kind: 'unresolved' };

/**
 * Resolve an INHERITS / IMPLEMENTS row against the entity index.
 * Strategy:
 *   1. Same-file match wins outright (`class Foo extends Bar` where Bar
 *      lives in the same file -> resolve to that Bar).
 *   2. Walk imported files (after Pass 1's rewire) + collect entities
 *      with matching name/kind/lang.
 *   3. Single match -> resolve. Multiple -> ambiguous + record
 *      candidates. None -> stay unresolved.
 */
async function resolveInheritance(
  opts:  CrossFileResolveOpts,
  row:   UnresolvedRelation,
  index: EntityIndex,
): Promise<ResolveIntent> {
  const fromEntities = index.byFile.get(row.fromFile) ?? [];
  // The parser stores INHERITS edges with `from` = the inheriting class
  // entity id. Pull its language from the index.
  const fromEntity = fromEntities.find(e => e.id === row.fromEntity)
    ?? findEntityByIdAcrossIndex(index, row.fromEntity);
  if (fromEntity === undefined) {
    // Stale row; from-side was deleted but UnresolvedRelation row wasn't
    // cleaned. The Phase 5 invalidation hooks will catch this.
    return UNRESOLVED;
  }

  const language = fromEntity.language;
  const targetKinds: EntityKind[] = row.kind === 'INHERITS'
    ? ['class', 'interface']  // a class can extend either a class or an interface (Java/Scala mixin)
    : ['interface', 'class']; // IMPLEMENTS prefers interface but Scala traits may surface as 'class'

  // 1. Same-file
  for (const kind of targetKinds) {
    const sameFile = (index.byFile.get(row.fromFile) ?? [])
      .filter(e => e.language === language && e.kind === kind && e.name === row.rawTo);
    if (sameFile.length === 1) {
      return { kind: 'resolved', targetId: sameFile[0]!.id };
    }
    if (sameFile.length > 1) {
      return { kind: 'ambiguous', meta: { ...row.meta, candidates: sameFile.map(e => e.id) } };
    }
  }

  // 2. Cross-file -- walk imported files
  const importedFiles = await getResolvedImportTargets(opts.db, row.fromEntity, index);
  const candidates: Entity[] = [];
  for (const kind of targetKinds) {
    const all = index.byNameKindLang.get(entityKey(language, kind, row.rawTo)) ?? [];
    for (const e of all) {
      if (importedFiles.has(e.file) || isExportedFromSamePackage(fromEntity, e, opts.sourceRoots)) {
        candidates.push(e);
      }
    }
    if (candidates.length > 0) break;
  }

  if (candidates.length === 1) {
    return { kind: 'resolved', targetId: candidates[0]!.id };
  }
  if (candidates.length > 1) {
    return { kind: 'ambiguous', meta: { ...row.meta, candidates: candidates.map(e => e.id) } };
  }
  return UNRESOLVED;
}

// ---------------------------------------------------------------------------
// CALLS resolution -- the noisiest kind. The parser emits one row per
// invocation that didn't resolve to an in-file entity; this pass tries
// to match each call against the in-scope set built from the from-file
// (its own entities + exported entities from each imported file).
// ---------------------------------------------------------------------------

const CALL_TARGET_KINDS: readonly EntityKind[] = ['function', 'method', 'class'];

async function resolveCall(
  opts:  CrossFileResolveOpts,
  row:   UnresolvedRelation,
  index: EntityIndex,
): Promise<ResolveIntent> {
  const fromEntity = (index.byFile.get(row.fromFile) ?? []).find(e => e.id === row.fromEntity)
    ?? findEntityByIdAcrossIndex(index, row.fromEntity);
  if (fromEntity === undefined) return UNRESOLVED;
  const language = fromEntity.language;

  // 1. Same-file: function / method / class with matching name.
  const sameFile = (index.byFile.get(row.fromFile) ?? [])
    .filter(e => e.language === language
              && CALL_TARGET_KINDS.includes(e.kind)
              && e.name === row.rawTo
              && e.id !== row.fromEntity);
  if (sameFile.length === 1) {
    return { kind: 'resolved', targetId: sameFile[0]!.id };
  }
  if (sameFile.length > 1) {
    return { kind: 'ambiguous', meta: { ...row.meta, candidates: sameFile.map(e => e.id) } };
  }

  // 2. Cross-file: walk imported files (after Phase 3's rewire) and
  //    consider only exported targets.
  const importedFiles = await getResolvedImportTargets(opts.db, row.fromEntity, index);
  if (importedFiles.size === 0) return UNRESOLVED;

  const candidates: Entity[] = [];
  for (const kind of CALL_TARGET_KINDS) {
    const all = index.byNameKindLang.get(entityKey(language, kind, row.rawTo)) ?? [];
    for (const e of all) {
      if (!importedFiles.has(e.file)) continue;
      if (e.isExported !== true) continue;
      candidates.push(e);
    }
  }

  if (candidates.length === 1) {
    return { kind: 'resolved', targetId: candidates[0]!.id };
  }
  if (candidates.length > 1) {
    return { kind: 'ambiguous', meta: { ...row.meta, candidates: candidates.map(e => e.id) } };
  }
  return UNRESOLVED;
}

function findEntityByIdAcrossIndex(index: EntityIndex, id: string): Entity | undefined {
  return index.byId.get(id);
}

/**
 * Walk the IMPORTS edges originating from `fromEntityId`'s file (after
 * Pass 1's rewire). Returns the set of in-tree file paths reachable via
 * IMPORTS -- module-stub edges are filtered out.
 */
async function getResolvedImportTargets(
  db:    DbClient,
  fromEntityId: string,
  index: EntityIndex,
): Promise<Set<string>> {
  // Memo: pre-fix Pass 2 hammered this function once per row, even when
  // many rows shared the same from-entity (e.g. a function with 20
  // unresolved CALLs => 20 identical Kuzu queries). The cache is keyed
  // by from-entity id and lives for the lifetime of one resolver pass.
  const cached = index.importTargetsCache.get(fromEntityId);
  if (cached !== undefined) return cached;

  // The from-side of the IMPORTS edge is the file entity, not the
  // inheriting class. Resolve the from-entity to its file via the
  // O(1) byId map, then look up the file entity that owns it.
  const fromEntity = index.byId.get(fromEntityId);
  const fromFile = fromEntity !== undefined ? fromEntity.file : null;
  const fileEntity = fromFile !== null ? index.fileEntities.get(fromFile) : undefined;
  if (fileEntity === undefined) {
    const empty = new Set<string>();
    index.importTargetsCache.set(fromEntityId, empty);
    return empty;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await execGraph<any>(db,
    `MATCH (f:Entity {id: $from})-[:IMPORTS]->(t:Entity)
     WHERE t.kind = 'file'
     RETURN t.id AS fileId`,
    { from: fileEntity.id },
  );
  const out = new Set<string>();
  for (const row of rows) {
    const id = row['fileId'] as string;
    // O(1) via fileIdToPath; replaces the prior linear scan over
    // index.fileEntities entries.
    const path = index.fileIdToPath.get(id);
    if (path !== undefined) out.add(path);
  }
  index.importTargetsCache.set(fromEntityId, out);
  return out;
}

/**
 * Same-package visibility for Java / Scala: when both files live under
 * the same source-root subtree at the same package depth, the class is
 * implicitly visible without an explicit import.
 */
function isExportedFromSamePackage(
  fromEntity:  Entity,
  candidate:   Entity,
  sourceRoots: SourceRoots,
): boolean {
  if (fromEntity.language !== candidate.language) return false;
  if (fromEntity.language !== 'java' && fromEntity.language !== 'scala') return false;
  const roots = fromEntity.language === 'java' ? sourceRoots.java : sourceRoots.scala;
  for (const root of roots) {
    const fromUnder = fromEntity.file.startsWith(root + sep);
    const candUnder = candidate.file.startsWith(root + sep);
    if (!fromUnder || !candUnder) continue;
    const fromPkg = packageOf(fromEntity.file, root);
    const candPkg = packageOf(candidate.file, root);
    if (fromPkg === candPkg) return true;
  }
  return false;
}

function packageOf(filePath: string, root: string): string {
  const rel = filePath.slice(root.length + 1);  // strip "<root>/"
  const lastSep = rel.lastIndexOf(sep);
  if (lastSep === -1) return '';
  return rel.slice(0, lastSep).split(sep).join('.');
}

// ---------------------------------------------------------------------------
// Kuzu helper -- prepare + execute + return rows
// ---------------------------------------------------------------------------

async function execGraph<T = Record<string, unknown>>(
  db:    DbClient,
  stmt:  string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any = {},
): Promise<T[]> {
  const prepared = await db.graph.prepare(stmt);
  const result   = await db.graph.execute(prepared, params);
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const qr = Array.isArray(result) ? result[0]! : result;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (qr as any).getAll() as Promise<T[]>;
}
