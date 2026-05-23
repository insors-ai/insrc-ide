/**
 * Phase 12 tests for plans/code-analyzer-hallucination-mitigation.md.
 *
 * Covers the pure parse + render helpers. The cloud-call path is
 * covered indirectly by the existing discovery-flow tests once the
 * env var is set; here we test that:
 *   - Malformed responses parse safely (null) rather than throwing.
 *   - Paragraphs with empty refs[] are dropped.
 *   - Paragraphs with refs that don't resolve to entries are dropped.
 *   - Citation splicing puts the primary citation at the end of the
 *     first sentence and surfaces secondaries in parens.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	_parseStructuredResponseForTest as parseResponse,
	_renderParagraphsForTest        as render,
	_renderOneParagraphForTest      as renderOne,
} from '../write-from-evidence-structured.js';
import type { EvidenceEntry } from '../summarize-result.js';
import type { Citation } from '../../../content-gen/discovery-plan.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function entry(id: string, citationPath: string, startLine = 10, endLine = 20): EvidenceEntry {
	const cite: Citation = {
		path:       citationPath,
		startLine,
		endLine,
		label:      `${id}-label`,
	};
	return {
		skillId:      `skill-${id}`,
		args:         {},
		facts:        [`Fact about ${id}`],
		citations:    [],
		citationObjs: [cite],
		confidence:   'high',
	};
}

// ---------------------------------------------------------------------------
// parseStructuredResponse
// ---------------------------------------------------------------------------

test('parseStructuredResponse: parses a well-shaped JSON', () => {
	const r = parseResponse(JSON.stringify({
		paragraphs: [
			{ narrative: 'BlockManager spans 162-5558.', evidenceRefs: ['e1'] },
			{ narrative: 'It coordinates replication.', evidenceRefs: ['e2', 'e3'] },
		],
	}));
	assert.ok(r !== null);
	assert.equal(r!.paragraphs.length, 2);
});

test('parseStructuredResponse: strips ```json fences', () => {
	const r = parseResponse('```json\n' + JSON.stringify({
		paragraphs: [{ narrative: 'X', evidenceRefs: ['e1'] }],
	}) + '\n```');
	assert.ok(r !== null);
	assert.equal(r!.paragraphs.length, 1);
});

test('parseStructuredResponse: returns null on malformed JSON', () => {
	assert.equal(parseResponse('not json'), null);
	assert.equal(parseResponse(''), null);
});

test('parseStructuredResponse: filters paragraphs with empty refs[] or empty narrative', () => {
	const r = parseResponse(JSON.stringify({
		paragraphs: [
			{ narrative: '',                evidenceRefs: ['e1'] },
			{ narrative: 'Valid paragraph.', evidenceRefs: []    },
			{ narrative: 'Keep me.',         evidenceRefs: ['e2'] },
		],
	}));
	assert.ok(r !== null);
	assert.equal(r!.paragraphs.length, 1);
	assert.equal(r!.paragraphs[0]!.narrative, 'Keep me.');
});

// ---------------------------------------------------------------------------
// renderParagraphs (resolution)
// ---------------------------------------------------------------------------

test('renderParagraphs: drops paragraphs whose evidenceRefs do not resolve', () => {
	const entryById = new Map<string, EvidenceEntry>([
		['e1', entry('e1', '/repo/X.java')],
	]);
	const result = render(
		{
			paragraphs: [
				{ narrative: 'Valid paragraph.',  evidenceRefs: ['e1'] },
				{ narrative: 'Bad paragraph.',    evidenceRefs: ['e99'] }, // not in map
			],
		},
		entryById,
	);
	assert.equal(result.kept, 1);
	assert.equal(result.droppedBadRef, 1);
});

test('renderParagraphs: returns assembled markdown joined by \\n\\n', () => {
	const entryById = new Map<string, EvidenceEntry>([
		['e1', entry('e1', '/repo/X.java')],
		['e2', entry('e2', '/repo/Y.java')],
	]);
	const result = render(
		{
			paragraphs: [
				{ narrative: 'First. Second.',  evidenceRefs: ['e1'] },
				{ narrative: 'Another.',         evidenceRefs: ['e2'] },
			],
		},
		entryById,
	);
	assert.equal(result.kept, 2);
	assert.match(result.markdown, /\n\n/);
});

// ---------------------------------------------------------------------------
// renderOneParagraph (citation splicing)
// ---------------------------------------------------------------------------

test('renderOneParagraph: anchors primary citation at end of first sentence', () => {
	const e = entry('e1', '/repo/Block.java');
	const result = renderOne('BlockManager spans 162-5558. It manages replicas.', [e]);
	assert.match(result, /BlockManager spans 162-5558 \[e1-label\]\(path:\/repo\/Block\.java#L10-L20\)\./);
	assert.match(result, /It manages replicas\./);
});

test('renderOneParagraph: single-sentence narrative -- citation before terminal punctuation', () => {
	const e = entry('e1', '/repo/Block.java');
	const result = renderOne('BlockManager exists.', [e]);
	assert.match(result, /BlockManager exists \[e1-label\]\(path:[^)]+\)\./);
});

test('renderOneParagraph: 2+ refs -- secondaries appended in parens', () => {
	const e1 = entry('e1', '/repo/Block.java');
	const e2 = entry('e2', '/repo/Place.java');
	const result = renderOne('Block placement coordinates replication.', [e1, e2]);
	assert.match(result, /see also/);
	assert.match(result, /\[e2-label\]/);
});

test('renderOneParagraph: refs with no citations -- narrative returned unmodified (validator will catch)', () => {
	const noCite: EvidenceEntry = {
		skillId:      'no-cite',
		args:         {},
		facts:        ['fact'],
		citations:    [],
		citationObjs: [],
		confidence:   'medium',
	};
	const result = renderOne('A paragraph with no citation anchor.', [noCite]);
	// No citation appended -- validateCitationCoverage will flag this
	// in the discovery-flow merge step.
	assert.equal(result, 'A paragraph with no citation anchor.');
});
