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
import { IInsrcConfigService } from '../../common/configService.js';
import type { IListVirtualDelegate } from '../../../../../base/browser/ui/list/list.js';
import type { ITreeRenderer, ITreeNode, IAsyncDataSource } from '../../../../../base/browser/ui/tree/tree.js';
import { WorkbenchAsyncDataTree } from '../../../../../platform/list/browser/listService.js';
import { FuzzyScore } from '../../../../../base/common/filters.js';

// ---------------------------------------------------------------------------
// Tree node types
// ---------------------------------------------------------------------------

type StepProvidersRoot = { kind: 'providersRoot' };
const PROVIDERS_ROOT: StepProvidersRoot = { kind: 'providersRoot' };

type StepProviderNode = AgentNode | StepNode;

interface AgentNode {
	readonly kind: 'agent';
	readonly name: string;
	readonly steps: Array<{ step: string; provider: string }>;
}

interface StepNode {
	readonly kind: 'step';
	readonly agentName: string;
	readonly step: string;
	readonly provider: string;
}

// ---------------------------------------------------------------------------
// Tree infrastructure
// ---------------------------------------------------------------------------

class StepProvidersDelegate implements IListVirtualDelegate<StepProviderNode> {
	getHeight(): number { return 22; }
	getTemplateId(element: StepProviderNode): string { return element.kind; }
}

// -- Agent renderer --

interface IAgentTemplateData { label: HTMLElement; count: HTMLElement }

class AgentRenderer implements ITreeRenderer<StepProviderNode, FuzzyScore, IAgentTemplateData> {
	readonly templateId = 'agent';

	renderTemplate(container: HTMLElement): IAgentTemplateData {
		const row = dom.append(container, dom.$('.insrc-agent-row'));
		row.style.display = 'flex';
		row.style.gap = '6px';
		row.style.padding = '0 8px';

		const label = dom.append(row, dom.$('.insrc-agent-label'));
		label.style.fontWeight = '600';
		label.style.fontSize = '12px';

		const count = dom.append(row, dom.$('.insrc-agent-count'));
		count.style.opacity = '0.5';
		count.style.fontSize = '11px';

		return { label, count };
	}

	renderElement(node: ITreeNode<StepProviderNode, FuzzyScore>, _index: number, data: IAgentTemplateData): void {
		if (node.element.kind === 'agent') {
			data.label.textContent = node.element.name;
			data.count.textContent = `(${node.element.steps.length} steps)`;
		}
	}

	disposeTemplate(): void { }
}

// -- Step renderer --

interface IStepTemplateData { stepName: HTMLElement; arrow: HTMLElement; provider: HTMLElement }

class StepRenderer implements ITreeRenderer<StepProviderNode, FuzzyScore, IStepTemplateData> {
	readonly templateId = 'step';

	renderTemplate(container: HTMLElement): IStepTemplateData {
		const row = dom.append(container, dom.$('.insrc-step-row'));
		row.style.display = 'flex';
		row.style.gap = '4px';
		row.style.padding = '0 8px 0 16px';
		row.style.fontSize = '12px';

		const stepName = dom.append(row, dom.$('.insrc-step-name'));

		const arrow = dom.append(row, dom.$('.insrc-step-arrow'));
		arrow.style.opacity = '0.4';

		const provider = dom.append(row, dom.$('.insrc-step-provider'));
		provider.style.fontStyle = 'italic';
		provider.style.opacity = '0.7';

		return { stepName, arrow, provider };
	}

	renderElement(node: ITreeNode<StepProviderNode, FuzzyScore>, _index: number, data: IStepTemplateData): void {
		if (node.element.kind === 'step') {
			data.stepName.textContent = node.element.step;
			data.arrow.textContent = '\u2192';
			data.provider.textContent = node.element.provider;
		}
	}

	disposeTemplate(): void { }
}

// -- Data source --

class StepProvidersDataSource implements IAsyncDataSource<StepProvidersRoot, StepProviderNode> {
	constructor(private readonly configService: IInsrcConfigService) { }

	hasChildren(element: StepProvidersRoot | StepProviderNode): boolean {
		if ((element as StepProvidersRoot).kind === 'providersRoot') {
			return true;
		}
		return (element as StepProviderNode).kind === 'agent';
	}

	async getChildren(element: StepProvidersRoot | StepProviderNode): Promise<StepProviderNode[]> {
		if ((element as StepProvidersRoot).kind === 'providersRoot') {
			try {
				const config = await this.configService.showConfig();
				const models = config?.['models'] as Record<string, unknown> | undefined;
				const agents = (models?.['agents'] ?? {}) as Record<string, Record<string, string>>;

				return Object.entries(agents).map(([name, steps]) => ({
					kind: 'agent' as const,
					name,
					steps: Object.entries(steps).map(([step, provider]) => ({ step, provider })),
				}));
			} catch {
				return [];
			}
		}

		const node = element as StepProviderNode;
		if (node.kind === 'agent') {
			return node.steps.map(s => ({
				kind: 'step' as const,
				agentName: node.name,
				step: s.step,
				provider: s.provider,
			}));
		}

		return [];
	}
}

// ---------------------------------------------------------------------------
// Step Providers ViewPane
// ---------------------------------------------------------------------------

export class InsrcStepProvidersViewPane extends ViewPane {

	private tree!: WorkbenchAsyncDataTree<StepProvidersRoot, StepProviderNode, FuzzyScore>;

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
		@IInsrcConfigService private readonly configService: IInsrcConfigService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, telemetryService, hoverService);

		this._register(this.daemonService.onDidChangeState(state => {
			if (state === 'connected') {
				this.tree?.setInput(PROVIDERS_ROOT);
			}
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		const treeContainer = dom.append(container, dom.$('.insrc-step-providers-tree'));

		this.tree = this.instantiationService.createInstance(
			WorkbenchAsyncDataTree<StepProvidersRoot, StepProviderNode, FuzzyScore>,
			'InsrcStepProviders',
			treeContainer,
			new StepProvidersDelegate(),
			[new AgentRenderer(), new StepRenderer()],
			new StepProvidersDataSource(this.configService),
			{
				identityProvider: {
					getId: (e: StepProviderNode) => {
						if (e.kind === 'agent') { return `agent:${e.name}`; }
						return `step:${e.agentName}:${e.step}`;
					},
				},
				accessibilityProvider: {
					getAriaLabel: (e: StepProviderNode) => {
						if (e.kind === 'agent') { return e.name; }
						return `${e.step} uses ${e.provider}`;
					},
					getWidgetAriaLabel: () => 'Step Providers',
				},
			}
		) as WorkbenchAsyncDataTree<StepProvidersRoot, StepProviderNode, FuzzyScore>;
		this._register(this.tree);

		if (this.daemonService.isConnected) {
			this.tree.setInput(PROVIDERS_ROOT);
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.tree?.layout(height, width);
	}
}
