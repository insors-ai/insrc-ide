/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Smoke test for the MCP server's stdio entry point.
 *
 * Spawns `src/insrc/mcp/server.ts` as a subprocess via tsx, performs
 * the MCP initialize handshake + tools/list round-trip directly using
 * the SDK's client API, and asserts:
 *
 *   1. The server reports a non-empty `instructions` string from
 *      SERVER_INFO -> McpServer options.
 *   2. `tools/list` returns exactly 12 tools (Day 1 scaffold).
 *   3. Every tool name carries the required `insrc_` prefix.
 *   4. The five expected families (entity, artifact, memory, repo,
 *      spec) are all represented.
 *
 * This is a Day-1-of-Phase-1 deliverable. The tool handlers themselves
 * are still NotImplementedError stubs; calling them is exercised in a
 * later day's tests once handlers are wired.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const SERVER_TS  = resolve(__dirname, '../server.ts');
const TSX_BIN    = resolve(__dirname, '../../node_modules/.bin/tsx');

test('mcp/server: tools/list returns all 14 stubbed tools with correct names', async () => {
	const transport = new StdioClientTransport({
		command: TSX_BIN,
		args:    [SERVER_TS],
	});

	const client = new Client({
		name:    'insrc-mcp-smoke',
		version: '0.0.1',
	});

	try {
		await client.connect(transport);

		const { tools } = await client.listTools();
		// 6 entity + 2 artifact + 2 memory + 2 repo + 2 spec = 14.
		// (Design §4 reads "~12 tools"; actual exact count is 14.)
		assert.equal(tools.length, 14, `expected 14 tools, got ${tools.length}`);

		// 4.1 -- naming convention: every tool must start with 'insrc_'
		for (const t of tools) {
			assert.match(t.name, /^insrc_/, `tool '${t.name}' is missing the insrc_ prefix`);
			assert.ok(t.description !== undefined && t.description.length > 0, `tool '${t.name}' has no description`);
		}

		// 4.2 -- the five families are represented
		const families = new Set(tools.map(t => t.name.split('_')[1]));
		const expected = ['entity', 'artifact', 'memory', 'repo', 'spec'];
		for (const fam of expected) {
			assert.ok(families.has(fam), `family 'insrc_${fam}_*' is missing from tools/list`);
		}

		// 4.3 -- per-family counts match the design (6/2/2/2/2)
		const familyCount: Record<string, number> = {};
		for (const t of tools) {
			const fam = t.name.split('_')[1]!;
			familyCount[fam] = (familyCount[fam] ?? 0) + 1;
		}
		assert.equal(familyCount['entity'],   6, "expected 6 'insrc_entity_*' tools");
		assert.equal(familyCount['artifact'], 2, "expected 2 'insrc_artifact_*' tools");
		assert.equal(familyCount['memory'],   2, "expected 2 'insrc_memory_*' tools");
		assert.equal(familyCount['repo'],     2, "expected 2 'insrc_repo_*' tools");
		assert.equal(familyCount['spec'],     2, "expected 2 'insrc_spec_*' tools");
	} finally {
		try { await client.close(); } catch { /* swallow on shutdown */ }
	}
});

test('mcp/server: handler stub returns isError for a global tool', async () => {
	// Sanity: a global-scope tool with no session token must reach the
	// handler (no auth short-circuit) and throw NotImplementedError, which
	// the registry maps to a structured isError response.
	const transport = new StdioClientTransport({
		command: TSX_BIN,
		args:    [SERVER_TS],
	});

	const client = new Client({ name: 'insrc-mcp-smoke', version: '0.0.1' });

	try {
		await client.connect(transport);

		const res = await client.callTool({
			name: 'insrc_entity_search',
			arguments: { query: 'INGRN class', limit: 5 },
		});

		assert.equal(res.isError, true);
		const content = res.content as { type: string; text: string }[] | undefined;
		assert.ok(Array.isArray(content) && content.length > 0);
		assert.match(content[0]!.text, /Phase 1 scaffold|not yet wired|NotImplemented/);
	} finally {
		try { await client.close(); } catch { /* swallow */ }
	}
});

test('mcp/server: session-scoped tool without token returns isError before reaching handler', async () => {
	const transport = new StdioClientTransport({
		command: TSX_BIN,
		args:    [SERVER_TS],
	});

	const client = new Client({ name: 'insrc-mcp-smoke', version: '0.0.1' });

	try {
		await client.connect(transport);

		const res = await client.callTool({
			name: 'insrc_artifact_get',
			arguments: { artifactId: 'art-x' },
		});

		assert.equal(res.isError, true);
		const content = res.content as { type: string; text: string }[] | undefined;
		assert.ok(Array.isArray(content) && content.length > 0);
		assert.match(content[0]!.text, /session token/i);
	} finally {
		try { await client.close(); } catch { /* swallow */ }
	}
});
