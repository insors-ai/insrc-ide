/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IInsrcChatService } from '../../common/chatService.js';
import { IInsrcDaemonService } from '../../common/daemonService.js';
import {
	IInsrcHandoffService,
	type HandoffChunk,
	type HandoffEvent,
	type HandoffModeAPrompt,
	type HandoffModeAResolution,
	type HandoffModeBPrompt,
	type HandoffModeBResolution,
	type HandoffSessionState,
	type HandoffStage,
} from '../../common/handoffService.js';

/**
 * Browser-side impl of {@link IInsrcHandoffService}. Aggregates
 * daemon-emitted `HandoffEvent`s keyed by `specId` so the chat
 * handoff widget (Day 3) can render one card per in-flight or
 * recently-finished handoff.
 *
 * Events arrive via {@link dispatch}, which the chat service calls
 * for every `{ type: 'handoff' }` stream message it sees on the
 * active session. State transitions follow the daemon's pipeline
 * order (spec-assembling -> spec-ready -> ... -> final), with
 * `handoff-error` jumping straight to a terminal `error` stage.
 *
 * Session lifecycle: a fresh chat session clears the cache (a new
 * conversation never inherits the prior session's handoff cards).
 * Terminal sessions remain in the map until the user dismisses them
 * via `clear(specId)`.
 *
 * Concurrency: the daemon serialises events per specId, so we never
 * race ourselves; the only out-of-order possibility is
 * `spec-assembling` arriving after `spec-ready` for the same specId,
 * which `dispatch` rejects defensively to keep state monotone.
 */
export class InsrcHandoffServiceImpl extends Disposable implements IInsrcHandoffService {
	declare readonly _serviceBrand: undefined;

	private readonly _sessions = new Map<string, HandoffSessionState>();

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _onDidChangeSession = this._register(new Emitter<HandoffSessionState>());
	readonly onDidChangeSession: Event<HandoffSessionState> = this._onDidChangeSession.event;

	private readonly _onDidFinalize = this._register(new Emitter<HandoffSessionState>());
	readonly onDidFinalize: Event<HandoffSessionState> = this._onDidFinalize.event;

	private readonly _onDidRemoveSession = this._register(new Emitter<string>());
	readonly onDidRemoveSession: Event<string> = this._onDidRemoveSession.event;

	private readonly _onChunk = this._register(new Emitter<HandoffChunk>());
	readonly onChunk: Event<HandoffChunk> = this._onChunk.event;

	private readonly _onModeAPrompt = this._register(new Emitter<HandoffModeAPrompt>());
	readonly onModeAPrompt: Event<HandoffModeAPrompt> = this._onModeAPrompt.event;

	private readonly _onModeAResolution = this._register(new Emitter<HandoffModeAResolution>());
	readonly onModeAResolution: Event<HandoffModeAResolution> = this._onModeAResolution.event;

	private readonly _onModeBPrompt = this._register(new Emitter<HandoffModeBPrompt>());
	readonly onModeBPrompt: Event<HandoffModeBPrompt> = this._onModeBPrompt.event;

	private readonly _onModeBResolution = this._register(new Emitter<HandoffModeBResolution>());
	readonly onModeBResolution: Event<HandoffModeBResolution> = this._onModeBResolution.event;

	/**
	 * The current chat session id. We don't subscribe to handoff
	 * events directly here -- `chatServiceImpl` forwards them via
	 * `dispatch` -- but we DO clear our cache whenever the chat
	 * session flips so a new conversation starts with a clean slate.
	 */
	private _chatSessionId: string | undefined;

	/**
	 * Pending-specId hint for `spec-assembling` events. The daemon
	 * doesn't allocate a specId until `spec-ready`, so we keep one
	 * "pending" entry per chat-session keyed by intent. When
	 * `spec-ready` arrives we promote the pending state object into
	 * its real specId entry and drop the placeholder.
	 */
	private _pendingByIntent = new Map<string, string>();

	constructor(
		@IInsrcChatService chatService: IInsrcChatService,
		@IInsrcDaemonService private readonly daemonService: IInsrcDaemonService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._chatSessionId = chatService.activeSessionId;
		this.logService.info(`[insrc-handoff] init sessionId=${this._chatSessionId ?? '(none)'}`);

		this._register(chatService.onDidChangeSession(id => this._onChatSessionChange(id)));
	}

	get sessions(): ReadonlyMap<string, HandoffSessionState> {
		return this._sessions;
	}

	dispatch(event: HandoffEvent): boolean {
		switch (event.kind) {
			case 'spec-assembling': {
				const pendingId = this._pendingIdForIntent(event.intent);
				const prev = this._sessions.get(pendingId);
				if (prev !== undefined && prev.stage !== 'spec-assembling') {
					// Out-of-order replay -- ignore; later stages win.
					return false;
				}
				const state: HandoffSessionState = {
					specId: pendingId,
					intent: event.intent,
					templateId: event.templateId,
					stage: 'spec-assembling',
					preview: undefined,
					worktreePath: undefined,
					agent: undefined,
					exitCode: undefined,
					durationMs: undefined,
					verdict: undefined,
					auditReason: undefined,
					editHintCount: undefined,
					machineCheckCount: undefined,
					diffBytes: undefined,
					diff: undefined,
					errorStage: undefined,
					errorMessage: undefined,
					startedAt: prev?.startedAt ?? new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				};
				this._sessions.set(pendingId, state);
				this._emitChange(state);
				return true;
			}

			case 'spec-ready': {
				// Promote the matching pending entry into its canonical
				// specId entry. If no pending entry exists (direct IPC
				// invocation skipped `spec-assembling`), seed a fresh
				// state object so downstream events still aggregate.
				const pendingId = this._findPendingForSpecReady();
				let base: HandoffSessionState | undefined;
				if (pendingId !== undefined) {
					base = this._sessions.get(pendingId);
					this._sessions.delete(pendingId);
					this._dropPendingMapping(pendingId);
					// Don't emit a remove -- the pending id was an internal
					// placeholder. The widget keys on the canonical specId.
				}
				const state: HandoffSessionState = {
					specId: event.specId,
					intent: base?.intent,
					templateId: event.templateId,
					stage: 'spec-ready',
					preview: event.preview,
					worktreePath: undefined,
					agent: undefined,
					exitCode: undefined,
					durationMs: undefined,
					verdict: undefined,
					auditReason: undefined,
					editHintCount: undefined,
					machineCheckCount: undefined,
					diffBytes: undefined,
					diff: undefined,
					errorStage: undefined,
					errorMessage: undefined,
					startedAt: base?.startedAt ?? new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				};
				this._sessions.set(event.specId, state);
				this._emitChange(state);
				return true;
			}

			case 'agent-stdout-chunk':
			case 'agent-stderr-chunk': {
				// Live chunks don't change session state; fan out to the
				// dedicated chunk subscriber (Phase 2c terminal UX) and
				// return early so we don't trip the stage/terminal guard.
				this._onChunk.fire({
					specId: event.specId,
					stream: event.kind === 'agent-stdout-chunk' ? 'stdout' : 'stderr',
					chunk: event.chunk,
				});
				return true;
			}

			case 'mode-a-gate-request': {
				this._onModeAPrompt.fire({
					specId: event.specId,
					gateId: event.gateId,
					templateId: event.templateId,
					riskTag: event.riskTag,
					permissions: event.permissions,
					preview: event.preview,
				});
				return true;
			}

			case 'mode-a-gate-resolved': {
				const resolution: HandoffModeAResolution = {
					specId: event.specId,
					gateId: event.gateId,
					verdict: event.verdict,
					...(event.stopReason !== undefined ? { stopReason: event.stopReason } : {}),
				};
				this._onModeAResolution.fire(resolution);
				return true;
			}

			case 'mode-b-gate-request': {
				// Phase 3 Mode B: PreToolUse hook needs the user's call.
				// Pass through to subscribers (chatView modal) without
				// touching session state -- the prompt is orthogonal to
				// the pipeline stage.
				this._onModeBPrompt.fire({
					specId: event.specId,
					gateId: event.gateId,
					tool: event.tool,
					input: event.input,
					sessionId: event.sessionId,
				});
				return true;
			}

			case 'mode-b-gate-resolved': {
				const resolution: HandoffModeBResolution = {
					specId: event.specId,
					gateId: event.gateId,
					verdict: event.verdict,
					...(event.scope !== undefined ? { scope: event.scope } : {}),
					...(event.stopReason !== undefined ? { stopReason: event.stopReason } : {}),
				};
				this._onModeBResolution.fire(resolution);
				return true;
			}

			case 'worktree-created':
				return this._updateExisting(event.specId, 'worktree-created', prev => ({
					...prev,
					stage: 'worktree-created',
					worktreePath: event.worktreePath,
				}));

			case 'spawned':
				return this._updateExisting(event.specId, 'spawned', prev => ({
					...prev,
					stage: 'spawned',
					agent: event.agent,
				}));

			case 'agent-completed':
				return this._updateExisting(event.specId, 'agent-completed', prev => ({
					...prev,
					stage: 'agent-completed',
					exitCode: event.exitCode,
					durationMs: event.durationMs,
				}));

			case 'auditing':
				return this._updateExisting(event.specId, 'auditing', prev => ({
					...prev,
					stage: 'auditing',
				}));

			case 'audit-ready':
				return this._updateExisting(event.specId, 'audit-ready', prev => ({
					...prev,
					stage: 'audit-ready',
					verdict: event.verdict,
					auditReason: event.reason,
					editHintCount: event.editHintCount,
					machineCheckCount: event.machineCheckCount,
					diffBytes: event.diffBytes,
				}));

			case 'handoff-final': {
				const applied = this._updateExisting(event.specId, 'final', prev => ({
					...prev,
					stage: 'final',
					verdict: event.verdict,
					worktreePath: event.worktreePath,
					diff: event.diff,
					diffBytes: event.diff.length,
				}));
				if (applied) {
					const finalized = this._sessions.get(event.specId);
					if (finalized !== undefined) {
						this._onDidFinalize.fire(finalized);
					}
				}
				return applied;
			}

			case 'handoff-error': {
				// `handoff-error` doesn't carry a specId, so the failure
				// belongs to "the most recent non-terminal session". This
				// matches the daemon's serial pipeline -- only one handoff
				// runs at a time per chat session.
				const target = this._mostRecentActiveSpecId();
				if (target === undefined) {
					// Failure with no in-flight session: synthesize a
					// standalone error entry so the user still sees it.
					const specId = `error:${this._pendingIdForIntent('unknown')}`;
					const now = new Date().toISOString();
					const state: HandoffSessionState = {
						specId,
						intent: undefined,
						templateId: undefined,
						stage: 'error',
						preview: undefined,
						worktreePath: undefined,
						agent: undefined,
						exitCode: undefined,
						durationMs: undefined,
						verdict: undefined,
						auditReason: undefined,
						editHintCount: undefined,
						machineCheckCount: undefined,
						diffBytes: undefined,
						diff: undefined,
						errorStage: event.stage,
						errorMessage: event.message,
						startedAt: now,
						updatedAt: now,
					};
					this._sessions.set(specId, state);
					this._emitChange(state);
					return true;
				}
				return this._updateExisting(target, 'error', prev => ({
					...prev,
					stage: 'error',
					errorStage: event.stage,
					errorMessage: event.message,
				}));
			}
		}
	}

	async resolveModeAPrompt(
		gateId: string,
		verdict: 'allow' | 'deny',
		opts: { stopReason?: string } = {},
	): Promise<void> {
		const params: Record<string, unknown> = { gateId, verdict };
		if (opts.stopReason !== undefined) {
			params['stopReason'] = opts.stopReason;
		}
		try {
			await this.daemonService.rpc<{ resolved: boolean }>('handoff.mode-a.resolve', params);
		} catch (err) {
			this.logService.warn(`[insrc-handoff] handoff.mode-a.resolve(${gateId}) failed: ${(err as Error).message}`);
		}
	}

	async resolveModeBPrompt(
		gateId: string,
		verdict: 'allow' | 'deny',
		opts: { scope?: 'once' | 'session'; stopReason?: string } = {},
	): Promise<void> {
		const params: Record<string, unknown> = { gateId, verdict };
		if (opts.scope !== undefined) {
			params['scope'] = opts.scope;
		}
		if (opts.stopReason !== undefined) {
			params['stopReason'] = opts.stopReason;
		}
		try {
			await this.daemonService.rpc<{ resolved: boolean }>('gate.resolve', params);
		} catch (err) {
			this.logService.warn(`[insrc-handoff] gate.resolve(${gateId}) failed: ${(err as Error).message}`);
		}
	}

	clear(specId: string): void {
		if (this._sessions.delete(specId)) {
			this._dropPendingMapping(specId);
			this._onDidRemoveSession.fire(specId);
			this._onDidChange.fire();
		}
	}

	clearAll(): void {
		if (this._sessions.size === 0 && this._pendingByIntent.size === 0) {
			return;
		}
		const ids = Array.from(this._sessions.keys());
		this._sessions.clear();
		this._pendingByIntent.clear();
		for (const id of ids) {
			this._onDidRemoveSession.fire(id);
		}
		this._onDidChange.fire();
	}

	// -- Internal -----------------------------------------------------------

	private _onChatSessionChange(id: string | undefined): void {
		if (this._chatSessionId === id) {
			return;
		}
		this.logService.info(`[insrc-handoff] chat session change ${this._chatSessionId ?? '(none)'} -> ${id ?? '(none)'}`);
		this._chatSessionId = id;
		this.clearAll();
	}

	/**
	 * Compute a synthetic id for the "pending" state object that holds
	 * a `spec-assembling` event before its canonical specId is known.
	 * Multiple in-flight handoffs in the same chat session each get
	 * a unique pending id; once `spec-ready` arrives the pending
	 * entry is promoted to its canonical specId.
	 */
	private _pendingIdForIntent(intent: string): string {
		const existing = this._pendingByIntent.get(intent);
		if (existing !== undefined && this._sessions.has(existing)) {
			return existing;
		}
		const id = `pending:${intent.slice(0, 32)}:${this._sessions.size}`;
		this._pendingByIntent.set(intent, id);
		return id;
	}

	/**
	 * Find the pending-id entry that should be promoted by an incoming
	 * `spec-ready`. The daemon emits exactly one `spec-assembling`
	 * before each `spec-ready`, so we pick the oldest pending entry.
	 */
	private _findPendingForSpecReady(): string | undefined {
		for (const [intent, pendingId] of this._pendingByIntent) {
			if (this._sessions.has(pendingId)) {
				return pendingId;
			}
			// Drop dangling references.
			this._pendingByIntent.delete(intent);
		}
		return undefined;
	}

	private _dropPendingMapping(pendingId: string): void {
		for (const [intent, id] of this._pendingByIntent) {
			if (id === pendingId) {
				this._pendingByIntent.delete(intent);
				return;
			}
		}
	}

	private _mostRecentActiveSpecId(): string | undefined {
		let mostRecent: string | undefined;
		let mostRecentUpdate = '';
		for (const [id, state] of this._sessions) {
			if (state.stage === 'final' || state.stage === 'error') {
				continue;
			}
			if (state.updatedAt >= mostRecentUpdate) {
				mostRecentUpdate = state.updatedAt;
				mostRecent = id;
			}
		}
		return mostRecent;
	}

	private _updateExisting(
		specId: string,
		newStage: HandoffStage,
		patch: (prev: HandoffSessionState) => HandoffSessionState,
	): boolean {
		const prev = this._sessions.get(specId);
		if (prev === undefined) {
			this.logService.warn(`[insrc-handoff] ${newStage} for unknown specId=${specId}; dropping`);
			return false;
		}
		if (prev.stage === 'final' || prev.stage === 'error') {
			// Terminal -- no more updates accepted.
			return false;
		}
		const next: HandoffSessionState = {
			...patch(prev),
			updatedAt: new Date().toISOString(),
		};
		this._sessions.set(specId, next);
		this._emitChange(next);
		return true;
	}

	private _emitChange(state: HandoffSessionState): void {
		this._onDidChangeSession.fire(state);
		this._onDidChange.fire();
	}
}
