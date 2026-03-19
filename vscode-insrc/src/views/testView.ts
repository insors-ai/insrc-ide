/**
 * Test view — WebviewPanel for the tester agent flow.
 *
 * Displays: test plan with gate actions, per-file progress with
 * status badges and failure classification, fix loop counter,
 * Claude escalation indicator, impl bug gate, and test report.
 *
 * Receives stream messages from the chat panel when the tester
 * agent is running, and relays gate replies back.
 */

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RpcClient } from '../daemon/rpc';

export class TestView {
  private static instance: TestView | null = null;
  private panel: vscode.WebviewPanel;
  private disposed = false;
  private gateCallback: ((gateId: string, action: string, data?: Record<string, unknown>) => void) | null = null;

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly rpc: RpcClient,
    private readonly outputChannel: vscode.OutputChannel,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'insrc.testView',
      'insrc Tests',
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

    // Pin tab
    vscode.commands.executeCommand('workbench.action.pinEditor');

    this.panel.webview.onDidReceiveMessage(async (msg: {
      type: string;
      gateId?: string;
      action?: string;
      file?: string;
    }) => {
      switch (msg.type) {
        case 'gateReply':
          if (msg.gateId && msg.action) {
            this.gateCallback?.(msg.gateId, msg.action);
          }
          break;
        case 'implBugAction':
          if (msg.gateId && msg.file && msg.action) {
            this.gateCallback?.(msg.gateId, msg.action, { file: msg.file });
          }
          break;
      }
    });

    this.panel.onDidDispose(() => {
      this.disposed = true;
      TestView.instance = null;
    });
  }

  // ---------------------------------------------------------------------------
  // Singleton
  // ---------------------------------------------------------------------------

  static show(
    extensionUri: vscode.Uri,
    rpc: RpcClient,
    outputChannel: vscode.OutputChannel,
  ): TestView {
    if (TestView.instance && !TestView.instance.disposed) {
      TestView.instance.panel.reveal(vscode.ViewColumn.Beside);
      return TestView.instance;
    }
    TestView.instance = new TestView(extensionUri, rpc, outputChannel);
    return TestView.instance;
  }

  static current(): TestView | null {
    return TestView.instance && !TestView.instance.disposed ? TestView.instance : null;
  }

  // ---------------------------------------------------------------------------
  // Public API — called by chat panel when tester agent sends stream messages
  // ---------------------------------------------------------------------------

  /** Set the test plan (from agent's generate-test-plan step). */
  setPlan(plan: {
    entries: Array<{
      name: string;
      description?: string;
      scenarios?: string[];
      fixtures?: string[];
      priority?: string;
    }>;
    files?: string[];
  }): void {
    this.post({ type: 'setPlan', plan });
  }

  /** Show the plan approval gate. */
  showPlanGate(gateId: string, actions?: Array<{ name: string; label: string }>): void {
    this.post({
      type: 'setPlanGate',
      gateId,
      actions: actions ?? [
        { name: 'approve', label: 'Approve' },
        { name: 'approve-review', label: 'Approve with Review' },
        { name: 'edit', label: 'Edit Plan' },
        { name: 'reject', label: 'Reject' },
      ],
    });
  }

  /** Update a file's test status. */
  updateFile(
    file: string,
    status: 'pending' | 'written' | 'passing' | 'failing' | 'impl-bug' | 'skipped',
    classification?: 'test_issue' | 'implementation_bug' | 'setup_issue',
    fixLoop?: number,
    escalated?: boolean,
  ): void {
    this.post({ type: 'updateFile', file, status, classification, fixLoop, escalated });
  }

  /** Show the implementation bug gate with batch list. */
  showImplBugGate(
    bugs: Array<{ file: string; error?: string }>,
    gateId: string,
  ): void {
    this.post({ type: 'setImplBugGate', bugs, gateId });
  }

  /** Show the test report summary. */
  showReport(report: {
    total: number;
    passing: number;
    failing: number;
    implBugs: number;
    skipped: number;
    duration: string;
    coverage?: string;
    allPassing: boolean;
  }): void {
    this.post({ type: 'setReport', report });
  }

  /** Set the overall status badge. */
  setStatus(status: 'running' | 'done' | 'failed'): void {
    this.post({ type: 'setStatus', status });
  }

  /** Register callback for gate replies from the webview. */
  onGateReply(cb: (gateId: string, action: string, data?: Record<string, unknown>) => void): void {
    this.gateCallback = cb;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private post(msg: Record<string, unknown>): void {
    if (!this.disposed) this.panel.webview.postMessage(msg);
  }

  private getHtml(): string {
    const htmlPath = path.join(this.extensionUri.fsPath, 'src', 'webview', 'testView.html');
    try {
      return fs.readFileSync(htmlPath, 'utf-8');
    } catch {
      const distPath = path.join(this.extensionUri.fsPath, 'dist', 'webview', 'testView.html');
      try {
        return fs.readFileSync(distPath, 'utf-8');
      } catch {
        return '<html><body><p>Test view failed to load.</p></body></html>';
      }
    }
  }
}
