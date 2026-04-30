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

import { existsSync, statSync } from 'node:fs';
import { resolve as pathResolve, basename, extname, isAbsolute } from 'node:path';

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
 * Walk the prompt, find file paths whose extension maps to a known
 * file-driver kind AND that exist on disk relative to `cwd`.
 *
 * `cwd` is typically `session.repoPath`. Absolute paths in the prompt
 * are honoured as-is; relative paths resolve against cwd.
 *
 * Deduplicates on absolute path.
 */
export function detectFilePaths(prompt: string, cwd: string): readonly DetectedFile[] {
  const out = new Map<string, DetectedFile>();
  let m: RegExpExecArray | null;
  // Reset lastIndex so the global regex resumes from 0 for each call.
  PATH_TOKEN_REGEX.lastIndex = 0;
  while ((m = PATH_TOKEN_REGEX.exec(prompt)) !== null) {
    const typed = m[1];
    if (typed === undefined) continue;
    const ext = extname(typed).slice(1).toLowerCase();
    const kind = EXTENSION_TO_KIND[ext];
    if (kind === undefined) continue;
    const abs = isAbsolute(typed) ? typed : pathResolve(cwd, typed);
    // existsSync + statSync(...).isFile() avoids a directory or
    // a deleted-since-typing path being registered as a "file".
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
  return Array.from(out.values());
}

/**
 * Build an ephemeral connection id from an absolute path. Stable
 * across calls (no timestamps / random parts) so the same prompt run
 * twice in a row reuses the same connection entry. Prefix
 * `ephemeral:` keeps it visually distinct from user-registered ids
 * in `db:list_connections` output.
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
