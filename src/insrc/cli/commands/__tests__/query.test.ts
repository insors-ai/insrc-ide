/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `insrc query` unit tests via the runQuery test seam.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runQuery } from '../query.js';

interface CapturedIo {
	stdout: string;
	stderr: string;
}

function captureIo(): { writer: { stdout: (s: string) => void; stderr: (s: string) => void }; captured: CapturedIo } {
	const captured: CapturedIo = { stdout: '', stderr: '' };
	const writer = {
		stdout: (s: string) => { captured.stdout += s; },
		stderr: (s: string) => { captured.stderr += s; },
	};
	return { writer, captured };
}

test('query --list: prints the 14 tools + their schema as JSON, exits 0', async () => {
	const { writer, captured } = captureIo();
	const code = await runQuery({ list: true }, writer);
	assert.equal(code, 0);
	const out = JSON.parse(captured.stdout) as { tools: { name: string }[]; count: number };
	assert.equal(out.count, 14);
	assert.equal(out.tools.length, 14);
	const names = out.tools.map(t => t.name);
	assert.ok(names.includes('insrc_entity_search'));
	assert.ok(names.includes('insrc_artifact_get'));
	assert.ok(names.includes('insrc_repo_depends_on'));
});

test('query: no --list and no --tool returns exit code 2 with helpful message', async () => {
	const { writer, captured } = captureIo();
	const code = await runQuery({}, writer);
	assert.equal(code, 2);
	assert.match(captured.stderr, /--list or --tool/);
});

test('query --tool unknown returns exit code 2', async () => {
	const { writer, captured } = captureIo();
	const code = await runQuery({ tool: 'insrc_nope' }, writer);
	assert.equal(code, 2);
	assert.match(captured.stderr, /unknown tool 'insrc_nope'/);
});

test('query --tool valid + --args invalid JSON returns exit code 3', async () => {
	const { writer, captured } = captureIo();
	const code = await runQuery({ tool: 'insrc_entity_search', args: '{not json' }, writer);
	assert.equal(code, 3);
	assert.match(captured.stderr, /not valid JSON/);
});

test('query --tool valid + --args missing required field returns exit code 3 with schema error', async () => {
	const { writer, captured } = captureIo();
	const code = await runQuery({ tool: 'insrc_entity_search', args: '{}' }, writer);
	assert.equal(code, 3);
	assert.match(captured.stderr, /does not match the input schema/);
});

test('query --tool insrc_artifact_get without --session-token returns exit code 4 with required-token message', async () => {
	// scope: 'session' -> tool registry maps to isError before reaching the handler.
	// Since invokeTool surfaces the error as a result with isError: true, runQuery
	// exits with code 4 (tool error).
	const { writer, captured } = captureIo();
	const code = await runQuery({ tool: 'insrc_artifact_get', args: '{"artifactId":"art-1"}' }, writer);
	assert.equal(code, 4);
	const result = JSON.parse(captured.stdout) as { isError?: boolean; content: { text: string }[] };
	assert.equal(result.isError, true);
	assert.match(result.content[0]!.text, /session token/i);
});
