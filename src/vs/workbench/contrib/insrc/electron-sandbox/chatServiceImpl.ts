/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Chat service implementation -- drives analyze.run.start over the
 * daemon's streaming RPC.
 *
 * sendMessage(text) starts a run by calling
 * daemonService.stream('analyze.run.start', { runId, userPrompt, scopeRef })
 * and re-fires every DaemonStreamMessage frame as a generic
 * `onDidReceiveEvent` event the chat panel + status bar listen to.
 *
 * Frame -> event mapping:
 *
 *   { type: 'progress', step, status, ...extras }
 *     re-emitted as onDidReceiveEvent({ type: 'progress', ... }) so the
 *     existing status bar's spinner logic (it watches for 'progress' +
 *     'streamEnd' on this service) keeps working unchanged.
 *
 *   { type: 'analyze-result', result }
 *     re-emitted as onDidReceiveEvent({ type: 'analyze-result', runId,
 *     result }). The chat view pane subscribes to this + opens the
 *     AnalyzeReportInput editor tab on ok:true / surfaces the failure
 *     code on ok:false.
 *
 *   stream's onDidEnd
 *     fires onDidReceiveEvent({ type: 'streamEnd', runId }) so the
 *     status bar's spinner stops.
 *
 *   stream's onDidError
 *     fires onDidReceiveEvent({ type: 'streamError', runId, message })
 *     followed by 'streamEnd' to ensure isStreaming flips back to false
 *     even on socket loss.
 *
 * scopeRef derivation: caller passes the active workspace folder path
 * via sendMessage's contract. The chat view pane reads
 * IWorkspaceContextService for that path and forwards it. If no
 * folder is open, sendMessage logs a warning + drops the call (no
 * point starting an analyze run with no scope).
 *
 * Session lifecycle: U1 doesn't bootstrap chat sessions; the analyze
 * pipeline uses its own runId universe. Session integration (per-repo
 * persisted message history) lands in U4.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IInsrcDaemonService, type DaemonStreamMessage, type IInsrcStreamHandle } from '../common/daemonService.js';
import type { IChatMessage, IInsrcChatService } from '../common/chatService.js';

/** Storage key used to persist per-workspace chat history. */
const CHAT_HISTORY_STORAGE_KEY = 'insrc.chat.history';
/** Storage key for the user-pinned scope path (per workbench). */
const CHAT_PINNED_SCOPE_KEY = 'insrc.chat.pinnedScope';
/** Cap the on-disk history at this many entries per workspace to keep
 *  reads bounded. Older entries roll off; the user's "current
 *  conversation" feels lossy if we cap too low, so a few hundred is
 *  the right ballpark. */
const CHAT_HISTORY_MAX_ENTRIES = 500;

interface PersistedChatHistory {
	readonly version: 1;
	readonly messages: readonly IChatMessage[];
}

export class InsrcChatServiceImpl extends Disposable implements IInsrcChatService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChangeSession = this._register(new Emitter<string | undefined>());
	readonly onDidChangeSession: Event<string | undefined> = this._onDidChangeSession.event;

	private readonly _onDidReceiveEvent = this._register(new Emitter<{ type: string;[key: string]: unknown }>());
	readonly onDidReceiveEvent: Event<{ type: string;[key: string]: unknown }> = this._onDidReceiveEvent.event;

	private readonly _onDidChangeMessages = this._register(new Emitter<void>());
	readonly onDidChangeMessages: Event<void> = this._onDidChangeMessages.event;

	private readonly _onDidChangeActiveScope = this._register(new Emitter<void>());
	readonly onDidChangeActiveScope: Event<void> = this._onDidChangeActiveScope.event;

	private _activeSessionId: string | undefined = undefined;
	private _activeHandle: IInsrcStreamHandle | undefined = undefined;

	/** In-memory mirror of the persisted history for the active
	 *  workspace folder. Reloaded on construction + when the workspace
	 *  changes. */
	private _messages: IChatMessage[] = [];
	/** Workspace path the in-memory _messages were loaded for; used
	 *  to invalidate when the workspace changes. */
	private _messagesScopePath: string | undefined = undefined;

	constructor(
		@IInsrcDaemonService private readonly daemonService: IInsrcDaemonService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
		@IStorageService private readonly storageService: IStorageService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();
		this._loadMessagesForActiveWorkspace();
		// Workspace folders changed (folder added/removed, multi-root edits).
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => {
			this._reloadIfScopeChanged();
		}));
		// Active editor changed -- the scope may have moved to a different
		// workspace folder if the user opened a file in another root.
		this._register(this.editorService.onDidActiveEditorChange(() => {
			this._reloadIfScopeChanged();
		}));
	}

	get activeScopePath(): string | undefined {
		return this._activeScopePath();
	}

	get pinnedScopePath(): string | undefined {
		const raw = this.storageService.get(CHAT_PINNED_SCOPE_KEY, StorageScope.WORKSPACE);
		return raw !== undefined && raw.length > 0 ? raw : undefined;
	}

	setPinnedScope(path: string | undefined): void {
		const prev = this._activeScopePath();
		if (path === undefined || path.length === 0) {
			this.storageService.remove(CHAT_PINNED_SCOPE_KEY, StorageScope.WORKSPACE);
		} else {
			this.storageService.store(CHAT_PINNED_SCOPE_KEY, path, StorageScope.WORKSPACE, StorageTarget.USER);
		}
		const next = this._activeScopePath();
		if (next !== prev) {
			this._loadMessagesForActiveWorkspace();
			this._onDidChangeActiveScope.fire();
			this._onDidChangeMessages.fire();
		} else {
			this._onDidChangeActiveScope.fire();
		}
	}

	/**
	 * Re-derive the active scope from the active editor + workspace
	 * folders. If the result differs from what's currently loaded, swap
	 * the in-memory message list + fire onDidChangeMessages so the chat
	 * pane re-renders for the new folder. Also fires onDidChangeActiveScope
	 * so the scope badge updates regardless of whether messages changed.
	 */
	private _reloadIfScopeChanged(): void {
		const next = this._activeScopePath();
		if (next === this._messagesScopePath) {
			// Same folder -- just notify the badge (it may need a refresh
			// for other reasons, e.g. workspace folder renamed).
			this._onDidChangeActiveScope.fire();
			return;
		}
		this._loadMessagesForActiveWorkspace();
		this._onDidChangeActiveScope.fire();
		this._onDidChangeMessages.fire();
	}

	// -------------------------------------------------------------------------
	// Persisted message history
	// -------------------------------------------------------------------------

	getMessages(): readonly IChatMessage[] {
		return this._messages;
	}

	clearMessages(): void {
		this._messages = [];
		this._saveMessages();
		this._onDidChangeMessages.fire();
	}

	private _appendMessage(msg: IChatMessage): void {
		this._messages = [...this._messages, msg];
		// Cap the in-memory + persisted history.
		if (this._messages.length > CHAT_HISTORY_MAX_ENTRIES) {
			this._messages = this._messages.slice(this._messages.length - CHAT_HISTORY_MAX_ENTRIES);
		}
		this._saveMessages();
		this._onDidChangeMessages.fire();
	}

	private _saveMessages(): void {
		const scope = this._messagesScopePath;
		if (scope === undefined) {
			// No workspace folder open -- can't scope persistence. Drop
			// the save silently; the in-memory list still serves the
			// current session.
			return;
		}
		const payload: PersistedChatHistory = { version: 1, messages: this._messages };
		try {
			this.storageService.store(
				`${CHAT_HISTORY_STORAGE_KEY}.${scope}`,
				JSON.stringify(payload),
				StorageScope.PROFILE,
				StorageTarget.USER,
			);
		} catch (err) {
			this.logService.warn('[insrc-chat] failed to persist chat history', (err as Error).message);
		}
	}

	private _loadMessagesForActiveWorkspace(): void {
		const scope = this._activeScopePath();
		this._messagesScopePath = scope;
		if (scope === undefined) {
			this._messages = [];
			return;
		}
		const raw = this.storageService.get(`${CHAT_HISTORY_STORAGE_KEY}.${scope}`, StorageScope.PROFILE);
		if (raw === undefined || raw === '') {
			this._messages = [];
			return;
		}
		try {
			const parsed = JSON.parse(raw) as PersistedChatHistory;
			if (parsed.version !== 1 || !Array.isArray(parsed.messages)) {
				this.logService.warn(`[insrc-chat] discarding chat history at ${scope}: unrecognised payload`);
				this._messages = [];
				return;
			}
			this._messages = parsed.messages.slice();
		} catch (err) {
			this.logService.warn(`[insrc-chat] failed to parse chat history at ${scope}; resetting`,
				(err as Error).message);
			this._messages = [];
		}
	}

	get activeSessionId(): string | undefined { return this._activeSessionId; }

	get isStreaming(): boolean { return this._activeHandle !== undefined; }

	// -------------------------------------------------------------------------
	// Session lifecycle (no-op shells for U1 -- U4 wires chat sessions in)
	// -------------------------------------------------------------------------

	async startSession(repo: string): Promise<string | undefined> {
		// Sessions sidebar -> repo chat-icon -> _openChatForRepo(repoPath)
		// routes here. We don't have a daemon-backed session lifecycle
		// wired in this rebuild, but the caller's intent is clear: "open
		// the chat scoped to this repo." Pin the scope so the badge +
		// history + outgoing analyze.run.start all target the picked
		// repo regardless of what the active editor is doing.
		if (repo.length > 0) {
			this.setPinnedScope(repo);
		}
		return undefined;
	}
	async resumeSession(sessionId: string): Promise<void> {
		// Sessions sidebar -> session row click -> _openSessionInChat
		// routes here. Look up the session's repo via the daemon's
		// chat.restore RPC + pin the chat scope so the click lands
		// where the user expected.
		if (!this.daemonService.isConnected) {
			this.logService.debug('[insrc-chat] resumeSession: daemon not connected; ignoring');
			return;
		}
		try {
			const result = await this.daemonService.rpc<{ ok: boolean; repoPath?: string }>(
				'chat.restore', { id: sessionId },
			);
			if (result?.ok === true && typeof result.repoPath === 'string' && result.repoPath.length > 0) {
				this.setPinnedScope(result.repoPath);
				this._activeSessionId = sessionId;
				this._onDidChangeSession.fire(sessionId);
			}
		} catch (err) {
			this.logService.warn('[insrc-chat] resumeSession failed', (err as Error).message);
		}
	}
	async deleteSession(_sessionId: string): Promise<{ deleted: boolean; reason?: string }> { return { deleted: false, reason: 'sessions not yet wired' }; }
	async deleteSessionsBulk(_sessionIds: readonly string[]): Promise<{ deleted: number; failed: number }> { return { deleted: 0, failed: 0 }; }
	async cancelBrainstormSession(_reason: string, _opts?: { discardCheckpoint?: boolean }): Promise<void> { /* no-op */ }
	async resumeCodeAnalysis(_sessionId: string, _repo: string): Promise<void> { /* no-op */ }
	async resumeDataAnalysis(_sessionId: string, _repo: string): Promise<void> { /* no-op */ }
	async resumeFromCheckpoint(_sessionId: string, _repo: string): Promise<void> { /* no-op */ }

	// -------------------------------------------------------------------------
	// sendMessage -- the load-bearing entry point
	// -------------------------------------------------------------------------

	async sendMessage(message: string): Promise<void> {
		const trimmed = message.trim();
		if (trimmed.length === 0) {
			this.logService.debug('[insrc-chat] sendMessage: empty prompt -- ignoring');
			return;
		}
		if (this._activeHandle !== undefined) {
			this.logService.warn('[insrc-chat] sendMessage: a run is already in flight -- ignoring new prompt');
			this._onDidReceiveEvent.fire({
				type: 'streamError',
				message: 'A previous analyze run is still in progress. Wait for it to finish or cancel before starting a new one.',
			});
			return;
		}

		const scopePath = this._activeScopePath();
		if (scopePath === undefined) {
			this.logService.warn('[insrc-chat] sendMessage: no workspace folder open');
			this._onDidReceiveEvent.fire({
				type: 'streamError',
				message: 'No workspace folder is open. Open a folder + try again.',
			});
			return;
		}

		const runId = this._mintRunId();

		// Parse leading slash command, e.g. `/code map this repo` or
		// `/data:xl describe schemas`. Recognised forms:
		//   /<target>          (target hint only; scope defaults to M)
		//   /<target>:<scope>  (target + scope hint)
		// Targets: code | data | infra | generic
		// Scopes:  xs | s | m | l | xl   (lowercased on input; uppercased
		// before the wire call to match AnalyzeScope enum values)
		// The prefix is stripped from the prompt before persistence +
		// wire so the user-message bubble shows the bare request.
		const slash = this._parseSlashCommand(trimmed);
		const promptText = slash !== undefined ? slash.rest : trimmed;
		if (promptText.length === 0) {
			this._onDidReceiveEvent.fire({
				type: 'streamError',
				message: 'Slash command needs a prompt after it.',
			});
			return;
		}

		// Persist the user prompt so it restores across IDE restarts
		// alongside whatever assistant message follows.
		this._appendMessage({
			id: this._mintMessageId(),
			runId,
			role: 'user',
			content: promptText,
			timestamp: new Date().toISOString(),
		});

		// Echo the user's prompt back as a message event so the chat
		// pane can render it immediately. The `repo` field gives
		// agentRunService something to scope by when registering the
		// analyze run in the Runs sidebar.
		this._onDidReceiveEvent.fire({
			type: 'userMessage',
			runId,
			content: promptText,
			repo: scopePath,
		});

		// Kick off the streaming RPC. Persistence (run.json + per-task
		// outputs) happens daemon-side inside runAnalyze; the IDE just
		// observes the wire frames.
		const handle = this.daemonService.stream('analyze.run.start', {
			runId,
			userPrompt: promptText,
			scopeRef: { kind: 'workspace', value: scopePath },
			...(slash?.target !== undefined ? { targetHint: slash.target } : {}),
			...(slash?.scope !== undefined ? { scopeHint: slash.scope } : {}),
		});
		this._activeHandle = handle;

		const dispose = (): void => {
			this._activeHandle = undefined;
			handle.dispose();
		};

		this._register(handle.onMessage(msg => this._handleFrame(msg, runId)));
		this._register(handle.onDidEnd(() => {
			this._onDidReceiveEvent.fire({ type: 'streamEnd', runId });
			dispose();
		}));
		this._register(handle.onDidError(err => {
			this.logService.error('[insrc-chat] stream error', err.message);
			this._appendMessage({
				id: this._mintMessageId(),
				runId,
				role: 'error',
				content: err.message,
				status: 'failed',
				timestamp: new Date().toISOString(),
			});
			this._onDidReceiveEvent.fire({
				type: 'streamError',
				runId,
				message: err.message,
			});
			this._onDidReceiveEvent.fire({ type: 'streamEnd', runId });
			dispose();
		}));
	}

	// -------------------------------------------------------------------------
	// Frame dispatcher
	// -------------------------------------------------------------------------

	private _handleFrame(msg: DaemonStreamMessage, runId: string): void {
		switch (msg.type) {
			case 'progress':
				this._onDidReceiveEvent.fire({
					type: 'progress',
					runId,
					step: msg.step,
					status: msg.status,
					...(msg.taskId !== undefined ? { taskId: msg.taskId } : {}),
					...(msg.template !== undefined ? { template: msg.template } : {}),
					...(msg.index !== undefined ? { index: msg.index } : {}),
					...(msg.total !== undefined ? { total: msg.total } : {}),
					...(msg.parentTaskPath !== undefined ? { parentTaskPath: msg.parentTaskPath } : {}),
				});
				return;
			case 'analyze-result':
				this._persistAnalyzeResult(runId, msg.result);
				this._onDidReceiveEvent.fire({
					type: 'analyze-result',
					runId,
					result: msg.result,
				});
				return;
			default:
				// Other frame types (delta / liveStep / gate / todos / ...)
				// are intentionally ignored by U1's chat service -- the
				// analyze pipeline doesn't emit them. Future stages (S4 token
				// streaming, U4 todos bridge) will pick them up here.
				return;
		}
	}

	// -------------------------------------------------------------------------
	// Helpers
	// -------------------------------------------------------------------------

	/**
	 * Resolve the workspace folder the chat is scoped to.
	 *
	 * Preference order:
	 *   1. User-pinned scope override (persisted per-workspace via the
	 *      header dropdown)
	 *   2. The folder containing the active editor's file (multi-root
	 *      workspaces -- pick the root matching what the user is currently
	 *      looking at)
	 *   3. The first workspace folder (single-root, or no editor open)
	 *   4. undefined (no folder open at all)
	 */
	private _activeScopePath(): string | undefined {
		// (1) pinned override -- if the user explicitly picked a folder,
		// honour it regardless of editor / workspace state. Validate that
		// it's still in the current workspace; the user may have removed
		// the folder since the pin was last saved.
		const pinned = this.pinnedScopePath;
		if (pinned !== undefined) {
			const workspace = this.workspaceService.getWorkspace();
			const stillPresent = workspace.folders.some(f => f.uri.fsPath === pinned);
			if (stillPresent) {
				return pinned;
			}
		}
		// (2) active editor's containing folder
		const activeEditor = this.editorService.activeEditor;
		const resource = activeEditor?.resource;
		if (resource !== undefined) {
			const folder = this.workspaceService.getWorkspaceFolder(resource);
			if (folder !== undefined && folder !== null) {
				return folder.uri.fsPath;
			}
		}
		// (3) first workspace folder
		const workspace = this.workspaceService.getWorkspace();
		const folder = workspace.folders[0];
		return folder?.uri.fsPath;
	}

	/**
	 * Persist the terminal analyze-result frame as an assistant or
	 * error message in the chat history. Called by the frame handler
	 * BEFORE re-firing the event so the chat pane sees a consistent
	 * state when it re-renders.
	 */
	private _persistAnalyzeResult(runId: string, resultRaw: unknown): void {
		const result = resultRaw as {
			ok?: boolean;
			error?: { code?: string; message?: string };
			stage?: string;
		};
		if (result.ok === true) {
			this._appendMessage({
				id: this._mintMessageId(),
				runId,
				role: 'assistant',
				content: 'Analysis complete. See the report editor tab.',
				status: 'completed',
				reportRunId: runId,
				timestamp: new Date().toISOString(),
			});
		} else {
			const code = result.error?.code ?? 'unknown';
			const message = result.error?.message ?? 'Run failed without a structured error.';
			this._appendMessage({
				id: this._mintMessageId(),
				runId,
				role: 'error',
				content: `Failed at stage='${result.stage ?? '?'}' (${code}): ${message}`,
				status: 'failed',
				timestamp: new Date().toISOString(),
			});
		}
	}

	private _mintMessageId(): string {
		return `msg-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')}`;
	}

	/**
	 * Parse leading slash command from a chat prompt. Recognised forms:
	 *
	 *   /code           map the architecture
	 *   /data           describe the schemas
	 *   /infra:xs       inventory k8s manifests
	 *   /generic:l      cross-domain audit
	 *
	 * Target is required; scope optional (defaults to 'M' daemon-side).
	 * Both case-insensitive on input; mapped to canonical enum values
	 * before the wire call.
	 *
	 * Returns undefined when the input doesn't start with a recognised
	 * `/<target>` prefix. Returns { target, scope?, rest } when it does.
	 */
	private _parseSlashCommand(input: string): { target: string; scope?: string; rest: string } | undefined {
		const m = input.match(/^\/(code|data|infra|generic)(?::(xs|s|m|l|xl))?(?:\s+(.+))?$/i);
		if (m === null) { return undefined; }
		const target = m[1]!.toLowerCase();
		const scope = m[2] !== undefined ? m[2].toUpperCase() : undefined;
		const rest = (m[3] ?? '').trim();
		const out: { target: string; scope?: string; rest: string } = { target, rest };
		if (scope !== undefined) { out.scope = scope; }
		return out;
	}

	private _mintRunId(): string {
		// Format: analyze-<timestamp>-<rand>. Avoid Date.now() vs Math.random()
		// readability issues by zero-padding the random suffix.
		const ts = Date.now().toString(36);
		const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
		return `analyze-${ts}-${rand}`;
	}

	override dispose(): void {
		this._activeHandle?.dispose();
		this._activeHandle = undefined;
		super.dispose();
	}
}
