import { homedir } from 'node:os';
import { join } from 'node:path';

const INSRC_DIR = join(homedir(), '.insrc');
const LOG_DIR   = join('/tmp', '.insrc');

export const PATHS = {
  insrc:       INSRC_DIR,
  config:      join(INSRC_DIR, 'config.json'),
  duckdb:      join(INSRC_DIR, 'duckdb.db'),    // DuckDB — graph + entities + conversations + config-store + todos
  graph:       join(INSRC_DIR, 'graph'),        // legacy: Kuzu DB (cleaned up on first DuckDB-only boot)
  lance:       join(INSRC_DIR, 'lance'),        // LanceDB — entity store + embeddings (Phase B; removed in B.10)
  configStore: join(INSRC_DIR, 'config-store'), // LanceDB — config entry store (Phase B; removed in B.10)
  templates:   join(INSRC_DIR, 'templates'),    // global config templates
  feedback:    join(INSRC_DIR, 'feedback'),     // global config feedback
  conventions: join(INSRC_DIR, 'conventions'),  // global config conventions
  pidFile:     join(INSRC_DIR, 'daemon.pid'),
  sockFile:    join(INSRC_DIR, 'daemon.sock'),
  agents:      join(INSRC_DIR, 'agents'),          // agent run storage
  agentIndex:  join(INSRC_DIR, 'agents', 'index.json'),
  // Backing-file directory for ephemeral workbench panes (notepad,
  // artifacts, analysis report, brainstorm presentation, ...). Each
  // ephemeral pane writes its content to a real file under this
  // directory and opens that file URI -- so on next IDE restart the
  // editor restoration finds a valid resource instead of the old
  // custom-scheme URI whose provider hasn't initialised yet (and shows
  // an error pane). A startup reconciler in the workbench prunes any
  // file here that no open editor references.
  tmp:         join(INSRC_DIR, 'tmp'),
  // Cache root for the Code Analyzer's per-task LRU
  // (plans/analyzers/code-analyzer.md Phase 2.5). Each cache entry
  // stores a reviewer-accepted AnalyzerResult keyed on
  // SHA256(question + scope + tier + repoSnapshotId). Caps at 200
  // entries; evicts oldest by mtime. Cache invalidates per-commit
  // automatically when the repoSnapshotId carries the git HEAD
  // SHA. Cleared via the `insrc.codeAnalyzer.clearCache` palette
  // command.
  codeAnalyzerCache: join(INSRC_DIR, 'cache', 'code-analyzer'),
  // Cache root for the Data Analyzer's per-task LRU
  // (plans/analyzers/data-analyzer.md Phase 2.4). Mirrors the
  // code-analyzer cache shape; key shape differs --
  // SHA256(question + scope + tier + connection-fingerprint) -- so
  // schema changes invalidate per-target rather than per-commit.
  // Cleared via `insrc.dataAnalyzer.clearCache`.
  dataAnalyzerCache: join(INSRC_DIR, 'cache', 'data-analysis'),
  logDir:      LOG_DIR,
  daemonLog:   join(LOG_DIR, 'daemon.log'),
  agentLog:    join(LOG_DIR, 'agent.log'),
} as const;
