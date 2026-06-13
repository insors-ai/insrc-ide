/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for the 4 Day-2.5 MCP tool handlers wired through the
 * daemon: `insrc_artifact_get`, `insrc_artifact_search`,
 * `insrc_repo_depends_on`, `insrc_repo_search_cross_repo`.
 *
 * Same stub-RpcFn pattern as tools-entity.test.ts: assert each
 * handler's daemon method, parameter shape, and result transform.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	artifactGetHandler,
	artifactSearchHandler,
} from '../tools/artifact.js';
import {
	repoDependsOnHandler,
	repoSearchCrossRepoHandler,
} from '../tools/repo.js';
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
// insrc_artifact_get
// ---------------------------------------------------------------------------

test('artifactGet: calls artifact.get and returns wrapped payload on hit', async () => {
	const fakeHit = {
		id: 'art-1', session_id: 'sess-1', intent: 'data-analyze', skill_id: 'code.class.extract-fields',
		timestamp: '0', path: '/tmp/x', preview: 'p', summary: 's', raw: 'raw body',
	};
	const { rpc, calls } = stubRpc(() => fakeHit);
	const res = await artifactGetHandler({ artifactId: 'art-1' }, rpc);
	assert.deepEqual(calls[0], { method: 'artifact.get', params: { artifactId: 'art-1' } });
	const payload = readJsonContent(res) as { artifact: { id: string; raw: string } };
	assert.equal(payload.artifact.id, 'art-1');
	assert.equal(payload.artifact.raw, 'raw body');
});

test('artifactGet: returns isError on miss', async () => {
	const { rpc } = stubRpc(() => null);
	const res = await artifactGetHandler({ artifactId: 'art-missing' }, rpc);
	assert.equal(res.isError, true);
	assert.match(res.content[0]!.text, /art-missing.*not found/);
});

// ---------------------------------------------------------------------------
// insrc_artifact_search
// ---------------------------------------------------------------------------

test('artifactSearch: forwards sessionId from ctx + query + limit to artifact.search', async () => {
	const { rpc, calls } = stubRpc(() => [
		{ id: 'art-1', session_id: 'sess-1', intent: 'data-analyze', skill_id: 's', timestamp: '0',
			path: '/p', preview: '', summary: 'sum-1', distance: 0.1 },
	]);
	const res = await artifactSearchHandler({ query: 'X', limit: 7 }, rpc, 'sess-1');
	assert.deepEqual(calls[0], {
		method: 'artifact.search',
		params: { query: 'X', sessionId: 'sess-1', limit: 7 },
	});
	const payload = readJsonContent(res) as { hits: { id: string }[]; count: number };
	assert.equal(payload.count, 1);
	assert.equal(payload.hits[0]!.id, 'art-1');
});

test('artifactSearch: passes intent filter when set', async () => {
	const { rpc, calls } = stubRpc(() => [] as unknown[]);
	await artifactSearchHandler({ query: 'X', limit: 5, intent: 'code-analysis' }, rpc, 'sess-1');
	const params = calls[0]!.params as { intent?: string };
	assert.equal(params.intent, 'code-analysis');
});

test('artifactSearch: omits intent param when undefined', async () => {
	const { rpc, calls } = stubRpc(() => [] as unknown[]);
	await artifactSearchHandler({ query: 'X', limit: 5 }, rpc, 'sess-1');
	const params = calls[0]!.params as Record<string, unknown>;
	assert.equal(Object.hasOwn(params, 'intent'), false);
});

// ---------------------------------------------------------------------------
// insrc_repo_depends_on
// ---------------------------------------------------------------------------

test('repoDependsOn: forwards repoId and wraps closure list with count', async () => {
	const fake = [
		{ repoId: '/a', name: 'a', path: '/a', transitive: false },
		{ repoId: '/b', name: 'b', path: '/b', transitive: true },
	];
	const { rpc, calls } = stubRpc(() => fake);
	const res = await repoDependsOnHandler({ repoId: '/a' }, rpc);
	assert.deepEqual(calls[0], { method: 'repo.depends_on', params: { repoId: '/a' } });
	const payload = readJsonContent(res) as { closure: typeof fake; count: number };
	assert.equal(payload.count, 2);
	assert.equal(payload.closure[0]!.transitive, false);
	assert.equal(payload.closure[1]!.transitive, true);
});

// ---------------------------------------------------------------------------
// insrc_repo_search_cross_repo
// ---------------------------------------------------------------------------

test('repoSearchCrossRepo: calls repo.search_cross_repo and projects entity rows into search hits', async () => {
	const { rpc, calls } = stubRpc(() => [entity('e1'), entity('e2', 'class', '/dep-repo')]);
	const res = await repoSearchCrossRepoHandler({ query: 'INGRN', repoId: '/root', limit: 8 }, rpc);
	assert.deepEqual(calls[0], {
		method: 'repo.search_cross_repo',
		params: { query: 'INGRN', repoId: '/root', limit: 8 },
	});
	const payload = readJsonContent(res) as { hits: { entityId: string; repo: string }[]; count: number };
	assert.equal(payload.count, 2);
	assert.equal(payload.hits[0]!.entityId, 'e1');
	assert.equal(payload.hits[1]!.repo,     '/dep-repo');
});
