/**
 * Assertion-interest index tests -- part of P5.6.
 *
 * Coverage:
 *   - register / lookup round-trip.
 *   - empty interest list deregisters the owner.
 *   - re-registering replaces (not merges) the prior set.
 *   - deregister removes all matches for an owner.
 *   - multi-owner same-subject: lookup returns all matches.
 *   - priority ordering: higher priority first; undefined last; ties by owner.
 *   - unknown subject -> [].
 *   - all() lists every registration.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAssertionIndex } from '../assertion-index.js';

test('register / lookup round-trip', () => {
	const idx = createAssertionIndex();
	idx.register('skill:a', [{ subjectPattern: 'python-indentation', description: 'python indent rules' }]);
	const hits = idx.lookup('python-indentation');
	assert.equal(hits.length, 1);
	assert.equal(hits[0]!.owner, 'skill:a');
});

test('empty interests deregister the owner', () => {
	const idx = createAssertionIndex();
	idx.register('skill:a', [{ subjectPattern: 'x', description: '' }]);
	assert.equal(idx.lookup('x').length, 1);
	idx.register('skill:a', []);
	assert.equal(idx.lookup('x').length, 0);
});

test('re-registering replaces prior set', () => {
	const idx = createAssertionIndex();
	idx.register('skill:a', [{ subjectPattern: 'first', description: '' }]);
	idx.register('skill:a', [{ subjectPattern: 'second', description: '' }]);
	assert.equal(idx.lookup('first').length, 0,  'old subject removed');
	assert.equal(idx.lookup('second').length, 1, 'new subject present');
});

test('deregister removes all matches for an owner', () => {
	const idx = createAssertionIndex();
	idx.register('skill:a', [
		{ subjectPattern: 'x', description: '' },
		{ subjectPattern: 'y', description: '' },
	]);
	idx.register('skill:b', [{ subjectPattern: 'x', description: '' }]);
	idx.deregister('skill:a');
	const hits = idx.lookup('x');
	assert.equal(hits.length, 1);
	assert.equal(hits[0]!.owner, 'skill:b');
	assert.equal(idx.lookup('y').length, 0);
});

test('multi-owner same-subject: lookup returns all matches', () => {
	const idx = createAssertionIndex();
	idx.register('skill:a', [{ subjectPattern: 'naming', description: '' }]);
	idx.register('skill:b', [{ subjectPattern: 'naming', description: '' }]);
	const hits = idx.lookup('naming');
	assert.equal(hits.length, 2);
	const owners = hits.map(h => h.owner).sort();
	assert.deepEqual(owners, ['skill:a', 'skill:b']);
});

test('priority ordering: higher first; undefined last; ties by owner', () => {
	const idx = createAssertionIndex();
	idx.register('skill:low',     [{ subjectPattern: 'x', description: '', priority: 1 }]);
	idx.register('skill:high',    [{ subjectPattern: 'x', description: '', priority: 10 }]);
	idx.register('skill:none-b',  [{ subjectPattern: 'x', description: '' }]);
	idx.register('skill:none-a',  [{ subjectPattern: 'x', description: '' }]);
	idx.register('skill:mid',     [{ subjectPattern: 'x', description: '', priority: 5 }]);

	const hits = idx.lookup('x');
	assert.deepEqual(
		hits.map(h => h.owner),
		['skill:high', 'skill:mid', 'skill:low', 'skill:none-a', 'skill:none-b'],
	);
});

test('unknown subject -> []', () => {
	const idx = createAssertionIndex();
	idx.register('skill:a', [{ subjectPattern: 'x', description: '' }]);
	assert.equal(idx.lookup('not-registered').length, 0);
});

test('all() lists every registration', () => {
	const idx = createAssertionIndex();
	idx.register('skill:a', [{ subjectPattern: 'x', description: '' }, { subjectPattern: 'y', description: '' }]);
	idx.register('skill:b', [{ subjectPattern: 'z', description: '' }]);
	assert.equal(idx.all().length, 3);
});
