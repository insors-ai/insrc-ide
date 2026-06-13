/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runMachineChecks } from '../audit/machine-checks.js';
import type { AcceptanceCriterion } from '../types.js';

function makeTmp(): string {
	return mkdtempSync(join(tmpdir(), 'insrc-machine-checks-test-'));
}

// ---------------------------------------------------------------------------
// Soft criteria
// ---------------------------------------------------------------------------

test('runMachineChecks: soft criteria are skipped (not run) with explanatory detail', async () => {
	const tmp = makeTmp();
	const out = await runMachineChecks(
		[{ id: 'soft.x', description: 'judged later', kind: 'soft' }],
		{ cwd: tmp },
	);
	assert.equal(out.length, 1);
	assert.equal(out[0]!.status, 'skipped');
	assert.equal(out[0]!.kind,   'soft');
	assert.match(out[0]!.detail, /soft criterion/);
});

// ---------------------------------------------------------------------------
// file-exists
// ---------------------------------------------------------------------------

test('runMachineChecks: file-exists pass on a present file', async () => {
	const tmp = makeTmp();
	writeFileSync(join(tmp, 'dist.txt'), 'x');
	const out = await runMachineChecks(
		[{ id: 'machine.exists', description: 'd', kind: 'machine',
			verifier: { type: 'file-exists', path: 'dist.txt' } }],
		{ cwd: tmp },
	);
	assert.equal(out[0]!.status, 'pass');
	assert.match(out[0]!.detail, /dist\.txt exists/);
});

test('runMachineChecks: file-exists fail on missing file', async () => {
	const tmp = makeTmp();
	const out = await runMachineChecks(
		[{ id: 'machine.exists', description: 'd', kind: 'machine',
			verifier: { type: 'file-exists', path: 'missing.txt' } }],
		{ cwd: tmp },
	);
	assert.equal(out[0]!.status, 'fail');
	assert.match(out[0]!.detail, /missing\.txt does not exist/);
});

test('runMachineChecks: file-exists honors absolute paths', async () => {
	const tmp = makeTmp();
	writeFileSync(join(tmp, 'abs.txt'), 'x');
	const out = await runMachineChecks(
		[{ id: 'machine.exists', description: 'd', kind: 'machine',
			verifier: { type: 'file-exists', path: join(tmp, 'abs.txt') } }],
		{ cwd: '/some/other/cwd' },
	);
	assert.equal(out[0]!.status, 'pass');
});

// ---------------------------------------------------------------------------
// regex-match
// ---------------------------------------------------------------------------

test('runMachineChecks: regex-match pass when pattern is in the file', async () => {
	const tmp = makeTmp();
	writeFileSync(join(tmp, 'README.md'), '# insrc\n\nthings\n');
	const out = await runMachineChecks(
		[{ id: 'machine.banner', description: 'd', kind: 'machine',
			verifier: { type: 'regex-match', path: 'README.md', pattern: '^# insrc' } }],
		{ cwd: tmp },
	);
	assert.equal(out[0]!.status, 'pass');
});

test('runMachineChecks: regex-match fail when pattern absent', async () => {
	const tmp = makeTmp();
	writeFileSync(join(tmp, 'README.md'), '# nope\n');
	const out = await runMachineChecks(
		[{ id: 'machine.banner', description: 'd', kind: 'machine',
			verifier: { type: 'regex-match', path: 'README.md', pattern: '^# insrc' } }],
		{ cwd: tmp },
	);
	assert.equal(out[0]!.status, 'fail');
	assert.match(out[0]!.detail, /did not match/);
});

test('runMachineChecks: regex-match fail when file is missing', async () => {
	const tmp = makeTmp();
	const out = await runMachineChecks(
		[{ id: 'machine.banner', description: 'd', kind: 'machine',
			verifier: { type: 'regex-match', path: 'missing.md', pattern: '.' } }],
		{ cwd: tmp },
	);
	assert.equal(out[0]!.status, 'fail');
	assert.match(out[0]!.detail, /cannot regex-match/);
});

test('runMachineChecks: regex-match fail on an invalid regex (no throw)', async () => {
	const tmp = makeTmp();
	writeFileSync(join(tmp, 'f.txt'), 'x');
	const out = await runMachineChecks(
		[{ id: 'machine.bad', description: 'd', kind: 'machine',
			verifier: { type: 'regex-match', path: 'f.txt', pattern: '*(invalid' } }],
		{ cwd: tmp },
	);
	assert.equal(out[0]!.status, 'fail');
	assert.match(out[0]!.detail, /invalid regex/);
});

// ---------------------------------------------------------------------------
// shell-exit
// ---------------------------------------------------------------------------

test('runMachineChecks: shell-exit pass on exit 0', async () => {
	const tmp = makeTmp();
	const out = await runMachineChecks(
		[{ id: 'machine.true', description: 'd', kind: 'machine',
			verifier: { type: 'shell-exit', command: 'true' } }],
		{ cwd: tmp },
	);
	assert.equal(out[0]!.status, 'pass');
});

test('runMachineChecks: shell-exit fail on non-zero exit; stderr tail captured', async () => {
	const tmp = makeTmp();
	const out = await runMachineChecks(
		[{ id: 'machine.false', description: 'd', kind: 'machine',
			verifier: { type: 'shell-exit', command: 'echo oops 1>&2; exit 7' } }],
		{ cwd: tmp },
	);
	assert.equal(out[0]!.status, 'fail');
	assert.match(out[0]!.detail, /exited 7/);
	assert.match(out[0]!.detail, /stderr: oops/);
});

test('runMachineChecks: shell-exit timeout kill -> fail with timeout detail', async () => {
	const tmp = makeTmp();
	const out = await runMachineChecks(
		[{ id: 'machine.slow', description: 'd', kind: 'machine',
			verifier: { type: 'shell-exit', command: 'sleep 60', timeoutMs: 200 } }],
		{ cwd: tmp },
	);
	assert.equal(out[0]!.status, 'fail');
	assert.match(out[0]!.detail, /timed out after 200ms/);
});

test('runMachineChecks: shell-exit honors per-criterion cwd override', async () => {
	const tmp = makeTmp();
	writeFileSync(join(tmp, 'marker'), 'x');
	const out = await runMachineChecks(
		[{ id: 'machine.cwd', description: 'd', kind: 'machine',
			verifier: { type: 'shell-exit', command: 'test -f marker', cwd: tmp } }],
		{ cwd: '/' },   // global cwd doesn't have marker; per-criterion cwd does.
	);
	assert.equal(out[0]!.status, 'pass');
});

// ---------------------------------------------------------------------------
// Mixed slate
// ---------------------------------------------------------------------------

test('runMachineChecks: mixed slate preserves order and per-criterion isolation', async () => {
	const tmp = makeTmp();
	writeFileSync(join(tmp, 'a.txt'), 'x');
	const list: AcceptanceCriterion[] = [
		{ id: 'a.pass-exists', description: 'd', kind: 'machine',
			verifier: { type: 'file-exists', path: 'a.txt' } },
		{ id: 'b.fail-exists', description: 'd', kind: 'machine',
			verifier: { type: 'file-exists', path: 'missing.txt' } },
		{ id: 'c.soft',        description: 'd', kind: 'soft' },
		{ id: 'd.pass-shell',  description: 'd', kind: 'machine',
			verifier: { type: 'shell-exit', command: 'true' } },
	];
	const out = await runMachineChecks(list, { cwd: tmp });
	assert.equal(out.length, 4);
	assert.equal(out[0]!.status, 'pass');
	assert.equal(out[1]!.status, 'fail');
	assert.equal(out[2]!.status, 'skipped');
	assert.equal(out[3]!.status, 'pass');
});
