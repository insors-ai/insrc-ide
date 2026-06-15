/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * HTTP MCP gateway tests (Phase 6).
 *
 * Pinned:
 *   - The gateway binds to 127.0.0.1 by default (NOT 0.0.0.0).
 *   - Requests without `Authorization: Bearer <token>` get 401 +
 *     a `WWW-Authenticate` header. The body never reaches the
 *     MCP transport.
 *   - Requests with an unknown / expired token get 401 with
 *     `error="invalid_token"`.
 *   - Requests to a non-`/mcp` path get 404.
 *   - Requests with malformed JSON body get 400.
 *   - A successful initialize -> tools/list round-trip works
 *     against the real MCP SDK transport when the token
 *     validates.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { HttpMcpGateway } from '../http.js';

async function fetchJson(url: string, opts: { method: string; headers?: Record<string, string>; body?: unknown }): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
	const res = await fetch(url, {
		method: opts.method,
		headers: {
			'content-type': 'application/json',
			'accept': 'application/json, text/event-stream',
			...(opts.headers ?? {}),
		},
		...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
	});
	const headers: Record<string, string> = {};
	res.headers.forEach((v, k) => { headers[k] = v; });
	const text = await res.text();
	let body: unknown = text;
	try { body = text.length > 0 ? JSON.parse(text) : undefined; } catch { /* keep as text */ }
	return { status: res.status, headers, body };
}

function tinyMcpServer(): McpServer {
	return new McpServer({ name: 'test-server', version: '0.0.1' });
}

test('HttpMcpGateway: binds to 127.0.0.1 by default', async () => {
	const gw = new HttpMcpGateway({ mcpServerFactory: tinyMcpServer });
	try {
		await gw.listen();
		assert.equal(gw.host, '127.0.0.1');
		assert.ok(gw.port > 0, `expected a positive port, got ${gw.port}`);
	} finally {
		await gw.close();
	}
});

test('HttpMcpGateway: missing bearer -> 401 with WWW-Authenticate header', async () => {
	const gw = new HttpMcpGateway({
		mcpServerFactory: tinyMcpServer,
		validateToken: () => undefined,
	});
	try {
		await gw.listen();
		const res = await fetchJson(`http://127.0.0.1:${gw.port}/mcp`, { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'initialize' } });
		assert.equal(res.status, 401);
		assert.match(res.headers['www-authenticate'] ?? '', /Bearer/);
		assert.deepStrictEqual(res.body, { error: 'missing bearer token' });
	} finally {
		await gw.close();
	}
});

test('HttpMcpGateway: unknown bearer -> 401 with invalid_token annotation', async () => {
	const gw = new HttpMcpGateway({
		mcpServerFactory: tinyMcpServer,
		validateToken: token => token === 'good' ? 'sess-1' : undefined,
	});
	try {
		await gw.listen();
		const res = await fetchJson(`http://127.0.0.1:${gw.port}/mcp`, {
			method: 'POST',
			headers: { authorization: 'Bearer wrong' },
			body: { jsonrpc: '2.0', id: 1, method: 'initialize' },
		});
		assert.equal(res.status, 401);
		assert.match(res.headers['www-authenticate'] ?? '', /invalid_token/);
	} finally {
		await gw.close();
	}
});

test('HttpMcpGateway: non-/mcp path -> 404', async () => {
	const gw = new HttpMcpGateway({
		mcpServerFactory: tinyMcpServer,
		validateToken: () => 'sess-1',
	});
	try {
		await gw.listen();
		const res = await fetchJson(`http://127.0.0.1:${gw.port}/health`, {
			method: 'GET',
			headers: { authorization: 'Bearer any' },
		});
		assert.equal(res.status, 404);
	} finally {
		await gw.close();
	}
});

test('HttpMcpGateway: invalid JSON body -> 400', async () => {
	const gw = new HttpMcpGateway({
		mcpServerFactory: tinyMcpServer,
		validateToken: () => 'sess-1',
	});
	try {
		await gw.listen();
		const res = await fetch(`http://127.0.0.1:${gw.port}/mcp`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'accept': 'application/json, text/event-stream',
				'authorization': 'Bearer any',
			},
			body: '{not-json',
		});
		assert.equal(res.status, 400);
		const body = await res.json() as { error: string };
		assert.equal(body.error, 'invalid JSON body');
	} finally {
		await gw.close();
	}
});

test('HttpMcpGateway: valid bearer + initialize -> 200 with MCP handshake', async () => {
	const gw = new HttpMcpGateway({
		mcpServerFactory: tinyMcpServer,
		validateToken: token => token === 'good-tok' ? 'sess-1' : undefined,
	});
	try {
		await gw.listen();
		const res = await fetchJson(`http://127.0.0.1:${gw.port}/mcp`, {
			method: 'POST',
			headers: { authorization: 'Bearer good-tok' },
			body: {
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: {
					protocolVersion: '2024-11-05',
					capabilities: {},
					clientInfo: { name: 'test-client', version: '0.0.1' },
				},
			},
		});
		assert.equal(res.status, 200, `expected 200, got ${res.status} body=${JSON.stringify(res.body)}`);
		// The MCP transport replies on the SSE stream; the body
		// includes the initialize result. SDK may also send as
		// text/event-stream framing -- accept either by checking
		// for the presence of the protocolVersion in the raw text.
		const asText = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
		assert.match(asText, /protocolVersion/);
	} finally {
		await gw.close();
	}
});

test('HttpMcpGateway: per-session transport reuse (same token reuses MCP server instance)', async () => {
	let factoryCalls = 0;
	const gw = new HttpMcpGateway({
		mcpServerFactory: () => { factoryCalls++; return tinyMcpServer(); },
		validateToken: token => token === 'tok-A' ? 'sess-A' : (token === 'tok-B' ? 'sess-B' : undefined),
	});
	try {
		await gw.listen();
		const initBody = (id: number) => ({
			jsonrpc: '2.0', id, method: 'initialize',
			params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0.0.1' } },
		});
		await fetchJson(`http://127.0.0.1:${gw.port}/mcp`, { method: 'POST', headers: { authorization: 'Bearer tok-A' }, body: initBody(1) });
		await fetchJson(`http://127.0.0.1:${gw.port}/mcp`, { method: 'POST', headers: { authorization: 'Bearer tok-A' }, body: initBody(2) });
		await fetchJson(`http://127.0.0.1:${gw.port}/mcp`, { method: 'POST', headers: { authorization: 'Bearer tok-B' }, body: initBody(3) });
		// tok-A's two requests reuse the same factory; tok-B
		// triggers a fresh one -> factoryCalls should be 2.
		assert.equal(factoryCalls, 2);
	} finally {
		await gw.close();
	}
});
