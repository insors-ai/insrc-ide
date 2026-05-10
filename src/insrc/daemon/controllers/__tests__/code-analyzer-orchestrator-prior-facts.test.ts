/**
 * Tests for the chat-handler -> orchestrator priorFacts handoff
 * (conversation-flow-refinement.md Phase 4).
 *
 * `readPriorFactsTag` is the orchestrator's read side of the
 * `[priorContext:current]` tag the chat-handler stamps after running
 * the resolve+retrieve+enhance pipeline. It MUST tolerate every
 * shape the chat-handler might ever leave behind -- missing tag,
 * malformed JSON, empty `facts`, or a populated facts payload --
 * because a misread starves the meta-skills of their friendly-label
 * context (the original HDFS-Core regression).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { _readPriorFactsTagForTest as readPriorFactsTag } from '../code-analyzer-orchestrator.js';
import { PRIOR_CONTEXT_TAG_CURRENT } from '../../../agent/intent/retriever.js';
import type { Session } from '../../../agent/session.js';

function fakeSession(initialTagValue?: string): Session {
	const tags = new Map<string, string>();
	if (initialTagValue !== undefined) {
		tags.set(PRIOR_CONTEXT_TAG_CURRENT, initialTagValue);
	}
	return {
		id: 'session-X',
		contextManager: {
			setTag: (k: string, v: string) => { tags.set(k, v); },
			getTag: (k: string) => tags.get(k) ?? '',
		},
	} as unknown as Session;
}

test('readPriorFactsTag: missing tag -> undefined', () => {
	const session = fakeSession();
	assert.equal(readPriorFactsTag(session), undefined);
});

test('readPriorFactsTag: empty string tag -> undefined', () => {
	const session = fakeSession('');
	assert.equal(readPriorFactsTag(session), undefined);
});

test('readPriorFactsTag: malformed JSON -> undefined (no throw)', () => {
	const session = fakeSession('{not valid json');
	assert.equal(readPriorFactsTag(session), undefined);
});

test('readPriorFactsTag: parsed but no facts -> undefined', () => {
	const session = fakeSession(JSON.stringify({ artifactCount: 4 }));
	assert.equal(readPriorFactsTag(session), undefined);
});

test('readPriorFactsTag: empty facts buckets -> undefined', () => {
	const session = fakeSession(JSON.stringify({
		facts: { modules: [], entities: [], tables: [], ormModels: [] },
	}));
	assert.equal(readPriorFactsTag(session), undefined);
});

test('readPriorFactsTag: populated modules -> returns facts', () => {
	const session = fakeSession(JSON.stringify({
		currentIntent: 'code-analysis',
		intentChanged: false,
		facts: {
			modules: [
				{ path: '/repo/hadoop-hdfs', label: 'HDFS Core', fileCount: 240 },
			],
		},
	}));
	const out = readPriorFactsTag(session);
	assert.ok(out !== undefined);
	assert.equal(out.modules?.length, 1);
	assert.equal(out.modules?.[0]?.path, '/repo/hadoop-hdfs');
	assert.equal(out.modules?.[0]?.label, 'HDFS Core');
});

test('readPriorFactsTag: populated entities + tables + ormModels -> returns facts', () => {
	const session = fakeSession(JSON.stringify({
		facts: {
			entities:  [{ entityRef: 'a', name: 'compute', kind: 'function' }],
			tables:    [{ connectionId: 'c1', name: 'orders', columns: ['id'] }],
			ormModels: [{ name: 'Order', dialect: 'prisma' }],
		},
	}));
	const out = readPriorFactsTag(session);
	assert.ok(out !== undefined);
	assert.equal(out.entities?.length,  1);
	assert.equal(out.tables?.length,    1);
	assert.equal(out.ormModels?.length, 1);
});
