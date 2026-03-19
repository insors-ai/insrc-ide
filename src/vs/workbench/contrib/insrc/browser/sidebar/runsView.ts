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
import type { IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import type { ITreeRenderer, ITreeNode, IAsyncDataSource } from '../../../../../base/browser/ui/tree/tree.js';
import { WorkbenchAsyncDataTree } from '../../../../../platform/list/browser/listService.js';
import { FuzzyScore } from '../../../../../base/common/filters.js';
import type { AgentRunInfo } from '../../common/agentRunService.js';

// ---------------------------------------------------------------------------
// Tree infrastructure
// ---------------------------------------------------------------------------

type RunsRoot = { kind: 'runsRoot' };
const RUNS_ROOT: RunsRoot = { kind: 'runsRoot' };

interface AgentGroupNode {
	readonly kind: 'agentGroup';
	readonly agentType: string;
	readonly runs: AgentRunInfo[];
}

interface RunNode {
	readonly kind: 'run';
	readonly run: AgentRunInfo;
}

type RunsTreeNode = AgentGroupNode | RunNode;

const STATUS_ICON: Record<string, string> = {
	active: '\u25B6',       // play triangle
	paused: '\u275A\u275A', // double bar
	crashed: '\u2716',      // heavy X
	completed: '\u2714',    // check
};

function getAgentType(run: AgentRunInfo): string {
	// Parse from ID prefix (e.g. "brainstorm-1773761128644" -> "brainstorm")
	const dashIdx = run.id.indexOf('-');
	if (dashIdx > 0) {
		return run.id.substring(0, dashIdx);
	}
	return run.agent || 'unknown';
}

class RunsDelegate implements IListVirtualDelegate<RunsTreeNode> {
	getHeight(): number { return 22; }
	getTemplateId(element: RunsTreeNode): string { return element.kind === 'agentGroup' ? 'agentGroup' : 'run'; }
}

// -- Agent group renderer --

interface IAgentGroupTemplateData { label: HTMLElement; count: HTMLElement }

class AgentGroupRenderer implements ITreeRenderer<RunsTreeNode, FuzzyScore, IAgentGroupTemplateData> {
	readonly templateId = 'agentGroup';

	renderTemplate(container: HTMLElement): IAgentGroupTemplateData {
		const row = dom.append(container, dom.$('.insrc-agent-group-row'));
		row.style.display = 'flex';
		row.style.gap = '6px';
		row.style.padding = '0 8px';

		const label = dom.append(row, dom.$('.insrc-agent-group-label'));
		label.style.fontWeight = '600';
		label.style.fontSize = '12px';
		label.style.textTransform = 'capitalize';

		const count = dom.append(row, dom.$('.insrc-agent-group-count'));
		count.style.opacity = '0.5';
		count.style.fontSize = '11px';

		return { label, count };
	}

	renderElement(node: ITreeNode<RunsTreeNode, FuzzyScore>, _index: number, data: IAgentGroupTemplateData): void {
		if (node.element.kind === 'agentGroup') {
			data.label.textContent = node.element.agentType;
			data.count.textContent = `(${node.element.runs.length})`;
		}
	}

	disposeTemplate(): void { }
}

// -- Run renderer --

interface IRunTemplateData { icon: HTMLElement; label: HTMLElement; status: HTMLElement }

class RunRenderer implements ITreeRenderer<RunsTreeNode, FuzzyScore, IRunTemplateData> {
	readonly templateId = 'run';

	renderTemplate(container: HTMLElement): IRunTemplateData {
		const row = dom.append(container, dom.$('.insrc-run-row'));
		row.style.display = 'flex';
		row.style.gap = '6px';
		row.style.padding = '0 8px';
		row.style.alignItems = 'center';

		const icon = dom.append(row, dom.$('.insrc-run-icon'));
		icon.style.flexShrink = '0';
		icon.style.width = '16px';
		icon.style.textAlign = 'center';
		icon.style.fontSize = '11px';

		const label = dom.append(row, dom.$('.insrc-run-label'));
		label.style.overflow = 'hidden';
		label.style.textOverflow = 'ellipsis';
		label.style.whiteSpace = 'nowrap';
		label.style.flex = '1';
		label.style.fontSize = '12px';

		const status = dom.append(row, dom.$('.insrc-run-status'));
		status.style.flexShrink = '0';
		status.style.opacity = '0.6';
		status.style.fontSize = '11px';

		return { icon, label, status };
	}

	renderElement(node: ITreeNode<RunsTreeNode, FuzzyScore>, _index: number, data: IRunTemplateData): void {
		if (node.element.kind !== 'run') { return; }
		const run = node.element.run;
		const statusStr = run.status || 'unknown';
		data.icon.textContent = STATUS_ICON[statusStr] ?? '?';

		// Color the icon by status
		if (statusStr === 'active') {
			data.icon.style.color = 'var(--vscode-testing-iconPassed)';
		} else if (statusStr === 'paused') {
			data.icon.style.color = 'var(--vscode-editorWarning-foreground)';
		} else if (statusStr === 'crashed') {
			data.icon.style.color = 'var(--vscode-errorForeground)';
		} else {
			data.icon.style.color = 'var(--vscode-descriptionForeground)';
		}

		// Agent name from ID prefix (e.g. "brainstorm-1773761128644" -> "brainstorm")
		const agentName = run.id.split('-')[0] || run.agent || 'unknown';
		const step = run.step ? ` \u2014 ${run.step}` : '';
		data.label.textContent = `${agentName}${step}`;

		data.status.textContent = `[${statusStr}]`;
	}

	disposeTemplate(): void { }
}

// -- Data source --

class RunsDataSource implements IAsyncDataSource<RunsRoot, RunsTreeNode> {
	constructor(private readonly daemonService: IInsrcDaemonService) { }

	hasChildren(element: RunsRoot | RunsTreeNode): boolean {
		if ((element as RunsRoot).kind === 'runsRoot') { return true; }
		return (element as RunsTreeNode).kind === 'agentGroup';
	}

	async getChildren(element: RunsRoot | RunsTreeNode): Promise<RunsTreeNode[]> {
		if ((element as RunsRoot).kind === 'runsRoot') {
			if (!this.daemonService.isConnected) {
				return [];
			}
			try {
				const runs = await this.daemonService.rpc<AgentRunInfo[]>('agent.list');
				if (!runs || runs.length === 0) {
					return [];
				}

				// Group by agent type
				const groups = new Map<string, AgentRunInfo[]>();
				for (const run of runs) {
					const type = getAgentType(run);
					if (!groups.has(type)) {
						groups.set(type, []);
					}
					groups.get(type)!.push(run);
				}

				return Array.from(groups.entries()).map(([agentType, agentRuns]) => ({
					kind: 'agentGroup' as const,
					agentType,
					runs: agentRuns,
				}));
			} catch {
				return [];
			}
		}

		const node = element as RunsTreeNode;
		if (node.kind === 'agentGroup') {
			return node.runs.map(r => ({ kind: 'run' as const, run: r }));
		}

		return [];
	}
}

// ---------------------------------------------------------------------------
// Runs ViewPane
// ---------------------------------------------------------------------------

export class InsrcRunsViewPane extends ViewPane {

	private tree!: WorkbenchAsyncDataTree<RunsRoot, RunsTreeNode, FuzzyScore>;

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
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, telemetryService, hoverService);

		this._register(this.daemonService.onDidChangeState(state => {
			if (state === 'connected') {
				this.tree?.setInput(RUNS_ROOT);
			}
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		const treeContainer = dom.append(container, dom.$('.insrc-runs-tree'));

		this.tree = this.instantiationService.createInstance(
			WorkbenchAsyncDataTree<RunsRoot, RunsTreeNode, FuzzyScore>,
			'InsrcRuns',
			treeContainer,
			new RunsDelegate(),
			[new AgentGroupRenderer(), new RunRenderer()],
			new RunsDataSource(this.daemonService),
			{
				identityProvider: {
					getId: (e: RunsTreeNode) => {
						if (e.kind === 'agentGroup') { return `group:${e.agentType}`; }
						return `run:${e.run.id}`;
					},
				},
				accessibilityProvider: {
					getAriaLabel: (e: RunsTreeNode) => {
						if (e.kind === 'agentGroup') { return `${e.agentType} (${e.runs.length} runs)`; }
						return `${e.run.agent} ${e.run.status}`;
					},
					getWidgetAriaLabel: () => 'Agent Runs',
				},
			}
		) as WorkbenchAsyncDataTree<RunsRoot, RunsTreeNode, FuzzyScore>;
		this._register(this.tree);

		if (this.daemonService.isConnected) {
			this.tree.setInput(RUNS_ROOT);
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.tree?.layout(height, width);
	}
}
