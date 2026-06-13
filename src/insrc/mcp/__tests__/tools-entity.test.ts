/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for the 6 `insrc_entity_*` MCP tool handlers.
 *
 * The handlers are exported as named functions that take a stub
 * `RpcFn` so we can verify the daemon method, parameter shape, and
 * result transform without standing up the daemon. End-to-end
 * verification (real daemon, real LMDB / Lance) lives in a separate
 * integration test gated on INSRC_TEST_INTEGRATION.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	entitySearchHandler,
	entitySummaryHandler,
	entityCallersHandler,
	entityCalleesHandler,
	entityClosureHandler,
	entityUnreachableHandler,
} from '../tools/entity.js';
import type { RpcFn } from '../daemon-rpc.js';
import type { Entity } from '../../shared/types.js';

interface RecordedCall {
	readonly method: string;
	readonly params: unknown;
}

function stubRpc(impl: (method: string, params: unknown) => unknown): { rpc: RpcFn; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const rpc: RpcFn = async <T = unknown>(method: string, params: unknown = {}): Promise<T> => {
		calls.push({ method, params });
		return impl(method, params) as T;
	};
	return { rpc, calls };
}

function entity(id: string, kind: string = 'function', repo: string = '/repo'): Entity {
	return {
		id, kind: kind as Entity['kind'], name: `name-${id}`, file: `${repo}/src/x.ts`, repo,
		startLine: 1, endLine: 10,
	} as Entity;
}

function readJsonContent(result: { content: { type: string; text: string }[] }): unknown {
	const c = result.content[0]!;
	assert.equal(c.type, 'text');
	return JSON.parse(c.text);
}

// ---------------------------------------------------------------------------
// insrc_entity_search
// ---------------------------------------------------------------------------

test('entitySearch: calls search.query with filter=code and projects hits', async () => {
	const { rpc, calls } = stubRpc(() => [entity('e1'), entity('e2', 'class')]);
	const res = await entitySearchHandler({ query: 'INGRN', limit: 5 }, rpc);

	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0], { method: 'search.query', params: { text: 'INGRN', limit: 5, filter: 'code' } });
	const payload = readJsonContent(res) as { hits: { entityId: string; kind: string }[] };
	assert.equal(payload.hits.length, 2);
	assert.equal(payload.hits[0]!.entityId, 'e1');
	assert.equal(payload.hits[1]!.kind,     'class');
});

test('entitySearch: kind filter narrows results client-side', async () => {
	const { rpc } = stubRpc(() => [entity('e1', 'function'), entity('e2', 'class'), entity('e3', 'function')]);
	const res = await entitySearchHandler({ query: 'q', limit: 10, kind: 'class' }, rpc);
	const payload = readJsonContent(res) as { hits: { entityId: string }[] };
	assert.equal(payload.hits.length, 1);
	assert.equal(payload.hits[0]!.entityId, 'e2');
});

test('entitySearch: repo filter narrows results by prefix', async () => {
	const { rpc } = stubRpc(() => [
		entity('e1', 'function', '/repo-a'),
		entity('e2', 'function', '/repo-b'),
		entity('e3', 'function', '/repo-a/nested'),
	]);
	const res = await entitySearchHandler({ query: 'q', limit: 10, repo: '/repo-a' }, rpc);
	const payload = readJsonContent(res) as { hits: { entityId: string }[] };
	assert.equal(payload.hits.length, 2);
	assert.deepEqual(payload.hits.map(h => h.entityId), ['e1', 'e3']);
});

// ---------------------------------------------------------------------------
// insrc_entity_summary
// ---------------------------------------------------------------------------

test('entitySummary: returns entity payload on hit', async () => {
	const { rpc, calls } = stubRpc(() => entity('e1'));
	const res = await entitySummaryHandler({ entityId: 'e1' }, rpc);
	assert.deepEqual(calls[0], { method: 'entity.summary', params: { entityId: 'e1' } });
	const payload = readJsonContent(res) as { entity: { id: string } };
	assert.equal(payload.entity.id, 'e1');
});

test('entitySummary: returns isError when daemon says not found', async () => {
	const { rpc } = stubRpc(() => null);
	const res = await entitySummaryHandler({ entityId: 'e-missing' }, rpc);
	assert.equal(res.isError, true);
	assert.match(res.content[0]!.text, /e-missing.*not found/);
});

// ---------------------------------------------------------------------------
// insrc_entity_callers
// ---------------------------------------------------------------------------

test('entityCallers: depth=1 calls search.callers', async () => {
	const { rpc, calls } = stubRpc(() => [entity('caller-1')]);
	await entityCallersHandler({ entityId: 'e1', depth: 1 }, rpc);
	assert.deepEqual(calls[0], { method: 'search.callers', params: { entityId: 'e1' } });
});

test('entityCallers: depth>1 calls search.callers_nhop with hops', async () => {
	const { rpc, calls } = stubRpc(() => [entity('caller-1'), entity('caller-2')]);
	const res = await entityCallersHandler({ entityId: 'e1', depth: 3 }, rpc);
	assert.deepEqual(calls[0], { method: 'search.callers_nhop', params: { entityId: 'e1', hops: 3 } });
	const payload = readJsonContent(res) as { callers: { id: string }[] };
	assert.equal(payload.callers.length, 2);
});

// ---------------------------------------------------------------------------
// insrc_entity_callees
// ---------------------------------------------------------------------------

test('entityCallees: calls search.callees and returns array', async () => {
	const { rpc, calls } = stubRpc(() => [entity('callee-1')]);
	const res = await entityCalleesHandler({ entityId: 'e1' }, rpc);
	assert.deepEqual(calls[0], { method: 'search.callees', params: { entityId: 'e1' } });
	const payload = readJsonContent(res) as { callees: { id: string }[] };
	assert.equal(payload.callees[0]!.id, 'callee-1');
});

// ---------------------------------------------------------------------------
// insrc_entity_closure
// ---------------------------------------------------------------------------

test('entityClosure: wraps entityId into rootIds, forwards edgeKind+direction+maxDepth', async () => {
	const { rpc, calls } = stubRpc(() => [entity('r1'), entity('r2')]);
	const res = await entityClosureHandler({ entityId: 'root', edgeKind: 'CALLS', direction: 'out', maxDepth: 5 }, rpc);
	assert.deepEqual(calls[0], {
		method: 'entity.closure',
		params: { rootIds: ['root'], edgeKind: 'CALLS', direction: 'out', maxDepth: 5 },
	});
	const payload = readJsonContent(res) as { reachable: { id: string }[]; count: number };
	assert.equal(payload.count, 2);
});

// ---------------------------------------------------------------------------
// insrc_entity_unreachable
// ---------------------------------------------------------------------------

test('entityUnreachable: defaults candidateKinds to function+method', async () => {
	const { rpc, calls } = stubRpc(() => [] as Entity[]);
	await entityUnreachableHandler({ repoId: '/r', entryPoints: ['e1'] }, rpc);
	assert.deepEqual(calls[0], {
		method: 'entity.unreachable',
		params: { rootIds: ['e1'], candidateKinds: ['function', 'method'] },
	});
});

test('entityUnreachable: post-filters results by repoId prefix', async () => {
	const { rpc } = stubRpc(() => [
		entity('u1', 'function', '/repo-a'),
		entity('u2', 'function', '/repo-b'),
		entity('u3', 'function', '/repo-a/nested'),
	]);
	const res = await entityUnreachableHandler({ repoId: '/repo-a', entryPoints: ['root'] }, rpc);
	const payload = readJsonContent(res) as { unreachable: { id: string }[]; count: number };
	assert.equal(payload.count, 2);
	assert.deepEqual(payload.unreachable.map(e => e.id), ['u1', 'u3']);
});

test('entityUnreachable: caller-provided kindFilter overrides the default', async () => {
	const { rpc, calls } = stubRpc(() => [] as Entity[]);
	await entityUnreachableHandler({ repoId: '/r', entryPoints: ['e1'], kindFilter: ['class'] }, rpc);
	const params = calls[0]!.params as { candidateKinds: string[] };
	assert.deepEqual(params.candidateKinds, ['class']);
});
