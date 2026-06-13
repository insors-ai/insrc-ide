/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Surface-isolation CI check.
 *
 * The local-LLM IPC surface MUST NOT reach for the entity / repo /
 * search backing stores. These belong on the external-agent MCP
 * surface (`src/insrc/mcp/`); the local LLM never does code
 * discovery (design §4.0).
 *
 * This test walks every `.ts` file under `src/insrc/internal-ipc/`
 * and asserts no import path matches the disallowed list.
 *
 * Failure here means someone added an `import ... from
 * '../db/graph/...'` (or similar) in an internal-IPC handler --
 * which structurally violates the role split. Fix is to either:
 *   - Move the capability to the MCP surface (correct), or
 *   - Convince yourself the rule shouldn't apply and explicitly
 *     allow-list the path here (rare; deliberate; documented).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname        = dirname(fileURLToPath(import.meta.url));
const INTERNAL_IPC_DIR = join(__dirname, '..');

/**
 * Disallowed import substrings. Any `from '...'` whose path contains
 * one of these is an isolation violation. The list deliberately
 * includes the exact paths the design §4.0 carve-out cites.
 */
const DISALLOWED_IMPORTS = [
	'/db/graph/',           // graph layer (LMDB)
	'/db/entities',         // entity CRUD
	'/db/relations',        // relations CRUD
	'/db/search',           // entity / repo / closure search wrappers
	'/db/lance/entity-vec', // entity embeddings table
	'/mcp/',                // external-agent MCP surface -- internal IPCs must not depend on it
];

async function listTsFiles(dir: string): Promise<string[]> {
	const out: string[] = [];
	const entries = await readdir(dir, { withFileTypes: true });
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			// Walk subdirs, including handlers/ but skip __tests__/
			if (e.name === '__tests__') continue;
			out.push(...(await listTsFiles(p)));
		} else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
			out.push(p);
		}
	}
	return out;
}

test('surface isolation: no internal-ipc file imports entity/repo/search backing stores', async () => {
	const files = await listTsFiles(INTERNAL_IPC_DIR);
	assert.ok(files.length > 0, 'expected at least one .ts file under internal-ipc/');

	const violations: string[] = [];
	for (const f of files) {
		const src = await readFile(f, 'utf8');
		const relPath = f.replace(`${INTERNAL_IPC_DIR}/`, '');
		// Scan only import lines (`from '...'` or `import ... from '...'`).
		const importLines = src.split('\n').filter(line => /from\s+['"]/.test(line));
		for (const line of importLines) {
			const m = /from\s+['"]([^'"]+)['"]/.exec(line);
			if (m === null) continue;
			const importPath = m[1]!;
			for (const banned of DISALLOWED_IMPORTS) {
				if (importPath.includes(banned)) {
					violations.push(`${relPath}: imports '${importPath}' (matches banned substring '${banned}')`);
				}
			}
		}
	}

	if (violations.length > 0) {
		assert.fail(
			`internal-ipc surface isolation violated:\n  ${violations.join('\n  ')}\n` +
			`These import paths belong on the external-agent MCP surface, not the local-LLM ` +
			`internal IPC surface. See design/external-agent-integration.md §4.0.`,
		);
	}
});

test('surface isolation: the test enumerates a non-empty banned list', () => {
	// Cheap regression guard so a future edit that empties DISALLOWED_IMPORTS
	// turns the file-scan test into a silent no-op.
	assert.ok(DISALLOWED_IMPORTS.length >= 5);
});
