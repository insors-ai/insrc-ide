/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `meta-task.run` streaming IPC handler.
 *
 * Mirrors `handoff-stream.ts`. Builds the cloud provider from the active
 * agent config + embedder from local Ollama; wires a `MetaTaskEmitter` over
 * the IPC send callback + the in-process TodosApi; calls into `runMetaTask`.
 *
 * Plan ref: [`plans/meta-tasks.md`](../../../plans/meta-tasks.md) M2.7.
 */

import type { StreamHandler } from './server.js';
import type { IpcStreamMessage } from '../shared/types.js';
import type { ScopeManifest } from '../meta-task/index.js';
import { runMetaTask, MetaTaskEmitter } from '../meta-task/index.js';
import { getDb } from '../db/client.js';
import { makeTodosApi } from './todos-api.js';
import type { TodosApi } from './todos-api.js';
import { buildProvider } from '../agent/providers/factory.js';
import { loadConfigForRepo } from '../agent/config.js';
import { getLogger } from '../shared/logger.js';

const log = getLogger('meta-task:stream-ipc');

interface MetaTaskRunParams {
	readonly templateId: string;
	readonly intent:     string;
	readonly scope:      ScopeManifest;
	readonly sessionId:  string;
}

export const metaTaskRunStream: StreamHandler = async (params, send, signal) => {
	const p = params as MetaTaskRunParams;

	const wrappedSend = (msg: Omit<IpcStreamMessage, 'id'>): void => {
		send({ id: 0, ...msg });
	};

	if (typeof p.templateId !== 'string' || p.templateId.length === 0) {
		wrappedSend({ stream: 'error', data: { error: 'meta-task.run: templateId is required', recoverable: false } });
		return;
	}
	if (typeof p.sessionId !== 'string' || p.sessionId.length === 0) {
		wrappedSend({ stream: 'error', data: { error: 'meta-task.run: sessionId is required', recoverable: false } });
		return;
	}
	if (p.scope === undefined || typeof p.scope.repoPath !== 'string') {
		wrappedSend({ stream: 'error', data: { error: 'meta-task.run: scope.repoPath is required', recoverable: false } });
		return;
	}

	// Build cloud + local providers from the active config. `meta-task` is a
	// new step name; until per-step bindings are surfaced in the config schema
	// we fall back to the active provider's default (same fallback chain as
	// chat).
	let cloud;
	let embedProvider;
	try {
		const config = await loadConfigForRepo(p.scope.repoPath);
		const active = config.models.activeProvider;
		if (active === null) {
			wrappedSend({ stream: 'error', data: { error: 'meta-task.run: no active cloud provider configured', recoverable: false } });
			return;
		}
		const def = config.models.providers[active].default;
		if (def === undefined || def === null) {
			wrappedSend({ stream: 'error', data: { error: `meta-task.run: no default model configured for ${active}`, recoverable: false } });
			return;
		}
		cloud = buildProvider({ provider: active, model: def }, config);
		embedProvider = buildProvider({ provider: 'local' }, config);
	} catch (err) {
		wrappedSend({ stream: 'error', data: { error: `meta-task.run: provider build failed: ${(err as Error).message}`, recoverable: false } });
		return;
	}

	let todos: TodosApi;
	try {
		todos = makeTodosApi(await getDb(), 'meta-task');
	} catch (err) {
		wrappedSend({ stream: 'error', data: { error: `meta-task.run: TodosApi unavailable: ${(err as Error).message}`, recoverable: false } });
		return;
	}

	const emit = new MetaTaskEmitter({ send: wrappedSend, todos });
	const onAbort = (): void => { emit.abort(); };
	signal.addEventListener('abort', onAbort, { once: true });

	try {
		await runMetaTask({
			templateId: p.templateId,
			intent:     p.intent,
			scope:      p.scope,
			sessionId:  p.sessionId,
			emit,
			cloud,
			embed:      (text: string) => embedProvider.embed(text),
			signal,
		});
	} catch (err) {
		log.warn({ err: (err as Error).message, templateId: p.templateId }, 'meta-task.run threw');
		emit.error((err as Error).message, false);
	} finally {
		signal.removeEventListener('abort', onAbort);
	}
};
