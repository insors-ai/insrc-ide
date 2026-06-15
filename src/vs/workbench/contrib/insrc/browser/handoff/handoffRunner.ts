/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `/handoff` test-harness runner.
 *
 * Wires the chat's slash-command intercept to the daemon's
 * `handoff.run` streaming IPC. The runner:
 *
 *   1. Resolves the active session id + repo path from the
 *      injected chat / repo services.
 *   2. Classifies the free-form intent into a template id
 *      (handoffClassifier.ts).
 *   3. Picks an agent based on the `insrc.handoff.preferredAgent`
 *      config (defaults to 'auto' -> the daemon's pickAgent
 *      decides). For the test harness we ship a workbench-side
 *      heuristic: when the setting is 'auto' we hand 'claude-code'
 *      so users with claude installed get the working path; users
 *      who want codex set it explicitly.
 *   4. Opens a streaming RPC against `handoff.run` with
 *      `modeAGate: true` so the pre-flight modal fires.
 *   5. Forwards every `{type:'handoff'}` message arriving on the
 *      stream into the existing `IInsrcHandoffService.dispatch`,
 *      which fans events out to the card / terminal panel /
 *      modals.
 *
 * Because the dispatched events look identical to the events that
 * arrive on the regular chat stream once M.2 lands, every
 * downstream surface (widget, panel, Mode A modal, Mode B modal,
 * diff opener, accept/reject buttons) lights up unchanged.
 *
 * Errors during stream setup surface back to the chat as a
 * synthesized log entry; we never throw out of the runner.
 */

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInsrcDaemonService, type IInsrcStreamHandle } from '../../common/daemonService.js';
import { IInsrcHandoffService, type HandoffEvent } from '../../common/handoffService.js';
import { IInsrcChatService } from '../../common/chatService.js';
import { IInsrcRepoService } from '../../common/repoService.js';
import { classifyHandoffIntent } from './handoffClassifier.js';

const SETTING_PREFERRED_AGENT = 'insrc.handoff.preferredAgent';

/**
 * Coerce the `insrc.handoff.preferredAgent` setting to a concrete
 * agent name the daemon will accept on the `handoff.run` IPC. The
 * harness routes 'auto' to 'claude-code' because the active-cloud
 * resolver lives daemon-side and we don't have it here yet -- this
 * is the test harness, not the production router (which lands in
 * M.2).
 */
function resolveAgentForHarness(setting: string): 'claude-code' | 'codex' {
	if (setting === 'codex') { return 'codex'; }
	return 'claude-code';
}

export class InsrcHandoffRunner extends Disposable {

	/**
	 * In-flight handoff streams keyed by sessionId. We hold one at
	 * a time per session today (the daemon serialises on its side
	 * too); a second `/handoff` while one is still running just
	 * disposes the prior stream and starts a new one.
	 */
	private readonly _activeStreams = new Map<string, IInsrcStreamHandle>();

	constructor(
		@IInsrcDaemonService private readonly daemonService: IInsrcDaemonService,
		@IInsrcHandoffService private readonly handoffService: IInsrcHandoffService,
		@IInsrcChatService private readonly chatService: IInsrcChatService,
		@IInsrcRepoService private readonly repoService: IInsrcRepoService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	/**
	 * Drive the test harness for one `/handoff <intent>` invocation.
	 * Returns a short human-readable summary the caller can echo
	 * back to the chat transcript.
	 */
	async run(rawIntent: string): Promise<string> {
		const sessionId = this.chatService.activeSessionId;
		if (sessionId === undefined || sessionId.length === 0) {
			return '/handoff: no active chat session -- start a conversation first.';
		}
		const repos = this.repoService.repos;
		if (repos.length === 0) {
			return '/handoff: no repository selected -- add one via the repo dropdown first.';
		}
		const repo = repos[0]!;
		const classification = classifyHandoffIntent(rawIntent);
		if (classification.intent.length === 0) {
			return '/handoff: empty intent -- usage `/handoff <what you want done>`.';
		}

		const agentSetting = this.configurationService.getValue<string>(SETTING_PREFERRED_AGENT) ?? 'auto';
		const agent = resolveAgentForHarness(agentSetting);

		// Tear down any prior stream for this session before opening
		// the new one. The daemon's runHandoff also rejects
		// concurrent handoffs against the same worktree path, so
		// this is a courtesy to keep the IDE state coherent.
		this._closeStream(sessionId);

		this.logService.info(
			`[insrc-handoff-runner] starting template=${classification.templateId} agent=${agent} session=${sessionId} repo=${repo.path}`,
		);

		const handle = this.daemonService.stream('handoff.run', {
			templateId: classification.templateId,
			intent: classification.intent,
			agent,
			sessionId,
			modeAGate: true,
			scope: {
				repoId: repo.path,
				repoPath: repo.path,
				inScopeGlobs: ['**'],
				outOfScopePaths: [],
				riskHints: 'low',
			},
			memoryRefs: [],
		});
		this._activeStreams.set(sessionId, handle);

		this._register(handle.onMessage(msg => {
			if (msg.type !== 'handoff') { return; }
			// The daemon-side `handoff.run` stream carries the typed
			// HandoffEvent on `msg.event`; defensively coerce + drop
			// malformed payloads instead of letting them through.
			const event = msg.event as HandoffEvent | undefined;
			if (event === undefined || typeof event !== 'object' || typeof (event as { kind?: string }).kind !== 'string') {
				return;
			}
			this.handoffService.dispatch(event);
		}));
		this._register(handle.onDidError(err => {
			this.logService.warn(`[insrc-handoff-runner] stream error: ${err.message}`);
			this._closeStream(sessionId);
		}));
		this._register(handle.onDidEnd(() => {
			this._closeStream(sessionId);
		}));

		const summary = classification.viaOverride
			? `(forced ${classification.templateId})`
			: `(picked ${classification.templateId})`;
		return `/handoff: running ${classification.templateId} via ${agent} ${summary} -- approve via the pre-flight modal.`;
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
