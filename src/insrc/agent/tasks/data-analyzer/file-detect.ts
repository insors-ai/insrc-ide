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

/**
 * Threshold above which a directory walk's per-file registrations are
 * COLLAPSED into a single directory-group connection. Below threshold
 * we keep per-file ephemerals (small handful is easier for the planner
 * to reason about); at-or-above threshold the duckdb-file driver's
 * native directory-as-table support (a single connection whose path is
 * the directory, kind = json/csv/etc., driver globs `*.{ext}` at
 * sample-time) takes over.
 *
 * Two-file threshold chosen empirically: a single file is just a
 * single file; two-plus files of the same kind in one directory are
 * almost always "the dataset" the user meant.
 */
const DIR_COLLAPSE_MIN_FILES = 2;

export interface DetectedFile {
  /** Absolute resolved path (existed at detection time). */
  readonly absPath: string;
  /** As-typed token from the prompt (for logging / progress messages). */
  readonly typed: string;
  /** Inferred file kind ('json', 'csv', ...). */
  readonly kind: string;
  /** Auto-derived ephemeral connection id. For single files
   *  `ephemeral:<basename>-<hash>`; for directory groups
   *  `ephemeral:<dirname>-<kind>-<hash>`. */
  readonly connectionId: string;
  /**
   * True when this entry represents a directory aggregated across all
   * files of `kind` inside it. The driver's `statSync().isDirectory()`
   * detection picks this up and switches to glob mode at sample-time.
   *
   * When false (the default), the entry is a single-file ephemeral.
   */
  readonly isDirectory?: boolean;
  /**
   * Number of files of this kind under the directory at detection
   * time. Only set when `isDirectory: true`. Informational; the driver
   * doesn't pre-enumerate at runtime.
   */
  readonly memberCount?: number;
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

  // Pass 2: directories. Walk shallow for known-extension files and
  // collapse same-kind file groups into single directory-group
  // connections (one per (dir, kind) pair). The duckdb-file driver
  // natively handles directory connections: `statSync(path).isDirectory()`
  // switches it to glob mode (`<dir>/*.{ext}`), so registering one
  // directory entry per kind gives the planner a single handle for
  // "the dataset" without 30 individual file ephemerals.
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
    walkDirCollapsing(abs, typed, out);
  }

  return Array.from(out.values());
}

/**
 * Shallow walk of a directory; collapses same-kind file groups into
 * single directory-group ephemerals. Bounded by DIR_WALK_MAX_DEPTH.
 *
 * Algorithm:
 *   1. Scan the directory's immediate children (and one level of
 *      subdirs per DIR_WALK_MAX_DEPTH=1) for known-extension files.
 *   2. Tally by file kind: how many .json files, how many .csv, etc.
 *   3. For each kind with >= DIR_COLLAPSE_MIN_FILES (2) files,
 *      register ONE directory-group ephemeral whose path is the
 *      directory (the duckdb-file driver handles dir-as-table
 *      natively via glob).
 *   4. For each kind with < DIR_COLLAPSE_MIN_FILES files, register
 *      per-file (one ephemeral per file). A single .csv in a dir of
 *      mostly .json files still gets its own entry.
 *
 * Hidden entries (dotfiles / dotdirs) are skipped to avoid
 * accidentally pulling .git, OS metadata files, etc. `node_modules`
 * is excluded explicitly even though it has few data-extension files.
 */
function walkDirCollapsing(
  dirAbs: string,
  dirTyped: string,
  out: Map<string, DetectedFile>,
): void {
  // Tally same-kind groups. For each kind we observe under this dir
  // (or its immediate subdirs), collect the absolute paths.
  const byKind: Map<string, string[]> = new Map();
  collectFilesByKind(dirAbs, byKind, 0);
  if (byKind.size === 0) return;

  for (const [kind, files] of byKind) {
    if (files.length >= DIR_COLLAPSE_MIN_FILES) {
      // Collapse: register ONE directory-group ephemeral. The driver
      // statSyncs the path and switches to glob mode automatically.
      const groupId = makeDirGroupId(dirAbs, kind);
      if (out.has(dirAbs + '\0' + kind)) continue;  // dedup across multiple typed mentions
      out.set(dirAbs + '\0' + kind, {
        absPath:      dirAbs,
        typed:        dirTyped,
        kind,
        connectionId: groupId,
        isDirectory:  true,
        memberCount:  files.length,
      });
      continue;
    }
    // Below threshold: register per-file.
    for (const childAbs of files) {
      if (out.has(childAbs)) continue;
      out.set(childAbs, {
        absPath:      childAbs,
        typed:        `${dirTyped}/${basename(childAbs)}`,
        kind,
        connectionId: makeEphemeralId(childAbs),
      });
    }
  }
}

/**
 * Recursive collector: walks `dirAbs` up to DIR_WALK_MAX_DEPTH and
 * appends every known-extension file's absolute path to `byKind`
 * grouped by its inferred kind.
 *
 * Symlinks aren't followed beyond statSync's default behaviour.
 */
function collectFilesByKind(
  dirAbs: string,
  byKind: Map<string, string[]>,
  depth: number,
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
      collectFilesByKind(childAbs, byKind, depth + 1);
      continue;
    }
    if (!childIsFile) continue;
    const ext = extname(name).slice(1).toLowerCase();
    const kind = EXTENSION_TO_KIND[ext];
    if (kind === undefined) continue;
    const list = byKind.get(kind);
    if (list === undefined) byKind.set(kind, [childAbs]);
    else list.push(childAbs);
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

/**
 * Build an ephemeral directory-group connection id. The id encodes the
 * directory's basename + the file kind so a single directory hosting
 * multiple kinds (e.g. `data/` with both .csv and .parquet) gets two
 * distinct ids -- one per kind, matching the data-driver's one-kind-
 * per-connection contract.
 *
 * Stable across calls (same dir + kind always hashes to the same id),
 * so a re-run of the same prompt reuses the existing entry.
 */
function makeDirGroupId(dirAbs: string, kind: string): string {
  const base = basename(dirAbs);
  const slug = base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  // Hash off (path + kind) so two same-named dirs holding different
  // kinds stay distinct.
  const composite = `${dirAbs}|${kind}`;
  let h = 0;
  for (let i = 0; i < composite.length; i++) {
    h = ((h << 5) - h + composite.charCodeAt(i)) | 0;
  }
  const hashSuffix = (h >>> 0).toString(16).padStart(8, '0');
  return `ephemeral:${slug || 'dir'}-${kind}-${hashSuffix}`;
}
