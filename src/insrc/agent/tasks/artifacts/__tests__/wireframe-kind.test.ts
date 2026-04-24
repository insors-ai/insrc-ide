/**
 * Tests for agent/tasks/artifacts/kinds/wireframe.ts.
 *
 * Covers the branch selection logic:
 *   1. Caller-supplied spec -> 'high' confidence, "caller-supplied spec"
 *   2. Description + mock LLM returning valid spec -> 'medium', LLM synthesis
 *   3. Description + mock LLM returning garbage -> 'low', fallback scaffold
 *   4. No description, no provider -> 'low', default scaffold + warning
 *
 * The real `LLMProvider` interface (shared/types.ts) is tiny, so we
 * hand-roll a mock instead of importing a fixture.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { runWireframe } from '../kinds/wireframe.js';
import type {
	LLMMessage,
	LLMProvider,
	LLMResponse,
} from '../../../../shared/types.js';

// ---------------------------------------------------------------------------
// Mock LLM provider -- returns whatever text the test supplies.
// ---------------------------------------------------------------------------

function mockProvider(responseText: string): LLMProvider {
	let called = 0;
	return {
		async complete(_msgs: LLMMessage[]): Promise<LLMResponse> {
			called++;
			return { text: responseText, stopReason: 'end_turn' };
		},
		async *stream(): AsyncIterable<string> {
			yield responseText;
		},
		async embed(): Promise<number[]> { return []; },
		supportsTools: false,
		get callCount(): number { return called; },
	} as unknown as LLMProvider;
}

// ---------------------------------------------------------------------------
// Branch 1: caller-supplied spec
// ---------------------------------------------------------------------------

describe('runWireframe - caller-supplied spec', () => {
	it('renders the spec directly, high confidence, no warnings', async () => {
		const result = await runWireframe({
			sessionId: 's1',
			input: {
				spec: {
					layout: 'desktop',
					rows: [{ height: 48, cells: [{ kind: 'header', label: 'Hi' }] }],
				},
			},
		});
		assert.equal(result.kind, 'wireframe');
		assert.equal(result.confidence, 'high');
		assert.equal(result.warnings.length, 0);
		assert.equal(result.metadata['provenance'], 'caller-supplied spec');
		assert.ok(result.renderedHtml.embedded.includes('<svg'));
	});
});

// ---------------------------------------------------------------------------
// Branch 2: description + LLM synthesis (happy path)
// ---------------------------------------------------------------------------

describe('runWireframe - LLM synthesis', () => {
	it('parses a valid WireframeSpec out of a fenced JSON response', async () => {
		const provider = mockProvider([
			'```json',
			'{',
			'  "layout": "desktop",',
			'  "rows": [',
			'    { "height": 56, "cells": [{ "kind": "header", "label": "Dashboard" }] },',
			'    { "height": "auto", "cells": [',
			'      { "kind": "content", "label": "Metrics", "widthRatio": 4 },',
			'      { "kind": "sidebar", "label": "Filters", "widthRatio": 1 }',
			'    ] }',
			'  ]',
			'}',
			'```',
		].join('\n'));
		const result = await runWireframe({
			sessionId: 's2',
			provider,
			input: { description: 'dashboard with metrics and a filter sidebar' },
		});
		assert.equal(result.confidence, 'medium');
		assert.equal(result.warnings.length, 0);
		assert.equal(result.metadata['provenance'], 'LLM synthesis from description');
		// Spec JSON is stored as the artifact's source.
		const spec = JSON.parse(result.source) as { layout: string; rows: unknown[] };
		assert.equal(spec.layout, 'desktop');
		assert.equal(spec.rows.length, 2);
	});

	it('peels off prose/preamble before the JSON object', async () => {
		const provider = mockProvider(
			'Sure, here is the spec you asked for:\n\n' +
			'{"layout":"mobile","rows":[{"height":48,"cells":[{"kind":"header","label":"h"}]}]}\n\n' +
			'Let me know if you want changes.',
		);
		const result = await runWireframe({
			sessionId: 's3',
			provider,
			input: { description: 'mobile dashboard', layout: 'mobile' },
		});
		assert.equal(result.confidence, 'medium');
		const spec = JSON.parse(result.source) as { layout: string };
		assert.equal(spec.layout, 'mobile');
	});
});

// ---------------------------------------------------------------------------
// Branch 3: LLM returns garbage -> fallback to scaffold
// ---------------------------------------------------------------------------

describe('runWireframe - LLM failure fallback', () => {
	it('falls back to default scaffold with a warning when JSON is unparseable', async () => {
		const provider = mockProvider('I could not generate the spec.');
		const result = await runWireframe({
			sessionId: 's4',
			provider,
			input: { description: 'some ui' },
		});
		assert.equal(result.confidence, 'low');
		assert.ok(result.warnings.some(w => /LLM failed/.test(w)));
		assert.match(result.metadata['provenance'] ?? '', /LLM synthesis failed/);
	});

	it('falls back when the JSON is syntactically valid but shape-invalid', async () => {
		const provider = mockProvider(
			'{"layout":"desktop","rows":[{"height":"??","cells":[{"kind":"not-a-kind"}]}]}',
		);
		const result = await runWireframe({
			sessionId: 's5',
			provider,
			input: { description: 'x' },
		});
		assert.equal(result.confidence, 'low');
		assert.ok(result.warnings.some(w => /LLM failed/.test(w)));
	});
});

// ---------------------------------------------------------------------------
// Branch 4: no provider, no description
// ---------------------------------------------------------------------------

describe('runWireframe - no provider / no description', () => {
	it('produces the default scaffold with a "no provider" warning', async () => {
		const result = await runWireframe({
			sessionId: 's6',
			input: { description: 'ok' },     // no provider passed
		});
		assert.equal(result.confidence, 'low');
		assert.ok(result.warnings.some(w => /no LLM provider available/.test(w)));
		assert.equal(result.metadata['provenance'], 'default layout');
	});

	it('emits a "no description" warning when neither input is supplied', async () => {
		const result = await runWireframe({
			sessionId: 's7',
			input: {},
		});
		assert.equal(result.confidence, 'low');
		assert.ok(result.warnings.some(w => /no description or spec supplied/.test(w)));
	});
});
