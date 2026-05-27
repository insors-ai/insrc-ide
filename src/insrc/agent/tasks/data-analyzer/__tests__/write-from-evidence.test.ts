/**
 * Tests for write-from-evidence.ts (Phase E of
 * plans/analyzers/data-analyzer-parity.md).
 *
 * Coverage:
 *   - Citation rendering per kind (rdbms / kv / file-source / code-ref)
 *   - extractDataCitations parses both `data:` and `path:` schemes
 *   - stripWriterArtifacts strips fence + opener patterns
 *   - validateDataCitationCoverage: paragraph threshold + transition
 *     paragraphs skipped
 *   - validateParagraphCitationDedup (DA-B4): per-paragraph URI dedup
 *   - redraftRegressionGuard (DA-B1): score = textLen × citationCount,
 *     90% threshold, zero-baseline edge case
 *   - System + user prompt rendering: rules + evidence ledger
 *   - End-to-end via FakeProvider
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	writeFromDataEvidence,
	renderInlineCitation,
	extractDataCitations,
	stripWriterArtifacts,
	validateDataCitationCoverage,
	validateParagraphCitationDedup,
	redraftRegressionGuard,
	formatDataCitationCoverageNotes,
	formatParagraphDedupNotes,
	_buildSystemPromptForTest as buildSystemPrompt,
	_buildUserPromptForTest   as buildUserPrompt,
} from '../write-from-evidence.js';
import type { DataAnalysisTask, DataEvidenceEntry, DataCitation } from '../types.js';
import type { LLMProvider, LLMResponse } from '../../../../shared/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fakeProvider(responseText: string): LLMProvider {
	return {
		supportsTools: false,
		async complete(): Promise<LLMResponse> {
			return { text: responseText, stopReason: 'end_turn' };
		},
		async *stream() { return; },
		async embed() { return []; },
	} as unknown as LLMProvider;
}

const fixtureTask: DataAnalysisTask = {
	itemId:   'task-1',
	kind:     'inspect-schema',
	question: 'describe the orders table',
	origin:   'plan',
};

function entry(citations: DataCitation[], facts: string[] = ['fact A', 'fact B']): DataEvidenceEntry {
	return {
		skillId:    'data.source.rdbms.describe-table',
		args:       { connectionId: 'pg-primary', table: 'orders' },
		facts,
		citations,
		confidence: 'high',
	};
}

// ---------------------------------------------------------------------------
// renderInlineCitation per kind
// ---------------------------------------------------------------------------

test('renderInlineCitation: rdbms full shape', () => {
	const link = renderInlineCitation(
		{ kind: 'rdbms', connectionId: 'pg-primary', schema: 'public', table: 'orders', column: 'amount' },
		0, 0,
	);
	assert.equal(link, '[public.orders.amount](data:rdbms/pg-primary/public.orders#col=amount)');
});

test('renderInlineCitation: rdbms without schema', () => {
	const link = renderInlineCitation(
		{ kind: 'rdbms', connectionId: 'pg-primary', table: 'orders' },
		0, 0,
	);
	assert.equal(link, '[orders](data:rdbms/pg-primary/orders)');
});

test('renderInlineCitation: kv full shape', () => {
	const link = renderInlineCitation(
		{ kind: 'kv', connectionId: 'redis-1', keyPattern: 'user:{id}', fieldPath: '$.email' },
		0, 0,
	);
	assert.equal(link, '[user:{id} $.email](data:kv/redis-1/user:{id}#field=$.email)');
});

test('renderInlineCitation: file-source', () => {
	const link = renderInlineCitation(
		{ kind: 'file-source', connectionId: 'parquet-1', path: 's3://bucket/data.parquet', column: 'event_ts' },
		0, 0,
	);
	assert.equal(link, '[data.parquet.event_ts](data:file/parquet-1/s3://bucket/data.parquet#col=event_ts)');
});

test('renderInlineCitation: code-ref with line range', () => {
	const link = renderInlineCitation(
		{ kind: 'code-ref', path: 'src/orders/repo.ts', lineStart: 42, lineEnd: 58 },
		0, 0,
	);
	assert.equal(link, '[repo.ts](path:src/orders/repo.ts#L42-L58)');
});

test('renderInlineCitation: code-ref without lines', () => {
	const link = renderInlineCitation(
		{ kind: 'code-ref', path: 'src/foo.ts' },
		0, 0,
	);
	assert.equal(link, '[foo.ts](path:src/foo.ts)');
});

// ---------------------------------------------------------------------------
// extractDataCitations
// ---------------------------------------------------------------------------

test('extractDataCitations: pulls data: and path: URIs out of markdown', () => {
	const md = `
Some text [orders](data:rdbms/pg/orders) and more
text [repo.ts](path:src/repo.ts#L1-L10) here.
`;
	const cites = extractDataCitations(md);
	assert.equal(cites.length, 2);
	assert.ok(cites.includes('data:rdbms/pg/orders'));
	assert.ok(cites.includes('path:src/repo.ts#L1-L10'));
});

test('extractDataCitations: dedups distinct URIs', () => {
	const md = `[a](data:rdbms/pg/orders) text [b](data:rdbms/pg/orders) text`;
	const cites = extractDataCitations(md);
	assert.equal(cites.length, 1);
});

test('extractDataCitations: returns empty for citation-free markdown', () => {
	assert.equal(extractDataCitations('no citations here').length, 0);
});

// ---------------------------------------------------------------------------
// stripWriterArtifacts
// ---------------------------------------------------------------------------

test('stripWriterArtifacts: strips fenced wrapper', () => {
	const out = stripWriterArtifacts('```markdown\nbody content here\n```');
	assert.equal(out, 'body content here');
});

test('stripWriterArtifacts: strips "Here is..." opener', () => {
	const out = stripWriterArtifacts("Here's the section: body content");
	assert.equal(out, 'body content');
});

test('stripWriterArtifacts: strips "Based on the evidence" preamble', () => {
	const out = stripWriterArtifacts('Based on the evidence: real content here');
	assert.equal(out, 'real content here');
});

test('stripWriterArtifacts: strips leading heading', () => {
	const out = stripWriterArtifacts('## Section title\n\nactual content');
	assert.equal(out, 'actual content');
});

test('stripWriterArtifacts: empty input -> empty output', () => {
	assert.equal(stripWriterArtifacts(''), '');
	assert.equal(stripWriterArtifacts('   \n  '), '');
});

// ---------------------------------------------------------------------------
// validateDataCitationCoverage
// ---------------------------------------------------------------------------

test('validateDataCitationCoverage: empty markdown -> ok', () => {
	const r = validateDataCitationCoverage('');
	assert.equal(r.ok, true);
	assert.equal(r.nonTrivialParagraphs, 0);
});

test('validateDataCitationCoverage: long paragraph without citation -> not ok', () => {
	const longText = 'This is a very long paragraph designed to exceed the 80-char transition threshold and yet contain no citation links at all anywhere.';
	const r = validateDataCitationCoverage(longText);
	assert.equal(r.ok, false);
	assert.equal(r.uncitedParagraphs.length, 1);
});

test('validateDataCitationCoverage: long paragraph with citation -> ok', () => {
	const longText = 'This is a long paragraph that exceeds the 80-char threshold and contains an [orders](data:rdbms/pg/orders) citation inline so it counts as cited.';
	const r = validateDataCitationCoverage(longText);
	assert.equal(r.ok, true);
});

test('validateDataCitationCoverage: short transition paragraph exempt', () => {
	const shortText = 'A short paragraph under threshold.';
	const r = validateDataCitationCoverage(shortText);
	assert.equal(r.ok, true);
	assert.equal(r.nonTrivialParagraphs, 0);
});

test('validateDataCitationCoverage: colon-terminated intro paragraph exempt', () => {
	const intro = 'The following sections describe the relevant findings about the data layer below:';
	const r = validateDataCitationCoverage(intro);
	assert.equal(r.ok, true);
});

test('formatDataCitationCoverageNotes: ok result -> empty notes', () => {
	assert.deepEqual(formatDataCitationCoverageNotes({ ok: true, nonTrivialParagraphs: 0, uncitedParagraphs: [] }), []);
});

test('formatDataCitationCoverageNotes: failure surfaces excerpts', () => {
	const notes = formatDataCitationCoverageNotes({
		ok: false,
		nonTrivialParagraphs: 2,
		uncitedParagraphs: ['some long paragraph text that has no citation at all in its body anywhere'],
	});
	assert.ok(notes.length > 0);
	assert.match(notes[0]!, /Citation coverage failure/);
});

// ---------------------------------------------------------------------------
// validateParagraphCitationDedup (DA-B4)
// ---------------------------------------------------------------------------

test('validateParagraphCitationDedup: single citation per paragraph -> ok', () => {
	const md = `First paragraph cites [a](data:rdbms/pg/orders).\n\nSecond paragraph cites [b](data:rdbms/pg/users).`;
	const r = validateParagraphCitationDedup(md);
	assert.equal(r.ok, true);
});

test('validateParagraphCitationDedup: same URI twice in one paragraph -> fail', () => {
	const md = `Para repeats [a](data:rdbms/pg/orders) and then again [b](data:rdbms/pg/orders) in one breath.`;
	const r = validateParagraphCitationDedup(md);
	assert.equal(r.ok, false);
	assert.equal(r.offendingParagraphs.length, 1);
	assert.deepEqual(r.offendingParagraphs[0]!.duplicates, ['data:rdbms/pg/orders']);
});

test('validateParagraphCitationDedup: distinct URIs across paragraphs -> ok', () => {
	const md = `Para A cites [a](data:rdbms/pg/orders).\n\nPara B cites [b](data:rdbms/pg/orders) -- different paragraph, same URI is fine.`;
	const r = validateParagraphCitationDedup(md);
	assert.equal(r.ok, true);
});

test('validateParagraphCitationDedup: different fragments on same table -> ok (distinct URIs)', () => {
	const md = `Para uses [col1](data:rdbms/pg/orders#col=col1) and [col2](data:rdbms/pg/orders#col=col2) -- different fragments.`;
	const r = validateParagraphCitationDedup(md);
	assert.equal(r.ok, true);
});

test('formatParagraphDedupNotes: ok -> empty', () => {
	assert.deepEqual(formatParagraphDedupNotes({ ok: true, offendingParagraphs: [] }), []);
});

test('formatParagraphDedupNotes: failure surfaces duplicates', () => {
	const notes = formatParagraphDedupNotes({
		ok: false,
		offendingParagraphs: [{ paragraph: 'foo bar', duplicates: ['data:rdbms/pg/orders'] }],
	});
	assert.ok(notes.length >= 1);
	assert.match(notes[0]!, /DA-B4/);
});

// ---------------------------------------------------------------------------
// redraftRegressionGuard (DA-B1)
// ---------------------------------------------------------------------------

test('redraftRegressionGuard: redraft grows -> not regressed', () => {
	const r = redraftRegressionGuard({
		originalTextLen: 1000, originalCitationCount: 5,
		redraftTextLen:  1500, redraftCitationCount:  7,
	});
	assert.equal(r.regressed, false);
	assert.ok(r.ratio > 1);
});

test('redraftRegressionGuard: redraft shrinks > 10% -> regressed', () => {
	// original: 1000 * 5 = 5000. redraft below 4500 = regressed.
	const r = redraftRegressionGuard({
		originalTextLen: 1000, originalCitationCount: 5,
		redraftTextLen:   800, redraftCitationCount:  4,  // 3200 -- well below 90%
	});
	assert.equal(r.regressed, true);
});

test('redraftRegressionGuard: redraft drops citations only -> regressed', () => {
	const r = redraftRegressionGuard({
		originalTextLen: 1000, originalCitationCount: 10,
		redraftTextLen:  1000, redraftCitationCount:   5,  // half the citations
	});
	assert.equal(r.regressed, true);
});

test('redraftRegressionGuard: zero baseline edge case -> never regressed', () => {
	const r = redraftRegressionGuard({
		originalTextLen: 0,    originalCitationCount: 0,
		redraftTextLen:  500,  redraftCitationCount:  2,
	});
	assert.equal(r.regressed, false);
});

test('redraftRegressionGuard: redraft exactly 90% of original -> not regressed (boundary)', () => {
	const r = redraftRegressionGuard({
		originalTextLen: 1000, originalCitationCount: 10,
		redraftTextLen:   900, redraftCitationCount: 10,  // ratio = 0.9 exact
	});
	assert.equal(r.regressed, false);
});

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

test('buildSystemPrompt: includes the four URI schemes', () => {
	const p = buildSystemPrompt();
	assert.match(p, /data:rdbms/);
	assert.match(p, /data:kv/);
	assert.match(p, /data:file/);
	assert.match(p, /path:</);
});

test('buildSystemPrompt: enumerates DA-A1/B2/B3/B4 hard rules', () => {
	const p = buildSystemPrompt();
	assert.match(p, /DA-A1/);
	assert.match(p, /DA-B2/);
	assert.match(p, /DA-B3/);
	assert.match(p, /DA-B4/);
});

test('buildUserPrompt: empty evidence -> writes DA-A1 honest note', () => {
	const p = buildUserPrompt({ provider: fakeProvider(''), task: fixtureTask, evidence: [] });
	assert.match(p, /no evidence captured/);
	assert.match(p, /DA-A1/);
});

test('buildUserPrompt: pairs facts with inline citations', () => {
	const e = entry([
		{ kind: 'rdbms', connectionId: 'pg-primary', table: 'orders' },
	], ['orders has 1.2M rows']);
	const p = buildUserPrompt({ provider: fakeProvider(''), task: fixtureTask, evidence: [e] });
	assert.match(p, /orders has 1\.2M rows/);
	assert.match(p, /data:rdbms\/pg-primary\/orders/);
});

test('buildUserPrompt: surfaces numeric facts when present', () => {
	const e: DataEvidenceEntry = {
		skillId: 'data.profile.numeric.rdbms',
		args:    {},
		facts:   ['profile complete'],
		citations: [{ kind: 'rdbms', connectionId: 'pg', table: 'orders', column: 'amount' }],
		numericFacts: [{ name: 'p99', value: 5000, unit: 'usd' }],
		confidence: 'high',
	};
	const p = buildUserPrompt({ provider: fakeProvider(''), task: fixtureTask, evidence: [e] });
	assert.match(p, /numeric facts:/);
	assert.match(p, /p99 = 5000 usd/);
});

// ---------------------------------------------------------------------------
// End-to-end via FakeProvider
// ---------------------------------------------------------------------------

test('writeFromDataEvidence: returns model output + extracted citations', async () => {
	const proseOut = `The [orders](data:rdbms/pg/orders) table has 1.2M rows.`;
	const provider = fakeProvider(proseOut);
	const out = await writeFromDataEvidence({
		provider,
		task: fixtureTask,
		evidence: [entry([{ kind: 'rdbms', connectionId: 'pg', table: 'orders' }])],
	});
	assert.equal(out.markdown, proseOut);
	assert.equal(out.empty, false);
	assert.equal(out.citationsUsed.length, 1);
	assert.equal(out.citationsUsed[0], 'data:rdbms/pg/orders');
});

test('writeFromDataEvidence: empty model output -> empty:true', async () => {
	const provider = fakeProvider('');
	const out = await writeFromDataEvidence({
		provider,
		task: fixtureTask,
		evidence: [entry([{ kind: 'rdbms', connectionId: 'pg', table: 'orders' }])],
	});
	assert.equal(out.empty, true);
	assert.equal(out.citationsUsed.length, 0);
});

test('writeFromDataEvidence: strips wrapping fence', async () => {
	const provider = fakeProvider('```markdown\nReal body here\n```');
	const out = await writeFromDataEvidence({
		provider,
		task: fixtureTask,
		evidence: [],
	});
	assert.equal(out.markdown, 'Real body here');
});
