/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for Step 1 (Scope) of the section-flow orchestrator (P2).
 *
 * Covered:
 * - extractContextRefs against representative user prompts (absolute
 *   paths, project-relative paths, bare filenames, directory hints,
 *   backticked identifiers; dedupe; false-positive avoidance).
 * - decideTrivial: S+1ref -> trivial; anything else -> not.
 * - buildScopeContext: optional repo signals render correctly.
 * - runScopeStep end-to-end against a scripted provider:
 *     - Returns scope/subtype from classifyScope.
 *     - Surfaces contextRefs and trivial flag.
 *     - Surfaces classifyScope's fallback flag on provider failure.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	runScopeStep,
	_extractContextRefsForTest as extractContextRefs,
	_decideTrivialForTest      as decideTrivial,
	_buildScopeContextForTest  as buildScopeContext,
} from '../step-scope.js';
import type { CompletionOpts, LLMMessage, LLMProvider, LLMResponse } from '../../../shared/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface RecordedCall {
	readonly messages: LLMMessage[];
	readonly opts:     CompletionOpts;
}

function scriptedProvider(responses: readonly string[]): { provider: LLMProvider; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	let cursor = 0;
	const provider = {
		supportsTools: true,
		async complete(messages: LLMMessage[], opts: CompletionOpts = {}): Promise<LLMResponse> {
			calls.push({ messages, opts });
			if (cursor >= responses.length) {
				throw new Error(`scriptedProvider: ran out of responses at call ${cursor + 1}`);
			}
			const text = responses[cursor]!;
			cursor++;
			return { text, stopReason: 'end_turn' };
		},
		async *stream(): AsyncIterable<string> { yield ''; },
		async embed(): Promise<number[]> { return []; },
	} as unknown as LLMProvider;
	return { provider, calls };
}

function classifyResponse(scope: string, subtype: string, reasoning = 'r'): string {
	return JSON.stringify({ scope, subtype, reasoning });
}

// ---------------------------------------------------------------------------
// extractContextRefs
// ---------------------------------------------------------------------------

test('extractContextRefs: absolute path', () => {
	const refs = extractContextRefs('Please look at /etc/insrc/config.json for the bug.');
	assert.deepEqual(refs.map(r => r.value), ['/etc/insrc/config.json']);
	assert.equal(refs[0]!.kind, 'file');
	assert.equal(refs[0]!.origin, 'user-mention');
});

test('extractContextRefs: project-relative path with extension', () => {
	const refs = extractContextRefs('Why does src/insrc/agent/router.ts return undefined?');
	const paths = refs.map(r => r.value);
	assert.ok(paths.includes('src/insrc/agent/router.ts'));
});

test('extractContextRefs: bare filename with known extension', () => {
	const refs = extractContextRefs('Take a look at INGRN.py and let me know.');
	const paths = refs.map(r => r.value);
	assert.ok(paths.includes('INGRN.py'));
});

test('extractContextRefs: directory with trailing slash', () => {
	const refs = extractContextRefs('Audit everything under src/insrc/agent/ for missing tests.');
	const dirs = refs.filter(r => r.kind === 'dir').map(r => r.value);
	assert.ok(dirs.includes('src/insrc/agent/'));
});

test('extractContextRefs: backticked identifier surfaced as symbol', () => {
	const refs = extractContextRefs('Where is `BlockManager` instantiated?');
	const symbols = refs.filter(r => r.kind === 'symbol').map(r => r.value);
	assert.ok(symbols.includes('BlockManager'));
});

test('extractContextRefs: backticked path-shaped string NOT classified as symbol', () => {
	const refs = extractContextRefs('See `src/foo/bar.ts` please.');
	const symbols = refs.filter(r => r.kind === 'symbol').map(r => r.value);
	assert.ok(!symbols.includes('src/foo/bar.ts'));
});

test('extractContextRefs: dedupes refs that match multiple patterns', () => {
	const refs = extractContextRefs('Read src/insrc/agent/router.ts -- specifically src/insrc/agent/router.ts.');
	const matches = refs.filter(r => r.value === 'src/insrc/agent/router.ts');
	assert.equal(matches.length, 1);
});

test('extractContextRefs: prose-only question with no concrete refs', () => {
	const refs = extractContextRefs('What does this service do at a high level?');
	assert.deepEqual(refs, []);
});

test('extractContextRefs: avoids matching ordinary words ending in numbers', () => {
	const refs = extractContextRefs('Check the v2 schema and the 30k token limit.');
	assert.deepEqual(refs, []);
});

// ---------------------------------------------------------------------------
// decideTrivial
// ---------------------------------------------------------------------------

test('decideTrivial: S + 1 ref -> true', () => {
	assert.equal(decideTrivial('S', [{ kind: 'file', value: 'a.py', origin: 'user-mention' }]), true);
});

test('decideTrivial: S + 0 refs -> false', () => {
	assert.equal(decideTrivial('S', []), false);
});

test('decideTrivial: S + 2 refs -> false', () => {
	assert.equal(decideTrivial('S', [
		{ kind: 'file', value: 'a.py', origin: 'user-mention' },
		{ kind: 'file', value: 'b.py', origin: 'user-mention' },
	]), false);
});

test('decideTrivial: M scope (any refs) -> false', () => {
	assert.equal(decideTrivial('M', [{ kind: 'file', value: 'a.py', origin: 'user-mention' }]), false);
});

test('decideTrivial: XXL scope -> false', () => {
	assert.equal(decideTrivial('XXL', [{ kind: 'file', value: 'a.py', origin: 'user-mention' }]), false);
});

// ---------------------------------------------------------------------------
// buildScopeContext
// ---------------------------------------------------------------------------

test('buildScopeContext: undefined signals -> empty string', () => {
	assert.equal(buildScopeContext(undefined), '');
});

test('buildScopeContext: only fileCount provided', () => {
	assert.equal(buildScopeContext({ fileCount: 5000 }), 'File count: 5000');
});

test('buildScopeContext: combines fileCount + languages + top modules', () => {
	const text = buildScopeContext({
		fileCount: 1200,
		primaryLanguages: ['ts', 'py'],
		topModules: ['m1', 'm2', 'm3'],
	});
	assert.match(text, /File count: 1200/);
	assert.match(text, /Primary languages: ts, py/);
	assert.match(text, /Top modules: m1, m2, m3/);
});

test('buildScopeContext: top modules truncated at 10', () => {
	const many = Array.from({ length: 15 }, (_, i) => `m${i}`);
	const text = buildScopeContext({ topModules: many });
	assert.match(text, /Top modules: m0, m1, m2, m3, m4, m5, m6, m7, m8, m9$/);
});

// ---------------------------------------------------------------------------
// runScopeStep end-to-end
// ---------------------------------------------------------------------------

test('runScopeStep: returns classifyScope tier + extracted refs + trivial flag', async () => {
	const { provider } = scriptedProvider([classifyResponse('S', 'explain')]);
	const result = await runScopeStep({
		question: 'What does INGRN.py do?',
		provider,
	});
	assert.equal(result.scope, 'S');
	assert.equal(result.subtype, 'explain');
	assert.equal(result.contextRefs[0]?.value, 'INGRN.py');
	assert.equal(result.isTrivial, true);
	assert.equal(result.fallback, false);
});

test('runScopeStep: M scope + no refs -> not trivial', async () => {
	const { provider } = scriptedProvider([classifyResponse('M', 'review')]);
	const result = await runScopeStep({
		question: 'Review the data layer for SQL injection patterns.',
		provider,
	});
	assert.equal(result.scope, 'M');
	assert.equal(result.isTrivial, false);
	assert.deepEqual(result.contextRefs, []);
});

test('runScopeStep: surfaces classifier fallback on provider parse failure', async () => {
	// classifyScope returns its own fallback when the LLM response is unparseable.
	const { provider } = scriptedProvider(['not json at all']);
	const result = await runScopeStep({
		question: 'something',
		provider,
	});
	assert.equal(result.fallback, true);
	assert.equal(result.scope, 'M');     // classifyScope's default
	assert.equal(result.subtype, 'review');
});

test('runScopeStep: threads repo signals into classifyScope context block', async () => {
	const { provider, calls } = scriptedProvider([classifyResponse('XL', 'summarize')]);
	await runScopeStep({
		question: 'Summarise this repo.',
		repoSignals: {
			fileCount: 8000,
			primaryLanguages: ['java'],
			topModules: ['hdfs', 'yarn', 'mapreduce'],
		},
		provider,
	});
	assert.equal(calls.length, 1);
	const user = calls[0]!.messages[1]!.content;
	assert.match(user, /File count: 8000/);
	assert.match(user, /Primary languages: java/);
	assert.match(user, /Top modules: hdfs, yarn, mapreduce/);
});
