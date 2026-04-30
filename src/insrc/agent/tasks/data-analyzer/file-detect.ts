/**
 * File-path detection for the Data Analyzer's ephemeral-connection
 * registration (Phase 1.H).
 *
 * The user often types a one-off local-file question like
 *   /data-analyze find pii in /home/me/exports/customers.json
 * without first registering the file as a connection in the Data
 * Sources pane. The orchestrator runs this detector against the
 * prompt, registers a session-scoped ephemeral connection per
 * detected path (auto-approved), and the planner sees it in the
 * connection list.
 *
 * Detection is intentionally conservative: only paths whose extension
 * matches a known file-driver kind are extracted. Paths to source
 * code, config, or docs are ignored. The user can still register a
 * connection manually if the heuristic misses (e.g. an extensionless
 * jsonl dump).
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join as pathJoin, resolve as pathResolve, basename, extname, isAbsolute } from 'node:path';

/**
 * Map of file extension (lowercased, no dot) -> data-driver `kind`.
 * Mirrors the registrations in `daemon/db/drivers/*.ts`.
 */
const EXTENSION_TO_KIND: Readonly<Record<string, string>> = {
  json:    'json',
  jsonl:   'jsonl',
  ndjson:  'jsonl',
  csv:     'csv',
  tsv:     'tsv',
  parquet: 'parquet',
  arrow:   'arrow',
  feather: 'feather',
  xlsx:    'xlsx',
  xls:     'xlsx',
  avro:    'avro',
};

/**
 * Match path-shaped tokens in the prompt: an absolute path or a
 * relative-with-slash path (./foo, ../foo, src/foo). Bare filenames
 * (e.g. "users.json") only match when they have a known extension --
 * so a passing reference like "the customers.json export" is only
 * registered if customers.json exists relative to the cwd.
 *
 * The regex is purposely permissive on the path body (any non-
 * whitespace, no quoting) and strict on the extension. We then
 * `existsSync` the resolved path before registering.
 */
const PATH_TOKEN_REGEX =
  /(?:^|\s|[`'"(\[])((?:\/|\.\.?\/|[\w.-]+\/)?[\w.\/-]+\.(?:json|jsonl|ndjson|csv|tsv|parquet|arrow|feather|xlsx|xls|avro))(?=$|\s|[`'"\)\],.;!?])/gi;

/**
 * Match path-shaped tokens that COULD be a directory: anything with
 * a slash but no extension (relative or absolute). The trailing
 * slash form (`./data/`) is the unambiguous case; we also catch
 * extension-less paths (`./data`, `/tmp/exports`) via existsSync
 * + isDirectory in the consumer.
 *
 * Conservative: requires at least one slash so bare words ("data")
 * don't get scanned. False positives are filtered by the
 * existsSync + isDirectory + extension-walk pipeline.
 */
const DIR_TOKEN_REGEX =
  /(?:^|\s|[`'"(\[])((?:\/|\.\.?\/)[\w./-]+\/?|[\w.-]+\/[\w./-]+)(?=$|\s|[`'"\)\],.;!?])/gi;

/**
 * Max recursion depth for a directory walk. 1 = the dir's immediate
 * children; subdirs aren't descended. Avoids accidentally scanning
 * an entire repo or a node_modules tree the user happened to type
 * a path near.
 */
const DIR_WALK_MAX_DEPTH = 1;

// Note: there's no cap on how many ephemeral files we register from
// a directory. A 500-file dir registers 500 ephemerals. The planner
// is guided to BATCH (one task per group-of-N connections, typically
// 6-per-task to fit the analyzer's 8-tool-call budget) rather than
// emit one task per file. See plan.ts's tier guidance.

export interface DetectedFile {
  /** Absolute resolved path (existed at detection time). */
  readonly absPath: string;
  /** As-typed token from the prompt (for logging / progress messages). */
  readonly typed: string;
  /** Inferred file kind ('json', 'csv', ...). */
  readonly kind: string;
  /** Auto-derived ephemeral connection id (`ephemeral:<basename>`). */
  readonly connectionId: string;
}

/**
 * Walk the prompt, find data-source paths and produce one
 * DetectedFile per ephemeral connection to register.
 *
 * Two passes:
 *   1. File regex: paths whose extension matches a known kind.
 *   2. Dir regex: path-shaped tokens that resolve to a directory --
 *      walked shallow (depth = DIR_WALK_MAX_DEPTH) for known-extension
 *      files.
 *
 * No cap on the number of registrations. A 500-file directory
 * registers 500 ephemeral connections. The planner is guided to
 * BATCH (one task per group-of-N connections; the analyzer's
 * 8-tool-call budget naturally caps per-batch fan-out at ~6
 * connections + sample + submit_analysis) rather than emit one task
 * per file -- see plan.ts's per-tier guidance.
 *
 * `cwd` is typically `session.repoPath`. Absolute paths in the prompt
 * are honoured as-is; relative paths resolve against cwd.
 *
 * Deduplicates on absolute path -- the same file referenced twice (or
 * a file matched by both the file regex AND the dir-walk pass)
 * registers once.
 */
export function detectFilePaths(prompt: string, cwd: string): readonly DetectedFile[] {
  const out = new Map<string, DetectedFile>();

  // Pass 1: explicit file paths.
  let m: RegExpExecArray | null;
  PATH_TOKEN_REGEX.lastIndex = 0;
  while ((m = PATH_TOKEN_REGEX.exec(prompt)) !== null) {
    const typed = m[1];
    if (typed === undefined) continue;
    const ext = extname(typed).slice(1).toLowerCase();
    const kind = EXTENSION_TO_KIND[ext];
    if (kind === undefined) continue;
    const abs = isAbsolute(typed) ? typed : pathResolve(cwd, typed);
    if (!existsSync(abs)) continue;
    try {
      if (!statSync(abs).isFile()) continue;
    } catch {
      continue;
    }
    if (out.has(abs)) continue;
    out.set(abs, {
      absPath: abs,
      typed,
      kind,
      connectionId: makeEphemeralId(abs),
    });
  }

  // Pass 2: directories. Walk shallow for known-extension files.
  DIR_TOKEN_REGEX.lastIndex = 0;
  while ((m = DIR_TOKEN_REGEX.exec(prompt)) !== null) {
    const typed = m[1];
    if (typed === undefined) continue;
    // Skip paths that already had a known extension (handled by pass 1).
    const ext = extname(typed).slice(1).toLowerCase();
    if (EXTENSION_TO_KIND[ext] !== undefined) continue;
    const abs = isAbsolute(typed) ? typed : pathResolve(cwd, typed.replace(/\/+$/, ''));
    if (!existsSync(abs)) continue;
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    walkDir(abs, typed, 0, out);
  }

  return Array.from(out.values());
}

/**
 * Shallow walk of a directory; registers known-extension files as
 * ephemerals. Bounded by DIR_WALK_MAX_DEPTH only -- caller doesn't
 * cap on count.
 *
 * Hidden entries (dotfiles / dotdirs) are skipped to avoid
 * accidentally pulling .git, OS metadata files, etc.
 * `node_modules` is excluded explicitly for safety even though
 * its files don't normally have data extensions.
 */
function walkDir(
  dirAbs: string,
  dirTyped: string,
  depth: number,
  out: Map<string, DetectedFile>,
): void {
  if (depth > DIR_WALK_MAX_DEPTH) return;
  let entries: string[];
  try {
    entries = readdirSync(dirAbs);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue;        // skip dotfiles / dotdirs
    if (name === 'node_modules') continue;     // never recurse into npm trees
    const childAbs = pathJoin(dirAbs, name);
    let childIsDir = false;
    let childIsFile = false;
    try {
      const st = statSync(childAbs);
      childIsDir = st.isDirectory();
      childIsFile = st.isFile();
    } catch {
      continue;
    }
    if (childIsDir) {
      walkDir(childAbs, `${dirTyped}/${name}`, depth + 1, out);
      continue;
    }
    if (!childIsFile) continue;
    const ext = extname(name).slice(1).toLowerCase();
    const kind = EXTENSION_TO_KIND[ext];
    if (kind === undefined) continue;
    if (out.has(childAbs)) continue;
    out.set(childAbs, {
      absPath: childAbs,
      typed: `${dirTyped}/${name}`,
      kind,
      connectionId: makeEphemeralId(childAbs),
    });
  }
}

/**
 * Build an ephemeral connection id from an absolute path. Stable
 * across calls (no timestamps / random parts) so the same prompt run
 * twice in a row reuses the same connection entry. Prefix
 * `ephemeral:` keeps it visually distinct from user-registered ids
 * in `db_list_connections` output.
 */
function makeEphemeralId(absPath: string): string {
  const base = basename(absPath, extname(absPath));
  // Sanitize: lower-case alphanumerics + hyphens.
  const slug = base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  // 8-char hash suffix from the path keeps two files with the same
  // basename in different dirs distinct.
  let h = 0;
  for (let i = 0; i < absPath.length; i++) {
    h = ((h << 5) - h + absPath.charCodeAt(i)) | 0;
  }
  const hashSuffix = (h >>> 0).toString(16).padStart(8, '0');
  return `ephemeral:${slug || 'file'}-${hashSuffix}`;
}
