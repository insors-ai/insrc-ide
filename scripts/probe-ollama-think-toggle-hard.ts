/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Harder probe: the prompt does NOT supply a real entityId, just the
 * class name "INGRN" and a long list of past-turn output. This is the
 * scenario where section-flow's leaf executor was fabricating IDs
 * (`INGRN`, `00000000...01`, random hex strings).
 *
 * Tool description explicitly states the model should call locate-by-name
 * FIRST when only a name is available. With thinking off the model
 * usually skips that step and fabricates; we want to see whether thinking
 * actually causes it to take the locate-by-name path.
 *
 *   npx tsx scripts/probe-ollama-think-toggle-hard.ts
 */

const MODEL = process.env['OLLAMA_MODEL'] ?? 'qwen3.6:35b-a3b';
const HOST  = process.env['OLLAMA_HOST']  ?? 'http://localhost:11434';

const SYSTEM = `You are a tool-calling agent. You decide which skill to call next and supply its arguments. You MUST call exactly one tool. CRITICAL: entityId arguments MUST be a 32-character hex string returned by a prior locate-by-name lookup. If you do not have a hex entityId for the entity in question, you MUST call code.entity.locate-by-name FIRST. Never use a class name as an entityId. Never invent or guess an entityId.`;

const USER = `Goal: retrieve the body of the INGRN class to inspect its field declarations.

Prior turn outputs (none of these returned a 32-char hex entityId for INGRN):
- code.source.grep on "INGRN" returned 31 hits across 11 files, mostly docs
- code.source.file.describe on grn.py returned: "INGRN class defined in grn.py (lines 40-207) with 4 entities including GRNItemPropertyNames and validation methods"
- code.entity.search-by-vector returned: "INGRN class found at /repo/insors/core/model/invoice/regions/IN/grn.py lines 40-207"

Now: invoke the right tool to get INGRN's body.`;

const TOOLS = [
	{
		type: 'function' as const,
		function: {
			name: 'code.entity.locate-by-name',
			description: 'Find an entity by exact name. Returns {entityId, filePath, kind, ...}.',
			parameters: {
				type:                 'object',
				required:             ['name'],
				additionalProperties: false,
				properties: {
					name:  { type: 'string', description: 'Exact name of the entity.' },
					kinds: { type: 'array',  items: { type: 'string' } },
				},
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'code.entity.summary',
			description: 'Summarise a code entity by its 32-char hex entityId. Requires entityId from a prior locate-by-name call.',
			parameters: {
				type:                 'object',
				required:             ['entityId'],
				additionalProperties: false,
				properties: {
					entityId: {
						type:        'string',
						minLength:   32,
						maxLength:   32,
						description: '32-char hex entity id from a prior locate-by-name result.',
					},
					scope: { type: 'string', enum: ['closure', 'file'] },
				},
			},
		},
	},
];

interface OllamaResponse {
	readonly message?: {
		readonly role?:       string;
		readonly content?:    string;
		readonly thinking?:   string;
		readonly tool_calls?: ReadonlyArray<{
			readonly function?: {
				readonly name?:      string;
				readonly arguments?: Record<string, unknown>;
			};
		}>;
	};
	readonly done?:        boolean;
	readonly done_reason?: string;
	readonly total_duration?:    number;
	readonly prompt_eval_count?: number;
	readonly eval_count?:        number;
}

async function callOllama(think: boolean): Promise<OllamaResponse> {
	const body = {
		model:    MODEL,
		messages: [
			{ role: 'system', content: SYSTEM },
			{ role: 'user',   content: USER },
		],
		tools:   TOOLS,
		stream:  false,
		think,
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

function show(label: string, resp: OllamaResponse): void {
	const m  = resp.message ?? {};
	const tc = m.tool_calls?.[0]?.function;
	console.log(`\n==================== ${label} ====================`);
	console.log('eval_tokens         :', resp.eval_count);
	console.log('total_duration_ms   :', resp.total_duration ? Math.round(resp.total_duration / 1_000_000) : '(absent)');
	console.log('--- message.thinking ---');
	console.log(m.thinking && m.thinking.length > 0 ? m.thinking : '(empty)');
	console.log('--- message.content ---');
	console.log(m.content && m.content.length > 0 ? m.content : '(empty)');
	console.log('--- tool_call ---');
	if (tc) {
		console.log('name :', tc.name);
		console.log('args :', JSON.stringify(tc.arguments));
		if (tc.name === 'code.entity.locate-by-name') {
			console.log('verdict: CORRECT -- chose locate-by-name path (no entityId available)');
		} else if (tc.name === 'code.entity.summary') {
			const id = tc.arguments?.['entityId'];
			if (typeof id === 'string') {
				if (/^[0-9a-f]{32}$/i.test(id)) {
					console.log(`verdict: HALLUCINATED -- fabricated a 32-hex entityId never returned by any prior call: ${id}`);
				} else {
					console.log(`verdict: HALLUCINATED -- non-hex entityId: ${id}`);
				}
			}
		}
	} else {
		console.log('(no tool_call emitted)');
	}
}

async function main(): Promise<void> {
	console.log(`model: ${MODEL}`);
	console.log(`host:  ${HOST}`);

	const respFalse = await callOllama(false);
	show('think: false', respFalse);

	const respTrue = await callOllama(true);
	show('think: true', respTrue);
}

main().catch(err => { console.error('probe failed:', err); process.exit(1); });
