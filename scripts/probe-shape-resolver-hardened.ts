/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Validate the hardened shape-resolver SYSTEM_PROMPT against the
 * actual hallucination patterns we saw in the 5th section-flow run.
 *
 * Three scenarios, each run against qwen3.6 with `think: false` (the
 * production setting):
 *
 *   1. entityId IS in prior outputs -> model must USE it
 *   2. entityId is NOT in prior outputs -> model must OMIT it
 *      (not fabricate hex, not use the class name as id)
 *   3. classFields is required, no prior extract-fields output exists ->
 *      model must OMIT it (not pass [], not fabricate from JSON keys)
 *
 *   npx tsx scripts/probe-shape-resolver-hardened.ts
 */

import { _buildMessagesForTest as buildMessages, SUBMIT_ARGS_TOOL_NAME } from '../src/insrc/agent/section-flow/shape-resolve.js';

const MODEL = process.env['OLLAMA_MODEL'] ?? 'qwen3.6:35b-a3b';
const HOST  = process.env['OLLAMA_HOST']  ?? 'http://localhost:11434';

interface OllamaResponse {
	readonly message?: {
		readonly content?:    string;
		readonly thinking?:   string;
		readonly tool_calls?: ReadonlyArray<{
			readonly function?: {
				readonly name?:      string;
				readonly arguments?: Record<string, unknown>;
			};
		}>;
	};
	readonly eval_count?: number;
	readonly total_duration?: number;
}

async function callOllama(messages: ReadonlyArray<{ role: string; content: string }>, toolSchema: Record<string, unknown>): Promise<OllamaResponse> {
	const body = {
		model:    MODEL,
		messages,
		tools: [{
			type:     'function' as const,
			function: {
				name:        SUBMIT_ARGS_TOOL_NAME,
				description: 'Submit the args dict.',
				parameters:  toolSchema,
			},
		}],
		stream:  false,
		think:   false,
		options: { temperature: 0 },
	};
	const res = await fetch(`${HOST}/api/chat`, {
		method:  'POST',
		headers: { 'content-type': 'application/json' },
		body:    JSON.stringify(body),
	});
	if (!res.ok) {
		throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
	}
	return await res.json() as OllamaResponse;
}

function show(label: string, resp: OllamaResponse, classify: (args: Record<string, unknown> | undefined) => string): void {
	const tc = resp.message?.tool_calls?.[0]?.function;
	console.log(`\n==================== ${label} ====================`);
	console.log('eval_tokens   :', resp.eval_count);
	console.log('duration_ms   :', resp.total_duration ? Math.round(resp.total_duration / 1_000_000) : '(absent)');
	console.log('args submitted:', JSON.stringify(tc?.arguments ?? null));
	console.log('verdict       :', classify(tc?.arguments));
}

// ---------------------------------------------------------------------------
// Scenario 1: entityId IS in prior outputs (positive control)
// ---------------------------------------------------------------------------

async function scenarioEntityIdPresent(): Promise<void> {
	const summarySchema = {
		type: 'object',
		required: ['entityId'],
		additionalProperties: false,
		properties: {
			entityId: { type: 'string', minLength: 32, maxLength: 32, description: '32-char hex entity id from a prior lookup.' },
			scope:    { type: 'string', enum: ['closure', 'file'] },
		},
	};

	// Build messages by hand to mirror the production buildMessages output.
	// We can't import the closure-bound buildMessages without a fully
	// constructed ShapeResolveInput, so we paste the same shape inline.
	const messages = buildMessages({
		skillId:      'code.entity.summary',
		objective:    'Retrieve the body of the INGRN class to inspect its field declarations.',
		userQuestion: 'How does the JSON GRN data map to the INGRN Pydantic class?',
		priorOutputs: {
			'locate-ingrn': JSON.stringify({
				entityId:  'b2097ef0ba38110e005d437d6b0c8442',
				filePath:  '/repo/insors/core/model/invoice/regions/IN/grn.py',
				kind:      'class',
				name:      'INGRN',
				lineStart: 40,
				lineEnd:   207,
			}, null, 2),
		},
		contextBag: {},
		provider:   null as never,
	}, 'Summarise a code entity by its 32-char hex entityId.');

	const resp = await callOllama(messages, summarySchema);
	show('S1: entityId IS in prior outputs', resp, args => {
		const id = args?.['entityId'];
		const real = 'b2097ef0ba38110e005d437d6b0c8442';
		if (id === real) {
			return 'CORRECT -- copied the real entityId';
		}
		if (typeof id === 'string' && /^[0-9a-f]{32}$/i.test(id)) {
			return `WRONG -- fabricated different hex: ${id}`;
		}
		if (id === undefined) {
			return 'UNDER-FILL -- omitted entityId when it was available (regression)';
		}
		return `WRONG -- non-hex: ${id as string}`;
	});
}

// ---------------------------------------------------------------------------
// Scenario 2: entityId is NOT in any prior output (the failure mode)
// ---------------------------------------------------------------------------

async function scenarioEntityIdAbsent(): Promise<void> {
	const summarySchema = {
		type: 'object',
		required: ['entityId'],
		additionalProperties: false,
		properties: {
			entityId: { type: 'string', minLength: 32, maxLength: 32, description: '32-char hex entity id from a prior lookup.' },
			scope:    { type: 'string', enum: ['closure', 'file'] },
		},
	};

	const messages = buildMessages({
		skillId:      'code.entity.summary',
		objective:    'Retrieve the body of the INGRN class to inspect its field declarations.',
		userQuestion: 'How does the JSON GRN data map to the INGRN Pydantic class?',
		priorOutputs: {
			'grep-ingrn':   '31 hits across 11 files for "INGRN" pattern, mostly documentation matches in AGENTS.md and CLAUDE.md.',
			'describe-grn-py': 'File grn.py contains 4 entities including INGRN class (lines 40-207), GRNItemPropertyNames, and validation methods.',
			'vector-search-ingrn': 'INGRN class found at /repo/insors/core/model/invoice/regions/IN/grn.py lines 40-207. confidence=high.',
		},
		contextBag: {},
		provider:   null as never,
	}, 'Summarise a code entity by its 32-char hex entityId.');

	const resp = await callOllama(messages, summarySchema);
	show('S2: entityId is NOT in prior outputs', resp, args => {
		const id = args?.['entityId'];
		if (id === undefined) {
			return 'CORRECT -- omitted unfillable entityId (orchestrator will surface a leaf failure)';
		}
		if (typeof id === 'string' && /^[0-9a-f]{32}$/i.test(id)) {
			return `WRONG -- fabricated a 32-hex entityId from nowhere: ${id}`;
		}
		return `WRONG -- non-hex entityId: ${id as string}`;
	});
}

// ---------------------------------------------------------------------------
// Scenario 3: classFields required, no extract-fields prior output
// ---------------------------------------------------------------------------

async function scenarioClassFieldsAbsent(): Promise<void> {
	const compareSchema = {
		type: 'object',
		required: ['className', 'classFields', 'dataShape'],
		additionalProperties: false,
		properties: {
			className:   { type: 'string' },
			dataLabel:   { type: 'string' },
			classFields: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string' }, nullable: { type: 'boolean' } } } },
			dataShape:   { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, type: { type: 'string' } } } },
		},
	};

	const messages = buildMessages({
		skillId:      'shared.compare.fields-vs-shape',
		objective:    'Compare INGRN Pydantic field declarations against the JSON GRN fixture shape.',
		userQuestion: 'How does the JSON GRN data map to the INGRN Pydantic class?',
		priorOutputs: {
			'sample-shape': JSON.stringify([
				{ path: 'grn_number',     type: 'string', nullable: true },
				{ path: 'grn_date',       type: 'object', nullable: true },
				{ path: 'po_number',      type: 'string', nullable: true },
				{ path: 'grn_status',     type: 'number', nullable: true },
				{ path: 'vendor_details', type: 'object', nullable: true },
				{ path: 'grn_amount',     type: 'number', nullable: true },
			], null, 2),
		},
		contextBag: {},
		provider:   null as never,
	}, 'Compare a list of class fields against a JSON shape descriptor and report mismatches.');

	const resp = await callOllama(messages, compareSchema);
	show('S3: classFields has no source', resp, args => {
		const cf = args?.['classFields'];
		if (cf === undefined) {
			return 'CORRECT -- omitted classFields with no source (orchestrator will surface a leaf failure)';
		}
		if (Array.isArray(cf) && cf.length === 0) {
			return 'WRONG -- emitted empty [] to dodge the rule';
		}
		if (Array.isArray(cf)) {
			const looksLikeJsonKeys = cf.some(f => {
				const name = (f as Record<string, unknown>)['name'];
				return typeof name === 'string' && /_/.test(name);
			});
			if (looksLikeJsonKeys) {
				return `WRONG -- fabricated classFields with JSON-key names: ${JSON.stringify(cf).slice(0, 200)}`;
			}
			return `WRONG-ish -- emitted ${cf.length} classFields from unknown source: ${JSON.stringify(cf).slice(0, 200)}`;
		}
		return `WRONG -- non-array classFields: ${JSON.stringify(cf)}`;
	});
}

async function main(): Promise<void> {
	console.log(`model: ${MODEL}`);
	console.log(`host:  ${HOST}`);
	await scenarioEntityIdPresent();
	await scenarioEntityIdAbsent();
	await scenarioClassFieldsAbsent();
}

main().catch(err => { console.error('probe failed:', err); process.exit(1); });
