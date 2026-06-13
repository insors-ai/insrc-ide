/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDeliverableMarkdown } from '../audit/deliverable-parser.js';
import { DEBUG_SESSION_REQUIRED_SECTIONS } from '../templates/debug-session.js';

// ---------------------------------------------------------------------------
// Section extraction
// ---------------------------------------------------------------------------

test('parseDeliverableMarkdown: extracts level-2 section bodies keyed lowercase', () => {
	const md = [
		'# Debug Session Deliverable',
		'',
		'## Reproduce',
		'ran npm test -- --grep foo',
		'',
		'## Localize',
		'race in beforeEach',
	].join('\n');
	const r = parseDeliverableMarkdown(md, []);
	assert.equal(r.sections['reproduce'], 'ran npm test -- --grep foo');
	assert.equal(r.sections['localize'],  'race in beforeEach');
});

test('parseDeliverableMarkdown: top-level # is NOT treated as a section header', () => {
	const md = [
		'# Top',
		'top body should not become a section',
		'## Real Section',
		'real body',
	].join('\n');
	const r = parseDeliverableMarkdown(md, []);
	assert.equal(r.sections['top'], undefined);
	assert.equal(r.sections['real section'], 'real body');
});

test('parseDeliverableMarkdown: titles are normalised case-insensitively for required matching', () => {
	const md = '## reproduce\nbody-r\n## CONCLUDE\nbody-c\n';
	const r = parseDeliverableMarkdown(md, ['Reproduce', 'Conclude']);
	assert.equal(r.missing.length, 0);
	assert.equal(r.allRequiredFilled, true);
});

// ---------------------------------------------------------------------------
// Required-section coverage
// ---------------------------------------------------------------------------

test('parseDeliverableMarkdown: empty deliverable -> all required marked missing', () => {
	const r = parseDeliverableMarkdown('', DEBUG_SESSION_REQUIRED_SECTIONS);
	assert.deepEqual(r.missing, [...DEBUG_SESSION_REQUIRED_SECTIONS]);
	assert.deepEqual(r.emptyOrPlaceholder, []);
	assert.equal(r.allRequiredFilled, false);
});

test('parseDeliverableMarkdown: partial deliverable -> only the absent ones reported missing', () => {
	const md = '## Reproduce\nx\n\n## Conclude\ny\n';
	const r = parseDeliverableMarkdown(md, DEBUG_SESSION_REQUIRED_SECTIONS);
	assert.deepEqual(r.missing, ['Localize', 'Hypothesize', 'Test']);
	assert.equal(r.allRequiredFilled, false);
});

// ---------------------------------------------------------------------------
// Placeholder / empty detection
// ---------------------------------------------------------------------------

test('parseDeliverableMarkdown: <TODO> body counts as empty/placeholder', () => {
	const md = [
		'## Reproduce', '<TODO>',
		'## Localize', '<TODO>',
		'## Hypothesize', '<TODO>',
		'## Test', '<TODO>',
		'## Conclude', '<TODO>',
	].join('\n');
	const r = parseDeliverableMarkdown(md, DEBUG_SESSION_REQUIRED_SECTIONS);
	assert.deepEqual(r.missing, []);
	assert.deepEqual(r.emptyOrPlaceholder, [...DEBUG_SESSION_REQUIRED_SECTIONS]);
	assert.equal(r.allRequiredFilled, false);
});

test('parseDeliverableMarkdown: TODO and TBD bare bodies are placeholders too', () => {
	const md = '## Reproduce\nTODO\n## Localize\nTBD\n';
	const r = parseDeliverableMarkdown(md, ['Reproduce', 'Localize']);
	assert.deepEqual(r.emptyOrPlaceholder, ['Reproduce', 'Localize']);
});

test('parseDeliverableMarkdown: whitespace-only body is empty/placeholder', () => {
	const md = '## Reproduce\n   \n\n';
	const r = parseDeliverableMarkdown(md, ['Reproduce']);
	assert.deepEqual(r.emptyOrPlaceholder, ['Reproduce']);
});

test('parseDeliverableMarkdown: filled non-placeholder body -> allRequiredFilled true', () => {
	const md = [
		'## Reproduce',     'npm test -- --grep foo, 1/50 fail',
		'## Localize',      'race condition in beforeEach',
		'## Hypothesize',   '1. setUp mock not awaited',
		'## Test',          'awaited mock -> 100/100 passes',
		'## Conclude',      'applied fix: await mock',
	].join('\n');
	const r = parseDeliverableMarkdown(md, DEBUG_SESSION_REQUIRED_SECTIONS);
	assert.deepEqual(r.missing, []);
	assert.deepEqual(r.emptyOrPlaceholder, []);
	assert.equal(r.allRequiredFilled, true);
});

// ---------------------------------------------------------------------------
// Mixed cases
// ---------------------------------------------------------------------------

test('parseDeliverableMarkdown: missing + placeholder mix is reported independently', () => {
	const md = '## Reproduce\n<TODO>\n## Conclude\nreal\n';
	const r = parseDeliverableMarkdown(md, DEBUG_SESSION_REQUIRED_SECTIONS);
	assert.deepEqual(r.missing, ['Localize', 'Hypothesize', 'Test']);
	assert.deepEqual(r.emptyOrPlaceholder, ['Reproduce']);
});
