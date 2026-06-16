/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Sub-meta-task composability tests. Scripts a parent meta-task that invokes
 * a child meta-task as part of its phase-2; verifies:
 *   - Child writes under `<parentRoot>/sub-<n>-<templateId>/`.
 *   - Child sees parent's deliverable catalog (via parentCatalog snapshot).
 *   - Child's `meta.json` records `parentMetaTaskId`.
 *   - Child does NOT emit a terminal `done` event (would close the IPC
 *     stream the parent is sharing).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LLMProvider, LLMResponse } from '../../shared/types.js';
import { runSubMetaTask } from '../sub-meta-task.js';
import { MetaTaskStore } from '../persist.js';
import { MetaTaskEmitter } from '../event-emitter.js';
import { PATHS } from '../../shared/paths.js';
import type { OutboundMessage } from '../event-emitter.js';
import type { DeliverableCatalogEntry } from '../types.js';

// Bootstrap the template registry.
import '../templates/index.js';


class ScriptedCloud implements LLMProvider {
	private idx = 0;
	constructor(private readonly responses: readonly string[]) {}
	async complete(_messages: unknown, opts?: { onToken?: (t: string) => void }): Promise<LLMResponse> {
		const text = this.responses[this.idx++] ?? '';
		if (opts?.onToken !== undefined) { opts.onToken(text); }
		return { text, stopReason: 'end_turn' };
	}
	stream(): AsyncIterable<string> { return (async function* () { yield ''; })(); }
	async embed(): Promise<number[]> { return []; }
}

class FakeTodosApi {
	calls: string[] = [];
	private c = 0;
	async createList(opts: { title: string }): Promise<{ id: string }> {
		this.calls.push(`createList:${opts.title}`); return { id: `list-${++this.c}` };
	}
	async addItem(_listId: string, opts: { title: string }): Promise<{ id: string }> {
		this.calls.push(`addItem:${opts.title}`); return { id: `item-${++this.c}` };
	}
	async markInProgress(itemId: string): Promise<unknown> { this.calls.push(`markInProgress:${itemId}`); return {}; }
	async markComplete(itemId: string): Promise<unknown> { this.calls.push(`markComplete:${itemId}`); return {}; }
	async markBlocked(itemId: string, reason: string): Promise<unknown> { this.calls.push(`markBlocked:${itemId}:${reason}`); return {}; }
	async updateListBody(_listId: string, _body: string): Promise<unknown> { return {}; }
}

function setupEnv(): { home: string; restore: () => void } {
	const home = mkdtempSync(join(tmpdir(), 'mt-sub-'));
	const restore = process.env.HOME;
	process.env.HOME = home;
	const originalMeta = PATHS.meta;
	(PATHS as { meta: string }).meta = join(home, '.insrc', 'meta');
	return {
		home,
		restore: () => {
			(PATHS as { meta: string }).meta = originalMeta;
			if (restore !== undefined) { process.env.HOME = restore; }
			try { rmSync(home, { recursive: true, force: true }); } catch { /* skip */ }
		},
	};
}

function makeEmitter(): { emit: MetaTaskEmitter; todos: FakeTodosApi; events: OutboundMessage[] } {
	const events: OutboundMessage[] = [];
	const todos = new FakeTodosApi();
	const emit = new MetaTaskEmitter({
		send: msg => events.push(msg),
		todos: todos as unknown as MetaTaskEmitter['todos'],
	});
	return { emit, todos, events };
}


test('runSubMetaTask: writes under parent persist root in sub-NN-templateId/', async () => {
	const env = setupEnv();
	try {
		const { emit } = makeEmitter();
		// Pre-allocate the parent's store so the sub-task derives from it.
		const parentStore = new MetaTaskStore('mt-parent-1');
		await parentStore.writeMeta({
			metaTaskId:        'mt-parent-1',
			templateId:        'review',
			intent:             'parent',
			scope: {
				intent: 'parent', repoPath: env.home, inScopeGlobs: ['**'], outOfScopePaths: [],
			},
			worktreeMode:       'none',
			startedAt:          new Date().toISOString(),
			planRevisionCount:  0,
		});

		const cloud = new ScriptedCloud([
			JSON.stringify({ kind: 'sufficient' }),
			JSON.stringify({ kind: 'deliverable', body: '# Sub review\n\n## Findings\n- Sub' }),
		]);
		const result = await runSubMetaTask({
			templateId: 'review',
			intent:     'child',
			scope: {
				intent: 'child', repoPath: env.home, inScopeGlobs: ['**'], outOfScopePaths: [],
			},
			sessionId:      'sess-sub-1',
			emit,
			cloud,
			embed:           async () => [],
			parentStore,
			parentStepIndex: 3,
			parentCatalog:   [],
			allocId:         () => 'mt-child-1',
		});

		assert.equal(result.outcome, 'completed');

		// Child files live under the parent's root in sub-03-review/.
		const childRoot = join(parentStore.root, 'sub-03-review');
		assert.ok(existsSync(join(childRoot, 'meta.json')));
		assert.ok(existsSync(join(childRoot, 'plan.json')));
		const childMeta = JSON.parse(readFileSync(join(childRoot, 'meta.json'), 'utf8'));
		assert.equal(childMeta.metaTaskId,       'mt-child-1');
		assert.equal(childMeta.parentMetaTaskId, 'mt-parent-1');
		assert.equal(childMeta.templateId,       'review');
	} finally {
		env.restore();
	}
});


test('runSubMetaTask: child catalog seeds with parent catalog snapshot', async () => {
	const env = setupEnv();
	try {
		const { emit } = makeEmitter();
		const parentStore = new MetaTaskStore('mt-parent-2');

		const parentCatalog: DeliverableCatalogEntry[] = [
			{ id: 'step-01-something', label: 'Parent step',
			  headings: ['Title'], bytes: 100, absPath: '/tmp/parent.md' },
		];

		// We can't directly inspect the catalog from outside the orchestrator,
		// but we can verify the sub-task ran successfully when its phase-1 is
		// 'sufficient' (i.e., it doesn't need to consume the catalog) -- this
		// gates that the orchestrator at least accepted the parentCatalog input
		// without rejecting on type / shape.
		const cloud = new ScriptedCloud([
			JSON.stringify({ kind: 'sufficient' }),
			JSON.stringify({ kind: 'deliverable', body: '# Done\n\n## Findings\n- Ok' }),
		]);
		const result = await runSubMetaTask({
			templateId: 'review',
			intent:     'child-with-catalog',
			scope: {
				intent: 'child', repoPath: env.home, inScopeGlobs: ['**'], outOfScopePaths: [],
			},
			sessionId:      'sess-sub-2',
			emit,
			cloud,
			embed:           async () => [],
			parentStore,
			parentStepIndex: 1,
			parentCatalog,
			allocId:         () => 'mt-child-2',
		});
		assert.equal(result.outcome, 'completed');
	} finally {
		env.restore();
	}
});


test('runSubMetaTask: child does NOT emit terminal done event', async () => {
	const env = setupEnv();
	try {
		const { emit, events } = makeEmitter();
		const parentStore = new MetaTaskStore('mt-parent-3');
		const cloud = new ScriptedCloud([
			JSON.stringify({ kind: 'sufficient' }),
			JSON.stringify({ kind: 'deliverable', body: '# Sub\n\n## Findings\n- Ok' }),
		]);
		await runSubMetaTask({
			templateId: 'review',
			intent:     'child',
			scope: {
				intent: 'child', repoPath: env.home, inScopeGlobs: ['**'], outOfScopePaths: [],
			},
			sessionId:      'sess-sub-3',
			emit,
			cloud,
			embed:           async () => [],
			parentStore,
			parentStepIndex: 2,
			parentCatalog:   [],
			allocId:         () => 'mt-child-3',
		});
		// Parent owns the stream terminal signal. Child must not emit `done`.
		const streams = events.map(e => e.stream);
		assert.ok(!streams.includes('done'),
			`sub-meta-task emitted 'done' which would close parent IPC stream`);
		// progress + liveStep are expected.
		assert.ok(streams.includes('progress'));
		assert.ok(streams.includes('liveStep'));
	} finally {
		env.restore();
	}
});


test('runSubMetaTask: child abort returns abort outcome without emitting done', async () => {
	const env = setupEnv();
	try {
		const { emit, events } = makeEmitter();
		const parentStore = new MetaTaskStore('mt-parent-4');
		const cloud = new ScriptedCloud([
			JSON.stringify({ kind: 'sufficient' }),
			JSON.stringify({
				kind:       'abort',
				reason:     'child cannot proceed',
				resolution: 'plan-revisable',
			}),
		]);
		const result = await runSubMetaTask({
			templateId: 'review',
			intent:     'child',
			scope: {
				intent: 'child', repoPath: env.home, inScopeGlobs: ['**'], outOfScopePaths: [],
			},
			sessionId:      'sess-sub-4',
			emit,
			cloud,
			embed:           async () => [],
			parentStore,
			parentStepIndex: 1,
			parentCatalog:   [],
			allocId:         () => 'mt-child-4',
		});
		assert.equal(result.outcome, 'aborted');
		assert.ok(result.abortReason!.includes('plan-revisable'));
		// Even on abort, sub-task must not close the parent's stream.
		assert.ok(!events.map(e => e.stream).includes('done'));
	} finally {
		env.restore();
	}
});
