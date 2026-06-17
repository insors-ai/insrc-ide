/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for the Layer 3 confirm toast's pure state machine (memory-context
 * M1.6.c). The DOM renderer is excluded -- exercising it requires a
 * workbench host. The `nextState` transition function is the part the
 * UX correctness hinges on; this suite pins every reachable transition.
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { nextState, type ToastAction, type ToastState } from '../../browser/chat/chatLayer3ConfirmToast.js';


function showing(text = 'Always include unit tests.'): ToastState {
	return { kind: 'showing', canonicalText: text };
}


suite('chatLayer3ConfirmToast: nextState', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ---------------------------------------------------------------------
	// showing -> submitting
	// ---------------------------------------------------------------------

	test('showing + save -> submitting accept', () => {
		const next = nextState(showing(), { kind: 'save' });
		assert.equal(next.kind, 'submitting');
		assert.equal((next as { verdict: string }).verdict, 'accept');
	});

	test('showing + discard -> submitting discard', () => {
		const next = nextState(showing(), { kind: 'discard' });
		assert.equal(next.kind, 'submitting');
		assert.equal((next as { verdict: string }).verdict, 'discard');
	});


	// ---------------------------------------------------------------------
	// showing -> editing
	// ---------------------------------------------------------------------

	test('showing + customize -> editing (carries canonical text)', () => {
		const next = nextState(showing('original text'), { kind: 'customize' });
		assert.equal(next.kind, 'editing');
		assert.equal((next as { canonicalText: string }).canonicalText, 'original text');
	});


	// ---------------------------------------------------------------------
	// editing transitions
	// ---------------------------------------------------------------------

	test('editing + editor-cancel -> showing (restores original text)', () => {
		const edit: ToastState = { kind: 'editing', canonicalText: 'original' };
		const next = nextState(edit, { kind: 'editor-cancel' });
		assert.equal(next.kind, 'showing');
		assert.equal((next as { canonicalText: string }).canonicalText, 'original');
	});

	test('editing + editor-save -> submitting accept (with edited text)', () => {
		const edit: ToastState = { kind: 'editing', canonicalText: 'original' };
		const action: ToastAction = { kind: 'editor-save', canonicalText: 'edited canonical text' };
		const next = nextState(edit, action);
		assert.equal(next.kind, 'submitting');
		assert.equal((next as { verdict: string }).verdict, 'accept');
		assert.equal((next as { canonicalText?: string }).canonicalText, 'edited canonical text');
	});

	test('editing + editor-save with empty string -> stays in editing (no submit)', () => {
		const edit: ToastState = { kind: 'editing', canonicalText: 'original' };
		const next = nextState(edit, { kind: 'editor-save', canonicalText: '' });
		assert.equal(next.kind, 'editing', 'empty save should be ignored');
	});

	test('editing + discard -> submitting discard (skip editor)', () => {
		const edit: ToastState = { kind: 'editing', canonicalText: 'original' };
		const next = nextState(edit, { kind: 'discard' });
		assert.equal(next.kind, 'submitting');
		assert.equal((next as { verdict: string }).verdict, 'discard');
	});


	// ---------------------------------------------------------------------
	// submitting transitions
	// ---------------------------------------------------------------------

	test('submitting + submit-ok -> persisted (preserves verdict)', () => {
		const sub: ToastState = { kind: 'submitting', verdict: 'accept' };
		const next = nextState(sub, { kind: 'submit-ok' });
		assert.equal(next.kind, 'persisted');
		assert.equal((next as { verdict: string }).verdict, 'accept');
	});

	test('submitting (discard) + submit-ok -> persisted discard', () => {
		const sub: ToastState = { kind: 'submitting', verdict: 'discard' };
		const next = nextState(sub, { kind: 'submit-ok' });
		assert.equal(next.kind, 'persisted');
		assert.equal((next as { verdict: string }).verdict, 'discard');
	});

	test('submitting + submit-failed -> failed (with error message)', () => {
		const sub: ToastState = { kind: 'submitting', verdict: 'accept' };
		const next = nextState(sub, { kind: 'submit-failed', error: 'daemon down' });
		assert.equal(next.kind, 'failed');
		assert.equal((next as { error: string }).error, 'daemon down');
	});


	// ---------------------------------------------------------------------
	// terminal states ignore further actions
	// ---------------------------------------------------------------------

	test('persisted ignores all actions', () => {
		const term: ToastState = { kind: 'persisted', verdict: 'accept' };
		assert.deepEqual(nextState(term, { kind: 'save' }), term);
		assert.deepEqual(nextState(term, { kind: 'discard' }), term);
		assert.deepEqual(nextState(term, { kind: 'customize' }), term);
	});

	test('failed ignores all but Retry handled by widget (state stays put)', () => {
		const term: ToastState = { kind: 'failed', error: 'boom' };
		assert.deepEqual(nextState(term, { kind: 'save' }), term);
		assert.deepEqual(nextState(term, { kind: 'discard' }), term);
	});


	// ---------------------------------------------------------------------
	// invariants
	// ---------------------------------------------------------------------

	test('unknown action on showing is a no-op', () => {
		const s = showing();
		const next = nextState(s, { kind: 'editor-cancel' });  // not a 'showing' action
		assert.deepEqual(next, s);
	});

	test('unknown action on editing is a no-op', () => {
		const e: ToastState = { kind: 'editing', canonicalText: 'x' };
		const next = nextState(e, { kind: 'save' });  // not an 'editing' action
		assert.deepEqual(next, e);
	});
});
