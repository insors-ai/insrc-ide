/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Tests for the incremental working-memory updater (P1.d).
 *
 * Covered:
 * - Cold-rebuild trigger matrix (first run, growth >= 50%, user
 *   request, orchestrator inconsistency flag, no-rebuild path).
 * - Per-layer functions: system reuse, code append + budget cap,
 *   recent window selection, deterministic fallback when polish
 *   skipped, findings rendering, code-block extraction.
 * - Top-level incrementalUpdate:
 *     - Three LLM calls fire by default (summary + recent polish +
 *       semantic).
 *     - skipRecentPolish drops the polish call.
 *     - Every call sends `disableThinking: true` + temperature 0 +
 *       responseFormat 'json' (parity with shapeMemory's contract).
 *     - Empty prior bundle bootstraps fine.
 * - Schema / parse robustness: malformed layer-update responses
 *   degrade to empty string, not throw.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	incrementalUpdate,
	shouldColdRebuild,
	_updateSystemForTest as updateSystem,
	_updateCodeForTest as updateCode,
	_buildRecentWindowForTest as buildRecentWindow,
	_extractCodeBlocksForTest as extractCodeBlocks,
	_renderFindingsForTest as renderFindings,
	_enforceBudgetForTest as enforceBudget,
	_tryParseSingleFieldForTest as tryParseSingleField,
	_formatBulletsAsSemanticForTest as formatBulletsAsSemantic,
	RECENT_ENTRY_WINDOW_VALUE,
	COLD_REBUILD_GROWTH_MULTIPLIER_VALUE,
	type BulletCache,
	type BulletCacheHit,
} from '../updater.js';
import { createBudget } from '../../context/budget.js';
import type { CompletionOpts, LLMMessage, LLMProvider, LLMResponse } from '../../../shared/types.js';
import type { MemoryShapeBundle } from '../shaper.js';
import type { WorkingMemoryEntry } from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface RecordedCall {
	readonly messages: LLMMessage[];
	readonly opts:     CompletionOpts;
}

function scriptedProvider(responses: readonly string[], opts: { embedVec?: number[] } = {}): { provider: LLMProvider; calls: RecordedCall[]; embedCalls: number } {
	const calls: RecordedCall[] = [];
	let cursor = 0;
	let embedCalls = 0;
	const embedVec = opts.embedVec ?? [];
	const provider = {
		supportsTools: true,
		async complete(messages: LLMMessage[], optsArg: CompletionOpts = {}): Promise<LLMResponse> {
			calls.push({ messages, opts: optsArg });
			if (cursor >= responses.length) {
				throw new Error(`scriptedProvider: ran out of responses at call ${cursor + 1}`);
			}
			const text = responses[cursor]!;
			cursor++;
			return { text, stopReason: 'end_turn' };
		},
		async *stream(): AsyncIterable<string> { yield ''; },
		async embed(): Promise<number[]> {
			embedCalls++;
			return embedVec;
		},
	} as unknown as LLMProvider;
	return {
		provider,
		calls,
		get embedCalls() { return embedCalls; },
	};
}

function fakeBulletCache(hits: readonly BulletCacheHit[]): { cache: BulletCache; calls: Array<{ vec: number[]; topK: number }> } {
	const calls: Array<{ vec: number[]; topK: number }> = [];
	const cache: BulletCache = {
		async query(vec: number[], topK: number): Promise<readonly BulletCacheHit[]> {
			calls.push({ vec, topK });
			return hits;
		},
	};
	return { cache, calls };
}

function makeBundle(overrides: Partial<MemoryShapeBundle> = {}): MemoryShapeBundle {
	return {
		system:   overrides.system   ?? 'project: insrc; subject: GRN extraction',
		summary:  overrides.summary  ?? 'prior summary covers turn 1-2',
		recent:   overrides.recent   ?? '- turn-2: validator gaps',
		semantic: overrides.semantic ?? '- INGRN class has timestamp fields',
		code:     overrides.code     ?? '```python\nclass INGRN(BaseModel): pass\n```',
	};
}

function makeEntry(overrides: Partial<WorkingMemoryEntry> = {}): WorkingMemoryEntry {
	return {
		todoId:    overrides.todoId    ?? 'todo-3',
		objective: overrides.objective ?? 'Audit timestamp validation',
		detail:    overrides.detail    ?? '## Findings\n\nValidator gaps in invoice_date.\n\n```python\nfrom datetime import datetime\n```\n',
		findings:  overrides.findings  ?? {
			perRoot: [
				{ rootId: 'discover',   verdict: 'accept', cyclesConsumed: 0, exhausted: false, content: 'invoice_date uses {micros} object' },
				{ rootId: 'synthesize', verdict: 'accept', cyclesConsumed: 0, exhausted: false, content: 'pydantic datetime field with validator gap' },
			],
		},
		completedAt: overrides.completedAt ?? 1_717_545_600_000,
		origin:      overrides.origin      ?? 'initial',
	};
}

const layerResponse = (layer: string, value: string): string =>
	JSON.stringify({ [layer]: value });

// ---------------------------------------------------------------------------
// Cold-rebuild trigger
// ---------------------------------------------------------------------------

test('shouldColdRebuild: first TODO (lastCold=0) -> true', () => {
	assert.equal(shouldColdRebuild({
		lastColdRebuildMemoryTokens: 0,
		currentMemoryTokens:         100,
	}), true);
});

test('shouldColdRebuild: user-requested -> true regardless of growth', () => {
	assert.equal(shouldColdRebuild({
		lastColdRebuildMemoryTokens: 1000,
		currentMemoryTokens:         1100,
		userRequestedRebuild:        true,
	}), true);
});

test('shouldColdRebuild: orchestrator-flagged inconsistency -> true', () => {
	assert.equal(shouldColdRebuild({
		lastColdRebuildMemoryTokens:        1000,
		currentMemoryTokens:                1100,
		orchestratorFlaggedInconsistency:   true,
	}), true);
});

test('shouldColdRebuild: growth >= 50% threshold -> true', () => {
	assert.equal(shouldColdRebuild({
		lastColdRebuildMemoryTokens: 1000,
		currentMemoryTokens:         1500,
	}), true);
});

test('shouldColdRebuild: growth > 50% threshold -> true', () => {
	assert.equal(shouldColdRebuild({
		lastColdRebuildMemoryTokens: 1000,
		currentMemoryTokens:         1700,
	}), true);
});

test('shouldColdRebuild: growth < 50% -> false (incremental path stays viable)', () => {
	assert.equal(shouldColdRebuild({
		lastColdRebuildMemoryTokens: 1000,
		currentMemoryTokens:         1400,
	}), false);
});

test('shouldColdRebuild: shrinking memory -> false', () => {
	assert.equal(shouldColdRebuild({
		lastColdRebuildMemoryTokens: 1000,
		currentMemoryTokens:         900,
	}), false);
});

test('COLD_REBUILD_GROWTH_MULTIPLIER matches the Q1.1 spec (1.5x)', () => {
	assert.equal(COLD_REBUILD_GROWTH_MULTIPLIER_VALUE, 1.5);
});

// ---------------------------------------------------------------------------
// Per-layer helpers
// ---------------------------------------------------------------------------

test('updateSystem: passes prior through unchanged (evergreen layer)', () => {
	const prior = 'fixed evergreen context';
	const result = updateSystem(prior, makeEntry());
	assert.equal(result, prior);
});

test('updateCode: appends new code blocks from the entry detail', () => {
	const prior = '```python\nold = 1\n```';
	const entry = makeEntry({ detail: '## body\n```python\nnew = 2\n```\n' });
	const merged = updateCode(prior, entry, 1000);
	assert.match(merged, /old = 1/);
	assert.match(merged, /new = 2/);
});

test('updateCode: no new code blocks -> returns prior verbatim', () => {
	const prior = '```python\nold = 1\n```';
	const entry = makeEntry({ detail: '## body\n\nno code here\n' });
	const merged = updateCode(prior, entry, 1000);
	assert.equal(merged, prior);
});

test('updateCode: merged result exceeding the budget is truncated', () => {
	const prior = '```python\n' + 'a'.repeat(3000) + '\n```';
	const entry = makeEntry({ detail: '```python\nb'.repeat(1000) + '\n```\n' });
	const merged = updateCode(prior, entry, 100);   // tight cap
	assert.ok(merged.length <= 100 * 3);
});

test('updateCode: empty prior + new code -> just the new code', () => {
	const entry = makeEntry({ detail: '```python\nfresh = 1\n```\n' });
	const result = updateCode('', entry, 1000);
	assert.match(result, /fresh = 1/);
});

test('buildRecentWindow: selects last (RECENT_ENTRY_WINDOW-1) prior + new', () => {
	const prior = [
		makeEntry({ todoId: 'a' }),
		makeEntry({ todoId: 'b' }),
		makeEntry({ todoId: 'c' }),
		makeEntry({ todoId: 'd' }),
	];
	const newEntry = makeEntry({ todoId: 'new' });
	const window = buildRecentWindow(prior, newEntry);
	assert.equal(window.length, RECENT_ENTRY_WINDOW_VALUE);
	// Most recent (RECENT_ENTRY_WINDOW - 1) prior entries + new -> 'c', 'd', 'new'.
	assert.deepEqual(window.map(e => e.todoId), ['c', 'd', 'new']);
});

test('buildRecentWindow: fewer prior entries than window -> includes all priors + new', () => {
	const prior = [makeEntry({ todoId: 'a' })];
	const newEntry = makeEntry({ todoId: 'new' });
	const window = buildRecentWindow(prior, newEntry);
	assert.deepEqual(window.map(e => e.todoId), ['a', 'new']);
});

test('buildRecentWindow: no prior -> [new]', () => {
	const newEntry = makeEntry({ todoId: 'new' });
	const window = buildRecentWindow([], newEntry);
	assert.deepEqual(window.map(e => e.todoId), ['new']);
});

test('extractCodeBlocks: pulls every fenced block', () => {
	const md = '## title\n\n```ts\nlet a = 1;\n```\n\nprose\n\n```py\nb = 2\n```\n';
	const blocks = extractCodeBlocks(md);
	assert.equal(blocks.length, 2);
	assert.match(blocks[0]!, /let a = 1;/);
	assert.match(blocks[1]!, /b = 2/);
});

test('extractCodeBlocks: no fenced blocks -> []', () => {
	assert.deepEqual(extractCodeBlocks('just prose\nno code\n'), []);
});

test('renderFindings: per-root content + verdict + cycles + exhausted bits', () => {
	const entry = makeEntry({
		findings: {
			perRoot: [
				{ rootId: 'discover',  verdict: 'force-accept', cyclesConsumed: 3, exhausted: true,  content: 'forced after cap' },
				{ rootId: 'synthesize', verdict: 'L2-fallback', cyclesConsumed: 0, exhausted: false, content: 'L2 took over' },
			],
			fallback: 'L2',
		},
	});
	const rendered = renderFindings(entry);
	assert.match(rendered, /discover.*verdict: force-accept.*cycles: 3.*exhausted/s);
	assert.match(rendered, /forced after cap/);
	assert.match(rendered, /synthesize.*verdict: L2-fallback/s);
	assert.match(rendered, /fallback: L2/);
});

test('renderFindings: empty perRoot -> "(no findings)"', () => {
	const entry = makeEntry({ findings: { perRoot: [] } });
	assert.equal(renderFindings(entry), '(no findings)');
});

test('enforceBudget: passes short values through', () => {
	assert.equal(enforceBudget('hello', 100), 'hello');
});

test('enforceBudget: truncates over-budget values to budget*3 chars', () => {
	const big = 'x'.repeat(500);
	const truncated = enforceBudget(big, 100);
	assert.equal(truncated.length, 300);
});

test('tryParseSingleField: extracts named field from valid JSON', () => {
	assert.equal(tryParseSingleField('{"summary":"hi"}', 'summary'), 'hi');
});

test('tryParseSingleField: unwraps markdown fences', () => {
	assert.equal(tryParseSingleField('```json\n{"recent":"x"}\n```', 'recent'), 'x');
});

test('tryParseSingleField: malformed JSON -> undefined', () => {
	assert.equal(tryParseSingleField('not json', 'summary'), undefined);
});

test('tryParseSingleField: JSON missing the requested key -> undefined', () => {
	assert.equal(tryParseSingleField('{"other":"x"}', 'summary'), undefined);
});

test('tryParseSingleField: JSON value not a string -> undefined', () => {
	assert.equal(tryParseSingleField('{"summary":42}', 'summary'), undefined);
});

// ---------------------------------------------------------------------------
// incrementalUpdate (top-level)
// ---------------------------------------------------------------------------

test('incrementalUpdate: 3 LLM calls by default (summary + recent + semantic)', async () => {
	const { provider, calls } = scriptedProvider([
		layerResponse('summary',  'new summary'),
		layerResponse('recent',   '- recent X'),
		layerResponse('semantic', '- semantic Y'),
	]);
	const result = await incrementalUpdate(provider, {
		priorBundle:   makeBundle(),
		priorEntries:  [makeEntry({ todoId: 'a' })],
		newEntry:      makeEntry({ todoId: 'b' }),
		nextObjective: 'next thing',
		budget:        createBudget(16_384),
	});
	assert.equal(calls.length, 3);
	assert.equal(result.bundle.summary,  'new summary');
	assert.equal(result.bundle.recent,   '- recent X');
	assert.equal(result.bundle.semantic, '- semantic Y');
	assert.equal(result.trace.llmCallsCount, 3);
});

test('incrementalUpdate: skipRecentPolish drops the recent LLM call', async () => {
	const { provider, calls } = scriptedProvider([
		layerResponse('summary',  'new summary'),
		layerResponse('semantic', '- semantic Y'),
	]);
	const prior = makeEntry({ todoId: 'a' });
	const result = await incrementalUpdate(provider, {
		priorBundle:   makeBundle(),
		priorEntries:  [prior],
		newEntry:      makeEntry({ todoId: 'b' }),
		nextObjective: 'next thing',
		budget:        createBudget(16_384),
	}, { skipRecentPolish: true });
	assert.equal(calls.length, 2);
	assert.equal(result.trace.llmCallsCount, 2);
	// The deterministic bullet list still landed in recent, with
	// per-entry "- <todoId> (objective: ...)" headers.
	assert.match(result.bundle.recent, /^- a \(objective:/m);
	assert.match(result.bundle.recent, /^- b \(objective:/m);
});

test('incrementalUpdate: system layer passes through unchanged', async () => {
	const { provider } = scriptedProvider([
		layerResponse('summary',  's'),
		layerResponse('recent',   'r'),
		layerResponse('semantic', 'se'),
	]);
	const prior = makeBundle({ system: 'EVERGREEN' });
	const result = await incrementalUpdate(provider, {
		priorBundle:   prior,
		priorEntries:  [],
		newEntry:      makeEntry(),
		nextObjective: 'next',
		budget:        createBudget(16_384),
	});
	assert.equal(result.bundle.system, 'EVERGREEN');
	assert.equal(result.trace.layersUpdated.includes('system'), false);
});

test('incrementalUpdate: code layer updates deterministically when new code is present', async () => {
	const { provider } = scriptedProvider([
		layerResponse('summary',  's'),
		layerResponse('recent',   'r'),
		layerResponse('semantic', 'se'),
	]);
	const result = await incrementalUpdate(provider, {
		priorBundle:   makeBundle({ code: '```py\nold = 1\n```' }),
		priorEntries:  [],
		newEntry:      makeEntry({ detail: '```py\nnew = 2\n```' }),
		nextObjective: 'next',
		budget:        createBudget(16_384),
	});
	assert.match(result.bundle.code, /old = 1/);
	assert.match(result.bundle.code, /new = 2/);
	assert.equal(result.trace.layersUpdated.includes('code'), true);
});

test('incrementalUpdate: every LLM call has disableThinking=true + temperature=0 + responseFormat=json', async () => {
	const { provider, calls } = scriptedProvider([
		layerResponse('summary',  's'),
		layerResponse('recent',   'r'),
		layerResponse('semantic', 'se'),
	]);
	await incrementalUpdate(provider, {
		priorBundle:   makeBundle(),
		priorEntries:  [],
		newEntry:      makeEntry(),
		nextObjective: 'next',
		budget:        createBudget(16_384),
	});
	for (const call of calls) {
		assert.equal(call.opts.disableThinking, true);
		assert.equal(call.opts.temperature, 0);
		assert.equal(call.opts.responseFormat, 'json');
	}
});

test('incrementalUpdate: malformed layer-update response degrades to empty string, not throw', async () => {
	const { provider } = scriptedProvider([
		'not json at all',                    // summary call fails
		layerResponse('recent', '- ok'),
		layerResponse('semantic', '- ok'),
	]);
	const result = await incrementalUpdate(provider, {
		priorBundle:   makeBundle(),
		priorEntries:  [],
		newEntry:      makeEntry(),
		nextObjective: 'next',
		budget:        createBudget(16_384),
	});
	assert.equal(result.bundle.summary, '');
	assert.equal(result.bundle.recent, '- ok');
	assert.equal(result.bundle.semantic, '- ok');
});

test('incrementalUpdate: empty prior bundle bootstraps cleanly', async () => {
	const { provider } = scriptedProvider([
		layerResponse('summary',  'fresh start'),
		layerResponse('recent',   '- first finding'),
		layerResponse('semantic', '- first semantic'),
	]);
	const result = await incrementalUpdate(provider, {
		priorBundle:   makeBundle({ system: '', summary: '', recent: '', semantic: '', code: '' }),
		priorEntries:  [],
		newEntry:      makeEntry(),
		nextObjective: 'next',
		budget:        createBudget(16_384),
	});
	assert.equal(result.bundle.summary,  'fresh start');
	assert.equal(result.bundle.recent,   '- first finding');
	assert.equal(result.bundle.semantic, '- first semantic');
});

test('incrementalUpdate: layer caps enforced -- overlong values get truncated', async () => {
	const huge = 'a'.repeat(50_000);   // 50k chars = ~16.7k tokens
	const { provider } = scriptedProvider([
		layerResponse('summary',  huge),
		layerResponse('recent',   huge),
		layerResponse('semantic', huge),
	]);
	const budget = createBudget(16_384);   // small layer caps
	const result = await incrementalUpdate(provider, {
		priorBundle:   makeBundle(),
		priorEntries:  [],
		newEntry:      makeEntry(),
		nextObjective: 'next',
		budget,
	});
	assert.ok(result.bundle.summary.length  <= budget.summary  * 3);
	assert.ok(result.bundle.recent.length   <= budget.recent   * 3);
	assert.ok(result.bundle.semantic.length <= budget.semantic * 3);
});

// ---------------------------------------------------------------------------
// formatBulletsAsSemantic
// ---------------------------------------------------------------------------

test('formatBulletsAsSemantic: renders bullets with todoId prefix in order', () => {
	const hits: BulletCacheHit[] = [
		{ todoId: 't1', todoIndex: 0, bullet: 'fact A', score: 0.1 },
		{ todoId: 't2', todoIndex: 1, bullet: 'fact B', score: 0.2 },
		{ todoId: 't3', todoIndex: 2, bullet: 'fact C', score: 0.3 },
	];
	const out = formatBulletsAsSemantic(hits, 1000);
	assert.equal(out, '- [t1] fact A\n- [t2] fact B\n- [t3] fact C');
});

test('formatBulletsAsSemantic: dedupes by exact bullet text, preserves first hit', () => {
	const hits: BulletCacheHit[] = [
		{ todoId: 't1', todoIndex: 0, bullet: 'fact A', score: 0.1 },
		{ todoId: 't2', todoIndex: 1, bullet: 'fact A', score: 0.4 },   // dup
		{ todoId: 't3', todoIndex: 2, bullet: 'fact B', score: 0.5 },
	];
	const out = formatBulletsAsSemantic(hits, 1000);
	assert.equal(out, '- [t1] fact A\n- [t3] fact B');
});

test('formatBulletsAsSemantic: empty hits -> empty string', () => {
	assert.equal(formatBulletsAsSemantic([], 1000), '');
});

test('formatBulletsAsSemantic: enforces budget cap on rendered output', () => {
	const hits: BulletCacheHit[] = Array.from({ length: 20 }, (_, i) => ({
		todoId:    `t${i}`,
		todoIndex: i,
		bullet:    'x'.repeat(50),
		score:     i * 0.01,
	}));
	const out = formatBulletsAsSemantic(hits, 50);   // 50 tokens * 3 = 150 chars
	assert.ok(out.length <= 150);
});

// ---------------------------------------------------------------------------
// Bullet-cache integration in incrementalUpdate
// ---------------------------------------------------------------------------

test('incrementalUpdate: bulletCache provided + non-empty embedding -> semantic skips LLM', async () => {
	const { provider, calls } = scriptedProvider([
		layerResponse('summary', 'fresh summary'),
		layerResponse('recent',  '- recent X'),
		// NO semantic response -- cache supplies it.
	], { embedVec: [0.1, 0.2, 0.3] });
	const { cache, calls: cacheCalls } = fakeBulletCache([
		{ todoId: 't-prior', todoIndex: 0, bullet: 'NameNode FSImage persists inode tree', score: 0.05 },
		{ todoId: 't-prior', todoIndex: 0, bullet: 'BlockManager owns BlocksMap',          score: 0.07 },
	]);
	const result = await incrementalUpdate(provider, {
		priorBundle:   makeBundle(),
		priorEntries:  [],
		newEntry:      makeEntry(),
		nextObjective: 'next thing',
		budget:        createBudget(16_384),
	}, { bulletCache: { cache, topK: 5 } });

	assert.equal(calls.length, 2);            // summary + recent only
	assert.equal(result.trace.llmCallsCount, 2);
	assert.equal(cacheCalls.length, 1);
	assert.equal(cacheCalls[0]!.topK, 5);
	assert.match(result.bundle.semantic, /NameNode FSImage persists inode tree/);
	assert.match(result.bundle.semantic, /BlockManager owns BlocksMap/);
});

test('incrementalUpdate: bulletCache provided BUT provider.embed returns [] -> falls back to LLM semantic', async () => {
	const { provider, calls } = scriptedProvider([
		layerResponse('summary',  's'),
		layerResponse('recent',   'r'),
		layerResponse('semantic', 'llm-based semantic'),   // LLM fallback still called
	], { embedVec: [] });
	const { cache, calls: cacheCalls } = fakeBulletCache([
		{ todoId: 't', todoIndex: 0, bullet: 'should not appear', score: 0.1 },
	]);
	const result = await incrementalUpdate(provider, {
		priorBundle:   makeBundle(),
		priorEntries:  [],
		newEntry:      makeEntry(),
		nextObjective: 'next',
		budget:        createBudget(16_384),
	}, { bulletCache: { cache } });

	assert.equal(calls.length, 3);            // fallback ran the LLM call
	assert.equal(result.trace.llmCallsCount, 3);
	assert.equal(cacheCalls.length, 0);       // cache never queried
	assert.equal(result.bundle.semantic, 'llm-based semantic');
});

test('incrementalUpdate: bulletCache provided + topK omitted -> defaults to 10', async () => {
	const { provider } = scriptedProvider([
		layerResponse('summary', 's'),
		layerResponse('recent',  'r'),
	], { embedVec: [0.5] });
	const { cache, calls: cacheCalls } = fakeBulletCache([]);
	await incrementalUpdate(provider, {
		priorBundle:   makeBundle(),
		priorEntries:  [],
		newEntry:      makeEntry(),
		nextObjective: 'next',
		budget:        createBudget(16_384),
	}, { bulletCache: { cache } });
	assert.equal(cacheCalls.length, 1);
	assert.equal(cacheCalls[0]!.topK, 10);
});

test('incrementalUpdate: bulletCache provided + zero hits -> semantic is empty (no LLM fallback)', async () => {
	const { provider, calls } = scriptedProvider([
		layerResponse('summary', 's'),
		layerResponse('recent',  'r'),
		// No semantic call -- a 0-hit cache result is honored as "nothing relevant", not as an error.
	], { embedVec: [0.5] });
	const { cache } = fakeBulletCache([]);
	const result = await incrementalUpdate(provider, {
		priorBundle:   makeBundle(),
		priorEntries:  [],
		newEntry:      makeEntry(),
		nextObjective: 'next',
		budget:        createBudget(16_384),
	}, { bulletCache: { cache } });
	assert.equal(calls.length, 2);
	assert.equal(result.bundle.semantic, '');
});
