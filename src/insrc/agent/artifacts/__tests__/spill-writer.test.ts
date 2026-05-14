/**
 * Tests for the per-session spill-writer
 * (conversation-flow-refinement.md Phase 2).
 *
 * Two layers:
 *
 *   1. Pure helpers -- previewOf / safeSkillIdForPath. Just data
 *      munging.
 *
 *   2. End-to-end: makeSpillHandler -> calls onSkillEnd -> disk
 *      file appears under PATHS.sessionTmp(sessionId). The Lance
 *      side-effect is exercised separately in
 *      `db/lance/__tests__/artifact-vec.test.ts`; here we verify
 *      the writer doesn't BLOCK on a missing Ollama (embed returns
 *      [] -> Lance write skipped; disk write still happens).
 *
 * `purgeSession` is also exercised: it should rm the per-session
 * tmp dir without throwing even when Lance hasn't been touched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeLanceConn, setLanceConnPath } from '../../../db/lance/conn.js';
import { _resetArtifactVecCache } from '../../../db/lance/artifact-vec.js';

import {
	makeSpillHandler,
	purgeSession,
	_previewOfForTest as previewOf,
	_safeSkillIdForPathForTest as safeSkillIdForPath,
	PREVIEW_MAX_BYTES_FOR_TEST,
} from '../spill-writer.js';
import { INTENT_TAG_CURRENT } from '../../intent/resolver.js';
import { PATHS } from '../../../shared/paths.js';
import type { Session } from '../../session.js';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('previewOf: stringifies primitives + objects, handles null', () => {
	assert.equal(previewOf('hello'),         'hello');
	assert.equal(previewOf({ a: 1 }),        '{"a":1}');
	assert.equal(previewOf(null),            '');
	assert.equal(previewOf(undefined),       '');
	assert.equal(previewOf(42),              '42');
});

test('previewOf: gracefully handles unserialisable values', () => {
	const cyclic: Record<string, unknown> = { a: 1 };
	cyclic['self'] = cyclic;
	const out = previewOf(cyclic);
	assert.equal(typeof out, 'string');
});

test('safeSkillIdForPath: replaces / : \\ with _', () => {
	assert.equal(safeSkillIdForPath('code.source.repo.describe'), 'code.source.repo.describe');
	assert.equal(safeSkillIdForPath('a/b\\c:d'), 'a_b_c_d');
});

test('preview cap is sane (smoke check on the constant)', () => {
	assert.ok(PREVIEW_MAX_BYTES_FOR_TEST > 0);
	assert.ok(PREVIEW_MAX_BYTES_FOR_TEST <= 8 * 1024);
});

// ---------------------------------------------------------------------------
// End-to-end: spill + purge
// ---------------------------------------------------------------------------

let dir: string;
let sessionId: string;
let sessionTmpDir: string;

function makeFakeSession(id: string, intent = 'code-analysis'): Session {
	const tags = new Map<string, string>();
	tags.set(INTENT_TAG_CURRENT, intent);
	const stub = {
		id,
		contextManager: {
			setTag: (k: string, v: string) => { tags.set(k, v); },
			getTag: (k: string) => tags.get(k) ?? '',
		},
	} as unknown as Session;
	return stub;
}

test.beforeEach(async () => {
	await closeLanceConn();
	_resetArtifactVecCache();
	dir = mkdtempSync(join(tmpdir(), 'insrc-spill-writer-'));
	setLanceConnPath(join(dir, 'lance'));
	sessionId = 'test-session-' + Math.random().toString(36).slice(2, 10);
	sessionTmpDir = PATHS.sessionTmp(sessionId);
});

test.afterEach(async () => {
	await closeLanceConn();
	_resetArtifactVecCache();
	rmSync(dir, { recursive: true, force: true });
	rmSync(sessionTmpDir, { recursive: true, force: true });
});

test('makeSpillHandler: writes disk JSON under per-session tmp on skill-end', async () => {
	const session = makeFakeSession(sessionId);
	const handler = makeSpillHandler(session);

	await handler({
		skillId:    'code.source.repo.describe',
		input:      { repoPath: '/repo/alpha' },
		value:      { fileCount: 12500, topModules: [{ path: '/repo/alpha/src', fileCount: 30 }] },
		confidence: 'high',
		notes:      [],
		durationMs: 42,
	});

	// At least one file appears under the per-session dir.
	const fs = await import('node:fs');
	const entries = fs.readdirSync(sessionTmpDir);
	assert.equal(entries.length, 1);
	const file = join(sessionTmpDir, entries[0]!);
	assert.match(entries[0]!, /^\d+-code\.source\.repo\.describe\.json$/);

	// JSON envelope contains the expected fields.
	const payload = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
	assert.equal(payload['session_id'], sessionId);
	assert.equal(payload['intent'],     'code-analysis');
	assert.equal(payload['skill_id'],   'code.source.repo.describe');
	assert.deepEqual(payload['skill_input'], { repoPath: '/repo/alpha' });
	const value = payload['value'] as Record<string, unknown>;
	assert.equal(value['fileCount'], 12500);
});

test('makeSpillHandler: swallows writer errors -- caller never throws', async () => {
	// Force a failure path by giving the session a non-string id, which
	// breaks the path resolution. The handler MUST swallow + log.
	const session = makeFakeSession('');   // empty id -> sessionTmp returns the parent tmp dir
	const handler = makeSpillHandler(session);
	// Just assert it doesn't throw -- and that the user-visible behaviour
	// is no exception. We don't assert on logs (those are pino + may be
	// silenced); the contract is the swallow.
	await assert.doesNotReject(async () => {
		await handler({
			skillId:    's',
			input:      {},
			value:      { x: 1 },
			confidence: 'high',
			notes:      [],
			durationMs: 1,
		});
	});
});

test('makeSpillHandler: large value blob is written in full, no truncation', async () => {
	// Phase B.3 of plans/code-analyzer-interleaved-investigation.md:
	// the on-disk cap was removed so the spill is the source of truth
	// for skill_load_page paging.
	const session = makeFakeSession(sessionId);
	const handler = makeSpillHandler(session);

	const hugeStr = 'x'.repeat(512 * 1024); // 512 KB -- well past the old 256 KB cap
	const huge = { huge: hugeStr };
	await handler({
		skillId:    'huge',
		input:      {},
		value:      huge,
		confidence: 'high',
		notes:      [],
		durationMs: 1,
	});

	const fs = await import('node:fs');
	const entries = fs.readdirSync(sessionTmpDir);
	const file = join(sessionTmpDir, entries[0]!);
	const onDisk = readFileSync(file, 'utf8');
	const parsed = JSON.parse(onDisk) as { value: { huge: string } };
	assert.equal(parsed.value.huge.length, hugeStr.length, 'spill must carry the full payload byte-for-byte');
	assert.doesNotMatch(onDisk, /<truncated>$/);
});

test('purgeSession: removes the tmp dir + tolerates empty / missing dirs', async () => {
	const session = makeFakeSession(sessionId);
	const handler = makeSpillHandler(session);
	await handler({
		skillId:    'a', input: {}, value: { x: 1 },
		confidence: 'high', notes: [], durationMs: 1,
	});
	assert.ok(existsSync(sessionTmpDir));

	await purgeSession(session);
	assert.equal(existsSync(sessionTmpDir), false);

	// Second purge against an already-purged session must not throw.
	await assert.doesNotReject(() => purgeSession(session));
});
