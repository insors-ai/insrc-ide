/**
 * Document view — split panel for requirements/design documents.
 *
 * Top: rendered preview (MD or HTML). Bottom: raw editor (editable).
 * Live preview updates on edit. Revision history from agent responses.
 * Format toggle (MD/HTML). Swap button flips panes. Save to file.
 */

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RpcClient } from '../daemon/rpc';

export class DocView {
  private static instance: DocView | null = null;
  private panel: vscode.WebviewPanel;
  private disposed = false;
  private filePath: string | null = null;

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly rpc: RpcClient,
    private readonly outputChannel: vscode.OutputChannel,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'insrc.docView',
      'insrc Document',
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
      content?: string;
      format?: string;
    }) => {
      switch (msg.type) {
        case 'save':
          await this.handleSave(msg.content ?? '', msg.format ?? 'md');
          break;
      }
    });

    this.panel.onDidDispose(() => {
      this.disposed = true;
      DocView.instance = null;
    });
  }

  // ---------------------------------------------------------------------------
  // Singleton
  // ---------------------------------------------------------------------------

  static show(
    extensionUri: vscode.Uri,
    rpc: RpcClient,
    outputChannel: vscode.OutputChannel,
  ): DocView {
    if (DocView.instance && !DocView.instance.disposed) {
      DocView.instance.panel.reveal(vscode.ViewColumn.Beside);
      return DocView.instance;
    }
    DocView.instance = new DocView(extensionUri, rpc, outputChannel);
    return DocView.instance;
  }

  static current(): DocView | null {
    return DocView.instance && !DocView.instance.disposed ? DocView.instance : null;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Load a document with title, content, and format. */
  setDocument(title: string, content: string, format: 'md' | 'html', filePath?: string): void {
    this.filePath = filePath ?? null;
    this.panel.title = `insrc: ${title}`;
    this.post({ type: 'setDocument', title, content, format });
  }

  /** Append content (streaming from agent). */
  appendContent(content: string): void {
    this.post({ type: 'appendContent', content });
  }

  /** Add a named revision (each agent response). */
  addRevision(name: string, content: string, format?: 'md' | 'html'): void {
    this.post({ type: 'addRevision', name, content, format });
  }

  // ---------------------------------------------------------------------------
  // Save
  // ---------------------------------------------------------------------------

  private async handleSave(content: string, format: string): Promise<void> {
    const ext = format === 'html' ? '.html' : '.md';

    if (this.filePath) {
      // Save to existing path
      try {
        fs.writeFileSync(this.filePath, content, 'utf-8');
        this.post({ type: 'saved' });
        this.log(`saved: ${this.filePath}`);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to save: ${err}`);
      }
      return;
    }

    // Prompt for save location
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(
        path.join(
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.env['HOME'] ?? '',
          `document${ext}`,
        ),
      ),
      filters: format === 'html'
        ? { 'HTML': ['html'], 'All': ['*'] }
        : { 'Markdown': ['md'], 'All': ['*'] },
    });

    if (!uri) return;

    try {
      fs.writeFileSync(uri.fsPath, content, 'utf-8');
      this.filePath = uri.fsPath;
      this.post({ type: 'saved' });
      this.log(`saved: ${uri.fsPath}`);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to save: ${err}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private post(msg: Record<string, unknown>): void {
    if (!this.disposed) this.panel.webview.postMessage(msg);
  }

  private log(msg: string): void {
    this.outputChannel.appendLine(`[doc] ${msg}`);
  }

  private getHtml(): string {
    const htmlPath = path.join(this.extensionUri.fsPath, 'src', 'webview', 'docView.html');
    try {
      return fs.readFileSync(htmlPath, 'utf-8');
    } catch {
      const distPath = path.join(this.extensionUri.fsPath, 'dist', 'webview', 'docView.html');
      try {
        return fs.readFileSync(distPath, 'utf-8');
      } catch {
        return '<html><body><p>Document view failed to load.</p></body></html>';
      }
    }
  }
}
