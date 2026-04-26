import { existsSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import type { Entity, Relation, Language } from '../shared/types.js';
import { makeEntityId } from './parser/base.js';

/**
 * Resolve unresolved relations in a ParseResult.
 *
 * For relative IMPORTS:
 *   - Compute the absolute path of the imported file
 *   - Try the per-language extension candidate map
 *   - If the file exists on disk, mark the relation resolved with the File entity ID
 *
 * For CALLS with raw function/method names:
 *   - Match against entities parsed from the same file
 *   - If a unique match is found, resolve to the entity ID
 *
 * For INHERITS / IMPLEMENTS with raw class/interface names:
 *   - Left unresolved for the cross-file resolver pass.
 *   - See plans/cross-file-references.md.
 *
 * Does not touch the database — purely path-based, synchronous.
 */
export function resolveRelations(
  relations: Relation[],
  filePath:  string,
  repo:      string,
  entities?: Entity[],
): Relation[] {
  // Build a name→id lookup from entities in this file (for CALLS resolution)
  const localByName = new Map<string, string>();
  const ambiguous = new Set<string>();
  if (entities) {
    for (const e of entities) {
      if (e.file !== filePath) continue;
      if (e.kind === 'file' || e.kind === 'module') continue;
      if (ambiguous.has(e.name)) continue;
      if (localByName.has(e.name)) {
        // Ambiguous: multiple entities with same name in this file
        localByName.delete(e.name);
        ambiguous.add(e.name);
      } else {
        localByName.set(e.name, e.id);
      }
    }
  }

  const language = detectLanguage(filePath, entities);

  return relations.map(rel => {
    if (rel.resolved) return rel;

    // CALLS: resolve by matching callee name to local entities
    if (rel.kind === 'CALLS') {
      const targetId = localByName.get(rel.to);
      if (targetId && targetId !== rel.from) {
        return { ...rel, to: targetId, resolved: true };
      }
      return rel; // keep unresolved — may resolve in cross-file pass
    }

    if (rel.kind !== 'IMPORTS') return rel;          // INHERITS/IMPLEMENTS: defer
    if (!rel.meta?.['isRelative']) return rel;       // external module: already handled by parser

    const specifier = rel.to;
    const absPath   = resolveImportPath(filePath, specifier, repo, language);

    if (!absPath) return rel; // can't resolve — keep unresolved

    const targetId = makeEntityId(repo, absPath, 'file', absPath);
    return { ...rel, to: targetId, resolved: true };
  });
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a relative import specifier to an absolute file path using the
 * per-language extension candidate map.
 * Returns null if the file cannot be found.
 */
function resolveImportPath(
  fromFile:  string,
  specifier: string,
  repo:      string,
  language:  Language,
): string | null {
  const fromDir = dirname(fromFile);

  // Strip query strings / hashes (rare but possible)
  const clean = specifier.split('?')[0]?.split('#')[0] ?? specifier;

  const candidates = buildCandidates(resolve(fromDir, clean), language);

  for (const candidate of candidates) {
    // Must be inside the repo to avoid leaking outside the graph scope
    if (!candidate.startsWith(repo)) continue;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-language extension candidate map
//
// Outer key: source-file language. Inner key: extension on the import
// specifier (or '' for an extensionless specifier). Value: the list of
// candidate suffixes to probe in order. A leading '/' on an entry means
// "append to the bare path" (used for index/__init__-style targets).
//
// Phase 0 ships the skeleton with TS/JS populated (current behaviour).
// Phase 1 fills in Python; later phases add the other languages.
// See plans/cross-file-references.md §0.5 / §1.
// ---------------------------------------------------------------------------

type ExtensionCandidates = Readonly<Record<string, readonly string[]>>;

const TS_CANDIDATES: ExtensionCandidates = {
  '.js':  ['.ts', '.tsx', '.js', '.jsx'],
  '.jsx': ['.jsx', '.tsx', '.js', '.ts'],
  '.mjs': ['.mts', '.mjs'],
  '.cjs': ['.cts', '.cjs'],
  '':     ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'],
};

const EXTENSION_MAP: Readonly<Partial<Record<Language, ExtensionCandidates>>> = {
  typescript: TS_CANDIDATES,
  javascript: TS_CANDIDATES,
  // python: filled in Phase 1
  // go / java / scala: filled in their respective phases (cross-file pass
  // handles JVM package-style imports rather than relative-path probing).
};

function buildCandidates(base: string, language: Language): string[] {
  const map = EXTENSION_MAP[language];
  if (!map) return [base];

  const ext  = extname(base);
  const stem = base.slice(0, base.length - ext.length);
  const alts = map[ext] ?? [ext];

  const candidates: string[] = alts.map(a =>
    a.startsWith('/') ? stem + a : stem + a,
  );

  // Also try bare path → index variants if we started with an extension
  if (ext) {
    const bare = map[''] ?? [];
    candidates.push(...bare.map(a => a.startsWith('/') ? base + a : base + a));
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Language detection — derive from a parsed file entity when available,
// otherwise fall back to extension-based mapping.
// ---------------------------------------------------------------------------

function detectLanguage(filePath: string, entities?: Entity[]): Language {
  if (entities) {
    const fileEntity = entities.find(e => e.kind === 'file' && e.file === filePath);
    if (fileEntity) return fileEntity.language;
  }
  const ext = extname(filePath).toLowerCase();
  return EXT_TO_LANG[ext] ?? 'config';
}

const EXT_TO_LANG: Readonly<Record<string, Language>> = {
  '.ts':    'typescript', '.tsx': 'typescript',
  '.mts':   'typescript', '.cts': 'typescript',
  '.js':    'javascript', '.jsx': 'javascript',
  '.mjs':   'javascript', '.cjs': 'javascript',
  '.py':    'python',
  '.go':    'go',
  '.java':  'java',
  '.scala': 'scala', '.sc': 'scala',
};
