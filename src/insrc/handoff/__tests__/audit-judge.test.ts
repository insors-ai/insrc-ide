/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { auditDeliverable } from '../audit/judge.js';
import { DEBUG_SESSION_REQUIRED_SECTIONS } from '../templates/debug-session.js';
import type { AcceptanceCriterion } from '../types.js';

function makeTmp(): string {
	return mkdtempSync(join(tmpdir(), 'insrc-audit-judge-test-'));
}

const FILLED_DELIVERABLE = [
	'# Debug Session Deliverable',
	'',
	'## Reproduce',
	'ran the test',
	'## Localize',
	'beforeEach race',
	'## Hypothesize',
	'awaiting setUp mock',
	'## Test',
	'100/100 passes after fix',
	'## Conclude',
	'fix applied; root cause: missing await',
].join('\n');

const NO_CRITERIA: readonly AcceptanceCriterion[] = [];

// ---------------------------------------------------------------------------
// Verdict: accept
// ---------------------------------------------------------------------------

test('auditDeliverable: filled deliverable + no criteria -> accept', async () => {
	const tmp = makeTmp();
	const r = await auditDeliverable({
		deliverable:        FILLED_DELIVERABLE,
		requiredSections:   DEBUG_SESSION_REQUIRED_SECTIONS,
		acceptanceCriteria: NO_CRITERIA,
		cwd:                tmp,
	});
	assert.equal(r.verdict, 'accept');
	assert.match(r.reason, /All required sections filled/);
	assert.deepEqual(r.editHints, []);
});

test('auditDeliverable: filled deliverable + all machine criteria pass -> accept', async () => {
	const tmp = makeTmp();
	writeFileSync(join(tmp, 'fix.patch'), 'x');
	const r = await auditDeliverable({
		deliverable:        FILLED_DELIVERABLE,
		requiredSections:   DEBUG_SESSION_REQUIRED_SECTIONS,
		acceptanceCriteria: [
			{ id: 'm.exists', description: 'fix written', kind: 'machine',
				verifier: { type: 'file-exists', path: 'fix.patch' } },
		],
		cwd:                tmp,
	});
	assert.equal(r.verdict, 'accept');
});

test('auditDeliverable: filled deliverable + only soft criteria -> accept; soft listed as skipped', async () => {
	const tmp = makeTmp();
	const r = await auditDeliverable({
		deliverable:        FILLED_DELIVERABLE,
		requiredSections:   DEBUG_SESSION_REQUIRED_SECTIONS,
		acceptanceCriteria: [
			{ id: 'soft.x', description: 'judged later', kind: 'soft' },
		],
		cwd:                tmp,
	});
	assert.equal(r.verdict, 'accept');
	assert.equal(r.machineResults[0]!.status, 'skipped');
});

// ---------------------------------------------------------------------------
// Verdict: revise-edits
// ---------------------------------------------------------------------------

test('auditDeliverable: filled sections but a machine criterion fails -> revise-edits', async () => {
	const tmp = makeTmp();
	const r = await auditDeliverable({
		deliverable:        FILLED_DELIVERABLE,
		requiredSections:   DEBUG_SESSION_REQUIRED_SECTIONS,
		acceptanceCriteria: [
			{ id: 'm.test-passes', description: 'test passes', kind: 'machine',
				verifier: { type: 'shell-exit', command: 'false' } },
		],
		cwd:                tmp,
	});
	assert.equal(r.verdict, 'revise-edits');
	assert.match(r.reason, /1 machine criteria failed/);
	assert.equal(r.editHints.length, 1);
	assert.match(r.editHints[0]!, /m\.test-passes/);
});

test('auditDeliverable: a section is empty/placeholder -> revise-edits with a section-fill hint', async () => {
	const tmp = makeTmp();
	const partial = [
		'## Reproduce', 'real body',
		'## Localize', '<TODO>',
		'## Hypothesize', 'real',
		'## Test', 'real',
		'## Conclude', 'real',
	].join('\n');
	const r = await auditDeliverable({
		deliverable:        partial,
		requiredSections:   DEBUG_SESSION_REQUIRED_SECTIONS,
		acceptanceCriteria: NO_CRITERIA,
		cwd:                tmp,
	});
	assert.equal(r.verdict, 'revise-edits');
	assert.match(r.reason, /empty\/placeholder sections.*'## Localize'/);
	assert.equal(r.editHints.length, 1);
	assert.match(r.editHints[0]!, /Fill the empty '## Localize'/);
});

test('auditDeliverable: empty section + machine fail combine into a single revise-edits with multiple hints', async () => {
	const tmp = makeTmp();
	const partial = [
		'## Reproduce', '<TODO>',
		'## Localize', 'real',
		'## Hypothesize', 'real',
		'## Test', 'real',
		'## Conclude', 'real',
	].join('\n');
	const r = await auditDeliverable({
		deliverable:        partial,
		requiredSections:   DEBUG_SESSION_REQUIRED_SECTIONS,
		acceptanceCriteria: [
			{ id: 'm.test', description: 'tests pass', kind: 'machine',
				verifier: { type: 'shell-exit', command: 'false' } },
		],
		cwd:                tmp,
	});
	assert.equal(r.verdict, 'revise-edits');
	assert.match(r.reason, /empty\/placeholder/);
	assert.match(r.reason, /1 machine criteria failed/);
	assert.equal(r.editHints.length, 2);
});

// ---------------------------------------------------------------------------
// Verdict: revise-major
// ---------------------------------------------------------------------------

test('auditDeliverable: a required section is missing entirely -> revise-major', async () => {
	const tmp = makeTmp();
	const partial = [
		'## Reproduce', 'real',
		'## Conclude', 'real',
		// missing Localize, Hypothesize, Test
	].join('\n');
	const r = await auditDeliverable({
		deliverable:        partial,
		requiredSections:   DEBUG_SESSION_REQUIRED_SECTIONS,
		acceptanceCriteria: NO_CRITERIA,
		cwd:                tmp,
	});
	assert.equal(r.verdict, 'revise-major');
	assert.match(r.reason, /missing required sections.*'## Localize'.*'## Hypothesize'.*'## Test'/);
	// Each missing section gets an "Add the missing" hint at the FRONT of editHints.
	const adds = r.editHints.filter(h => /^Add the missing '## /.test(h));
	assert.equal(adds.length, 3);
});

test('auditDeliverable: empty deliverable -> revise-major (all required missing)', async () => {
	const tmp = makeTmp();
	const r = await auditDeliverable({
		deliverable:        '',
		requiredSections:   DEBUG_SESSION_REQUIRED_SECTIONS,
		acceptanceCriteria: NO_CRITERIA,
		cwd:                tmp,
	});
	assert.equal(r.verdict, 'revise-major');
	assert.equal(r.parse.missing.length, DEBUG_SESSION_REQUIRED_SECTIONS.length);
});

// ---------------------------------------------------------------------------
// Result wiring
// ---------------------------------------------------------------------------

test('auditDeliverable: parse + machineResults exposed on result for downstream consumption', async () => {
	const tmp = makeTmp();
	const r = await auditDeliverable({
		deliverable:        FILLED_DELIVERABLE,
		requiredSections:   DEBUG_SESSION_REQUIRED_SECTIONS,
		acceptanceCriteria: [
			{ id: 'm.true', description: 'd', kind: 'machine',
				verifier: { type: 'shell-exit', command: 'true' } },
			{ id: 'soft.x', description: 'd', kind: 'soft' },
		],
		cwd:                tmp,
	});
	assert.equal(r.parse.allRequiredFilled, true);
	assert.equal(r.machineResults.length, 2);
	assert.equal(r.machineResults[0]!.status, 'pass');
	assert.equal(r.machineResults[1]!.status, 'skipped');
});
