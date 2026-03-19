/**
 * Brainstorm view — idea pool with theme clustering and live spec builder.
 *
 * Layout: ideas panel (left, 2/3) + spec panel (right, 1/3).
 * Ideas: cards with status badges, grouped by themes after converge.
 * Spec: builds incrementally as ideas are promoted.
 * Gate bar: actions for each brainstorm round gate.
 */

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RpcClient } from '../daemon/rpc';

export interface BrainstormIdea {
  id: string;
  title: string;
  description?: string;
  status: 'proposed' | 'accepted' | 'rejected' | 'parked' | 'promoted' | 'merged';
  theme?: string;
}

export interface BrainstormTheme {
  id: string;
  name: string;
}

export class BrainstormView {
  private static instance: BrainstormView | null = null;
  private panel: vscode.WebviewPanel;
  private disposed = false;
  private gateCallback: ((gateId: string, action: string) => void) | null = null;

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly rpc: RpcClient,
    private readonly outputChannel: vscode.OutputChannel,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'insrc.brainstormView',
      'insrc Brainstorm',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      },
    );

    const iconPath = vscode.Uri.joinPath(extensionUri, 'assets', 'icon-insrc.svg');
    this.panel.iconPath = iconPath;
    this.panel.webview.html = this.getHtml();

    vscode.commands.executeCommand('workbench.action.pinEditor');

    this.panel.webview.onDidReceiveMessage(async (msg: {
      type: string;
      gateId?: string;
      action?: string;
    }) => {
      if (msg.type === 'gateReply' && msg.gateId && msg.action) {
        this.gateCallback?.(msg.gateId, msg.action);
      }
    });

    this.panel.onDidDispose(() => {
      this.disposed = true;
      BrainstormView.instance = null;
    });
  }

  static show(
    extensionUri: vscode.Uri,
    rpc: RpcClient,
    outputChannel: vscode.OutputChannel,
  ): BrainstormView {
    if (BrainstormView.instance && !BrainstormView.instance.disposed) {
      BrainstormView.instance.panel.reveal(vscode.ViewColumn.Beside);
      return BrainstormView.instance;
    }
    BrainstormView.instance = new BrainstormView(extensionUri, rpc, outputChannel);
    return BrainstormView.instance;
  }

  static current(): BrainstormView | null {
    return BrainstormView.instance && !BrainstormView.instance.disposed ? BrainstormView.instance : null;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  setRound(round: number, mode: 'diverge' | 'converge' | 'promote'): void {
    this.post({ type: 'setRound', round, mode });
  }

  setIdeas(ideas: BrainstormIdea[], themes?: BrainstormTheme[]): void {
    this.post({ type: 'setIdeas', ideas, themes });
  }

  addIdea(idea: BrainstormIdea): void {
    this.post({ type: 'addIdea', idea });
  }

  updateIdea(id: string, updates: Partial<BrainstormIdea>): void {
    this.post({ type: 'updateIdea', id, updates });
  }

  setThemes(themes: BrainstormTheme[]): void {
    this.post({ type: 'setThemes', themes });
  }

  setSpec(content: string): void {
    this.post({ type: 'setSpec', content });
  }

  appendSpec(content: string): void {
    this.post({ type: 'appendSpec', content });
  }

  showGate(gateId: string, label: string, actions?: Array<{ name: string; label: string }>): void {
    this.post({ type: 'showGate', gateId, label, actions });
  }

  hideGate(): void {
    this.post({ type: 'hideGate' });
  }

  onGateReply(cb: (gateId: string, action: string) => void): void {
    this.gateCallback = cb;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private post(msg: Record<string, unknown>): void {
    if (!this.disposed) this.panel.webview.postMessage(msg);
  }

  private getHtml(): string {
    const htmlPath = path.join(this.extensionUri.fsPath, 'src', 'webview', 'brainstormView.html');
    try {
      return fs.readFileSync(htmlPath, 'utf-8');
    } catch {
      const distPath = path.join(this.extensionUri.fsPath, 'dist', 'webview', 'brainstormView.html');
      try {
        return fs.readFileSync(distPath, 'utf-8');
      } catch {
        return '<html><body><p>Brainstorm view failed to load.</p></body></html>';
      }
    }
  }
}
