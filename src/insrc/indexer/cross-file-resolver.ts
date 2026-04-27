/**
 * Cross-file resolver pass -- the second pass over the graph.
 * See plans/cross-file-references.md §3-§5.
 *
 * Runs after the per-file index settles. Two responsibilities:
 *
 *   Pass 1 (rewireModuleStubImports):
 *     For every file in the active repo with an IMPORTS edge to a
 *     module-stub entity, try to resolve the module name to an in-tree
 *     file via per-language path rules. If it resolves, replace the
 *     stub edge with a (file)-[:IMPORTS]->(target-file) edge. External-
 *     dep stubs (no in-tree match) stay untouched.
 *
 *   Pass 2 (resolveRelations):
 *     Walk UnresolvedRelation rows for the active repo (CALLS,
 *     INHERITS, IMPLEMENTS). Resolve via:
 *       - same-file candidates (best match)
 *       - cross-file candidates filtered by Pass 1's rewired imports
 *       - same-package visibility for Java/Scala
 *     Resolved rows become typed REL edges; ambiguous rows record
 *     `meta.candidates`; no-match stays unresolved.
 *
 * Architectural notes (post-rewrite, per
 * plans/analyzers/code-analyzer.md F7 + the validation perf trip):
 *
 *  - Every Kuzu MATCH is repo-scoped (`f.repo = $repo`). Multi-repo
 *    workspaces no longer pay for the union of all repos' edges per
 *    pass.
 *  - Pass 1's opening MATCH JOINs the module name + language so we
 *    don't need a per-row getEntity fallback.
 *  - Pass 2 prefetches all (fromFile -> imported file paths) upfront
 *    into an in-memory map. Per-row resolveCall / resolveInheritance
 *    are pure-sync; no Kuzu calls inside the loop.
 *  - Writes go through UNWIND batches of KUZU_BATCH (=500), one
 *    auto-commit txn (= one fsync) per chunk.
 *  - Helpers in db/relations.ts (promoteResolvedBatch +
 *    updateUnresolvedMetaBatch) flush the accumulated Pass 2 intents.
 *
 * The pre-rewrite version had ~7 in-memory maps + per-row Kuzu
 * fallbacks + memoized read queries. This version drops to 4 maps +
 * 0 in-loop Kuzu calls + a constant number of upfront prefetches.
 */

import { existsSync, statSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { getLogger } from '../shared/logger.js';
import type { DbClient } from '../db/client.js';
import type { Entity, EntityKind, Language } from '../shared/types.js';
import { listEntitiesForRepo, getEntitiesByIds } from '../db/entities.js';
import {
  listUnresolvedRelations,
  promoteResolvedBatch,
  updateUnresolvedMetaBatch,
  type UnresolvedRelation,
} from '../db/relations.js';
import type { SourceRoots } from './source-roots.js';

const log = getLogger('cross-file-resolver');

/** UNWIND chunk size; matches eeae2ef7ac7's batched DETACH DELETE. */
const KUZU_BATCH = 500;

const CALL_TARGET_KINDS: readonly EntityKind[] = ['function', 'method', 'class'];

// ---------------------------------------------------------------------------
// Public surface (unchanged)
// ---------------------------------------------------------------------------

export interface CrossFileResolveOpts {
  readonly db:           DbClient;
  readonly repoRoot:     string;
  readonly sourceRoots:  SourceRoots;
  /** Optional: limit Pass 2 to UnresolvedRelation rows for one file. */
  readonly scopeFile?:   string | undefined;
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

  // -- Setup: load this repo's entities + build a small in-memory index --
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

  // -- Pass 1 --
  const tPass1 = Date.now();
  const importsRewired = await runPass1(opts, index);
  log.info(
    { repo: opts.repoRoot, importsRewired, elapsedMs: Date.now() - tPass1 },
    'cross-file Pass 1 (IMPORTS rewire) complete',
  );

  // -- Pass 2 --
  const tPass2 = Date.now();
  const { resolved, ambiguous, stillUnresolved } = await runPass2(opts, index);
  const pass2ElapsedMs = Date.now() - tPass2;

  const elapsedMs = Date.now() - t0;
  log.info(
    { repo: opts.repoRoot, importsRewired, resolved, ambiguous, stillUnresolved, pass2ElapsedMs, elapsedMs },
    'cross-file resolver pass complete',
  );
  return { importsRewired, resolved, ambiguous, stillUnresolved, elapsedMs };
}

// ---------------------------------------------------------------------------
// Pass 1: rewire module-stub IMPORTS to file-target IMPORTS
// ---------------------------------------------------------------------------

interface Rewire {
  readonly fromId:        string;
  readonly oldModuleId:   string;
  readonly targetFileId:  string;
}

async function runPass1(
  opts:  CrossFileResolveOpts,
  index: EntityIndex,
): Promise<number> {
  // Step 1 -- opening MATCH. Kuzu's Entity table is stub-only
  // (`Entity(id STRING, kind STRING)` per db/schema.ts:10). Full entity
  // data (name, language, repo, file) lives in LanceDB. So this MATCH
  // returns just f.id + m.id; repo scoping happens in-memory below
  // against the LanceDB-loaded `index.byId`, and module name/language
  // come from a batched LanceDB prefetch.
  const tMatch = Date.now();
  const stmt = `MATCH (f:Entity)-[r:IMPORTS]->(m:Entity)
                WHERE m.kind = 'module'
                RETURN f.id AS fromId, m.id AS moduleId`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await execGraph<any>(opts.db, stmt);
  log.info(
    { repo: opts.repoRoot, rows: rows.length, elapsedMs: Date.now() - tMatch },
    'cross-file Pass 1: opening MATCH done',
  );
  if (rows.length === 0) return 0;

  // Step 2 -- in-memory repo filter + collect unique moduleIds.
  // Cypher can't filter by f.repo since `repo` isn't on the Kuzu
  // Entity stub; index.byId was built from listEntitiesForRepo(repo)
  // and contains only this repo's entities, so .has(fromId) is the
  // valid scope check. uniqueModuleIds drives the LanceDB prefetch
  // and dedupes the (typically ~200-500 unique modules across thousands
  // of edges).
  const tFilter = Date.now();
  const scopedRows: { fromId: string; moduleId: string }[] = [];
  const uniqueModuleIds = new Set<string>();
  for (const row of rows) {
    const fromId   = row['fromId']   as string;
    const moduleId = row['moduleId'] as string;
    if (!index.byId.has(fromId)) continue;  // not in this repo
    scopedRows.push({ fromId, moduleId });
    uniqueModuleIds.add(moduleId);
  }
  log.info(
    {
      repo: opts.repoRoot,
      scopedRows: scopedRows.length,
      uniqueModules: uniqueModuleIds.size,
      elapsedMs: Date.now() - tFilter,
    },
    'cross-file Pass 1: repo-scope filter + dedup done',
  );
  if (scopedRows.length === 0) return 0;

  // Step 3 -- batched LanceDB prefetch for module name + language.
  // Module-stub entities are created with repo='' so they don't
  // appear in listEntitiesForRepo(repo); fetch only the unique set
  // we actually need (1-2 chunks of 500 for typical repos).
  const tPrefetch = Date.now();
  const moduleEntities = await getEntitiesByIds(opts.db, [...uniqueModuleIds]);
  const modulesById = new Map<string, Entity>();
  for (const m of moduleEntities) {
    if (m.kind === 'module') modulesById.set(m.id, m);
  }
  log.info(
    {
      repo: opts.repoRoot,
      requested: uniqueModuleIds.size,
      fetched: modulesById.size,
      elapsedMs: Date.now() - tPrefetch,
    },
    'cross-file Pass 1: prefetched module entities (LanceDB)',
  );

  // Step 4 -- in-memory resolve. No Kuzu calls in this loop.
  const tResolve = Date.now();
  const rewires: Rewire[] = [];
  for (const row of scopedRows) {
    const module = modulesById.get(row.moduleId);
    if (module === undefined) continue;  // shouldn't happen post-prefetch

    const targetPath = locateInTreeFile(module.name, module.language, opts.sourceRoots);
    if (targetPath === null) continue;
    const targetEntity = index.fileEntities.get(targetPath);
    if (targetEntity === undefined) continue;

    rewires.push({ fromId: row.fromId, oldModuleId: row.moduleId, targetFileId: targetEntity.id });
  }
  log.info(
    { repo: opts.repoRoot, rewires: rewires.length, elapsedMs: Date.now() - tResolve },
    'cross-file Pass 1: in-memory resolve done',
  );
  if (rewires.length === 0) return 0;

  // Step 3 -- batched DELETE via UNWIND. One auto-commit txn per chunk.
  const tDelete = Date.now();
  for (let i = 0; i < rewires.length; i += KUZU_BATCH) {
    const chunk = rewires.slice(i, i + KUZU_BATCH);
    await execGraph(opts.db,
      `UNWIND $rewires AS r
       MATCH (f:Entity {id: r.fromId})-[e:IMPORTS]->(m:Entity {id: r.oldModuleId})
       DELETE e`,
      { rewires: chunk },
    );
  }
  log.info(
    {
      repo: opts.repoRoot,
      batches: Math.ceil(rewires.length / KUZU_BATCH),
      elapsedMs: Date.now() - tDelete,
    },
    'cross-file Pass 1: DELETE complete',
  );

  // Step 4 -- batched MERGE via UNWIND. Idempotent: re-runs are safe.
  const tMerge = Date.now();
  for (let i = 0; i < rewires.length; i += KUZU_BATCH) {
    const chunk = rewires.slice(i, i + KUZU_BATCH);
    await execGraph(opts.db,
      `UNWIND $rewires AS r
       MATCH (f:Entity {id: r.fromId}), (t:Entity {id: r.targetFileId})
       MERGE (f)-[:IMPORTS]->(t)`,
      { rewires: chunk },
    );
  }
  log.info(
    {
      repo: opts.repoRoot,
      batches: Math.ceil(rewires.length / KUZU_BATCH),
      elapsedMs: Date.now() - tMerge,
    },
    'cross-file Pass 1: MERGE complete',
  );

  return rewires.length;
}

// ---------------------------------------------------------------------------
// Pass 2: resolve INHERITS / IMPLEMENTS / CALLS rows
// ---------------------------------------------------------------------------

type ResolveIntent =
  | { readonly kind: 'resolved';   readonly targetId: string }
  | { readonly kind: 'ambiguous';  readonly meta: Record<string, unknown> }
  | { readonly kind: 'unresolved' };

const UNRESOLVED: ResolveIntent = { kind: 'unresolved' };

async function runPass2(
  opts:  CrossFileResolveOpts,
  index: EntityIndex,
): Promise<{ resolved: number; ambiguous: number; stillUnresolved: number }> {
  // Step 1 -- prefetch UnresolvedRelation rows + the file->file IMPORTS
  // map (one Kuzu read each; per-row helpers below are pure-sync).
  const tList = Date.now();
  const unresolved = await listUnresolvedRelations(opts.db, opts.repoRoot, opts.scopeFile);
  log.info(
    { repo: opts.repoRoot, rows: unresolved.length, elapsedMs: Date.now() - tList },
    'cross-file Pass 2: listUnresolvedRelations done',
  );

  const tImports = Date.now();
  const importsByFile = await prefetchImportsByFile(opts.db, index);
  log.info(
    { repo: opts.repoRoot, files: importsByFile.size, elapsedMs: Date.now() - tImports },
    'cross-file Pass 2: prefetched file->file imports',
  );

  // Step 2 -- in-memory loop over unresolved rows. Accumulate intents.
  const promotes:         { unresolved: UnresolvedRelation; targetEntityId: string }[] = [];
  const ambiguousUpdates: { id: string; meta: Record<string, unknown> }[]              = [];

  let resolved        = 0;
  let ambiguous       = 0;
  let stillUnresolved = 0;
  let processed       = 0;
  for (const row of unresolved) {
    let intent: ResolveIntent;
    if (row.kind === 'INHERITS' || row.kind === 'IMPLEMENTS') {
      intent = resolveInheritance(opts, row, index, importsByFile);
    } else if (row.kind === 'CALLS') {
      intent = resolveCall(opts, row, index, importsByFile);
    } else {
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
    if (processed % 100 === 0) {
      log.info(
        { repo: opts.repoRoot, processed, total: unresolved.length, resolved, ambiguous },
        'cross-file Pass 2 progress',
      );
    }
  }

  // Step 3 -- batched flush.
  if (promotes.length > 0) {
    const t = Date.now();
    await promoteResolvedBatch(opts.db, promotes);
    log.info(
      { repo: opts.repoRoot, count: promotes.length, elapsedMs: Date.now() - t },
      'cross-file Pass 2: promoted batch flushed',
    );
  }
  if (ambiguousUpdates.length > 0) {
    const t = Date.now();
    await updateUnresolvedMetaBatch(opts.db, ambiguousUpdates);
    log.info(
      { repo: opts.repoRoot, count: ambiguousUpdates.length, elapsedMs: Date.now() - t },
      'cross-file Pass 2: ambiguous-meta batch flushed',
    );
  }

  return { resolved, ambiguous, stillUnresolved };
}

/**
 * MATCH every (fromFile, importedFile) edge post-Pass-1, then build an
 * in-memory Map<fromFileEntityId, Set<importedFilePath>> so per-row
 * Pass 2 helpers can do O(1) lookups instead of issuing a Kuzu query
 * per from-entity.
 *
 * Repo scoping is in-memory (Kuzu's Entity table is stub-only; `f.repo`
 * isn't a property). Target paths come from `index.byId` -- the
 * Kuzu MATCH only returns ids; we resolve to file paths via the
 * LanceDB-loaded entity index.
 */
async function prefetchImportsByFile(
  db:    DbClient,
  index: EntityIndex,
): Promise<Map<string, Set<string>>> {
  const stmt = `MATCH (f:Entity)-[:IMPORTS]->(t:Entity)
                WHERE t.kind = 'file'
                RETURN f.id AS fromFileId, t.id AS targetFileId`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await execGraph<any>(db, stmt);

  const map = new Map<string, Set<string>>();
  for (const row of rows) {
    const fromFileId   = row['fromFileId']   as string;
    const targetFileId = row['targetFileId'] as string;
    // Repo scope: only keep edges from files in this repo's index.
    if (!index.byId.has(fromFileId)) continue;
    // Cross-repo targets won't be in index.byId; skip them. Pass 2
    // scope is single-repo; cross-repo CALLS / INHERITS resolution
    // is out of scope today.
    const targetEntity = index.byId.get(targetFileId);
    if (targetEntity === undefined || targetEntity.kind !== 'file') continue;

    let set = map.get(fromFileId);
    if (set === undefined) { set = new Set<string>(); map.set(fromFileId, set); }
    set.add(targetEntity.file);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Pass 2 helpers -- pure-sync, in-memory only
// ---------------------------------------------------------------------------

/**
 * Resolve an INHERITS / IMPLEMENTS row.
 * Strategy:
 *   1. Same-file match (`class Foo extends Bar` where Bar is in the
 *      same file -> resolve outright).
 *   2. Cross-file: candidates whose file is reachable via Pass 1's
 *      rewired IMPORTS edges OR is in the same Java/Scala package.
 *   3. None -> stay unresolved.
 */
function resolveInheritance(
  opts:           CrossFileResolveOpts,
  row:            UnresolvedRelation,
  index:          EntityIndex,
  importsByFile:  Map<string, Set<string>>,
): ResolveIntent {
  const fromEntity = (index.byFile.get(row.fromFile) ?? []).find(e => e.id === row.fromEntity)
    ?? index.byId.get(row.fromEntity);
  if (fromEntity === undefined) {
    // Stale row; from-side was deleted. Phase 5 invalidation hooks
    // sweep these eventually.
    return UNRESOLVED;
  }

  const language = fromEntity.language;
  const targetKinds: EntityKind[] = row.kind === 'INHERITS'
    ? ['class', 'interface']  // a class can extend either
    : ['interface', 'class']; // IMPLEMENTS prefers interface; Scala traits may surface as class

  // Same-file
  for (const kind of targetKinds) {
    const sameFile = (index.byFile.get(row.fromFile) ?? [])
      .filter(e => e.language === language && e.kind === kind && e.name === row.rawTo);
    if (sameFile.length === 1) return { kind: 'resolved', targetId: sameFile[0]!.id };
    if (sameFile.length > 1) {
      return { kind: 'ambiguous', meta: { ...row.meta, candidates: sameFile.map(e => e.id) } };
    }
  }

  // Cross-file
  const fileEntity = index.fileEntities.get(row.fromFile);
  const importedFiles = fileEntity ? (importsByFile.get(fileEntity.id) ?? new Set<string>()) : new Set<string>();

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

  if (candidates.length === 1) return { kind: 'resolved', targetId: candidates[0]!.id };
  if (candidates.length > 1) {
    return { kind: 'ambiguous', meta: { ...row.meta, candidates: candidates.map(e => e.id) } };
  }
  return UNRESOLVED;
}

/**
 * Resolve a CALLS row. The noisiest kind -- the parser emits one row
 * per invocation that didn't resolve to an in-file entity; this pass
 * matches each call against the in-scope set built from the from-file
 * (its own entities + exported entities from each imported file).
 */
function resolveCall(
  opts:           CrossFileResolveOpts,
  row:            UnresolvedRelation,
  index:          EntityIndex,
  importsByFile:  Map<string, Set<string>>,
): ResolveIntent {
  const fromEntity = (index.byFile.get(row.fromFile) ?? []).find(e => e.id === row.fromEntity)
    ?? index.byId.get(row.fromEntity);
  if (fromEntity === undefined) return UNRESOLVED;
  const language = fromEntity.language;

  // Same-file
  const sameFile = (index.byFile.get(row.fromFile) ?? [])
    .filter(e => e.language === language
              && CALL_TARGET_KINDS.includes(e.kind)
              && e.name === row.rawTo
              && e.id !== row.fromEntity);
  if (sameFile.length === 1) return { kind: 'resolved', targetId: sameFile[0]!.id };
  if (sameFile.length > 1) {
    return { kind: 'ambiguous', meta: { ...row.meta, candidates: sameFile.map(e => e.id) } };
  }

  // Cross-file
  const fileEntity = index.fileEntities.get(row.fromFile);
  const importedFiles = fileEntity ? (importsByFile.get(fileEntity.id) ?? new Set<string>()) : new Set<string>();
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

  if (candidates.length === 1) return { kind: 'resolved', targetId: candidates[0]!.id };
  if (candidates.length > 1) {
    return { kind: 'ambiguous', meta: { ...row.meta, candidates: candidates.map(e => e.id) } };
  }
  return UNRESOLVED;
}

// ---------------------------------------------------------------------------
// Same-package visibility (Java / Scala)
// ---------------------------------------------------------------------------

/**
 * When two Java/Scala files live under the same source-root subtree
 * at the same package depth, the class is implicitly visible without
 * an explicit import. The import map alone misses these.
 */
function isExportedFromSamePackage(
  fromEntity:   Entity,
  candidate:    Entity,
  sourceRoots:  SourceRoots,
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
// Module name -> in-tree file path (per language)
// ---------------------------------------------------------------------------

function locateInTreeFile(
  moduleName:   string,
  language:     Language,
  sourceRoots:  SourceRoots,
): string | null {
  switch (language) {
    case 'java':       return locateJvm(moduleName, sourceRoots.java,  '.java');
    case 'scala':      return locateJvm(moduleName, sourceRoots.scala, '.scala');
    case 'python':     return locatePython(moduleName, sourceRoots.python);
    case 'go':         return locateGo(moduleName, sourceRoots.go);
    case 'typescript':
    case 'javascript':
      return locateTs(moduleName, language === 'typescript' ? sourceRoots.typescript : sourceRoots.javascript);
    default:           return null;
  }
}

/**
 * Java/Scala: a dotted name like `com.example.Foo` maps to
 * `<root>/com/example/Foo.<ext>` under any source root.
 */
function locateJvm(
  moduleName:  string,
  roots:       readonly string[],
  ext:         '.java' | '.scala',
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
  moduleName:  string,
  roots:       readonly string[],
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
  importPath:  string,
  go:          SourceRoots['go'],
): string | null {
  if (go === null) return null;
  const prefix = go.modulePath + '/';
  if (!importPath.startsWith(prefix) && importPath !== go.modulePath) return null;
  const rel = importPath === go.modulePath ? '' : importPath.slice(prefix.length);
  const dir = rel === '' ? go.repoRoot : join(go.repoRoot, rel);
  if (!existsSync(dir)) return null;
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
  specifier:  string,
  ts:         SourceRoots['typescript'],
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
// Entity index -- 4 maps, built once per pass
// ---------------------------------------------------------------------------

interface EntityIndex {
  /** id -> entity. */
  readonly byId:           Map<string, Entity>;
  /** file path -> entities defined in that file (excludes file/module entities). */
  readonly byFile:         Map<string, Entity[]>;
  /** file path -> the file entity itself. */
  readonly fileEntities:   Map<string, Entity>;
  /** `<lang>:<kind>:<name>` -> entities matching that triple. */
  readonly byNameKindLang: Map<string, Entity[]>;
}

function buildEntityIndex(entities: readonly Entity[]): EntityIndex {
  const byId           = new Map<string, Entity>();
  const byFile         = new Map<string, Entity[]>();
  const fileEntities   = new Map<string, Entity>();
  const byNameKindLang = new Map<string, Entity[]>();

  for (const e of entities) {
    byId.set(e.id, e);
    if (e.kind === 'file') {
      fileEntities.set(e.file, e);
      continue;
    }
    if (e.kind === 'module') {
      // Module stubs have repo='' and shouldn't appear in
      // listEntitiesForRepo, but defensively skip if any leak through.
      continue;
    }
    const key = entityKey(e.language, e.kind, e.name);
    let nameArr = byNameKindLang.get(key);
    if (nameArr === undefined) { nameArr = []; byNameKindLang.set(key, nameArr); }
    nameArr.push(e);

    let fileArr = byFile.get(e.file);
    if (fileArr === undefined) { fileArr = []; byFile.set(e.file, fileArr); }
    fileArr.push(e);
  }

  return { byId, byFile, fileEntities, byNameKindLang };
}

function entityKey(lang: Language, kind: EntityKind, name: string): string {
  return `${lang}:${kind}:${name}`;
}

// ---------------------------------------------------------------------------
// Kuzu helper -- prepare + execute + return rows
// ---------------------------------------------------------------------------

async function execGraph<T = Record<string, unknown>>(
  db:    DbClient,
  stmt:  string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: Record<string, any> = {},
): Promise<T[]> {
  const prepared = await db.graph.prepare(stmt);
  const result   = await db.graph.execute(prepared, params);
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const qr = Array.isArray(result) ? result[0]! : result;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (qr as any).getAll() as Promise<T[]>;
}
