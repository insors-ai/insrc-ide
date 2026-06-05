/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Probe Ollama directly with the same system + user + tools the daemon
 * sends in `executeStep`, dumping every streamed chunk verbatim. Lets
 * us see whether the 100-token outputs Devstral generates are landing
 * in `message.content`, `message.tool_calls`, both, or neither.
 *
 *   npx tsx scripts/probe-ollama-raw.ts
 *
 * Prompt loaded from /tmp/probe-prompt.json (written via a small
 * extract-from-log step).
 */

import { readFileSync } from 'node:fs';

interface ProbeFile {
	readonly system: string;
	readonly user:   string;
	readonly opts:   { readonly tools: ReadonlyArray<{ readonly name: string; readonly description: string; readonly inputSchema: unknown }>; readonly maxTokens?: number };
}

interface OllamaChunk {
	readonly message?: {
		readonly role?:    string;
		readonly content?: string;
		readonly thinking?: string;
		readonly tool_calls?: ReadonlyArray<unknown>;
	};
	readonly done?:        boolean;
	readonly done_reason?: string;
	readonly prompt_eval_count?: number;
	readonly eval_count?:        number;
}

async function main(): Promise<void> {
	const probe = JSON.parse(readFileSync('/tmp/probe-prompt.json', 'utf8')) as ProbeFile;

	console.log('--- INPUT SIZES ---');
	console.log('  system chars:', probe.system.length);
	console.log('  user chars:  ', probe.user.length);
	console.log('  tools:       ', probe.opts.tools.map(t => t.name).join(', '));
	console.log('  maxTokens:   ', probe.opts.maxTokens);
	console.log();

	const ollamaTools = probe.opts.tools.map(t => ({
		type: 'function' as const,
		function: { name: t.name, description: t.description, parameters: t.inputSchema },
	}));

	const body = {
		model:    'devstral-small-2:latest',
		messages: [
			{ role: 'system', content: probe.system },
			{ role: 'user',   content: probe.user },
		],
		tools:    ollamaTools,
		stream:   true,
		// Match the daemon's exact settings -- keep_alive='24h' is what
		// the daemon passes for the long-running tool-loop case.
		keep_alive: '24h',
		options:    { num_ctx: 16384, num_predict: probe.opts.maxTokens ?? 4096 },
	};

	console.log('--- CALLING http://localhost:11434/api/chat ---');
	const t0 = Date.now();
	const resp = await fetch('http://localhost:11434/api/chat', {
		method:  'POST',
		headers: { 'content-type': 'application/json' },
		body:    JSON.stringify(body),
	});
	if (!resp.body) {
		console.error('no body in response');
		process.exit(1);
	}

	const reader  = resp.body.getReader();
	const decoder = new TextDecoder();
	let buf       = '';

	let chunkIdx = 0;
	let allText  = '';
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
		// Ollama streams one JSON object per line.
		const lines = buf.split('\n');
		buf = lines.pop() ?? '';
		for (const line of lines) {
			if (line.trim() === '') {
				continue;
			}
			let chunk: OllamaChunk;
			try {
				chunk = JSON.parse(line) as OllamaChunk;
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
				evalCount  = chunk.eval_count;
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
	console.log(`  tool_calls dump : ${JSON.stringify(allToolCalls, null, 2)}`);
	process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
