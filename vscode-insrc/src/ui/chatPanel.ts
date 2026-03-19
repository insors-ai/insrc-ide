/**
 * Chat panel — WebviewPanel (editor tab) for the insrc chat interface.
 *
 * Opens in ViewColumn.Beside (right of current editor) so the layout is:
 *   <left: nav panel> <center: editor> <right: chat>
 *
 * Connects to daemon via streaming RPC (chat.start/send/reply/cancel/close).
 * Renders messages, streaming deltas, progress, gates, and errors.
 */

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RpcClient, StreamMessage } from '../daemon/rpc';
import type { DiffManager } from './diffManager';
import { parseDiffToFileDiffs } from './diffManager';

export class ChatPanel {
  private static instance: ChatPanel | null = null;
  private static globalState: vscode.Memento | null = null;
  private diffManager: DiffManager | null = null;

  private panel: vscode.WebviewPanel;
  private sessionId: string | null = null;
  private repoPath: string | null = null;
  private streaming = false;
  private disposed = false;
  private historyLoaded = false;

  /** Set the globalState memento for persisting panel open/close state. */
  static setGlobalState(state: vscode.Memento): void {
    ChatPanel.globalState = state;
  }

  /** Returns true if the chat panel was open when the IDE last closed. */
  static wasOpenLastSession(): boolean {
    return ChatPanel.globalState?.get<boolean>('insrc.chatPanelOpen', false) ?? false;
  }

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly rpc: RpcClient,
    private readonly outputChannel: vscode.OutputChannel,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'insrc.chat',
      'Chat',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      },
    );

    // Set icon
    const iconPath = vscode.Uri.joinPath(extensionUri, 'assets', 'icon-insrc.svg');
    this.panel.iconPath = iconPath;

    this.panel.webview.html = this.getHtml();

    // Pin the tab and lock the editor group so files don't open here
    vscode.commands.executeCommand('workbench.action.pinEditor');
    vscode.commands.executeCommand('workbench.action.lockEditorGroup');

    // Handle messages from webview
    this.panel.webview.onDidReceiveMessage(async (msg: {
      type: string;
      text?: string;
      intent?: string;
      files?: string[];
      gateId?: string;
      action?: string;
      feedback?: string;
      expanded?: boolean;
      sessionId?: string;
      repo?: string;
    }) => {
      switch (msg.type) {
        case 'send':
          if (msg.text) await this.sendMessage(msg.text, msg.intent, msg.files);
          break;
        case 'gateReply':
          if (msg.gateId && msg.action) {
            await this.replyToGate(msg.gateId, msg.action, msg.feedback);
          }
          break;
        case 'inject':
          if (msg.text && this.sessionId) {
            try {
              await this.rpc.call('chat.inject', { sessionId: this.sessionId, message: msg.text });
              this.postMessage({ type: 'addMessage', role: 'user', content: msg.text });
            } catch (err) {
              this.log(`inject failed: ${err}`);
            }
          }
          break;
        case 'cancel':
          await this.cancelAgent();
          break;
        case 'newSession':
          await this.newSession();
          break;
        case 'switchRepo':
          await this.switchRepo();
          break;
        case 'attachFile':
          await this.pickAndAttachFile();
          break;
        case 'getModelConfig':
          await this.sendModelConfig();
          break;
        case 'getRecentSessions':
          await this.sendRecentSessions(msg.expanded === true);
          break;
        case 'loadSession':
          if (msg.sessionId) await this.loadSessionById(msg.sessionId as string, msg.repo as string);
          break;
      }
    });

    // Clean up singleton on dispose
    this.panel.onDidDispose(() => {
      this.disposed = true;
      ChatPanel.instance = null;
      ChatPanel.globalState?.update('insrc.chatPanelOpen', false);
    });

    // Set initial repo and load prior chat history
    this.initRepo();
    this.loadChatHistoryOnOpen();
  }

  private async loadChatHistoryOnOpen(): Promise<void> {
    const repo = this.repoPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!repo) return;
    await this.loadChatHistory(repo);
    this.historyLoaded = true;
  }

  // ---------------------------------------------------------------------------
  // Singleton access
  // ---------------------------------------------------------------------------

  /** Show the chat panel. Creates it if needed, reveals if already open. */
  static show(
    extensionUri: vscode.Uri,
    rpc: RpcClient,
    outputChannel: vscode.OutputChannel,
  ): ChatPanel {
    if (ChatPanel.instance && !ChatPanel.instance.disposed) {
      ChatPanel.instance.panel.reveal();
      return ChatPanel.instance;
    }
    ChatPanel.instance = new ChatPanel(extensionUri, rpc, outputChannel);
    ChatPanel.globalState?.update('insrc.chatPanelOpen', true);
    return ChatPanel.instance;
  }

  /** Get the existing instance (if any). */
  static current(): ChatPanel | null {
    return ChatPanel.instance && !ChatPanel.instance.disposed ? ChatPanel.instance : null;
  }

  /** Set the diff manager for inline diff display. */
  setDiffManager(dm: DiffManager): void {
    this.diffManager = dm;
    dm.onAction((action, filePath, feedback) => {
      this.log(`diff action: ${action} on ${filePath}`);
      if (action === 'accept' || action === 'reject') {
        // Notify the chat that the gate was resolved
        this.postMessage({ type: 'showProgress', message: `${action === 'accept' ? 'Accepted' : 'Rejected'}: ${filePath.split('/').pop()}` });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Public methods
  // ---------------------------------------------------------------------------

  /** Start a new session. */
  /** Send a pre-compiled message (e.g. from annotations). */
  sendCompiledMessage(text: string): void {
    this.sendMessage(text);
  }

  async newSession(): Promise<void> {
    if (this.sessionId) {
      try {
        await this.rpc.call('chat.close', { sessionId: this.sessionId });
      } catch { /* ignore */ }
      this.sessionId = null;
    }
    this.postMessage({ type: 'clearMessages' });
    this.historyLoaded = false;
    this.log('new session requested');
  }

  // ---------------------------------------------------------------------------
  // Message flow
  // ---------------------------------------------------------------------------

  private async sendMessage(text: string, intent?: string, files?: string[]): Promise<void> {
    if (this.streaming) return;

    // Handle /keys commands locally
    if (text.startsWith('/keys ')) {
      await this.handleKeysCommand(text);
      return;
    }

    // Lazy session init
    if (!this.sessionId) {
      await this.ensureSession();
      if (!this.sessionId) return;
    }

    // Show user message (with attachment names if any)
    const displayText = files && files.length > 0
      ? `${text}\n📎 ${files.map(f => f.split('/').pop()).join(', ')}`
      : text;
    this.postMessage({ type: 'addMessage', role: 'user', content: displayText });

    // Start assistant message container
    this.postMessage({ type: 'startAssistant' });
    this.streaming = true;

    const params: Record<string, unknown> = { sessionId: this.sessionId, message: text };
    if (intent) params.intent = intent;
    if (files && files.length > 0) params.files = files;

    try {
      await this.rpc.callStream(
        'chat.send',
        params,
        (msg: StreamMessage) => this.handleStreamMessage(msg),
      );
    } catch (err) {
      const errStr = String(err);
      // Auto-recover from stale session (e.g., daemon was restarted)
      if (errStr.includes('session not found') || errStr.includes('session expired')) {
        this.log('session lost — creating new session and retrying');
        this.sessionId = null;
        await this.ensureSession();
        if (this.sessionId) {
          params.sessionId = this.sessionId;
          try {
            await this.rpc.callStream(
              'chat.send',
              params,
              (msg: StreamMessage) => this.handleStreamMessage(msg),
            );
          } catch (retryErr) {
            this.postMessage({ type: 'showError', error: String(retryErr) });
            this.log(`retry error: ${retryErr}`);
          }
        } else {
          this.postMessage({ type: 'showError', error: 'Failed to create new session after daemon restart.' });
        }
      } else {
        this.postMessage({ type: 'showError', error: errStr });
        this.log(`send error: ${err}`);
      }
    } finally {
      this.streaming = false;
      this.postMessage({ type: 'finishMessage' });
    }
  }

  private handleStreamMessage(msg: StreamMessage): void {
    const data = msg.data as Record<string, unknown>;

    switch (msg.stream) {
      case 'delta':
        this.postMessage({
          type: 'appendDelta',
          text: (data['text'] as string) ?? '',
          format: (data['format'] as string) ?? undefined,
          replace: (data['replace'] as boolean) ?? false,
        });
        break;
      case 'progress': {
        const progressMsg = (data['message'] as string) ?? '';
        this.postMessage({ type: 'showProgress', message: progressMsg });
        // Detect intent classification from progress message
        if (progressMsg.startsWith('Intent: ')) {
          const intent = progressMsg.replace('Intent: ', '');
          this.postMessage({ type: 'showIntentBadge', intent });
        }
        break;
      }
      case 'tool':
        this.postMessage({ type: 'showToolBlock', data });
        break;
      case 'escalation':
        this.postMessage({ type: 'showEscalation', data });
        break;
      case 'gate':
        this.handleGate(data);
        break;
      case 'qna.update':
        this.postMessage({ type: 'updateQnA', entries: data['entries'] ?? [] });
        break;
      case 'checkpoint':
        this.log(`checkpoint: ${JSON.stringify(data)}`);
        break;
      case 'done':
        break;
      case 'error':
        this.postMessage({ type: 'showError', error: (data['error'] as string) ?? 'unknown error' });
        break;
    }
  }

  private handleGate(data: Record<string, unknown>): void {
    const content = (data['content'] as string) ?? '';
    const gateId = (data['gateId'] as string) ?? '';

    // Detect if this gate contains a diff (unified diff format)
    const hasDiff = content.includes('--- a/') || content.includes('+++ b/') || content.includes('@@');

    if (hasDiff && this.diffManager && this.repoPath) {
      // Open inline diff in editor
      const fileDiffs = parseDiffToFileDiffs(content, this.repoPath);
      if (fileDiffs.length > 0) {
        this.postMessage({ type: 'showProgress', message: `Opening ${fileDiffs.length} file diff(s)...` });
        this.diffManager.showDiffs(fileDiffs, gateId);

        // Wire diff actions back to the gate
        this.diffManager.onAction((action, _filePath, feedback) => {
          if (action === 'accept') {
            this.replyToGate(gateId, 'approve');
          } else if (action === 'reject') {
            this.replyToGate(gateId, 'reject');
          } else if (action === 'edit') {
            this.replyToGate(gateId, 'edit', feedback);
          }
        });
        return;
      }
    }

    // Fallback: show gate card in chat webview
    this.postMessage({ type: 'showGate', gateData: data });
  }

  private async replyToGate(gateId: string, action: string, feedback?: string): Promise<void> {
    if (!this.sessionId) return;

    try {
      await this.rpc.call('chat.reply', {
        sessionId: this.sessionId,
        gateId,
        action,
        feedback,
      });
      // Only resume streaming for continuing actions (approve, execute, edit/retry).
      // Terminal actions (reject, cancel, skip) will trigger stream:done which
      // the original callStream handler already consumes.
      const terminalActions = ['reject', 'cancel', 'skip', 'save', 'dismiss'];
      if (terminalActions.includes(action)) {
        // Immediately clear indicator — stream:done will also fire later via
        // the original callStream, but this ensures no stuck "Working..." state
        // even if the stream:done message is delayed or lost.
        this.streaming = false;
        this.postMessage({ type: 'finishMessage' });
      } else {
        this.postMessage({ type: 'startAssistant' });
        this.streaming = true;
      }
    } catch (err) {
      this.postMessage({ type: 'showError', error: `Gate reply failed: ${err}` });
    }
  }

  private async cancelAgent(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await this.rpc.call('chat.cancel', { sessionId: this.sessionId });
    } catch (err) {
      this.log(`cancel error: ${err}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Session management
  // ---------------------------------------------------------------------------

  private async ensureSession(): Promise<void> {
    if (this.sessionId) return;

    const repo = this.repoPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!repo) {
      this.postMessage({ type: 'showError', error: 'No workspace folder open. Open a folder first.' });
      return;
    }

    try {
      const result = await this.rpc.call<{ sessionId: string; repo: string }>('chat.start', { repo });
      this.sessionId = result.sessionId;
      this.repoPath = result.repo;
      this.log(`session created: ${this.sessionId}`);

      // Load prior chat history from DB (skip if already loaded on panel open)
      if (!this.historyLoaded) {
        await this.loadChatHistory(repo);
        this.historyLoaded = true;
      }
    } catch (err) {
      this.postMessage({ type: 'showError', error: `Failed to start session: ${err}` });
    }
  }

  private async loadChatHistory(repo: string): Promise<void> {
    try {
      const turns = await this.rpc.call<Array<{
        user: string;
        assistant: string;
        createdAt?: string;
        type?: string;
        format?: string;
      }>>('session.history', { repo, limit: 50 });

      if (turns.length === 0) return;

      this.log(`loading ${turns.length} prior turns`);

      for (const turn of turns) {
        // Skip non-turn entries (summaries, merged)
        if (turn.type && turn.type !== 'turn') continue;

        if (turn.user) {
          this.postMessage({ type: 'addMessage', role: 'user', content: turn.user });
        }
        if (turn.assistant) {
          this.postMessage({ type: 'addMessage', role: 'assistant', content: turn.assistant, format: turn.format });
        }
      }
    } catch (err) {
      // Non-fatal — just start with empty chat
      this.log(`failed to load chat history: ${err}`);
    }
  }

  private initRepo(): void {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) {
      this.repoPath = folder.uri.fsPath;
      this.postMessage({ type: 'setRepo', name: folder.name });
    } else {
      this.postMessage({ type: 'setRepo', name: 'no folder' });
    }
  }

  private async switchRepo(): Promise<void> {
    try {
      const repos = await this.rpc.call<Array<{ path: string; name: string }>>('repo.list');
      if (repos.length === 0) {
        vscode.window.showInformationMessage('No repos indexed. Add one first.');
        return;
      }

      const items = repos.map(r => ({ label: r.name, description: r.path, path: r.path }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a repo to switch to',
      });

      if (picked) {
        if (this.sessionId) {
          try { await this.rpc.call('chat.close', { sessionId: this.sessionId }); } catch { /* ok */ }
          this.sessionId = null;
        }
        this.repoPath = picked.path;
        this.postMessage({ type: 'setRepo', name: picked.label });
        this.log(`switched to repo: ${picked.path}`);
      }
    } catch (err) {
      this.log(`switchRepo error: ${err}`);
    }
  }

  // ---------------------------------------------------------------------------
  // File attachment
  // ---------------------------------------------------------------------------

  private async pickAndAttachFile(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: 'Attach',
      title: 'Select files to attach to message',
    });
    if (!uris || uris.length === 0) return;

    for (const uri of uris) {
      const name = uri.fsPath.split('/').pop() ?? uri.fsPath;
      this.postMessage({ type: 'addAttachment', name, path: uri.fsPath });
    }
  }

  // ---------------------------------------------------------------------------
  // Key management (via /keys chat command)
  // ---------------------------------------------------------------------------

  private async handleKeysCommand(text: string): Promise<void> {
    const parts = text.replace('/keys ', '').trim().split(/\s+/);
    const action = parts[0] ?? '';
    const name = parts[1] ?? '';

    this.postMessage({ type: 'addMessage', role: 'user', content: text });

    try {
      switch (action) {
        case 'list': {
          const entries = await this.rpc.call<Array<{ name: string; masked: string }>>('keys.list');
          if (entries.length === 0) {
            this.postMessage({ type: 'addMessage', role: 'assistant', content: 'No keys stored.' });
          } else {
            const lines = entries.map(e => `  ${e.name}: ${e.masked}`).join('\n');
            this.postMessage({ type: 'addMessage', role: 'assistant', content: `Stored keys:\n${lines}` });
          }
          break;
        }
        case 'set': {
          if (!name) {
            this.postMessage({ type: 'addMessage', role: 'assistant', content: 'Usage: /keys set <name>' });
            return;
          }
          const value = await vscode.window.showInputBox({
            prompt: `Enter value for '${name}'`,
            password: true,
            placeHolder: 'Paste your API key or secret...',
          });
          if (!value) {
            this.postMessage({ type: 'addMessage', role: 'assistant', content: 'Cancelled.' });
            return;
          }
          await this.rpc.call('keys.set', { name, value });
          this.postMessage({ type: 'addMessage', role: 'assistant', content: `Key '${name}' saved to OS keychain.` });
          break;
        }
        case 'delete': {
          if (!name) {
            this.postMessage({ type: 'addMessage', role: 'assistant', content: 'Usage: /keys delete <name>' });
            return;
          }
          await this.rpc.call('keys.delete', { name });
          this.postMessage({ type: 'addMessage', role: 'assistant', content: `Key '${name}' deleted.` });
          break;
        }
        default:
          this.postMessage({ type: 'addMessage', role: 'assistant', content: 'Usage: /keys list | /keys set <name> | /keys delete <name>' });
      }
    } catch (err) {
      this.postMessage({ type: 'showError', error: `Keys command failed: ${err}` });
    }
  }

  // ---------------------------------------------------------------------------
  // Model config display
  // ---------------------------------------------------------------------------

  private async sendRecentSessions(expanded: boolean): Promise<void> {
    try {
      const repo = this.repoPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const limit = expanded ? 32 : 5;
      const sessions = await this.rpc.call<Array<{
        id: string;
        repo: string;
        summary: string;
        createdAt: string;
      }>>('session.list', { repo, limit });

      this.postMessage({
        type: 'setRecentSessions',
        sessions,
        hasMore: !expanded && sessions.length >= 5,
      });
    } catch (err) {
      this.log(`failed to load recent sessions: ${err}`);
      this.postMessage({ type: 'setRecentSessions', sessions: [], hasMore: false });
    }
  }

  private async loadSessionById(sessionId: string, repo: string): Promise<void> {
    // Close current session
    if (this.sessionId) {
      try { await this.rpc.call('chat.close', { sessionId: this.sessionId }); } catch { /* ok */ }
    }

    // Load the selected session's history
    this.sessionId = null;
    this.repoPath = repo || this.repoPath;

    // Clear chat and load turns for the selected session
    this.postMessage({ type: 'clearMessages' });

    try {
      const turns = await this.rpc.call<Array<{
        user: string;
        assistant: string;
        createdAt?: string;
        type?: string;
        format?: string;
      }>>('session.history', { sessionId, limit: 50 });

      for (const turn of turns) {
        if (turn.type && turn.type !== 'turn') continue;
        if (turn.user) {
          this.postMessage({ type: 'addMessage', role: 'user', content: turn.user });
        }
        if (turn.assistant) {
          this.postMessage({ type: 'addMessage', role: 'assistant', content: turn.assistant, format: turn.format });
        }
      }

      this.log(`loaded session ${sessionId} with ${turns.length} turns`);
    } catch (err) {
      this.log(`failed to load session ${sessionId}: ${err}`);
    }

    // Create a new daemon session for new messages (old session is read-only)
    await this.ensureSession();
  }

  private async sendModelConfig(): Promise<void> {
    try {
      const configRaw = await this.rpc.call<Record<string, unknown>>('config.show');
      const models = (configRaw['models'] ?? {}) as Record<string, unknown>;
      const tiers = (models['tiers'] ?? {}) as Record<string, string>;
      const context = (models['context'] ?? {}) as Record<string, unknown>;

      this.postMessage({
        type: 'setModelConfig',
        config: {
          local: models['local'] ?? '—',
          embedding: models['embedding'] ?? '—',
          contextWindow: context['local'] ? `${context['local']} tokens` : '—',
          fast: tiers['fast'] ?? '—',
          standard: tiers['standard'] ?? '—',
          powerful: tiers['powerful'] ?? '—',
        },
      });
    } catch {
      // Fallback — read from VS Code settings
      const cfg = vscode.workspace.getConfiguration('insrc');
      this.postMessage({
        type: 'setModelConfig',
        config: {
          local: cfg.get('model.local', '—'),
          embedding: '—',
          contextWindow: '—',
          fast: cfg.get('model.tiers.fast', '—'),
          standard: cfg.get('model.tiers.standard', '—'),
          powerful: cfg.get('model.tiers.powerful', '—'),
        },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private postMessage(msg: Record<string, unknown>): void {
    if (!this.disposed) {
      this.panel.webview.postMessage(msg);
    }
  }

  private log(msg: string): void {
    this.outputChannel.appendLine(`[chat] ${msg}`);
  }

  private getHtml(): string {
    const htmlPath = path.join(this.extensionUri.fsPath, 'src', 'webview', 'chat.html');
    try {
      return fs.readFileSync(htmlPath, 'utf-8');
    } catch {
      const distPath = path.join(this.extensionUri.fsPath, 'dist', 'webview', 'chat.html');
      try {
        return fs.readFileSync(distPath, 'utf-8');
      } catch {
        return '<html><body><p>Chat panel failed to load.</p></body></html>';
      }
    }
  }
}
