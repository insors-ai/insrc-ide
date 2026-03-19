/**
 * TreeView navigation — repos and sessions backed by daemon RPC.
 *
 * Top level: repos from repo.list (not workspace folders).
 * Nested: sessions grouped by date (Today, Yesterday, This week, Older).
 * Context menu: re-index, remove repo.
 * "+ Add repo" via welcome view button → folder picker → repo.add RPC.
 */

import * as vscode from 'vscode';
import type { RpcClient } from '../daemon/rpc';

// ---------------------------------------------------------------------------
// Tree node types
// ---------------------------------------------------------------------------

interface RepoNode {
  kind: 'repo';
  path: string;
  name: string;
  status: string;
  lastIndexed?: string;
}

interface DateGroupNode {
  kind: 'dateGroup';
  label: string;
  repoPath: string;
  sessionIds: SessionInfo[];
}

interface SessionInfo {
  id: string;
  repo: string;
  summary: string;
  createdAt: string;
}

interface SessionNode {
  kind: 'session';
  session: SessionInfo;
}

interface RunsSectionNode {
  kind: 'runsSection';
}

interface RunNode {
  kind: 'run';
  run: RunInfo;
}

interface RunInfo {
  id: string;
  agent: string;       // 'pair' | 'delegate' | 'designer' | 'brainstorm' | 'planner' | 'tester'
  status: 'active' | 'paused' | 'crashed' | 'completed';
  step?: string;        // current step name
  repo?: string;
  createdAt: string;
  summary?: string;
}

interface TurnNode {
  kind: 'turn';
  turn: TurnInfo;
}

interface TurnInfo {
  sessionId: string;
  idx: number;
  user: string;
  assistant: string;
  type?: string;      // 'turn' | 'directive' | 'summary' | 'merged'
  tier?: string;      // 'hot' | 'warm' | 'cold' | 'archive'
  createdAt?: string;
}

interface ConversationStatsNode {
  kind: 'conversationStats';
}

type TreeNode = RepoNode | DateGroupNode | SessionNode | TurnNode | ConversationStatsNode | RunsSectionNode | RunNode;

// ---------------------------------------------------------------------------
// Date grouping helpers
// ---------------------------------------------------------------------------

function getDateGroup(createdAt: string): string {
  const now = new Date();
  const date = new Date(createdAt);
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0 && now.getDate() === date.getDate()) return 'Today';
  if (diffDays <= 1 && now.getDate() - date.getDate() === 1) return 'Yesterday';
  if (diffDays <= 7) return 'This week';
  return 'Older';
}

function groupSessionsByDate(sessions: SessionInfo[]): Map<string, SessionInfo[]> {
  const groups = new Map<string, SessionInfo[]>();
  const order = ['Today', 'Yesterday', 'This week', 'Older'];
  for (const label of order) {
    groups.set(label, []);
  }
  for (const s of sessions) {
    const group = getDateGroup(s.createdAt);
    groups.get(group)!.push(s);
  }
  // Remove empty groups
  for (const [key, val] of groups) {
    if (val.length === 0) groups.delete(key);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// TreeDataProvider
// ---------------------------------------------------------------------------

export class InsrcTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly rpc: RpcClient) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    switch (element.kind) {
      case 'repo':
        return this.repoItem(element);
      case 'dateGroup':
        return this.dateGroupItem(element);
      case 'session':
        return this.sessionItem(element);
      case 'turn':
        return this.turnItem(element);
      case 'conversationStats':
        return this.conversationStatsItem();
      case 'runsSection':
        return this.runsSectionItem();
      case 'run':
        return this.runItem(element);
    }
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    // Root: repos + stats + runs section
    if (!element) {
      const repos = await this.getRootNodes();
      return [...repos, { kind: 'conversationStats' as const }, { kind: 'runsSection' as const }];
    }

    // Under a repo: date groups
    if (element.kind === 'repo') {
      return this.getDateGroups(element.path);
    }

    // Under a date group: sessions
    if (element.kind === 'dateGroup') {
      return element.sessionIds.map(s => ({ kind: 'session' as const, session: s }));
    }

    // Under a session: list turns
    if (element.kind === 'session') {
      return this.getTurnNodes(element.session.id);
    }

    // Under conversation stats: nothing (leaf)
    if (element.kind === 'conversationStats') {
      return [];
    }

    // Under runs section: list agent runs
    if (element.kind === 'runsSection') {
      return this.getRunNodes();
    }

    return [];
  }

  // -------------------------------------------------------------------------
  // Data fetching
  // -------------------------------------------------------------------------

  private async getRootNodes(): Promise<RepoNode[]> {
    try {
      const repos = await this.rpc.call<Array<{
        path: string;
        name: string;
        status: string;
        lastIndexed?: string;
      }>>('repo.list');
      return repos.map(r => ({
        kind: 'repo' as const,
        path: r.path,
        name: r.name,
        status: r.status,
        lastIndexed: r.lastIndexed,
      }));
    } catch {
      return [];
    }
  }

  private async getDateGroups(repoPath: string): Promise<DateGroupNode[]> {
    try {
      const sessions = await this.rpc.call<SessionInfo[]>('session.list', { repo: repoPath });
      const grouped = groupSessionsByDate(sessions);
      const nodes: DateGroupNode[] = [];
      for (const [label, sessionsInGroup] of grouped) {
        nodes.push({
          kind: 'dateGroup',
          label,
          repoPath,
          sessionIds: sessionsInGroup,
        });
      }
      return nodes;
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Tree item rendering
  // -------------------------------------------------------------------------

  private repoItem(node: RepoNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
    item.contextValue = 'repo';
    item.description = node.status;
    item.tooltip = new vscode.MarkdownString(`**${node.path}**\n\nStatus: ${node.status}\n\nClick to open in Explorer`);

    // Click → open folder in VS Code Explorer
    item.command = {
      command: 'insrc.openRepoFolder',
      title: 'Open in Explorer',
      arguments: [node.path],
    };

    // Status icon
    switch (node.status) {
      case 'ready':
        item.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
        break;
      case 'indexing':
        item.iconPath = new vscode.ThemeIcon('sync~spin');
        item.description = 'indexing...';
        break;
      case 'stale':
        item.iconPath = new vscode.ThemeIcon('clock', new vscode.ThemeColor('editorWarning.foreground'));
        break;
      default:
        item.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('errorForeground'));
    }

    // Store path for context menu commands
    item.id = `repo:${node.path}`;
    return item;
  }

  private dateGroupItem(node: DateGroupNode): vscode.TreeItem {
    const count = node.sessionIds.length;
    const item = new vscode.TreeItem(
      `${node.label} (${count})`,
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.contextValue = 'dateGroup';
    item.iconPath = new vscode.ThemeIcon('calendar');
    return item;
  }

  private sessionItem(node: SessionNode): vscode.TreeItem {
    const s = node.session;
    const label = s.summary || `Session ${s.id.slice(0, 8)}`;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
    item.contextValue = 'session';
    item.iconPath = new vscode.ThemeIcon('comment-discussion');
    item.description = new Date(s.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    item.tooltip = new vscode.MarkdownString(
      `**${label}**\n\nRepo: \`${s.repo}\`\nCreated: ${s.createdAt}\nID: \`${s.id}\``,
    );

    // Click → open in chat panel (Segment 5 will implement the actual handler)
    item.command = {
      command: 'insrc.openPanel',
      title: 'Open Session',
      arguments: [s.id, s.repo],
    };

    item.id = `session:${s.id}`;
    return item;
  }

  private runsSectionItem(): vscode.TreeItem {
    const item = new vscode.TreeItem('Agent Runs', vscode.TreeItemCollapsibleState.Collapsed);
    item.contextValue = 'runsSection';
    item.iconPath = new vscode.ThemeIcon('rocket');
    item.id = 'runs-section';
    return item;
  }

  private runItem(node: RunNode): vscode.TreeItem {
    const r = node.run;
    const label = r.summary || `${r.agent} ${r.id.slice(0, 8)}`;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.contextValue = `run-${r.status}`;
    item.description = r.step ? `${r.status} — ${r.step}` : r.status;

    switch (r.status) {
      case 'active':
        item.iconPath = new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('editorWarning.foreground'));
        break;
      case 'paused':
        item.iconPath = new vscode.ThemeIcon('debug-pause', new vscode.ThemeColor('editorWarning.foreground'));
        break;
      case 'crashed':
        item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
        break;
      case 'completed':
        item.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
        break;
    }

    item.tooltip = new vscode.MarkdownString(
      `**${r.agent}** run\n\nStatus: ${r.status}${r.step ? `\nStep: ${r.step}` : ''}\nRepo: \`${r.repo ?? '?'}\`\nCreated: ${r.createdAt}\nID: \`${r.id}\``,
    );

    // Click → resume if paused, open view if active/completed
    if (r.status === 'paused' || r.status === 'crashed') {
      item.command = {
        command: 'insrc.agentResume',
        title: 'Resume Run',
        arguments: [r.id],
      };
    }

    item.id = `run:${r.id}`;
    return item;
  }

  private async getRunNodes(): Promise<RunNode[]> {
    try {
      const runs = await this.rpc.call<RunInfo[]>('agent.list');
      return runs.map(r => ({ kind: 'run' as const, run: r }));
    } catch {
      return [];
    }
  }

  private turnItem(node: TurnNode): vscode.TreeItem {
    const t = node.turn;
    const preview = (t.user || '').split('\n')[0]?.slice(0, 60) || `Turn ${t.idx}`;
    const item = new vscode.TreeItem(preview, vscode.TreeItemCollapsibleState.None);
    item.contextValue = 'turn';

    // Tier badge via description
    const tierLabel = t.tier ? ` [${t.tier}]` : '';
    item.description = (t.createdAt ? new Date(t.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '') + tierLabel;

    // Icon based on type
    if (t.type === 'directive') {
      item.iconPath = new vscode.ThemeIcon('pin', new vscode.ThemeColor('editorWarning.foreground'));
    } else if (t.type === 'summary') {
      item.iconPath = new vscode.ThemeIcon('note', new vscode.ThemeColor('descriptionForeground'));
    } else if (t.type === 'merged') {
      item.iconPath = new vscode.ThemeIcon('git-merge', new vscode.ThemeColor('descriptionForeground'));
    } else {
      // Regular turn — color by tier
      const tierColor = t.tier === 'hot' ? 'charts.blue' :
                        t.tier === 'warm' ? 'editorWarning.foreground' :
                        t.tier === 'cold' ? 'descriptionForeground' :
                        t.tier === 'archive' ? 'disabledForeground' : undefined;
      item.iconPath = new vscode.ThemeIcon('comment', tierColor ? new vscode.ThemeColor(tierColor) : undefined);
    }

    item.tooltip = new vscode.MarkdownString(
      `**User:** ${t.user.slice(0, 200)}\n\n**Assistant:** ${t.assistant.slice(0, 200)}${t.type ? `\n\nType: ${t.type}` : ''}${t.tier ? ` | Tier: ${t.tier}` : ''}`,
    );

    item.id = `turn:${t.sessionId}:${t.idx}`;
    return item;
  }

  private conversationStatsItem(): vscode.TreeItem {
    const item = new vscode.TreeItem('Conversation Stats', vscode.TreeItemCollapsibleState.None);
    item.contextValue = 'conversationStats';
    item.iconPath = new vscode.ThemeIcon('graph');
    item.command = {
      command: 'insrc.conversationStats',
      title: 'Show Conversation Stats',
    };
    item.id = 'conversation-stats';
    return item;
  }

  private async getTurnNodes(sessionId: string): Promise<TurnNode[]> {
    try {
      const turns = await this.rpc.call<TurnInfo[]>('session.history', { sessionId, limit: 30 });
      return turns.map(t => ({ kind: 'turn' as const, turn: t }));
    } catch {
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerTreeCommands(
  context: vscode.ExtensionContext,
  treeProvider: InsrcTreeProvider,
  rpc: RpcClient,
  outputChannel: vscode.OutputChannel,
): void {
  // Open repo folder in VS Code Explorer
  context.subscriptions.push(
    vscode.commands.registerCommand('insrc.openRepoFolder', async (repoPath: string) => {
      const uri = vscode.Uri.file(repoPath);
      const currentFolders = vscode.workspace.workspaceFolders ?? [];
      const alreadyOpen = currentFolders.some(f => f.uri.fsPath === repoPath);
      if (!alreadyOpen) {
        // Add as workspace folder (doesn't close current window)
        vscode.workspace.updateWorkspaceFolders(currentFolders.length, 0, { uri });
      }
      // Reveal in Explorer
      await vscode.commands.executeCommand('revealInExplorer', uri);
    }),
  );

  // Add repo — folder picker → repo.add RPC
  context.subscriptions.push(
    vscode.commands.registerCommand('insrc.addRepo', async () => {
      const folders = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: 'Add Repo',
        title: 'Select a repository to index',
      });
      if (!folders || folders.length === 0) return;

      const repoPath = folders[0].fsPath;
      outputChannel.appendLine(`adding repo: ${repoPath}`);
      try {
        await rpc.call('repo.add', { path: repoPath });
        vscode.window.showInformationMessage(`insrc: Added ${repoPath} for indexing`);
        treeProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`insrc: Failed to add repo — ${String(err)}`);
      }
    }),
  );

  // Re-index repo — context menu on repo node
  context.subscriptions.push(
    vscode.commands.registerCommand('insrc.reindex', async (node?: TreeNode) => {
      let repoPath: string | undefined;

      if (node && node.kind === 'repo') {
        repoPath = node.path;
      } else {
        // No context — try to use workspace folder
        const folder = vscode.workspace.workspaceFolders?.[0];
        repoPath = folder?.uri.fsPath;
      }

      if (!repoPath) {
        vscode.window.showWarningMessage('insrc: No repo selected for re-indexing');
        return;
      }

      outputChannel.appendLine(`re-indexing: ${repoPath}`);
      try {
        await rpc.call('repo.reindex', { path: repoPath });
        vscode.window.showInformationMessage(`insrc: Re-indexing ${repoPath}`);
        treeProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`insrc: Re-index failed — ${String(err)}`);
      }
    }),
  );

  // Remove repo — context menu on repo node
  context.subscriptions.push(
    vscode.commands.registerCommand('insrc.removeRepo', async (node?: TreeNode) => {
      if (!node || node.kind !== 'repo') return;

      const confirm = await vscode.window.showWarningMessage(
        `Remove ${node.name} from insrc index?`,
        { modal: true },
        'Remove',
      );
      if (confirm !== 'Remove') return;

      outputChannel.appendLine(`removing repo: ${node.path}`);
      try {
        await rpc.call('repo.remove', { path: node.path });
        vscode.window.showInformationMessage(`insrc: Removed ${node.name}`);
        treeProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`insrc: Remove failed — ${String(err)}`);
      }
    }),
  );

  // Refresh tree
  context.subscriptions.push(
    vscode.commands.registerCommand('insrc.refreshTree', () => {
      treeProvider.refresh();
    }),
  );
}
