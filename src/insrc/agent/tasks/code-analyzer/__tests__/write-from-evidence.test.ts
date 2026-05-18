/**
 * Tests for `writeSectionFromEvidence` -- Phase W of
 * plans/code-analyzer-gather-then-write.md.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	writeSectionFromEvidence,
	stripWriterArtifacts,
	extractCitations,
	type WriteFromEvidenceInput,
} from '../write-from-evidence.js';
import type { LLMProvider, LLMResponse, LLMMessage } from '../../../../shared/types.js';
import type { PlannedAction } from '../../../content-gen/plan-actions.js';
import type { EvidenceEntry } from '../gather-evidence.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

function buildFakeProvider(responseText: string): { provider: LLMProvider; lastCall: { messages: LLMMessage[] } | undefined } {
	const handle: { lastCall: { messages: LLMMessage[] } | undefined } = { lastCall: undefined };
	const provider: LLMProvider = {
		supportsTools: true,
		async complete(messages: LLMMessage[]): Promise<LLMResponse> {
			handle.lastCall = { messages: [...messages] };
			return { text: responseText, stopReason: 'end_turn' };
		},
		async *stream() { /* unused */ },
		async embed() { return []; },
	};
	return { provider, lastCall: handle.lastCall };
}

function buildAction(): PlannedAction {
	return {
		id:              'sec-1',
		title:           'Test Section',
		objective:       'Explain the database layer.',
		maxBudgetTokens: 1800,
		reviewCriteria:  ['cite specific files', 'name key entities'],
	};
}

function buildInput(opts: { provider: LLMProvider; evidence: readonly EvidenceEntry[] }): WriteFromEvidenceInput {
	return {
		provider: opts.provider,
		action:   buildAction(),
		request:  'describe the db layer',
		evidence: opts.evidence,
	};
}

const SAMPLE_EVIDENCE: readonly EvidenceEntry[] = [
	{
		skillId:    'code.source.module.describe',
		args:       { modulePath: 'insors/extraction/db' },
		facts:      ['Module contains 30 files', 'Key entities: ManagedCursor, ExtractionDbManager'],
		citations:  ['path:insors/extraction/db/__init__.py#L1-L20'],
		confidence: 'high',
	},
	{
		skillId:    'code.source.file.describe',
		args:       { file: 'insors/extraction/db/api_clients_data.py' },
		facts:      ['Handles API client persistence'],
		citations:  ['path:insors/extraction/db/api_clients_data.py#L1-L369'],
		confidence: 'medium',
	},
];

// ---------------------------------------------------------------------------
// stripWriterArtifacts (pure)
// ---------------------------------------------------------------------------

test('stripWriterArtifacts: empty input -> empty', () => {
	assert.equal(stripWriterArtifacts(''), '');
	assert.equal(stripWriterArtifacts('   \n  '), '');
});

test('stripWriterArtifacts: removes triple-backtick fence wrapper', () => {
	assert.equal(stripWriterArtifacts('```\nhello world\n```'), 'hello world');
	assert.equal(stripWriterArtifacts('```markdown\nhello world\n```'), 'hello world');
});

test('stripWriterArtifacts: strips "Here is the section:" prefix', () => {
	assert.equal(
		stripWriterArtifacts('Here is the section: The actual prose.'),
		'The actual prose.',
	);
});

test('stripWriterArtifacts: strips a leading "## heading" the model accidentally included', () => {
	const input = '## Some Section Title\n\nThe actual prose.';
	assert.equal(stripWriterArtifacts(input), 'The actual prose.');
});

test('stripWriterArtifacts: strips "Based on the evidence" preamble', () => {
	assert.equal(
		stripWriterArtifacts('Based on the evidence: The module has 30 files.'),
		'The module has 30 files.',
	);
});

test('stripWriterArtifacts: no-op on clean prose', () => {
	const clean = 'The `db` module contains 30 files and 785 entities. It exposes `ManagedCursor` and `ExtractionDbManager`.';
	assert.equal(stripWriterArtifacts(clean), clean);
});

// ---------------------------------------------------------------------------
// extractCitations (pure)
// ---------------------------------------------------------------------------

test('extractCitations: no citations -> empty', () => {
	assert.deepEqual(extractCitations('Plain prose with no links.'), []);
});

test('extractCitations: distinct path: URIs', () => {
	const md = 'See [foo](path:a/b.ts#L1) and [bar](path:c/d.ts) for details.';
	const cites = extractCitations(md);
	assert.equal(cites.length, 2);
	assert.ok(cites.includes('path:a/b.ts#L1'));
	assert.ok(cites.includes('path:c/d.ts'));
});

test('extractCitations: deduplicates repeated URIs', () => {
	const md = 'See [a](path:f.ts#L1) and again [a](path:f.ts#L1).';
	assert.deepEqual(extractCitations(md), ['path:f.ts#L1']);
});

// ---------------------------------------------------------------------------
// writeSectionFromEvidence end-to-end
// ---------------------------------------------------------------------------

test('writeSectionFromEvidence: returns the model output, post-stripped', async () => {
	const { provider } = buildFakeProvider('## Test Section\n\nThe `db` module contains 30 files [a](path:f.ts).');
	const out = await writeSectionFromEvidence(buildInput({ provider, evidence: SAMPLE_EVIDENCE }));
	assert.equal(out.empty, false);
	assert.doesNotMatch(out.markdown, /^#/);
	assert.match(out.markdown, /db.*module contains 30 files/);
	assert.deepEqual(out.citationsUsed, ['path:f.ts']);
});

test('writeSectionFromEvidence: empty response -> empty=true', async () => {
	const { provider } = buildFakeProvider('   ');
	const out = await writeSectionFromEvidence(buildInput({ provider, evidence: SAMPLE_EVIDENCE }));
	assert.equal(out.empty, true);
	assert.equal(out.markdown, '');
	assert.equal(out.citationsUsed.length, 0);
});

test('writeSectionFromEvidence: prompt includes the evidence ledger', async () => {
	const captured: { messages: LLMMessage[] } = { messages: [] };
	const provider: LLMProvider = {
		supportsTools: true,
		async complete(messages: LLMMessage[]): Promise<LLMResponse> {
			captured.messages = messages;
			return { text: 'OK', stopReason: 'end_turn' };
		},
		async *stream() { /* unused */ },
		async embed() { return []; },
	};
	await writeSectionFromEvidence(buildInput({ provider, evidence: SAMPLE_EVIDENCE }));
	const user = captured.messages.find(m => m.role === 'user');
	const text = typeof user?.content === 'string' ? user.content : '';
	assert.match(text, /code\.source\.module\.describe/);
	assert.match(text, /ManagedCursor/);
	assert.match(text, /api_clients_data\.py/);
});

test('writeSectionFromEvidence: empty evidence ledger surfaces the no-evidence note in prompt', async () => {
	const captured: { messages: LLMMessage[] } = { messages: [] };
	const provider: LLMProvider = {
		supportsTools: true,
		async complete(messages: LLMMessage[]): Promise<LLMResponse> {
			captured.messages = messages;
			return { text: 'Best-effort overview.', stopReason: 'end_turn' };
		},
		async *stream() { /* unused */ },
		async embed() { return []; },
	};
	await writeSectionFromEvidence(buildInput({ provider, evidence: [] }));
	const user = captured.messages.find(m => m.role === 'user');
	const text = typeof user?.content === 'string' ? user.content : '';
	assert.match(text, /no evidence captured/);
});

test('writeSectionFromEvidence: system prompt forbids process narration + heading', async () => {
	const captured: { messages: LLMMessage[] } = { messages: [] };
	const provider: LLMProvider = {
		supportsTools: true,
		async complete(messages: LLMMessage[]): Promise<LLMResponse> {
			captured.messages = messages;
			return { text: 'body', stopReason: 'end_turn' };
		},
		async *stream() { /* unused */ },
		async embed() { return []; },
	};
	await writeSectionFromEvidence(buildInput({ provider, evidence: SAMPLE_EVIDENCE }));
	const sys = captured.messages.find(m => m.role === 'system');
	const text = typeof sys?.content === 'string' ? sys.content : '';
	assert.match(text, /process narration/i);
	assert.match(text, /No section heading/i);
});
