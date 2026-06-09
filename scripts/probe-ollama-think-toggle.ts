/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Side-by-side qwen3.6 probe: same tool-arg synthesis prompt, ONE call
 * with `think: false`, ONE call with `think: true`. Dumps message.thinking
 * and message.content verbatim for each, plus the tool_call args the
 * model emits, so we can see exactly where the model puts its reasoning
 * and which version hallucinates the entityId.
 *
 * Scenario mirrors what kills section-flow's local-tier leaf executor:
 *   - Available skill: code.entity.summary({ entityId: 32-char hex })
 *   - Context message: contains the REAL entityId for INGRN, returned by
 *     a prior locate-by-name call
 *   - Ask the model to invoke code.entity.summary against INGRN
 *
 * Expected: the real id is `b2097ef0ba38110e005d437d6b0c8442`. A hallucination
 * looks like `INGRN`, `00000000000000000000000000000001`, or a fresh-from-nowhere
 * hex string.
 *
 *   npx tsx scripts/probe-ollama-think-toggle.ts
 */

const MODEL = process.env['OLLAMA_MODEL'] ?? 'qwen3.6:35b-a3b';
const HOST  = process.env['OLLAMA_HOST']  ?? 'http://localhost:11434';

const SYSTEM = `You are a tool-calling agent. You decide which skill to call next and supply its arguments. You MUST call exactly one tool. The entityId argument MUST be a 32-character hex string -- copy it from prior messages, do not invent one. Never use a class name as an entityId.`;

const USER = [
	'Earlier in this investigation, code.entity.locate-by-name returned the following result for "INGRN":',
	'',
	'{"entityId":"b2097ef0ba38110e005d437d6b0c8442","filePath":"/repo/insors/core/model/invoice/regions/IN/grn.py","kind":"class","name":"INGRN","lineStart":40,"lineEnd":207}',
	'',
	'Now: invoke code.entity.summary on the INGRN class to retrieve its body.',
].join('\n');

const TOOLS = [
	{
		type: 'function' as const,
		function: {
			name: 'code.entity.summary',
			description: 'Summarise a code entity by its 32-char hex entityId.',
			parameters: {
				type:                 'object',
				required:             ['entityId'],
				additionalProperties: false,
				properties: {
					entityId: {
						type:        'string',
						minLength:   32,
						maxLength:   32,
						description: '32-char hex entity id from a prior lookup result.',
					},
					scope: {
						type: 'string',
						enum: ['closure', 'file'],
					},
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
	const m = resp.message ?? {};
	const tc = m.tool_calls?.[0]?.function;
	console.log(`\n==================== ${label} ====================`);
	console.log('done_reason         :', resp.done_reason ?? '(absent)');
	console.log('prompt_eval_tokens  :', resp.prompt_eval_count);
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
		const id = tc.arguments?.['entityId'];
		const real = 'b2097ef0ba38110e005d437d6b0c8442';
		if (typeof id === 'string') {
			if (id === real) {
				console.log('verdict: REAL entityId copied from context');
			} else if (/^[0-9a-f]{32}$/i.test(id)) {
				console.log(`verdict: HALLUCINATED 32-hex (fabricated): ${id}`);
			} else {
				console.log(`verdict: HALLUCINATED non-hex: ${id}`);
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

main().catch(err => {
	console.error('probe failed:', err);
	process.exit(1);
});
