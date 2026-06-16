/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `/<meta-task-template>` runner. Routes slash invocations like `/review` to
 * the daemon's `meta-task.run` stream. Mirrors `handoff/handoffRunner.ts`.
 *
 * Events the daemon emits (`liveStep`, `progress`, `todos`, `done`, `error`)
 * are dispatched through the existing chat-panel IPC pipeline -- no custom
 * dispatch is needed here. The runner just opens the stream, holds the
 * handle, and closes it on session change / disposal.
 *
 * Plan ref: [`plans/meta-tasks.md`](../../../../../../plans/meta-tasks.md) M2.8.
 */

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IInsrcDaemonService, type IInsrcStreamHandle } from '../../common/daemonService.js';
import { IInsrcChatService } from '../../common/chatService.js';
import { IInsrcRepoService } from '../../common/repoService.js';

export class InsrcMetaTaskRunner extends Disposable {

	/** Active streams keyed by sessionId. One per session at a time. */
	private readonly _activeStreams = new Map<string, IInsrcStreamHandle>();

	constructor(
		@IInsrcDaemonService private readonly daemonService: IInsrcDaemonService,
		@IInsrcChatService private readonly chatService: IInsrcChatService,
		@IInsrcRepoService private readonly repoService: IInsrcRepoService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	/**
	 * Drive the daemon's meta-task pipeline for one slash invocation.
	 * @param templateId  Template id (e.g. 'review').
	 * @param rawIntent   Free-text intent the user typed after the slash.
	 * @returns A short human-readable summary.
	 */
	async run(templateId: string, rawIntent: string): Promise<string> {
		const sessionId = this.chatService.activeSessionId;
		if (sessionId === undefined || sessionId.length === 0) {
			return `/${templateId}: no active chat session -- start a conversation first.`;
		}
		const intent = rawIntent.trim();
		if (intent.length === 0) {
			return `/${templateId}: empty intent -- usage \`/${templateId} <what you want analyzed>\``;
		}

		const repos = this.repoService.repos;
		if (repos.length === 0) {
			return `/${templateId}: no repository selected -- add one via the repo dropdown first.`;
		}
		const activeRepoPath = this.chatService.activeRepo;
		const repo = activeRepoPath !== undefined
			? (repos.find(r => r.path === activeRepoPath) ?? repos[0]!)
			: repos[0]!;

		this._closeStream(sessionId);

		this.logService.info(
			`[insrc-meta-task-runner] starting template=${templateId} session=${sessionId} repo=${repo.path}`,
		);

		const handle = this.daemonService.stream('meta-task.run', {
			templateId,
			intent,
			sessionId,
			scope: {
				intent,
				repoPath: repo.path,
				inScopeGlobs: ['**'],
				outOfScopePaths: [],
			},
		});
		this._activeStreams.set(sessionId, handle);

		this._register(handle.onDidError(err => {
			this.logService.warn(`[insrc-meta-task-runner] stream error: ${err.message}`);
			this._closeStream(sessionId);
		}));
		this._register(handle.onDidEnd(() => {
			this._closeStream(sessionId);
		}));

		return `/${templateId}: started -- watch the chat panel for live progress.`;
	}

	private _closeStream(sessionId: string): void {
		const existing = this._activeStreams.get(sessionId);
		if (existing === undefined) { return; }
		try { existing.dispose(); } catch { /* swallow */ }
		this._activeStreams.delete(sessionId);
	}

	override dispose(): void {
		for (const sid of [...this._activeStreams.keys()]) {
			this._closeStream(sid);
		}
		super.dispose();
	}
}
