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
  listUnresolvedRelations, promoteToResolved, updateUnresolvedMeta,
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

  const entities = await listEntitiesForRepo(opts.db, opts.repoRoot);
  const index    = buildEntityIndex(entities);
  log.info(
    { repo: opts.repoRoot, entities: entities.length },
    'cross-file resolver starting',
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
  const unresolved = await listUnresolvedRelations(
    opts.db, opts.repoRoot, opts.scopeFile,
  );
  log.info(
    { repo: opts.repoRoot, rows: unresolved.length },
    'cross-file Pass 2 (relation resolution) starting',
  );
  const tPass2 = Date.now();

  let resolved        = 0;
  let ambiguous       = 0;
  let stillUnresolved = 0;
  let processed       = 0;
  for (const row of unresolved) {
    let result: 'resolved' | 'ambiguous' | 'unresolved';
    if (row.kind === 'INHERITS' || row.kind === 'IMPLEMENTS') {
      result = await resolveInheritance(opts, row, index);
    } else if (row.kind === 'CALLS') {
      result = await resolveCall(opts, row, index);
    } else {
      // Everything else stays unresolved.
      processed++;
      continue;
    }
    if      (result === 'resolved')  resolved++;
    else if (result === 'ambiguous') ambiguous++;
    else                             stillUnresolved++;
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
}

function buildEntityIndex(entities: readonly Entity[]): EntityIndex {
  const byNameKindLang = new Map<string, Entity[]>();
  const byFile         = new Map<string, Entity[]>();
  const fileEntities   = new Map<string, Entity>();
  const modules        = new Map<string, Entity>();

  for (const e of entities) {
    if (e.kind === 'file') {
      fileEntities.set(e.file, e);
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

  return { byNameKindLang, byFile, fileEntities, modules };
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stmt = `MATCH (f:Entity)-[r:IMPORTS]->(m:Entity)
                WHERE m.kind = 'module'
                RETURN f.id AS fromId, m.id AS moduleId`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await execGraph<any>(opts.db, stmt);

  let rewired = 0;
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

    // Delete the old stub edge, add the new file-target edge. MERGE
    // makes the second step idempotent if a previous pass already
    // rewired this one.
    await execGraph(opts.db,
      `MATCH (f:Entity {id: $from})-[r:IMPORTS]->(m:Entity {id: $module})
       DELETE r`,
      { from: fromId, module: moduleId },
    );
    await execGraph(opts.db,
      `MATCH (f:Entity {id: $from}), (t:Entity {id: $target})
       MERGE (f)-[:IMPORTS]->(t)`,
      { from: fromId, target: targetEntity.id },
    );
    rewired++;
  }

  return rewired;
}

function findFilePathByEntityId(id: string, index: EntityIndex): string | null {
  for (const [path, e] of index.fileEntities) {
    if (e.id === id) return path;
  }
  return null;
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
// Pass 2 -- INHERITS / IMPLEMENTS resolution
// ---------------------------------------------------------------------------

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
): Promise<'resolved' | 'ambiguous' | 'unresolved'> {
  const fromEntities = index.byFile.get(row.fromFile) ?? [];
  // The parser stores INHERITS edges with `from` = the inheriting class
  // entity id. Pull its language from the index.
  const fromEntity = fromEntities.find(e => e.id === row.fromEntity)
    ?? findEntityByIdAcrossIndex(index, row.fromEntity);
  if (fromEntity === undefined) {
    // Stale row; from-side was deleted but UnresolvedRelation row wasn't
    // cleaned. The Phase 5 invalidation hooks will catch this.
    return 'unresolved';
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
      await promoteToResolved(opts.db, row, sameFile[0]!.id);
      return 'resolved';
    }
    if (sameFile.length > 1) {
      await updateUnresolvedMeta(opts.db, row.id,
        { ...row.meta, candidates: sameFile.map(e => e.id) });
      return 'ambiguous';
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
    await promoteToResolved(opts.db, row, candidates[0]!.id);
    return 'resolved';
  }
  if (candidates.length > 1) {
    await updateUnresolvedMeta(opts.db, row.id,
      { ...row.meta, candidates: candidates.map(e => e.id) });
    return 'ambiguous';
  }
  return 'unresolved';
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
): Promise<'resolved' | 'ambiguous' | 'unresolved'> {
  const fromEntity = (index.byFile.get(row.fromFile) ?? []).find(e => e.id === row.fromEntity)
    ?? findEntityByIdAcrossIndex(index, row.fromEntity);
  if (fromEntity === undefined) return 'unresolved';
  const language = fromEntity.language;

  // 1. Same-file: function / method / class with matching name.
  const sameFile = (index.byFile.get(row.fromFile) ?? [])
    .filter(e => e.language === language
              && CALL_TARGET_KINDS.includes(e.kind)
              && e.name === row.rawTo
              && e.id !== row.fromEntity);
  if (sameFile.length === 1) {
    await promoteToResolved(opts.db, row, sameFile[0]!.id);
    return 'resolved';
  }
  if (sameFile.length > 1) {
    await updateUnresolvedMeta(opts.db, row.id,
      { ...row.meta, candidates: sameFile.map(e => e.id) });
    return 'ambiguous';
  }

  // 2. Cross-file: walk imported files (after Phase 3's rewire) and
  //    consider only exported targets.
  const importedFiles = await getResolvedImportTargets(opts.db, row.fromEntity, index);
  if (importedFiles.size === 0) return 'unresolved';

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
    await promoteToResolved(opts.db, row, candidates[0]!.id);
    return 'resolved';
  }
  if (candidates.length > 1) {
    await updateUnresolvedMeta(opts.db, row.id,
      { ...row.meta, candidates: candidates.map(e => e.id) });
    return 'ambiguous';
  }
  return 'unresolved';
}

function findEntityByIdAcrossIndex(index: EntityIndex, id: string): Entity | undefined {
  for (const arr of index.byNameKindLang.values()) {
    const hit = arr.find(e => e.id === id);
    if (hit !== undefined) return hit;
  }
  return undefined;
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
  // The from-side of the IMPORTS edge is the file entity, not the
  // inheriting class. Look up the file entity by row.fromFile via the
  // index, then walk its IMPORTS edges.
  let fromFile: string | null = null;
  for (const arr of index.byFile.values()) {
    if (arr.some(e => e.id === fromEntityId)) {
      fromFile = arr[0]!.file;
      break;
    }
  }
  if (fromFile === null) return new Set();
  const fileEntity = index.fileEntities.get(fromFile);
  if (fileEntity === undefined) return new Set();

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
    for (const [path, e] of index.fileEntities) {
      if (e.id === id) { out.add(path); break; }
    }
  }
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
