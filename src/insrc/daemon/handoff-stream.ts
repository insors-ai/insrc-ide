/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `handoff.run` streaming IPC handler.
 *
 * Wraps `runHandoff` (Phase 2a Day 5 orchestrator) so progress events
 * surface on the existing IPC stream mechanism (same pattern as
 * `chat.send`, `todos.subscribe`, `ollama.pull`). Subscribers (the VS
 * Code extension's daemonService, future TUI, CLI) receive
 * `IpcStreamMessage { stream: 'progress', data: HandoffEvent }`
 * messages at every pipeline boundary, then a `stream: 'done'` when
 * the orchestrator returns.
 *
 * Abort signal: when the caller cancels, we still let the in-flight
 * stage drain (createWorktree / git diff can't be safely interrupted
 * mid-call) but skip any subsequent stages. The agent subprocess
 * isn't killed by aborting the IPC request; cancellation of an
 * in-progress agent run requires a separate `handoff.cancel` IPC
 * that lands later.
 */

import type { StreamHandler } from './server.js';
import type { IpcStreamMessage } from '../shared/types.js';
import { runHandoff, type AgentChoice, type ScriptedAgentFn } from '../handoff/index.js';
import type { HandoffEvent, MemoryRef, ScopePayload, TemplateId } from '../handoff/types.js';
import { getLogger } from '../shared/logger.js';

const log = getLogger('handoff:stream-ipc');

interface HandoffRunParams {
	readonly templateId:        TemplateId;
	readonly intent:            string;
	readonly scope:             ScopePayload;
	readonly memoryRefs:        readonly MemoryRef[];
	readonly agent:             AgentChoice;
	readonly sessionId:         string;
	readonly mcpServerPath?:    string | undefined;
	readonly persistRoot?:      string | undefined;
	readonly templateExtras?:   Record<string, unknown> | undefined;
	readonly specIdOverride?:   string | undefined;
	readonly timeoutMs?:        number | undefined;
	/**
	 * When agent === 'scripted-agent', a synchronous deliverable body
	 * to use as the agent's stdout. (Live ScriptedAgentFn closures
	 * can't cross the IPC boundary.) Callers (e.g. the CLI dry-run
	 * path) inline the deliverable here.
	 */
	readonly scriptedDeliverable?: string | undefined;
	readonly forceCleanup?:     boolean | undefined;
}

/**
 * `handoff.run` stream handler. Conforms to `StreamHandler` so it
 * slots into the existing IpcServer streamHandlers map alongside
 * chat.send, todos.subscribe, ollama.pull.
 */
export const handoffRunStream: StreamHandler = async (params, send, signal) => {
	const p = params as HandoffRunParams;
	let aborted = false;
	const onAbort = (): void => { aborted = true; };
	signal.addEventListener('abort', onAbort, { once: true });

	// The IpcServer overrides msg.id with the request's id when it
	// writes to the socket (server.ts:156), so the value we pass here
	// is a placeholder. Tests inject their own send and read the
	// emitted (id, stream, data) tuples directly.
	const wrappedSend = (msg: Omit<IpcStreamMessage, 'id'>): void => {
		send({ id: 0, ...msg });
	};

	const emit = (event: HandoffEvent): void => {
		if (aborted) return;
		// Workbench-side `IInsrcHandoffService` dispatches the typed
		// discriminated union (9 variants) -- daemon only needs to
		// carry the event opaquely over the wire under a dedicated
		// stream kind so workbench subscribers can route without
		// colliding with the existing 'progress' stream's
		// {step, status} shape.
		wrappedSend({ stream: 'handoff', data: event });
	};

	let scriptedAgent: ScriptedAgentFn | undefined;
	if (p.agent === 'scripted-agent') {
		if (p.scriptedDeliverable === undefined) {
			wrappedSend({ stream: 'error', data: { error: "agent='scripted-agent' requires scriptedDeliverable", recoverable: false } });
			signal.removeEventListener('abort', onAbort);
			return;
		}
		const body = p.scriptedDeliverable;
		scriptedAgent = async () => ({ stdout: body, stderr: '', exitCode: 0, durationMs: 0 });
	}

	const sendIfNotAborted = (msg: Omit<IpcStreamMessage, 'id'>): void => {
		if (aborted) return;
		wrappedSend(msg);
	};

	try {
		await runHandoff({
			templateId:     p.templateId,
			intent:         p.intent,
			scope:          p.scope,
			memoryRefs:     p.memoryRefs,
			agent:          p.agent,
			sessionId:      p.sessionId,
			onEvent:        emit,
			...(p.mcpServerPath  !== undefined ? { mcpServerPath:  p.mcpServerPath  } : {}),
			...(p.persistRoot    !== undefined ? { persistRoot:    p.persistRoot    } : {}),
			...(p.templateExtras !== undefined ? { templateExtras: p.templateExtras } : {}),
			...(p.specIdOverride !== undefined ? { specIdOverride: p.specIdOverride } : {}),
			...(p.timeoutMs      !== undefined ? { timeoutMs:      p.timeoutMs      } : {}),
			...(p.forceCleanup   === true      ? { forceCleanup:   true            } : {}),
			...(scriptedAgent    !== undefined ? { scriptedAgent }                  : {}),
		});
		sendIfNotAborted({ stream: 'done', data: {} });
	} catch (err) {
		log.warn({ err: (err as Error).message }, 'handoff.run stream: handoff threw');
		sendIfNotAborted({ stream: 'error', data: { error: (err as Error).message, recoverable: false } });
	} finally {
		signal.removeEventListener('abort', onAbort);
	}
};

