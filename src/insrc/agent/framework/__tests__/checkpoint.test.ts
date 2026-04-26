/**
 * Tests for checkpoint persistence, run lifecycle, locking, and crash detection.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  mkdirSync, rmSync, existsSync, readFileSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  atomicWriteSync,
  cleanOrphanedTmp,
  writeCheckpoint,
  readCheckpoint,
  writeHeartbeat,
  readHeartbeat,
  writeMeta,
  readMeta,
  appendEvent,
  writeArtifact,
  readArtifact,
  acquireLock,
  releaseLock,
} from '../checkpoint.js';

import type { Checkpoint, RunMeta } from '../types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `insrc-test-${randomUUID()}`);
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  return dir;
}

function makeCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    runId: 'run-1',
    agentId: 'designer',
    version: 1,
    stepName: 'init',
    stepIndex: 0,
    state: { foo: 'bar' },
    status: 'running',
    pid: process.pid,
    heartbeat: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    completedSteps: [],
    ...overrides,
  };
}

function makeMeta(): RunMeta {
  return {
    agentId: 'designer',
    version: 1,
    repo: '/tmp/repo',
    createdAt: new Date().toISOString(),
    inputHash: 'abc123',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('atomicWriteSync', () => {
  let dir: string;

  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('writes file content', () => {
    const path = join(dir, 'test.json');
    atomicWriteSync(path, '{"ok":true}');
    assert.equal(readFileSync(path, 'utf-8'), '{"ok":true}');
  });

  it('removes .tmp file after write', () => {
    const path = join(dir, 'test.json');
    atomicWriteSync(path, 'data');
    assert.equal(existsSync(path + '.tmp'), false);
  });
});

describe('cleanOrphanedTmp', () => {
  let dir: string;

  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('removes .tmp files', () => {
    writeFileSync(join(dir, 'state.json.tmp'), 'orphan');
    writeFileSync(join(dir, 'other.tmp'), 'orphan2');
    writeFileSync(join(dir, 'keep.json'), 'real');
    cleanOrphanedTmp(dir);
    assert.equal(existsSync(join(dir, 'state.json.tmp')), false);
    assert.equal(existsSync(join(dir, 'other.tmp')), false);
    assert.equal(existsSync(join(dir, 'keep.json')), true);
  });

  it('handles non-existent directory gracefully', () => {
    assert.doesNotThrow(() => cleanOrphanedTmp('/tmp/does-not-exist-xyz'));
  });
});

describe('checkpoint read/write', () => {
  let dir: string;

  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('round-trips a checkpoint', () => {
    const cp = makeCheckpoint();
    writeCheckpoint(dir, cp);
    const loaded = readCheckpoint(dir);
    assert.deepEqual(loaded, cp);
  });

  it('returns null for missing checkpoint', () => {
    assert.equal(readCheckpoint(dir), null);
  });

  it('preserves state data', () => {
    const cp = makeCheckpoint({ state: { items: [1, 2, 3], nested: { a: true } } });
    writeCheckpoint(dir, cp);
    const loaded = readCheckpoint(dir);
    assert.deepEqual(loaded?.state, { items: [1, 2, 3], nested: { a: true } });
  });
});

describe('heartbeat', () => {
  let dir: string;

  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('writes and reads heartbeat timestamp', () => {
    writeHeartbeat(dir);
    const ts = readHeartbeat(dir);
    assert.ok(ts);
    // Should be a valid ISO string within the last few seconds
    const delta = Date.now() - new Date(ts!).getTime();
    assert.ok(delta < 5000);
  });

  it('returns null for missing heartbeat', () => {
    assert.equal(readHeartbeat(dir), null);
  });
});

describe('run metadata', () => {
  let dir: string;

  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('round-trips metadata', () => {
    const meta = makeMeta();
    writeMeta(dir, meta);
    assert.deepEqual(readMeta(dir), meta);
  });

  it('returns null for missing metadata', () => {
    assert.equal(readMeta(dir), null);
  });
});

describe('event log', () => {
  let dir: string;

  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('appends events as JSONL', () => {
    appendEvent(dir, { kind: 'step_start', step: 'init' });
    appendEvent(dir, { kind: 'step_end', step: 'init' });
    const lines = readFileSync(join(dir, 'events.jsonl'), 'utf-8')
      .trim().split('\n');
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(first['kind'], 'step_start');
    assert.ok(first['ts']);
  });
});

describe('artifacts', () => {
  let dir: string;

  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('writes and reads an artifact', () => {
    const path = writeArtifact(dir, 'design.md', '# Design');
    assert.ok(path.includes('artifacts'));
    assert.equal(readArtifact(dir, 'design.md'), '# Design');
  });

  it('supports nested artifact paths', () => {
    writeArtifact(dir, 'sub/nested.txt', 'hello');
    assert.equal(readArtifact(dir, 'sub/nested.txt'), 'hello');
  });

  it('returns null for missing artifact', () => {
    assert.equal(readArtifact(dir, 'nope.txt'), null);
  });
});

describe('run lock', () => {
  let dir: string;

  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => {
    releaseLock(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  it('acquires lock on first attempt', () => {
    assert.equal(acquireLock(dir), true);
  });

  it('fails to acquire when already held by this process', () => {
    acquireLock(dir);
    // Same PID is alive, so second acquire should fail
    assert.equal(acquireLock(dir), false);
  });

  it('can re-acquire after release', () => {
    acquireLock(dir);
    releaseLock(dir);
    assert.equal(acquireLock(dir), true);
  });

  it('breaks stale lock from dead PID', () => {
    // Write a lock file with a PID that doesn't exist
    const lockPath = join(dir, 'lock');
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, acquiredAt: new Date().toISOString() }));
    // Should break the stale lock and succeed
    assert.equal(acquireLock(dir), true);
  });
});
