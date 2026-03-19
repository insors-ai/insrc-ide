import * as vscode from 'vscode';
import { createDaemonManager, type DaemonManager, type DaemonStatus } from './daemon/lifecycle';
import { createStatusBar, type StatusBarManager } from './ui/statusBar';
import { InsrcTreeProvider, registerTreeCommands } from './ui/treeView';
import { ChatPanel } from './ui/chatPanel';
import { createDiffManager } from './ui/diffManager';
import { SetupWizard } from './ui/setupWizard';
import { SettingsPanel } from './ui/settingsPanel';
import { TestView } from './views/testView';
import { PlanView } from './views/planView';
import { DocView } from './views/docView';
import { BrainstormView } from './views/brainstormView';
import { createAnnotationManager } from './annotations/annotationManager';

// ---------------------------------------------------------------------------
// Extension state
// ---------------------------------------------------------------------------

let daemonManager: DaemonManager | null = null;
let statusBar: StatusBarManager | null = null;

// ---------------------------------------------------------------------------
// Extension lifecycle
// ---------------------------------------------------------------------------

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('insrc');
  outputChannel.appendLine('insrc extension activating...');

  // Initialize status bar
  statusBar = createStatusBar();
  context.subscriptions.push({ dispose: () => statusBar?.dispose() });

  // Initialize daemon manager
  daemonManager = createDaemonManager(outputChannel);

  // Auto-start daemon if configured
  const autoStart = vscode.workspace.getConfiguration('insrc.daemon').get<boolean>('autoStart', true);
  if (autoStart) {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'insrc: Starting daemon...',
        cancellable: false,
      },
      async () => {
        const started = await daemonManager!.ensureDaemon();
        if (started) {
          outputChannel.appendLine('daemon connected');
        } else {
          outputChannel.appendLine('daemon failed to start');
          vscode.window.showWarningMessage(
            'insrc daemon could not be started. Some features will be unavailable.',
            'Retry',
          ).then((action) => {
            if (action === 'Retry') {
              daemonManager?.ensureDaemon();
            }
          });
        }
      },
    );
  }

  // Initial status bar update
  if (autoStart) {
    const initialStatus = await daemonManager.getStatus();
    statusBar.update(initialStatus);
  }

  // Start health polling — updates both log and status bar
  daemonManager.startHealthPolling((status: DaemonStatus) => {
    outputChannel.appendLine(
      `health: running=${status.running} queue=${status.queueDepth ?? '?'} model=${status.modelPullStatus ?? '?'}`,
    );
    statusBar?.update(status);
  });

  // Register commands
  registerCommands(context, outputChannel);

  // Register TreeView with daemon-backed data
  const rpc = daemonManager.getClient();
  const treeProvider = new InsrcTreeProvider(rpc);
  const treeView = vscode.window.createTreeView('insrc.navigation', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);
  registerTreeCommands(context, treeProvider, rpc, outputChannel);

  // Diff manager (Segment 7) — inline diffs for agent proposals
  const diffManager = createDiffManager(context, outputChannel);
  context.subscriptions.push({ dispose: () => diffManager.dispose() });

  // Persist chat panel open/close state across IDE restarts
  ChatPanel.setGlobalState(context.globalState);

  // Restore chat panel if it was open when the IDE last closed
  if (ChatPanel.wasOpenLastSession()) {
    const panel = ChatPanel.show(context.extensionUri, rpc, outputChannel);
    panel.setDiffManager(diffManager);
  }

  // When the insrc sidebar becomes visible (user clicks activity bar icon),
  // auto-open the chat panel if not already open
  context.subscriptions.push(
    treeView.onDidChangeVisibility((e) => {
      if (e.visible && !ChatPanel.current()) {
        const panel = ChatPanel.show(context.extensionUri, rpc, outputChannel);
        panel.setDiffManager(diffManager);
      }
    }),
  );

  // Annotation manager (Segment 17)
  const annotationManager = createAnnotationManager(context, outputChannel);
  context.subscriptions.push({ dispose: () => annotationManager.dispose() });

  // Chat commands (Segment 5) — opens as editor tab on the right
  context.subscriptions.push(
    vscode.commands.registerCommand('insrc.openPanel', () => {
      const panel = ChatPanel.show(context.extensionUri, rpc, outputChannel);
      panel.setDiffManager(diffManager);
    }),
    vscode.commands.registerCommand('insrc.newSession', () => {
      const panel = ChatPanel.current();
      if (panel) {
        panel.newSession();
      } else {
        ChatPanel.show(context.extensionUri, rpc, outputChannel);
      }
    }),
  );

  // Setup wizard (Segment 8)
  const wizard = new SetupWizard(context.extensionUri, rpc, outputChannel);

  context.subscriptions.push(
    vscode.commands.registerCommand('insrc.openSetupWizard', () => {
      wizard.show();
    }),
    vscode.commands.registerCommand('insrc.openSettings', () => {
      SettingsPanel.show(context.extensionUri, rpc, outputChannel);
    }),
    vscode.commands.registerCommand('insrc.configSearch', () => {
      SettingsPanel.show(context.extensionUri, rpc, outputChannel);
    }),
    vscode.commands.registerCommand('insrc.conversationStats', async () => {
      try {
        const stats = await rpc.call<Record<string, unknown>>('conversation.stats', {});
        const lines = Object.entries(stats).map(([k, v]) => `${k}: ${v}`).join('\n');
        vscode.window.showInformationMessage(`Conversation Stats:\n${lines}`, { modal: true });
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to get stats: ${err}`);
      }
    }),
    vscode.commands.registerCommand('insrc.sendAnnotations', () => {
      if (annotationManager.count() === 0) {
        vscode.window.showInformationMessage('No annotations to send. Select code and press Ctrl+Shift+A to add one.');
        return;
      }
      const msg = annotationManager.compileForChat();
      const panel = ChatPanel.show(context.extensionUri, rpc, outputChannel);
      panel.setDiffManager(diffManager);
      // Send the compiled message via webview
      panel.sendCompiledMessage(msg);
      annotationManager.clearAll();
    }),
    vscode.commands.registerCommand('insrc.conversationCompact', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Compact conversation history? This merges old turns to save space.',
        { modal: true },
        'Compact',
      );
      if (confirm !== 'Compact') return;
      try {
        const result = await rpc.call<Record<string, unknown>>('conversation.compact', {});
        vscode.window.showInformationMessage(`Compaction done: ${JSON.stringify(result)}`);
        treeProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Compact failed: ${err}`);
      }
    }),
    vscode.commands.registerCommand('insrc.testRun', () => {
      TestView.show(context.extensionUri, rpc, outputChannel);
    }),
    vscode.commands.registerCommand('insrc.testPlan', () => {
      TestView.show(context.extensionUri, rpc, outputChannel);
    }),
    vscode.commands.registerCommand('insrc.openPlanView', () => {
      PlanView.show(context.extensionUri, rpc, outputChannel);
    }),
    vscode.commands.registerCommand('insrc.openDocView', () => {
      DocView.show(context.extensionUri, rpc, outputChannel);
    }),
    vscode.commands.registerCommand('insrc.openBrainstormView', () => {
      BrainstormView.show(context.extensionUri, rpc, outputChannel);
    }),
    vscode.commands.registerCommand('insrc.agentList', () => {
      // Refresh tree to show latest runs
      treeProvider.refresh();
    }),
    vscode.commands.registerCommand('insrc.agentResume', async (runId?: string) => {
      if (!runId) {
        vscode.window.showInformationMessage('Select a paused run from the navigation panel to resume.');
        return;
      }
      outputChannel.appendLine(`resuming agent run: ${runId}`);
      try {
        await rpc.call('agent.resume', { id: runId });
        // Open chat panel for the resumed session
        const panel = ChatPanel.show(context.extensionUri, rpc, outputChannel);
        panel.setDiffManager(diffManager);
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to resume: ${err}`);
      }
    }),
    vscode.commands.registerCommand('insrc.agentDiscard', async (node?: { kind: string; run?: { id: string } }) => {
      if (!node || node.kind !== 'run' || !node.run) return;
      const confirm = await vscode.window.showWarningMessage(
        `Discard this agent run? Checkpoint will be deleted.`,
        { modal: true },
        'Discard',
      );
      if (confirm !== 'Discard') return;
      try {
        await rpc.call('agent.discard', { id: node.run.id });
        treeProvider.refresh();
        vscode.window.showInformationMessage('Run discarded.');
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to discard: ${err}`);
      }
    }),
  );

  // Auto-trigger wizard on first activation if setup needed
  if (autoStart) {
    wizard.isSetupNeeded().then(needed => {
      if (needed) {
        outputChannel.appendLine('setup needed — opening wizard');
        wizard.show();
      }
    }).catch(() => { /* ignore — daemon may not be ready yet */ });
  }

  // Register daemon manager for cleanup
  context.subscriptions.push({ dispose: () => daemonManager?.dispose() });
  context.subscriptions.push(outputChannel);

  outputChannel.appendLine('insrc extension activated');
}

export function deactivate(): void {
  statusBar?.dispose();
  statusBar = null;
  daemonManager?.dispose();
  daemonManager = null;
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

function registerCommands(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel): void {
  // Daemon commands (functional in Segment 2)
  context.subscriptions.push(
    vscode.commands.registerCommand('insrc.restartDaemon', async () => {
      if (!daemonManager) return;
      outputChannel.appendLine('restarting daemon...');
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'insrc: Restarting daemon...',
          cancellable: false,
        },
        async () => {
          // Graceful stop (SIGTERM) + respawn
          const started = await daemonManager!.restart();
          if (started) {
            vscode.window.showInformationMessage('insrc daemon restarted');
            const newStatus = await daemonManager!.getStatus();
            statusBar?.update(newStatus);
            daemonManager!.startHealthPolling((status) => {
              outputChannel.appendLine(`health: running=${status.running}`);
              statusBar?.update(status);
            });
          } else {
            vscode.window.showErrorMessage('insrc daemon failed to restart');
          }
        },
      );
    }),
  );

  // Force restart — SIGKILL + respawn (for stuck indexer)
  context.subscriptions.push(
    vscode.commands.registerCommand('insrc.forceRestartDaemon', async () => {
      if (!daemonManager) return;
      outputChannel.appendLine('force restarting daemon (SIGKILL)...');
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'insrc: Force restarting daemon...',
          cancellable: false,
        },
        async () => {
          const started = await daemonManager!.forceRestart();
          if (started) {
            vscode.window.showInformationMessage('insrc daemon force restarted');
            const newStatus = await daemonManager!.getStatus();
            statusBar?.update(newStatus);
          } else {
            vscode.window.showErrorMessage('insrc daemon failed to restart after force kill');
          }
        },
      );
    }),
  );

  // Permission mode toggle (functional in Segment 3)
  context.subscriptions.push(
    vscode.commands.registerCommand('insrc.togglePermissionMode', async () => {
      const config = vscode.workspace.getConfiguration('insrc.permissions');
      const current = config.get<string>('mode', 'validate');
      const options = ['validate', 'auto-accept', 'strict'];
      const picked = await vscode.window.showQuickPick(options, {
        placeHolder: `Current: ${current}. Select permission mode`,
      });
      if (picked && picked !== current) {
        await config.update('mode', picked, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`insrc permission mode: ${picked}`);
        // Re-query status to update status bar state
        if (daemonManager) {
          const status = await daemonManager.getStatus();
          statusBar?.update(status);
        }
      }
    }),
  );

  // Show daemon logs (functional in Segment 3)
  context.subscriptions.push(
    vscode.commands.registerCommand('insrc.showLogs', () => {
      outputChannel.show(true);
    }),
  );

  // Placeholder commands (future segments)
  const placeholders: Array<[string, string]> = [
    ['insrc.showCost', 'Cost display coming in Segment 6'],
  ];

  for (const [command, message] of placeholders) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, () => {
        vscode.window.showInformationMessage(`insrc: ${message}`);
      }),
    );
  }
}

