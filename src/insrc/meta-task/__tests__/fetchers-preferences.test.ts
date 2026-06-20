/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for the `preferences` slot fetcher (memory-context M2.4).
 *
 * Drives `fetchPreferences` against a real substrate runtime configured with a
 * no-op LLM provider. Seeds the meta-task owner's `user-assertions` namespace
 * directly so the tests don't depend on the classifier; the curation pass is
 * exercised with a scripted local provider.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fetchPreferences, type FetchInputs } from '../fetchers.js';
import type {
	ContextRequestPreferences,
	DeliverableCatalog,
	ScopeManifest,
} from '../types.js';
import type { LLMMessage, LLMProvider, LLMResponse } from '../../shared/types.js';
import {
	_resetSubstrateRuntimeForTests,
	getSubstrateRuntime,
	initSubstrateRuntime,
} from '../../daemon/substrate/singleton.js';


const TEST_CAPS = {
	structuredOutput: true, toolCalling: false, vision: false,
	webSearch: false, streaming: false, embeddings: false,
} as const;

function noopProvider(): LLMProvider {
	return {
		supportsTools: false,
		capabilities:  TEST_CAPS,
		async complete(_messages: LLMMessage[]): Promise<LLMResponse> {
			throw new Error('noopProvider.complete: should not be invoked');
		},
		stream() { return (async function* () { yield ''; })(); },
		async embed() { return []; },
		async completeStructured() {
			throw new Error('noopProvider.completeStructured: should not be invoked');
		},
	};
}

function scriptedProvider(text: string): LLMProvider {
	return {
		supportsTools: false,
		capabilities:  TEST_CAPS,
		async complete(_messages: LLMMessage[]): Promise<LLMResponse> {
			return { text, stopReason: 'end_turn' };
		},
		stream() { return (async function* () { yield ''; })(); },
		async embed() { return []; },
		async completeStructured<T>(_messages: LLMMessage[], _schema: unknown): Promise<T> {
			// Phase C.2: the scripted text IS the JSON the test wants the
			// provider to "produce". The previous tests parsed via JSON.parse
			// at the callsite; now the migrated curator calls completeStructured
			// directly. Replay the same shape by parsing here.
			try { return JSON.parse(text) as T; }
			catch (err) {
				throw new Error(`scriptedProvider.completeStructured: text not JSON: ${text} (${(err as Error).message})`);
			}
		},
	};
}


interface Fx {
	readonly dir:     string;
	readonly inputs:  FetchInputs;
}

function setup(opts?: { localProvider?: LLMProvider }): Fx {
	_resetSubstrateRuntimeForTests();
	const dir = mkdtempSync(join(tmpdir(), 'm2-prefs-fetch-'));
	initSubstrateRuntime({
		localProvider: noopProvider(),
		workspaceId:   'm2-prefs-fetch',
		rootDir:       dir,
	});
	const scope:   ScopeManifest = { intent: 't', repoPath: '/r', inScopeGlobs: ['**'], outOfScopePaths: [] };
	const catalog: DeliverableCatalog = { entries: [] };
	const inputs: FetchInputs = {
		scope,
		catalog,
		byteCap: 50 * 1024,
		embed: async () => [],
		...(opts?.localProvider !== undefined ? { localProvider: opts.localProvider } : {}),
	};
	return { dir, inputs };
}
function teardown(fx: Fx): void {
	_resetSubstrateRuntimeForTests();
	try { rmSync(fx.dir, { recursive: true, force: true }); } catch { /* ignore */ }
}


interface SeedOpts {
	readonly templateId:    string;
	readonly turnId:        string;
	readonly subject:       string;
	readonly canonicalText: string;
	readonly confidence?:   number;
	readonly categories?:   readonly string[];
	readonly repoPaths?:    readonly string[];
}

async function seed(opts: SeedOpts): Promise<void> {
	const owner = `agent:meta-task:${opts.templateId}`;
	const ns = getSubstrateRuntime().memory.scope(owner, 'user-assertions');
	const key = `${opts.turnId}::${opts.subject}`;
	await ns.put(key, {
		text:              opts.canonicalText,
		subject:           opts.subject,
		preferenceSubject: opts.subject,
		canonicalText:     opts.canonicalText,
		polarity:          'preference',
		scope:             'workspace',
		targetOwners:      [],
		confidence:        opts.confidence ?? 0.9,
		...(opts.categories !== undefined ? { categories: opts.categories } : {}),
		...(opts.repoPaths  !== undefined ? { repoPaths:  opts.repoPaths  } : {}),
	}, {
		kind:       'constraint',
		source:     { kind: 'user-asserted', turnId: opts.turnId },
		confidence: opts.confidence ?? 0.9,
	});
}


// ---------------------------------------------------------------------------
// Basic shape
// ---------------------------------------------------------------------------

test('fetchPreferences: empty owner -> status:empty', async () => {
	const fx = setup();
	try {
		const req: ContextRequestPreferences = { kind: 'preferences', scope: { templateId: 'plan' } };
		const chunk = await fetchPreferences(req, fx.inputs);
		assert.equal(chunk.status, 'empty');
	} finally { teardown(fx); }
});

test('fetchPreferences: no substrate runtime -> status:empty (graceful)', async () => {
	_resetSubstrateRuntimeForTests();
	const scope:   ScopeManifest = { intent: 't', repoPath: '/r', inScopeGlobs: ['**'], outOfScopePaths: [] };
	const catalog: DeliverableCatalog = { entries: [] };
	const inputs: FetchInputs = { scope, catalog, byteCap: 1024, embed: async () => [] };
	const req: ContextRequestPreferences = { kind: 'preferences' };
	const chunk = await fetchPreferences(req, inputs);
	assert.equal(chunk.status, 'empty');
	assert.match(chunk.note ?? '', /not initialised/);
});

test('fetchPreferences: routes to correct owner by templateId', async () => {
	const fx = setup();
	try {
		// Seed two owners; only the 'plan' one should be returned.
		await seed({ templateId: 'plan',   turnId: 't-1', subject: 'test-policy', canonicalText: 'Plan: always tests' });
		await seed({ templateId: 'review', turnId: 't-2', subject: 'test-policy', canonicalText: 'Review: skim tests' });

		const reqPlan:   ContextRequestPreferences = { kind: 'preferences', scope: { templateId: 'plan' } };
		const reqReview: ContextRequestPreferences = { kind: 'preferences', scope: { templateId: 'review' } };

		const planChunk   = await fetchPreferences(reqPlan,   fx.inputs);
		const reviewChunk = await fetchPreferences(reqReview, fx.inputs);

		assert.equal(planChunk.status, 'ok');
		const planPayload = planChunk.payload as Array<{ canonicalText: string }>;
		assert.equal(planPayload.length, 1);
		assert.equal(planPayload[0]!.canonicalText, 'Plan: always tests');

		const reviewPayload = reviewChunk.payload as Array<{ canonicalText: string }>;
		assert.equal(reviewPayload[0]!.canonicalText, 'Review: skim tests');
	} finally { teardown(fx); }
});

test('fetchPreferences: __unknown__ owner when templateId missing', async () => {
	const fx = setup();
	try {
		const owner = 'agent:meta-task:__unknown__';
		const ns = getSubstrateRuntime().memory.scope(owner, 'user-assertions');
		await ns.put('t-1::test-policy', {
			text: 't', subject: 'test-policy', preferenceSubject: 'test-policy',
			canonicalText: 'Anonymous preference', polarity: 'preference',
			scope: 'workspace', targetOwners: [], confidence: 0.9,
		}, { kind: 'constraint', source: { kind: 'user-asserted', turnId: 't-1' }, confidence: 0.9 });

		const chunk = await fetchPreferences({ kind: 'preferences' }, fx.inputs);
		assert.equal(chunk.status, 'ok');
		const payload = chunk.payload as Array<{ canonicalText: string }>;
		assert.equal(payload[0]!.canonicalText, 'Anonymous preference');
	} finally { teardown(fx); }
});


// ---------------------------------------------------------------------------
// G4 hard scope filter
// ---------------------------------------------------------------------------

test('fetchPreferences: G4 repoPath filter drops non-matching candidates', async () => {
	const fx = setup();
	try {
		await seed({ templateId: 'plan', turnId: 't-1', subject: 'test-policy', canonicalText: 'For repo A', repoPaths: ['/a'] });
		await seed({ templateId: 'plan', turnId: 't-2', subject: 'code-style',  canonicalText: 'For repo B', repoPaths: ['/b'] });
		await seed({ templateId: 'plan', turnId: 't-3', subject: 'workflow',    canonicalText: 'Anywhere'  });

		const chunk = await fetchPreferences({
			kind: 'preferences', scope: { templateId: 'plan', repoPath: '/a' },
		}, fx.inputs);
		assert.equal(chunk.status, 'ok');
		const payload = chunk.payload as Array<{ canonicalText: string }>;
		const texts = payload.map(p => p.canonicalText);
		assert.ok(texts.includes('For repo A'));
		assert.ok(texts.includes('Anywhere'),     'preference without repoPaths should pass any repoPath filter');
		assert.ok(!texts.includes('For repo B'),  'non-matching repoPath should be dropped');
	} finally { teardown(fx); }
});

test('fetchPreferences: G4 category filter drops non-matching candidates', async () => {
	const fx = setup();
	try {
		await seed({ templateId: 'plan', turnId: 't-1', subject: 'a', canonicalText: 'Quality cat', categories: ['quality'] });
		await seed({ templateId: 'plan', turnId: 't-2', subject: 'b', canonicalText: 'Perf cat',    categories: ['perf'] });
		const chunk = await fetchPreferences({
			kind: 'preferences', scope: { templateId: 'plan', category: 'quality' },
		}, fx.inputs);
		const payload = chunk.payload as Array<{ canonicalText: string }>;
		const texts = payload.map(p => p.canonicalText);
		assert.ok(texts.includes('Quality cat'));
		assert.ok(!texts.includes('Perf cat'));
	} finally { teardown(fx); }
});


// ---------------------------------------------------------------------------
// G7 noise threshold
// ---------------------------------------------------------------------------

test('fetchPreferences: confidence below noise threshold dropped', async () => {
	const fx = setup();
	try {
		await seed({ templateId: 'plan', turnId: 't-1', subject: 'a', canonicalText: 'Strong',  confidence: 0.9 });
		await seed({ templateId: 'plan', turnId: 't-2', subject: 'b', canonicalText: 'Noisy',   confidence: 0.10 });
		const chunk = await fetchPreferences({ kind: 'preferences', scope: { templateId: 'plan' } }, fx.inputs);
		const payload = chunk.payload as Array<{ canonicalText: string }>;
		assert.equal(payload.length, 1);
		assert.equal(payload[0]!.canonicalText, 'Strong');
	} finally { teardown(fx); }
});


// ---------------------------------------------------------------------------
// G5 curation pass
// ---------------------------------------------------------------------------

test('fetchPreferences: curator drops orthogonal preferences when localProvider + stepIntent provided', async () => {
	const curator = scriptedProvider(JSON.stringify({ relevant_indices: [0] }));
	const fx = setup({ localProvider: curator });
	try {
		await seed({ templateId: 'plan', turnId: 't-1', subject: 'test-policy',     canonicalText: 'Always tests' });
		await seed({ templateId: 'plan', turnId: 't-2', subject: 'workflow-policy', canonicalText: 'Deploy only Fridays' });
		const chunk = await fetchPreferences({
			kind: 'preferences', scope: { templateId: 'plan' },
			stepIntent: 'drafting an implementation plan',
		}, fx.inputs);
		const payload = chunk.payload as Array<{ canonicalText: string }>;
		assert.equal(payload.length, 1);
		assert.equal(payload[0]!.canonicalText, 'Always tests');
	} finally { teardown(fx); }
});

test('fetchPreferences: curator returns empty -> inclusion bias falls back to scope-filtered set', async () => {
	const curator = scriptedProvider(JSON.stringify({ relevant_indices: [] }));
	const fx = setup({ localProvider: curator });
	try {
		await seed({ templateId: 'plan', turnId: 't-1', subject: 'a', canonicalText: 'A' });
		await seed({ templateId: 'plan', turnId: 't-2', subject: 'b', canonicalText: 'B' });
		const chunk = await fetchPreferences({
			kind: 'preferences', scope: { templateId: 'plan' }, stepIntent: 'unclear',
		}, fx.inputs);
		const payload = chunk.payload as Array<{ canonicalText: string }>;
		assert.equal(payload.length, 2, 'empty curator output should fall back to scope-filtered list');
	} finally { teardown(fx); }
});

test('fetchPreferences: curator malformed JSON -> include all', async () => {
	const curator = scriptedProvider('not-json');
	const fx = setup({ localProvider: curator });
	try {
		await seed({ templateId: 'plan', turnId: 't-1', subject: 'a', canonicalText: 'A' });
		await seed({ templateId: 'plan', turnId: 't-2', subject: 'b', canonicalText: 'B' });
		const chunk = await fetchPreferences({
			kind: 'preferences', scope: { templateId: 'plan' }, stepIntent: 'anything',
		}, fx.inputs);
		const payload = chunk.payload as Array<{ canonicalText: string }>;
		assert.equal(payload.length, 2);
	} finally { teardown(fx); }
});

test('fetchPreferences: no provider -> skip curation entirely', async () => {
	const fx = setup();  // no localProvider
	try {
		await seed({ templateId: 'plan', turnId: 't-1', subject: 'a', canonicalText: 'A' });
		await seed({ templateId: 'plan', turnId: 't-2', subject: 'b', canonicalText: 'B' });
		const chunk = await fetchPreferences({
			kind: 'preferences', scope: { templateId: 'plan' }, stepIntent: 'has content',
		}, fx.inputs);
		const payload = chunk.payload as Array<{ canonicalText: string }>;
		assert.equal(payload.length, 2);
	} finally { teardown(fx); }
});

test('fetchPreferences: single candidate skips curation even with provider + stepIntent', async () => {
	// Curator would drop the only candidate; if curation runs, we'd see length 0.
	const curator = scriptedProvider(JSON.stringify({ relevant_indices: [] }));
	const fx = setup({ localProvider: curator });
	try {
		await seed({ templateId: 'plan', turnId: 't-1', subject: 'a', canonicalText: 'Only' });
		const chunk = await fetchPreferences({
			kind: 'preferences', scope: { templateId: 'plan' }, stepIntent: 'something',
		}, fx.inputs);
		const payload = chunk.payload as Array<{ canonicalText: string }>;
		assert.equal(payload.length, 1, 'single candidate should bypass curation');
	} finally { teardown(fx); }
});
