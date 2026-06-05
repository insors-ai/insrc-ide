/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for the final report assembler (P4 part 1).
 *
 * Covered:
 * - Happy path: LLM emits the report markdown; usedFallback=false.
 * - Empty entries -> structured empty marker, no LLM call.
 * - LLM returns empty -> deterministic fallback (each entry's
 *   markdown under a per-objective heading).
 * - Prompt structure: user prompt carries question + each entry's
 *   objective + each entry's detail in order.
 * - LLM contract: disableThinking + temperature 0; NO
 *   responseFormat (output is markdown, not JSON).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	assembleReport,
	_buildAssembleUserForTest as buildAssembleUser,
	_deterministicConcatForTest as deterministicConcat,
} from '../step-report-assemble.js';
import type { CompletionOpts, LLMMessage, LLMProvider, LLMResponse } from '../../../shared/types.js';
import type { WorkingMemoryEntry } from '../../working-memory/types.js';

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

function entry(todoId: string, objective: string, detail: string): WorkingMemoryEntry {
	return {
		todoId, objective, detail,
		findings:    { perRoot: [] },
		completedAt: 1, origin: 'initial',
	};
}

// ---------------------------------------------------------------------------
// Empty entries
// ---------------------------------------------------------------------------

test('empty entries -> structured empty marker, no LLM call', async () => {
	const { provider, calls } = scriptedProvider([]);
	const result = await assembleReport({ question: 'q', entries: [], provider });
	assert.equal(calls.length, 0);
	assert.equal(result.usedFallback, true);
	assert.match(result.report, /no sections were produced/);
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('happy path: LLM emits markdown; usedFallback=false', async () => {
	const entries = [
		entry('t1', 'Survey HDFS layout', '# Discovery\n\nLayout details.'),
		entry('t2', 'Audit NameNode',     '# NameNode\n\nMetadata details.'),
	];
	const llmOutput = '# Hadoop Report\n\n## Intro\n\nblah\n\n## Discovery\n\n...';
	const { provider, calls } = scriptedProvider([llmOutput]);
	const result = await assembleReport({ question: 'Review HDFS', entries, provider });
	assert.equal(calls.length, 1);
	assert.equal(result.usedFallback, false);
	assert.equal(result.report, llmOutput);
});

// ---------------------------------------------------------------------------
// Fallback when LLM is empty
// ---------------------------------------------------------------------------

test('LLM returns empty -> deterministic fallback over the entries', async () => {
	const entries = [
		entry('t1', 'Survey HDFS layout', 'discovery body'),
		entry('t2', 'Audit NameNode',     'namenode body'),
	];
	const { provider } = scriptedProvider(['   ']);  // empty after trim
	const result = await assembleReport({ question: 'Review HDFS', entries, provider });
	assert.equal(result.usedFallback, true);
	// Each entry's markdown lives under a heading derived from the objective.
	assert.match(result.report, /## Survey HDFS layout/);
	assert.match(result.report, /discovery body/);
	assert.match(result.report, /## Audit NameNode/);
	assert.match(result.report, /namenode body/);
});

// ---------------------------------------------------------------------------
// Prompt structure
// ---------------------------------------------------------------------------

test('buildAssembleUser: question + entries in declared order', () => {
	const entries = [
		entry('t1', 'First objective',  'first detail'),
		entry('t2', 'Second objective', 'second detail'),
	];
	const text = buildAssembleUser({ question: 'My question', entries, provider: {} as LLMProvider });
	assert.match(text, /My question/);
	// Section labels are 1-based and ordered.
	assert.ok(text.indexOf('Section 1') < text.indexOf('Section 2'));
	assert.ok(text.indexOf('First objective') < text.indexOf('Second objective'));
	assert.ok(text.indexOf('first detail') < text.indexOf('second detail'));
	// Each section's body is wrapped in a markdown code fence so the
	// model sees them as opaque blobs.
	assert.match(text, /```markdown\nfirst detail\n```/);
});

// ---------------------------------------------------------------------------
// LLM contract
// ---------------------------------------------------------------------------

test('LLM call: disableThinking=true + temperature=0; NOT responseFormat=json', async () => {
	const { provider, calls } = scriptedProvider(['report']);
	await assembleReport({
		question: 'q',
		entries:  [entry('t1', 'o', 'd')],
		provider,
	});
	assert.equal(calls[0]!.opts.disableThinking, true);
	assert.equal(calls[0]!.opts.temperature, 0);
	assert.equal(calls[0]!.opts.responseFormat, undefined);
});

// ---------------------------------------------------------------------------
// deterministicConcat
// ---------------------------------------------------------------------------

test('deterministicConcat: includes question + every entry under its objective heading', () => {
	const text = deterministicConcat('Q1', [
		entry('a', 'First', 'A body'),
		entry('b', 'Second', 'B body'),
	]);
	assert.match(text, /Q1/);
	assert.match(text, /## First[\s\S]*A body[\s\S]*## Second[\s\S]*B body/);
});
