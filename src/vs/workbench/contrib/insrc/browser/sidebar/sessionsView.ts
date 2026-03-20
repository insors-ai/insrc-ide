/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { IViewPaneOptions, ViewPane } from '../../../../browser/parts/views/viewPane.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInsrcDaemonService } from '../../common/daemonService.js';
import { IInsrcChatService } from '../../common/chatService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import type { IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import type { ITreeRenderer, ITreeNode, IAsyncDataSource } from '../../../../../base/browser/ui/tree/tree.js';
import { IOpenEvent, WorkbenchAsyncDataTree } from '../../../../../platform/list/browser/listService.js';
import { FuzzyScore } from '../../../../../base/common/filters.js';
import { groupSessionsByRepo, groupSessionsByDate, getNodeId, type SessionInfo, type SessionsTreeNode } from './sessionsTreeNodes.js';

const INSRC_CHAT_VIEW_ID = 'insrc.chatView';

// ---------------------------------------------------------------------------
// Tree infrastructure
// ---------------------------------------------------------------------------

type SessionsRoot = { kind: 'root' };
const ROOT: SessionsRoot = { kind: 'root' };

class SessionsDelegate implements IListVirtualDelegate<SessionsTreeNode> {
	getHeight(): number { return 22; }
	getTemplateId(element: SessionsTreeNode): string {
		return element.kind;
	}
}

// -- Date group renderer --

interface IDateGroupTemplateData { label: HTMLElement }

class DateGroupRenderer implements ITreeRenderer<SessionsTreeNode, FuzzyScore, IDateGroupTemplateData> {
	readonly templateId = 'dateGroup';

	renderTemplate(container: HTMLElement): IDateGroupTemplateData {
		const row = dom.append(container, dom.$('.insrc-session-date-group'));
		row.style.display = 'flex';
		row.style.alignItems = 'center';
		row.style.gap = '4px';
		row.style.padding = '0 8px';

		const icon = dom.append(row, dom.$('.codicon.codicon-calendar'));
		icon.style.fontSize = '12px';
		icon.style.opacity = '0.6';

		const label = dom.append(row, dom.$('span'));
		label.style.fontWeight = '600';
		label.style.fontSize = '11px';
		label.style.textTransform = 'uppercase';
		label.style.letterSpacing = '0.5px';

		return { label };
	}

	renderElement(node: ITreeNode<SessionsTreeNode, FuzzyScore>, _index: number, data: IDateGroupTemplateData): void {
		if (node.element.kind === 'dateGroup') {
			data.label.textContent = node.element.label;
		}
	}

	disposeTemplate(): void { }
}

// -- Repo renderer --

interface IRepoTemplateData { row: HTMLElement; icon: HTMLElement; label: HTMLElement; chatBtn: HTMLElement }

class RepoRenderer implements ITreeRenderer<SessionsTreeNode, FuzzyScore, IRepoTemplateData> {
	readonly templateId = 'repo';

	constructor(private readonly _onChatClick: (repoPath: string) => void) { }

	renderTemplate(container: HTMLElement): IRepoTemplateData {
		const row = dom.append(container, dom.$('.insrc-session-repo-row'));
		row.style.display = 'flex';
		row.style.alignItems = 'center';
		row.style.padding = '0 8px';
		row.style.gap = '4px';

		const icon = dom.append(row, dom.$('.codicon.codicon-repo'));
		icon.style.fontSize = '14px';
		icon.style.opacity = '0.8';

		const label = dom.append(row, dom.$('.insrc-session-repo'));
		label.style.fontWeight = '600';
		label.style.fontSize = '12px';
		label.style.flex = '1';

		const chatBtn = dom.append(row, dom.$('a.insrc-repo-chat-btn'));
		chatBtn.title = 'Open Chat';
		chatBtn.style.cursor = 'pointer';
		chatBtn.style.display = 'inline-flex';
		chatBtn.style.alignItems = 'center';
		chatBtn.style.justifyContent = 'center';
		chatBtn.style.width = '22px';
		chatBtn.style.height = '18px';
		chatBtn.style.marginLeft = '4px';
		chatBtn.style.borderRadius = '3px';
		chatBtn.style.border = 'none';
		chatBtn.style.background = 'none';

		const chatIcon = dom.append(chatBtn, dom.$('.codicon.codicon-comment-discussion'));
		chatIcon.style.fontSize = '13px';

		return { row, icon, label, chatBtn };
	}

	renderElement(node: ITreeNode<SessionsTreeNode, FuzzyScore>, _index: number, data: IRepoTemplateData): void {
		const el = node.element;
		if (el.kind === 'repo') {
			data.label.textContent = el.repoName;
			const repoPath = el.repoPath;
			data.chatBtn.onclick = (e) => {
				e.stopPropagation();
				this._onChatClick(repoPath);
			};
		}
	}

	disposeTemplate(): void { }
}

// -- Session renderer --

interface ISessionTemplateData { row: HTMLElement; icon: HTMLElement; time: HTMLElement; summary: HTMLElement }

class SessionRenderer implements ITreeRenderer<SessionsTreeNode, FuzzyScore, ISessionTemplateData> {
	readonly templateId = 'session';

	renderTemplate(container: HTMLElement): ISessionTemplateData {
		const row = dom.append(container, dom.$('.insrc-session-row'));
		row.style.display = 'flex';
		row.style.alignItems = 'center';
		row.style.gap = '4px';
		row.style.padding = '0 8px';
		row.style.overflow = 'hidden';

		const icon = dom.append(row, dom.$('.codicon.codicon-comment-discussion'));
		icon.style.fontSize = '13px';
		icon.style.opacity = '0.5';
		icon.style.flexShrink = '0';

		const time = dom.append(row, dom.$('.insrc-session-time'));
		time.style.flexShrink = '0';
		time.style.opacity = '0.6';
		time.style.fontSize = '11px';
		time.style.minWidth = '40px';

		const summary = dom.append(row, dom.$('.insrc-session-summary'));
		summary.style.overflow = 'hidden';
		summary.style.textOverflow = 'ellipsis';
		summary.style.whiteSpace = 'nowrap';
		summary.style.fontSize = '12px';
		summary.style.flex = '1';

		return { row, icon, time, summary };
	}

	renderElement(node: ITreeNode<SessionsTreeNode, FuzzyScore>, _index: number, data: ISessionTemplateData): void {
		if (node.element.kind === 'session') {
			const s = node.element.session;
			data.time.textContent = new Date(s.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
			data.summary.textContent = (s.summary || s.id).substring(0, 80);
			data.row.title = s.summary || s.id;
		}
	}

	disposeTemplate(): void { }
}

// -- Data source --

class SessionsDataSource implements IAsyncDataSource<SessionsRoot, SessionsTreeNode> {
	private _allSessions: SessionInfo[] = [];

	constructor(private readonly daemonService: IInsrcDaemonService) { }

	hasChildren(element: SessionsRoot | SessionsTreeNode): boolean {
		if ((element as SessionsRoot).kind === 'root') {
			return true;
		}
		const node = element as SessionsTreeNode;
		return node.kind === 'repo' || node.kind === 'dateGroup';
	}

	async getChildren(element: SessionsRoot | SessionsTreeNode): Promise<SessionsTreeNode[]> {
		if ((element as SessionsRoot).kind === 'root') {
			if (!this.daemonService.isConnected) {
				return [];
			}
			try {
				// Fetch sessions and repos in parallel
				const [sessions, repos] = await Promise.all([
					this.daemonService.rpc<SessionInfo[]>('session.list').catch(() => [] as SessionInfo[]),
					this.daemonService.rpc<Array<{ path: string; name: string }>>('repo.list').catch(() => []),
				]);
				this._allSessions = sessions || [];

				// Build repo nodes from sessions
				const repoNodes = groupSessionsByRepo(this._allSessions);
				const repoPathsWithSessions = new Set(repoNodes.map(r => r.repoPath));

				// Add repos that have no sessions
				for (const repo of repos) {
					if (!repoPathsWithSessions.has(repo.path)) {
						repoNodes.push({
							kind: 'repo',
							repoPath: repo.path,
							repoName: repo.name || repo.path.split('/').pop() || repo.path,
						});
					}
				}

				return repoNodes;
			} catch {
				return [];
			}
		}

		const node = element as SessionsTreeNode;
		if (node.kind === 'repo') {
			return groupSessionsByDate(this._allSessions, node.repoPath);
		}
		if (node.kind === 'dateGroup') {
			return node.sessions.map(s => ({ kind: 'session' as const, session: s }));
		}

		return [];
	}
}

// ---------------------------------------------------------------------------
// Sessions ViewPane
// ---------------------------------------------------------------------------

export class InsrcSessionsViewPane extends ViewPane {

	private tree!: WorkbenchAsyncDataTree<SessionsRoot, SessionsTreeNode, FuzzyScore>;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IHoverService hoverService: IHoverService,
		@IInsrcDaemonService private readonly daemonService: IInsrcDaemonService,
		@IInsrcChatService private readonly chatService: IInsrcChatService,
		@IViewsService private readonly viewsService: IViewsService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, telemetryService, hoverService);

		this._register(this.daemonService.onDidChangeState(state => {
			if (state === 'connected') {
				this.tree?.setInput(ROOT);
			}
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		const treeContainer = dom.append(container, dom.$('.insrc-sessions-tree'));

		this.tree = this.instantiationService.createInstance(
			WorkbenchAsyncDataTree<SessionsRoot, SessionsTreeNode, FuzzyScore>,
			'InsrcSessions',
			treeContainer,
			new SessionsDelegate(),
			[new RepoRenderer((repoPath) => this._openChatForRepo(repoPath)), new DateGroupRenderer(), new SessionRenderer()],
			new SessionsDataSource(this.daemonService),
			{
				identityProvider: { getId: (e: SessionsTreeNode) => getNodeId(e) },
				accessibilityProvider: {
					getAriaLabel: (e: SessionsTreeNode) => {
						if (e.kind === 'dateGroup') { return e.label; }
						if (e.kind === 'session') { return e.session.summary || e.session.id; }
						return '';
					},
					getWidgetAriaLabel: () => 'Sessions',
				},
			}
		) as WorkbenchAsyncDataTree<SessionsRoot, SessionsTreeNode, FuzzyScore>;
		this._register(this.tree);

		// Click on a session opens it in the chat panel
		this._register(this.tree.onDidOpen((e: IOpenEvent<SessionsTreeNode | undefined>) => {
			if (e.element?.kind === 'session') {
				this._openSessionInChat(e.element.session.id);
			}
		}));

		if (this.daemonService.isConnected) {
			this.tree.setInput(ROOT);
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.tree?.layout(height, width);
	}

	private async _openSessionInChat(sessionId: string): Promise<void> {
		try {
			await this.chatService.resumeSession(sessionId);
			await this.viewsService.openView(INSRC_CHAT_VIEW_ID, true);
		} catch {
			// ignore - chat view may not be available
		}
	}

	private async _openChatForRepo(repoPath: string): Promise<void> {
		try {
			await this.chatService.startSession(repoPath);
			await this.viewsService.openView(INSRC_CHAT_VIEW_ID, true);
		} catch {
			// ignore
		}
	}
}
