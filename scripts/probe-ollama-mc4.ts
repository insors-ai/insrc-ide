/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Like probe-ollama-raw.ts, but loads a FULL multi-turn conversation
 * from /tmp/probe-prompt-mc4.json (system + alternating
 * assistant/tool_result turns) and replays it against Ollama. Used to
 * confirm the empty-end_turn-zero-text failure mode that the daemon
 * hits after several tool-loop iterations.
 */

import { readFileSync } from 'node:fs';

interface ProbeFile {
	readonly time:         number;
	readonly llmCallId:    number;
	readonly messageCount: number;
	readonly messages:     ReadonlyArray<{ readonly role: string; readonly content: unknown }>;
	readonly opts:         {
		readonly tools?:    ReadonlyArray<{ readonly name: string; readonly description: string; readonly inputSchema: unknown }>;
		readonly maxTokens?: number;
	};
}

// Reshape internal LLMMessage shape (content may be string OR ContentBlock[])
// into Ollama's chat message shape (string content + optional tool_calls).
// Tool-result blocks become a 'tool' role message with the result text as content.
interface OllamaMsg {
	role: string;
	content: string;
	tool_calls?: Array<{ id?: string; function: { name: string; arguments: Record<string, unknown> } }>;
	tool_call_id?: string;
}

function toOllamaMessages(messages: ProbeFile['messages']): OllamaMsg[] {
	const out: OllamaMsg[] = [];
	for (const m of messages) {
		const c = m.content;
		if (typeof c === 'string') {
			out.push({ role: m.role, content: c });
			continue;
		}
		if (!Array.isArray(c)) {
			continue;
		}
		if (m.role === 'assistant') {
			let text = '';
			const toolCalls: NonNullable<OllamaMsg['tool_calls']> = [];
			for (const b of c) {
				if (b && typeof b === 'object') {
					const blk = b as { type?: string; text?: string; name?: string; input?: Record<string, unknown>; id?: string };
					if (blk.type === 'text' && typeof blk.text === 'string') {
						text += blk.text;
					} else if (blk.type === 'tool_use' && blk.name) {
						toolCalls.push({ ...(blk.id ? { id: blk.id } : {}), function: { name: blk.name, arguments: blk.input ?? {} } });
					}
				}
			}
			const msg: OllamaMsg = { role: 'assistant', content: text };
			if (toolCalls.length > 0) {
				msg.tool_calls = toolCalls;
			}
			out.push(msg);
		} else if (m.role === 'user') {
			// Mix of text + tool_result blocks. Tool results become their own 'tool' messages.
			let userText = '';
			for (const b of c) {
				if (b && typeof b === 'object') {
					const blk = b as { type?: string; text?: string; tool_use_id?: string; content?: unknown };
					if (blk.type === 'text' && typeof blk.text === 'string') {
						userText += blk.text;
					} else if (blk.type === 'tool_result') {
						const tcContent = typeof blk.content === 'string'
							? blk.content
							: JSON.stringify(blk.content);
						out.push({ role: 'tool', content: tcContent, ...(blk.tool_use_id ? { tool_call_id: blk.tool_use_id } : {}) });
					}
				}
			}
			if (userText.length > 0) {
				out.push({ role: 'user', content: userText });
			}
		} else {
			out.push({ role: m.role, content: typeof c === 'string' ? c : JSON.stringify(c) });
		}
	}
	return out;
}

async function main(): Promise<void> {
	const probe = JSON.parse(readFileSync('/tmp/probe-prompt-mc4.json', 'utf8')) as ProbeFile;

	console.log('--- INPUT ---');
	console.log('  messageCount: ', probe.messageCount);
	console.log('  tools:        ', (probe.opts.tools ?? []).map(t => t.name).join(', '));
	console.log('  maxTokens:    ', probe.opts.maxTokens);

	const ollamaMessages = toOllamaMessages(probe.messages);
	console.log('  ollama msgs:  ', ollamaMessages.length);
	for (let i = 0; i < ollamaMessages.length; i++) {
		const m = ollamaMessages[i]!;
		console.log(`    [${i}] role=${m.role} content_chars=${m.content.length} tool_calls=${m.tool_calls?.length ?? 0}${m.tool_call_id ? ' tool_call_id='+m.tool_call_id : ''}`);
	}
	console.log();

	const ollamaTools = (probe.opts.tools ?? []).map(t => ({
		type: 'function' as const,
		function: { name: t.name, description: t.description, parameters: t.inputSchema },
	}));

	const body = {
		model:    'devstral-small-2:latest',
		messages: ollamaMessages,
		tools:    ollamaTools,
		stream:   true,
		keep_alive: '24h',
		options:  { num_ctx: 32768, num_predict: probe.opts.maxTokens ?? 4096 },
	};

	console.log('--- CALLING http://localhost:11434/api/chat ---');
	const t0 = Date.now();
	const resp = await fetch('http://localhost:11434/api/chat', {
		method:  'POST',
		headers: { 'content-type': 'application/json' },
		body:    JSON.stringify(body),
	});
	if (!resp.body) {
		console.error('no body');
		process.exit(1);
	}

	const reader = resp.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	let chunkIdx = 0;
	let allText = '';
	const allToolCalls: unknown[] = [];
	let promptEval: number | undefined;
	let evalCount:  number | undefined;
	let stopReason: string | undefined;

	for (;;) {
		const { value, done } = await reader.read();
		if (done) {
			break;
		}
		buf += decoder.decode(value, { stream: true });
		const lines = buf.split('\n');
		buf = lines.pop() ?? '';
		for (const line of lines) {
			if (line.trim() === '') {
				continue;
			}
			let chunk: { message?: { content?: string; thinking?: string; tool_calls?: ReadonlyArray<unknown> }; done?: boolean; done_reason?: string; prompt_eval_count?: number; eval_count?: number };
			try {
				chunk = JSON.parse(line);
			} catch {
				continue;
			}
			chunkIdx++;
			const m = chunk.message;
			const hasContent = m?.content !== undefined && m.content !== '';
			const hasTools   = Array.isArray(m?.tool_calls) && m.tool_calls.length > 0;
			const hasThink   = m?.thinking !== undefined && m.thinking !== '';
			if (hasContent || hasTools || hasThink || chunk.done) {
				console.log(`chunk #${chunkIdx} done=${chunk.done ?? false} done_reason=${chunk.done_reason ?? ''} content=${JSON.stringify(m?.content ?? '')} thinking=${JSON.stringify(m?.thinking ?? '')} tool_calls=${JSON.stringify(m?.tool_calls ?? [])}`);
			}
			if (m?.content) {
				allText += m.content;
			}
			if (Array.isArray(m?.tool_calls)) {
				allToolCalls.push(...m.tool_calls);
			}
			if (chunk.done) {
				promptEval = chunk.prompt_eval_count;
				evalCount = chunk.eval_count;
				stopReason = chunk.done_reason;
			}
		}
	}

	console.log();
	console.log('--- SUMMARY ---');
	console.log(`  duration_ms     : ${Date.now() - t0}`);
	console.log(`  stream chunks   : ${chunkIdx}`);
	console.log(`  prompt_eval_count: ${promptEval}`);
	console.log(`  eval_count       : ${evalCount}`);
	console.log(`  done_reason      : ${stopReason}`);
	console.log(`  total text chars: ${allText.length}`);
	console.log(`  text content    : ${JSON.stringify(allText.slice(0, 500))}`);
	console.log(`  tool_calls count: ${allToolCalls.length}`);
	console.log(`  tool_calls dump : ${JSON.stringify(allToolCalls, null, 2).slice(0, 1500)}`);
	process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
