/**
 * One-shot migration for the Phase 0 agent-family rename.
 *
 * Before the family-registry landed, the pair and delegate coding
 * agents identified themselves with `agentId: 'pair'` and
 * `agentId: 'delegate'` respectively. After the rename, both become
 * variants of the single `'implementation'` family -- `agentId` is
 * `'implementation'` for both, and the prior id becomes
 * `agentVariant`.
 *
 * Same story for config data: user-authored templates / feedback /
 * conventions lived under `~/.insrc/<category>/pair/` or `.../delegate/`
 * directories. They now live under `.../implementation/` with
 * variant-prefixed filenames preserved.
 *
 * This module migrates on-disk persisted state at daemon boot so
 * existing runs and config assets continue to work. Idempotent: a
 * second invocation on already-migrated data is a no-op.
 *
 * Not migrated here (by design):
 *   - Per-repo `<repoPath>/.insrc/...` config directories. Per-repo
 *     state is rarely duplicated; the user can re-run on demand via
 *     the `reindex` command which walks the frontmatter validator
 *     (already family-only) and rejects legacy namespace values.
 *   - Config-store LanceDB rows. A separate reindex run rewrites
 *     these from the file-system state, so moving the dirs above is
 *     sufficient.
 */

import {
  existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync,
  renameSync, rmdirSync, statSync,
} from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../shared/paths.js';
import { getLogger } from '../shared/logger.js';
import type { Checkpoint, RunIndexEntry, RunMeta } from '../agent/framework/types.js';

const log = getLogger('agent-family-migration');

// ---------------------------------------------------------------------------
// Legacy variant ids that must be rewritten to family id 'implementation'.
// ---------------------------------------------------------------------------

const LEGACY_VARIANT_IDS = new Set<string>(['pair', 'delegate']);
const FAMILY_ID = 'implementation';

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface MigrationReport {
  indexEntriesRewritten: number;
  runCheckpointsRewritten: number;
  runMetasRewritten: number;
  configDirsMoved: number;
  controllerCheckpointsRenamed: number;
}

export function migrateAgentFamilyRename(): MigrationReport {
  const report: MigrationReport = {
    indexEntriesRewritten: 0,
    runCheckpointsRewritten: 0,
    runMetasRewritten: 0,
    configDirsMoved: 0,
    controllerCheckpointsRenamed: 0,
  };

  try {
    report.indexEntriesRewritten = migrateRunIndex();
  } catch (err) {
    log.warn({ err }, 'run-index migration failed');
  }

  try {
    const runResult = migrateRunDirectories();
    report.runCheckpointsRewritten = runResult.checkpoints;
    report.runMetasRewritten = runResult.metas;
  } catch (err) {
    log.warn({ err }, 'run-directory migration failed');
  }

  try {
    report.configDirsMoved = migrateGlobalConfigDirs();
  } catch (err) {
    log.warn({ err }, 'config-directory migration failed');
  }

  try {
    report.controllerCheckpointsRenamed = migrateControllerCheckpoints();
  } catch (err) {
    log.warn({ err }, 'controller-checkpoint rename failed');
  }

  const touched =
    report.indexEntriesRewritten +
    report.runCheckpointsRewritten +
    report.runMetasRewritten +
    report.configDirsMoved +
    report.controllerCheckpointsRenamed;

  if (touched > 0) {
    log.info({ ...report }, 'agent-family rename migration applied');
  } else {
    log.debug('agent-family rename migration: nothing to migrate (idempotent no-op)');
  }

  return report;
}

// ---------------------------------------------------------------------------
// Run index -- ~/.insrc/agents/index.json
// ---------------------------------------------------------------------------

function migrateRunIndex(): number {
  if (!existsSync(PATHS.agentIndex)) return 0;

  const raw = readFileSync(PATHS.agentIndex, 'utf-8');
  let entries: RunIndexEntry[];
  try {
    entries = JSON.parse(raw) as RunIndexEntry[];
  } catch (err) {
    log.warn({ err, path: PATHS.agentIndex }, 'run-index parse failed; leaving intact');
    return 0;
  }

  let rewritten = 0;
  for (const entry of entries) {
    if (LEGACY_VARIANT_IDS.has(entry.agentId)) {
      const legacy = entry.agentId;
      entry.agentId = FAMILY_ID;
      entry.agentVariant = legacy;
      rewritten++;
    }
  }

  if (rewritten > 0) {
    writeFileSync(PATHS.agentIndex, JSON.stringify(entries, null, 2), 'utf-8');
  }
  return rewritten;
}

// ---------------------------------------------------------------------------
// Per-run state.json / meta.json under ~/.insrc/agents/<runId>/
// ---------------------------------------------------------------------------

function migrateRunDirectories(): { checkpoints: number; metas: number } {
  if (!existsSync(PATHS.agents)) return { checkpoints: 0, metas: 0 };

  let checkpoints = 0;
  let metas = 0;
  for (const entry of readdirSync(PATHS.agents)) {
    const runDir = join(PATHS.agents, entry);
    let isDir = false;
    try { isDir = statSync(runDir).isDirectory(); } catch { continue; }
    if (!isDir) continue;

    if (rewriteJsonFile<Checkpoint>(join(runDir, 'state.json'), cp => {
      if (!LEGACY_VARIANT_IDS.has(cp.agentId)) return null;
      return { ...cp, agentId: FAMILY_ID, agentVariant: cp.agentId };
    })) {
      checkpoints++;
    }

    if (rewriteJsonFile<RunMeta>(join(runDir, 'meta.json'), meta => {
      if (!LEGACY_VARIANT_IDS.has(meta.agentId)) return null;
      return { ...meta, agentId: FAMILY_ID, agentVariant: meta.agentId };
    })) {
      metas++;
    }
  }
  return { checkpoints, metas };
}

function rewriteJsonFile<T>(path: string, rewrite: (current: T) => T | null): boolean {
  if (!existsSync(path)) return false;
  let current: T;
  try {
    current = JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch (err) {
    log.warn({ err, path }, 'JSON parse failed; leaving file intact');
    return false;
  }
  const next = rewrite(current);
  if (next === null) return false;
  writeFileSync(path, JSON.stringify(next, null, 2), 'utf-8');
  return true;
}

// ---------------------------------------------------------------------------
// Global config dirs: ~/.insrc/<category>/<legacy>/  →  .../<family>/
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Controller-checkpoint files: ~/.insrc/checkpoints/<controller.id>-<sessionId>.json
// CodingController.id went from 'coding' to 'implementation'. Rename any
// legacy `coding-*.json` files so existing session state remains resumable.
// ---------------------------------------------------------------------------

function migrateControllerCheckpoints(): number {
  const checkpointsDir = join(PATHS.insrc, 'checkpoints');
  if (!existsSync(checkpointsDir)) return 0;

  const LEGACY_PREFIX = 'coding-';
  const FAMILY_PREFIX = 'implementation-';

  let renamed = 0;
  for (const entry of readdirSync(checkpointsDir)) {
    if (!entry.startsWith(LEGACY_PREFIX) || !entry.endsWith('.json')) continue;
    const suffix = entry.slice(LEGACY_PREFIX.length);
    const newPath = join(checkpointsDir, FAMILY_PREFIX + suffix);
    if (existsSync(newPath)) {
      log.warn(
        { legacy: join(checkpointsDir, entry), current: newPath },
        'skipping controller-checkpoint rename: destination already exists',
      );
      continue;
    }
    renameSync(join(checkpointsDir, entry), newPath);
    renamed++;
  }
  return renamed;
}

function migrateGlobalConfigDirs(): number {
  const categoryDirs = [PATHS.templates, PATHS.feedback, PATHS.conventions];
  let moved = 0;

  for (const categoryDir of categoryDirs) {
    if (!existsSync(categoryDir)) continue;

    const familyDir = join(categoryDir, FAMILY_ID);
    for (const legacy of LEGACY_VARIANT_IDS) {
      const legacyDir = join(categoryDir, legacy);
      if (!existsSync(legacyDir)) continue;

      mkdirSync(familyDir, { recursive: true });
      for (const entry of readdirSync(legacyDir)) {
        const src = join(legacyDir, entry);
        const dst = join(familyDir, entry);
        if (existsSync(dst)) {
          log.warn({ src, dst }, 'skipping: destination already exists (manual merge required)');
          continue;
        }
        renameSync(src, dst);
        moved++;
      }

      // Remove the now-empty legacy dir. Silently skip if readdir
      // still reports entries (manual-merge skips above left files).
      try { rmdirSync(legacyDir); } catch { /* non-empty: leave for user */ }
    }
  }

  return moved;
}
