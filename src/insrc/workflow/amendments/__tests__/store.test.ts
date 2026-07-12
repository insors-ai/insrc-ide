/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Amendment on-disk store — proposal + approval + rejection +
 * immutability + id generation.
 *
 * Run:
 *   npx tsx --test src/insrc/workflow/amendments/__tests__/store.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	AmendmentIdConflictError,
	AmendmentImmutabilityError,
	AmendmentNotFoundError,
	approveAmendment,
	listAmendments,
	listApprovedAmendments,
	nextAmendmentId,
	proposeAmendment,
	readAmendment,
	rejectAmendment,
} from '../store.js';
import type { Amendment, AmendmentRecord } from '../types.js';

const AMENDMENT: Amendment = {
	type: 'sharedContract.fieldAdd',
	contractId: 'sc1',
	field: { name: 'sortBy', type: 'string', optional: true, purpose: 'sort order' },
	breaking: false,
};

function record(overrides: Partial<AmendmentRecord> = {}): AmendmentRecord {
	return {
		id:           'amend-test-1',
		epicSlug:     'test',
		hldBaseRunId: 'base-1',
		amendment:    AMENDMENT,
		rationale:    'need sort order',
		citations:    [],
		proposedBy:   { workflow: 'design.story', runId: 'lld-1', storyId: 's2', stepId: 's4' },
		proposedAt:   '2026-07-12T00:00:00Z',
		status:       'pending',
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// nextAmendmentId
// ---------------------------------------------------------------------------

test('nextAmendmentId starts at 1 in an empty repo', () => {
	const repo = mkdtempSync(join(tmpdir(), 'insrc-amend-'));
	try {
		assert.equal(nextAmendmentId(repo, 'my-epic'), 'amend-my-epic-1');
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

test('nextAmendmentId advances past existing entries', () => {
	const repo = mkdtempSync(join(tmpdir(), 'insrc-amend-'));
	try {
		proposeAmendment(repo, record({ id: 'amend-test-1' }));
		proposeAmendment(repo, record({ id: 'amend-test-3' }));
		assert.equal(nextAmendmentId(repo, 'test'), 'amend-test-4');
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// propose
// ---------------------------------------------------------------------------

test('proposeAmendment writes a record then readAmendment returns it', () => {
	const repo = mkdtempSync(join(tmpdir(), 'insrc-amend-'));
	try {
		proposeAmendment(repo, record());
		const back = readAmendment(repo, 'test', 'amend-test-1');
		assert.equal(back.id, 'amend-test-1');
		assert.equal(back.status, 'pending');
		assert.equal(back.amendment.type, 'sharedContract.fieldAdd');
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

test('proposeAmendment refuses duplicate ids', () => {
	const repo = mkdtempSync(join(tmpdir(), 'insrc-amend-'));
	try {
		proposeAmendment(repo, record());
		assert.throws(
			() => proposeAmendment(repo, record()),
			(err: Error) => err instanceof AmendmentIdConflictError,
		);
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

test('proposeAmendment refuses non-pending status at write time', () => {
	const repo = mkdtempSync(join(tmpdir(), 'insrc-amend-'));
	try {
		assert.throws(() => proposeAmendment(repo, record({ status: 'approved' })));
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// approve / reject
// ---------------------------------------------------------------------------

test('approveAmendment sets status + approvedAt + approvedBy', () => {
	const repo = mkdtempSync(join(tmpdir(), 'insrc-amend-'));
	try {
		proposeAmendment(repo, record());
		const back = approveAmendment(repo, 'test', 'amend-test-1', 'alice');
		assert.equal(back.status, 'approved');
		assert.equal(back.approvedBy, 'alice');
		assert.match(back.approvedAt!, /^\d{4}-\d{2}-\d{2}T/);
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

test('approveAmendment refuses double-approve', () => {
	const repo = mkdtempSync(join(tmpdir(), 'insrc-amend-'));
	try {
		proposeAmendment(repo, record());
		approveAmendment(repo, 'test', 'amend-test-1', 'alice');
		assert.throws(
			() => approveAmendment(repo, 'test', 'amend-test-1', 'alice'),
			(err: Error) => err instanceof AmendmentImmutabilityError,
		);
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

test('rejectAmendment refuses missing reason', () => {
	const repo = mkdtempSync(join(tmpdir(), 'insrc-amend-'));
	try {
		proposeAmendment(repo, record());
		assert.throws(() => rejectAmendment(repo, 'test', 'amend-test-1', ''));
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

test('rejectAmendment refuses on approved records', () => {
	const repo = mkdtempSync(join(tmpdir(), 'insrc-amend-'));
	try {
		proposeAmendment(repo, record());
		approveAmendment(repo, 'test', 'amend-test-1', 'alice');
		assert.throws(
			() => rejectAmendment(repo, 'test', 'amend-test-1', 'x'),
			(err: Error) => err instanceof AmendmentImmutabilityError,
		);
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// list / listApproved
// ---------------------------------------------------------------------------

test('listAmendments returns records in id-suffix order', () => {
	const repo = mkdtempSync(join(tmpdir(), 'insrc-amend-'));
	try {
		proposeAmendment(repo, record({ id: 'amend-test-2' }));
		proposeAmendment(repo, record({ id: 'amend-test-1' }));
		proposeAmendment(repo, record({ id: 'amend-test-10' }));
		const rows = listAmendments(repo, 'test');
		assert.deepEqual(rows.map(r => r.id), ['amend-test-1', 'amend-test-2', 'amend-test-10']);
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

test('listApprovedAmendments filters + sorts by approvedAt', async () => {
	const repo = mkdtempSync(join(tmpdir(), 'insrc-amend-'));
	try {
		proposeAmendment(repo, record({ id: 'amend-test-1' }));
		proposeAmendment(repo, record({ id: 'amend-test-2' }));
		proposeAmendment(repo, record({ id: 'amend-test-3' }));
		proposeAmendment(repo, record({ id: 'amend-test-4' }));
		// Approve 3 → 1 with small waits to ensure distinct timestamps.
		approveAmendment(repo, 'test', 'amend-test-3', 'a');
		await new Promise(r => setTimeout(r, 5));
		approveAmendment(repo, 'test', 'amend-test-1', 'a');
		// Leave -2 pending and reject -4 to check the filter.
		rejectAmendment(repo, 'test', 'amend-test-4', 'nope');
		const rows = listApprovedAmendments(repo, 'test');
		assert.deepEqual(rows.map(r => r.id), ['amend-test-3', 'amend-test-1']);
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// readAmendment errors
// ---------------------------------------------------------------------------

test('readAmendment throws when record is missing', () => {
	const repo = mkdtempSync(join(tmpdir(), 'insrc-amend-'));
	try {
		assert.throws(
			() => readAmendment(repo, 'test', 'nope'),
			(err: Error) => err instanceof AmendmentNotFoundError,
		);
	} finally { rmSync(repo, { recursive: true, force: true }); }
});
