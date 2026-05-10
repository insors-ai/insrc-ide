import { homedir } from 'node:os';
import { join } from 'node:path';

const INSRC_DIR = join(homedir(), '.insrc');
const LOG_DIR   = join('/tmp', '.insrc');

export const PATHS = {
  insrc:       INSRC_DIR,
  config:      join(INSRC_DIR, 'config.json'),
  duckdb:      join(INSRC_DIR, 'duckdb.db'),    // legacy: file-backed DuckDB consolidation (cleaned up on boot)
  lmdb:        join(INSRC_DIR, 'graph.lmdb'),   // LMDB: graph + repo + plans + conversations + todos + config
  graph:       join(INSRC_DIR, 'graph'),        // legacy: Kuzu DB directory (cleaned up on boot)
  lance:       join(INSRC_DIR, 'lance'),        // LanceDB store (entity + session + turn + config vectors)
  configStore: join(INSRC_DIR, 'config-store'), // legacy: standalone Lance config-store (now folded into PATHS.lance; cleaned up on boot)
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
  // Cache root for the Code Analyzer's multipass synthesis section
  // builder (Phase 5.C / content-gen). Per-section disk LRU; cache
  // key salts on the run's repoSnapshotId so a new commit
  // invalidates every cached section. Used only by the synthesis
  // step that runs inline in the orchestrator -- the legacy
  // per-task cache that lived alongside it (`code-analyzer/`) was
  // dropped along with the legacy analyzer runner.
  codeAnalyzerSectionCache: join(INSRC_DIR, 'cache', 'code-analyzer-sections'),
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
