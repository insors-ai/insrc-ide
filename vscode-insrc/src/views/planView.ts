/**
 * Plan tracker — kanban-style WebviewPanel for plan/delegate agent steps.
 *
 * Columns: Pending, In Progress, Done, Failed, Skipped.
 * Step cards with title, description, dependencies, effort.
 * Active step highlighted with pulsing border.
 * Real-time updates as step status changes arrive from daemon.
 */

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RpcClient } from '../daemon/rpc';

export interface PlanStep {
  id: string;
  title: string;
  description?: string;
  dependencies?: string[];
  effort?: string;
  status: 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';
}

export class PlanView {
  private static instance: PlanView | null = null;
  private panel: vscode.WebviewPanel;
  private disposed = false;
  private actionCallback: ((action: string, stepId?: string) => void) | null = null;

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly rpc: RpcClient,
    private readonly outputChannel: vscode.OutputChannel,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'insrc.planView',
      'insrc Plan',
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
      stepId?: string;
    }) => {
      switch (msg.type) {
        case 'startNext':
          this.actionCallback?.('startNext');
          break;
        case 'skipStep':
          if (msg.stepId) this.actionCallback?.('skip', msg.stepId);
          break;
        case 'viewFullPlan':
          this.actionCallback?.('viewFull');
          break;
      }
    });

    this.panel.onDidDispose(() => {
      this.disposed = true;
      PlanView.instance = null;
    });
  }

  // ---------------------------------------------------------------------------
  // Singleton
  // ---------------------------------------------------------------------------

  static show(
    extensionUri: vscode.Uri,
    rpc: RpcClient,
    outputChannel: vscode.OutputChannel,
  ): PlanView {
    if (PlanView.instance && !PlanView.instance.disposed) {
      PlanView.instance.panel.reveal(vscode.ViewColumn.Beside);
      return PlanView.instance;
    }
    PlanView.instance = new PlanView(extensionUri, rpc, outputChannel);
    return PlanView.instance;
  }

  static current(): PlanView | null {
    return PlanView.instance && !PlanView.instance.disposed ? PlanView.instance : null;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Set the full plan with steps. */
  setPlan(title: string, steps: PlanStep[], activeStepId?: string): void {
    this.post({ type: 'setPlan', title, steps, activeStepId });
  }

  /** Update a single step's status. */
  updateStep(stepId: string, status: PlanStep['status']): void {
    this.post({ type: 'updateStep', stepId, status });
  }

  /** Set the currently active (executing) step. */
  setActiveStep(stepId: string): void {
    this.post({ type: 'setActiveStep', stepId });
  }

  /** Register callback for toolbar actions. */
  onAction(cb: (action: string, stepId?: string) => void): void {
    this.actionCallback = cb;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private post(msg: Record<string, unknown>): void {
    if (!this.disposed) this.panel.webview.postMessage(msg);
  }

  private getHtml(): string {
    const htmlPath = path.join(this.extensionUri.fsPath, 'src', 'webview', 'planView.html');
    try {
      return fs.readFileSync(htmlPath, 'utf-8');
    } catch {
      const distPath = path.join(this.extensionUri.fsPath, 'dist', 'webview', 'planView.html');
      try {
        return fs.readFileSync(distPath, 'utf-8');
      } catch {
        return '<html><body><p>Plan view failed to load.</p></body></html>';
      }
    }
  }
}
