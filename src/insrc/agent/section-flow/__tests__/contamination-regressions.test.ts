/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Contamination-pattern regression fixtures.
 *
 * Each fixture mirrors a section-review rejection from the Phase 0
 * retest of the section-flow pipeline (run id
 * `6f863ed9526d641110e7a653c8800042`, daemon log
 * `/tmp/.insrc/agent.{1,2}.log`, 2026-06-13).
 *
 * The retest exercised section-flow on a mixed-tier provider (Haiku
 * cloud for orchestration, Ollama qwen3-coder for extraction). Five of
 * nine TODO sections were rejected at compose-time review for
 * contamination patterns. These fixtures pin those patterns:
 *
 *   - Pattern A: L2-fallback contamination -- per-root findings record
 *     an L2 fallback failure ("steps must be an array" / "[unverified
 *     summary]") yet the candidate section markdown contains concrete
 *     structural / numeric claims that the failed extraction cannot
 *     support.
 *   - Pattern B: Elision / count contradiction -- candidate markdown
 *     asserts a count ("21 fields") while findings cite only partial
 *     evidence ("+18 more" elided) or contain internal contradictions
 *     between text and table.
 *   - Pattern C: Structural claims without citations -- candidate
 *     markdown makes specific structural assertions (snake_case vs
 *     camelCase mappings, nested `entries` / `items` wrappers) while
 *     findings are marked unverified or contain only raw data without
 *     extracted key-name correspondence.
 *
 * The tests below assert the orchestration plumbing: given the live-run
 * input shape and a scripted provider returning the recorded
 * revise-major verdict, reviewSection MUST propagate `reopenRequested`
 * with the recorded reason. Future devs editing reviewSection's input
 * shape or the section-review prompt writers will see these tests fail
 * when contamination becomes silently accepted, the input shape becomes
 * incompatible with these patterns, or the reason-propagation pipe gets
 * dropped.
 *
 * These fixtures DO NOT exercise LLM judgment quality -- the live LLM's
 * rejection is taken as ground truth and replayed via a scripted
 * provider. To test that the LLM (any LLM) still catches the patterns,
 * see the integration tests gated on INSRC_TEST_LIVE_LLM.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reviewSection } from '../audit/section-review.js';
import type { CompletionOpts, LLMMessage, LLMProvider, LLMResponse } from '../../../shared/types.js';
import type { WorkingMemoryFindings } from '../../working-memory/types.js';
import type { TodoSpec } from '../types.js';
import { _resetPromptRegistryForTest, registerAllPromptWriters } from '../../prompts/index.js';

test.beforeEach(() => {
	_resetPromptRegistryForTest();
	registerAllPromptWriters();
});

// ---------------------------------------------------------------------------
// Scripted provider
// ---------------------------------------------------------------------------

function scriptedProvider(responses: readonly string[]): LLMProvider {
	let cursor = 0;
	return {
		supportsTools: true,
		async complete(_messages: LLMMessage[], _opts: CompletionOpts = {}): Promise<LLMResponse> {
			if (cursor >= responses.length) {
				throw new Error(`scriptedProvider: out of responses at call ${cursor + 1}`);
			}
			const text = responses[cursor]!;
			cursor++;
			return { text, stopReason: 'end_turn' };
		},
		async *stream(): AsyncIterable<string> { yield ''; },
		async embed(): Promise<number[]> { return []; },
	} as unknown as LLMProvider;
}

function reviseMajor(reason: string): string {
	return JSON.stringify({ verdict: 'revise-major', reasoning: reason });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface ContaminationFixture {
	readonly todoId:      string;
	readonly objective:   string;
	readonly pattern:     'L2-fallback-contamination' | 'elision-or-count-contradiction' | 'structural-claims-without-citations';
	readonly runLogTime:  number;
	readonly recordedReason: string;
	readonly candidate:   string;
	readonly findings:    WorkingMemoryFindings;
}

/**
 * Pattern C -- TODO 4 `identify-core-field-mappings` first rejection at
 * run-log time 1781339166426. The reviewer flagged structural claims
 * (snake_case vs camelCase, nested `entries` wrappers) made without
 * cited findings; findings marked `[unverified]`.
 *
 * This is the canonical run-#6 hallucination pattern surviving into
 * the Phase 0 retest -- the safety net caught what the prompts didn't.
 */
const fx_identify_core_field_mappings: ContaminationFixture = {
	todoId:      'identify-core-field-mappings',
	objective:   'Identify core field mappings between GRN JSON keys and INGRN Pydantic class attributes.',
	pattern:     'structural-claims-without-citations',
	runLogTime:  1781339166426,
	recordedReason:
		"The section makes concrete claims about JSON key mappings (snake_case vs camelCase conventions, " +
		"nested 'entries' wrappers, nesting structure) without cited support from actual JSON file content; " +
		"step-6 findings are marked [unverified] and contain only raw data structures without extracted " +
		"key-name alignment.",
	candidate: [
		'## JSON-to-INGRN Field Mapping',
		'',
		'GRN JSON files use snake_case keys (`vendor_details`, `sku_details`)',
		'while the INGRN Pydantic class uses camelCase attributes (`vendor`, `items`).',
		'',
		'Nested objects use an `entries` wrapper:',
		'```json',
		'{ "vendor_details": { "entries": { "id": 1, "code": "X", "name": "Y" } } }',
		'```',
		'Arrays use an `items` + `entries` two-level wrapper for SKU lines.',
	].join('\n'),
	findings: {
		perRoot: [
			{
				rootId: 'step-6',
				verdict: 'accept',
				cyclesConsumed: 0,
				exhausted: false,
				content: '[unverified summary] raw data structures observed; no extracted key-name alignment.',
			},
		],
	},
};

/**
 * Pattern A -- TODO 5 `analyze-nested-object-structures` at compose-time
 * (run-log time 1781342159619). The TODO degraded to L2 fallback after
 * sketch validation failed ("steps must be an array"); section markdown
 * still emitted concrete structural claims about vendor_details /
 * sku_details / entries wrappers.
 */
const fx_analyze_nested_object_structures: ContaminationFixture = {
	todoId:      'analyze-nested-object-structures',
	objective:   'Analyze the nested object structures in GRN JSON to map shape to Pydantic models.',
	pattern:     'L2-fallback-contamination',
	runLogTime:  1781342159619,
	recordedReason:
		"The per-root findings report an L2 fallback failure ('steps must be an array') indicating the " +
		"investigation itself failed; the section makes numerous concrete claims about JSON structure, " +
		"field types, and wrapper patterns (vendor_details, sku_details, entries/items containers, " +
		"field-level type mappings) without any cited per-root evidence.",
	candidate: [
		'## Nested Object Structures',
		'',
		'`vendor_details` is a STRUCT with id (BIGINT), code (VARCHAR), name (VARCHAR);',
		'all three sub-fields are non-nullable.',
		'',
		'`sku_details` is a STRUCT[] array. Each line item has 11 fields including',
		'tax-related fields (sgst_rate, sgst_amount, ...) declared nullable.',
		'',
		'Both nested objects use the `entries` wrapper convention in the JSON serialization.',
	].join('\n'),
	findings: {
		perRoot: [
			{
				rootId: 'investigation-l2',
				verdict: 'L2-fallback',
				cyclesConsumed: 0,
				exhausted: true,
				content: 'L2 fallback: sketch validation failed ("steps must be an array"). No structural data extracted.',
			},
		],
		fallback: 'L2',
	},
};

/**
 * Pattern A -- TODO 6 `compare-json-data-types-with-pydantic-types` at
 * compose-time (run-log time 1781342161480). Same L2-fallback pattern;
 * section markdown declared type-alignment specifics that the failed
 * investigation cannot back.
 */
const fx_compare_json_data_types: ContaminationFixture = {
	todoId:      'compare-json-data-types-with-pydantic-types',
	objective:   'Compare observed JSON primitive types with declared Pydantic field annotations.',
	pattern:     'L2-fallback-contamination',
	runLogTime:  1781342161480,
	recordedReason:
		"The per-root findings show only L2-fallback failure ('steps must be an array') with no actual " +
		"type-alignment data cited; the section markdown contains multiple concrete claims (timestamp " +
		"object mismatches, nullability divergence, field-by-field comparisons) that are entirely " +
		"unsupported by any cited evidence.",
	candidate: [
		'## Type Alignment',
		'',
		'**Timestamp fields MISMATCH**: `grn_date` declared TIMESTAMP, inferred `object`',
		'(nested `micros` wrapper).',
		'',
		'**Nullability MISMATCH**: all sampled fields show `nullable: false` runtime;',
		'declared schema marks all fields `nullable: true`.',
		'',
		'Strings, numbers, structured objects, arrays all align primitively.',
	].join('\n'),
	findings: {
		perRoot: [
			{
				rootId: 'investigation-l2',
				verdict: 'L2-fallback',
				cyclesConsumed: 0,
				exhausted: true,
				content: 'L2 fallback: sketch step rejected ("steps must be an array"). Type-alignment investigation never executed.',
			},
		],
		fallback: 'L2',
	},
};

/**
 * Pattern A -- TODO `highlight-data-variations-across-files` at
 * compose-time (run-log time 1781342166209). Same L2-fallback pattern;
 * section markdown declared field/distribution specifics.
 */
const fx_highlight_data_variations: ContaminationFixture = {
	todoId:      'highlight-data-variations-across-files',
	objective:   'Highlight any data variations across the GRN JSON test files.',
	pattern:     'L2-fallback-contamination',
	runLogTime:  1781342166209,
	recordedReason:
		"The per-root findings show an L2 fallback due to sketch validation failure ('steps' must be an " +
		"array), indicating the extraction attempt failed entirely. The section markdown makes detailed " +
		"structural claims about INGRN fields, nested formats, tax field patterns, and value distributions " +
		"(n=25 samples) without any cited backing.",
	candidate: [
		'## Data Variations Across Files',
		'',
		'All sampled records (n=25) exhibit complete field presence across the 10 top-level fields.',
		'',
		'`grn_status` consistently shows value `1` across all 25 samples.',
		'',
		'Tax fields (sgst_rate, sgst_amount, cgst_rate, cgst_amount, igst_rate, igst_amount)',
		'within sku_details items are frequently null in test data, indicating optional tax calculation.',
	].join('\n'),
	findings: {
		perRoot: [
			{
				rootId: 'investigation-l2',
				verdict: 'L2-fallback',
				cyclesConsumed: 0,
				exhausted: true,
				content: 'L2 fallback: extraction sketch rejected. No data-variation investigation executed.',
			},
		],
		fallback: 'L2',
	},
};

/**
 * Pattern B -- TODO 9 `create-mapping-summary-table` first rejection at
 * TODO-end (run-log time 1781342009197). Section asserted "21 top-level
 * INGRN fields" with `+18 more` elided; INGRNItem field count claimed
 * as 6 with no corresponding cited finding; internal contradiction
 * between "7 actual model fields" prose and the cited count.
 */
const fx_create_mapping_summary_table_elision: ContaminationFixture = {
	todoId:      'create-mapping-summary-table',
	objective:   'Create a complete mapping summary table linking JSON keys to INGRN class fields.',
	pattern:     'elision-or-count-contradiction',
	runLogTime:  1781342009197,
	recordedReason:
		"The section makes multiple material claims about field counts and structures (21 top-level " +
		"INGRN fields, 6 INPartyDetails fields, 6 INGRNItem fields) that are cited in step-1 and " +
		"step-2 findings, but the findings themselves are incomplete: step-1's claim cites only " +
		"partial evidence ('count=21' with '+18 more' elided), step-2 cites 6 fields but the claim " +
		"text says '7 actual model fields' creating internal contradiction, and the INGRNItem field " +
		"count (claimed as 6) has no corresponding cited finding at all.",
	candidate: [
		'## Field Mapping Summary',
		'',
		'INGRN declares **21 top-level fields** including:',
		'- `vendor` (required), `buyer`, `items`, `electronicDetails` (optional)',
		'',
		'INPartyDetails contains **6 fields** (id, code, name, ...).',
		'',
		'INGRNItem contains **6 fields** covering SKU code, description, quantities, prices.',
		'',
		'Note: 7 actual model fields participate in the JSON-to-class mapping below.',
	].join('\n'),
	findings: {
		perRoot: [
			{
				rootId: 'step-1',
				verdict: 'accept',
				cyclesConsumed: 0,
				exhausted: false,
				content: 'INGRN field extraction: count=21 [vendor, buyer, items, electronicDetails, +18 more elided].',
			},
			{
				rootId: 'step-2',
				verdict: 'accept',
				cyclesConsumed: 0,
				exhausted: false,
				content: 'INPartyDetails fields: 6 enumerated [id, code, name, gstin, address, contact].',
			},
		],
	},
};

const ALL_CONTAMINATION_FIXTURES: readonly ContaminationFixture[] = [
	fx_identify_core_field_mappings,
	fx_analyze_nested_object_structures,
	fx_compare_json_data_types,
	fx_highlight_data_variations,
	fx_create_mapping_summary_table_elision,
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

for (const fx of ALL_CONTAMINATION_FIXTURES) {
	test(`contamination regression / ${fx.todoId} (${fx.pattern}) -> reopenRequested with recorded reason`, async () => {
		const todo: TodoSpec = { id: fx.todoId, objective: fx.objective, origin: 'initial' };
		const provider = scriptedProvider([reviseMajor(fx.recordedReason)]);

		const result = await reviewSection({
			todo,
			candidate: fx.candidate,
			findings:  fx.findings,
			provider,
		});

		assert.equal(result.reopenRequested, true,
			`fixture ${fx.todoId}: reopenRequested must be true on revise-major`);
		assert.equal(result.finalVerdict, 'revise-major',
			`fixture ${fx.todoId}: finalVerdict must propagate as 'revise-major'`);
		assert.equal(result.cyclesConsumed, 0,
			`fixture ${fx.todoId}: revise-major does not consume cycles`);
		assert.equal(result.exhausted, false,
			`fixture ${fx.todoId}: revise-major is escalation, not cap-hit exhaustion`);
		assert.equal(result.reopenReason, fx.recordedReason,
			`fixture ${fx.todoId}: reopenReason must equal the LLM's recorded reason verbatim`);
		// The pre-rejection candidate must round-trip unchanged because
		// revise-major skips the revise call entirely.
		assert.equal(result.finalMarkdown, fx.candidate,
			`fixture ${fx.todoId}: finalMarkdown must equal the rejected candidate on escalation`);
	});
}

test('contamination regressions / baseline: a clean section accepts on first pass', async () => {
	const todo: TodoSpec = { id: 'baseline-clean', objective: 'Sanity check on a well-cited section.', origin: 'initial' };
	const candidate = [
		'## Vendor field count',
		'',
		'Per the cited step-1 extraction, INPartyDetails contains exactly 6 fields:',
		'`id`, `code`, `name`, `gstin`, `address`, `contact`.',
	].join('\n');
	const findings: WorkingMemoryFindings = {
		perRoot: [
			{ rootId: 'step-1', verdict: 'accept', cyclesConsumed: 0, exhausted: false,
				content: 'INPartyDetails fields: 6 enumerated [id, code, name, gstin, address, contact].' },
		],
	};
	const provider = scriptedProvider([JSON.stringify({ verdict: 'accept', reasoning: 'well cited' })]);

	const result = await reviewSection({ todo, candidate, findings, provider });
	assert.equal(result.reopenRequested, false);
	assert.equal(result.finalVerdict, 'accept');
	assert.equal(result.cyclesConsumed, 0);
	assert.equal(result.exhausted, false);
	assert.equal(result.finalMarkdown, candidate);
});

// ---------------------------------------------------------------------------
// Fixture-shape integrity (catches accidental input-shape drift)
// ---------------------------------------------------------------------------

test('all contamination fixtures expose the documented marker in either candidate or findings', () => {
	for (const fx of ALL_CONTAMINATION_FIXTURES) {
		if (fx.pattern === 'L2-fallback-contamination') {
			const findingsHaveL2Marker = fx.findings.fallback === 'L2'
				|| fx.findings.perRoot.some(r => r.verdict === 'L2-fallback')
				|| fx.findings.perRoot.some(r => /L2 fallback/i.test(r.content));
			assert.equal(findingsHaveL2Marker, true,
				`fixture ${fx.todoId}: L2-fallback-contamination must mark findings with an L2 indicator`);
		}
		if (fx.pattern === 'structural-claims-without-citations') {
			const findingsHaveUnverifiedMarker = fx.findings.perRoot.some(r => /\[unverified/i.test(r.content));
			assert.equal(findingsHaveUnverifiedMarker, true,
				`fixture ${fx.todoId}: structural-claims-without-citations must mark a finding [unverified]`);
		}
		if (fx.pattern === 'elision-or-count-contradiction') {
			const findingsHaveElisionMarker = fx.findings.perRoot.some(r => /\+\d+ more|elided/i.test(r.content));
			assert.equal(findingsHaveElisionMarker, true,
				`fixture ${fx.todoId}: elision-or-count-contradiction must mark a finding with elision evidence`);
		}
	}
});
