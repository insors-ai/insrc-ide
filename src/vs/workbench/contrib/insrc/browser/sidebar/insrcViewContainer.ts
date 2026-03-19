/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../../nls.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { ViewPaneContainer } from '../../../../browser/parts/views/viewPaneContainer.js';
import { Extensions as ViewContainerExtensions, IViewContainersRegistry, IViewsRegistry, IViewDescriptorService, ViewContainerLocation } from '../../../../common/views.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { KeyMod, KeyCode } from '../../../../../base/common/keyCodes.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { InsrcSessionsViewPane } from './sessionsView.js';
import { InsrcRunsViewPane } from './runsView.js';
import { InsrcStepProvidersViewPane } from './stepProvidersView.js';

// ---------------------------------------------------------------------------
// Icon
// ---------------------------------------------------------------------------

// TODO: Replace with custom insrc spiral icon once icon registration supports SVG URIs
const insrcViewIcon = registerIcon('insrc-view-icon', Codicon.symbolMisc, localize('insrcViewIcon', 'View icon of the insrc sidebar.'));

// ---------------------------------------------------------------------------
// ViewContainer ID
// ---------------------------------------------------------------------------

export const INSRC_VIEW_CONTAINER_ID = 'workbench.view.insrc';
export const INSRC_SESSIONS_VIEW_ID = 'insrc.sessions';
export const INSRC_RUNS_VIEW_ID = 'insrc.runs';
export const INSRC_STEP_PROVIDERS_VIEW_ID = 'insrc.stepProviders';

// ---------------------------------------------------------------------------
// ViewPaneContainer
// ---------------------------------------------------------------------------

export class InsrcViewPaneContainer extends ViewPaneContainer {
	constructor(
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@IStorageService storageService: IStorageService,
		@IConfigurationService configurationService: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IExtensionService extensionService: IExtensionService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
	) {
		super(INSRC_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: false }, instantiationService, configurationService, layoutService, contextMenuService, telemetryService, extensionService, themeService, storageService, contextService, viewDescriptorService);
	}
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);
const viewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);

// Register the insrc ViewContainer in the sidebar
export const INSRC_VIEW_CONTAINER = viewContainerRegistry.registerViewContainer({
	id: INSRC_VIEW_CONTAINER_ID,
	title: localize2('insrc', 'insrc'),
	ctorDescriptor: new SyncDescriptor(InsrcViewPaneContainer),
	storageId: 'workbench.insrc.views.state',
	icon: insrcViewIcon,
	alwaysUseContainerInfo: true,
	hideIfEmpty: false,
	order: 10,
	openCommandActionDescriptor: {
		id: INSRC_VIEW_CONTAINER_ID,
		title: localize2('insrc', 'insrc'),
		mnemonicTitle: localize({ key: 'miViewInsrc', comment: ['&& denotes a mnemonic'] }, '&&insrc'),
		keybindings: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyI },
		order: 10,
	},
}, ViewContainerLocation.Sidebar);

// Register views inside the container
viewsRegistry.registerViews([
	{
		id: INSRC_SESSIONS_VIEW_ID,
		name: localize2('sessions', 'Sessions'),
		ctorDescriptor: new SyncDescriptor(InsrcSessionsViewPane),
		canToggleVisibility: true,
		canMoveView: false,
		order: 1,
		weight: 40,
		collapsed: true,
	},
	{
		id: INSRC_RUNS_VIEW_ID,
		name: localize2('runs', 'Runs'),
		ctorDescriptor: new SyncDescriptor(InsrcRunsViewPane),
		canToggleVisibility: true,
		canMoveView: false,
		order: 2,
		weight: 30,
		collapsed: true,
	},
	{
		id: INSRC_STEP_PROVIDERS_VIEW_ID,
		name: localize2('stepProviders', 'Step Providers'),
		ctorDescriptor: new SyncDescriptor(InsrcStepProvidersViewPane),
		canToggleVisibility: true,
		canMoveView: false,
		order: 3,
		weight: 30,
		collapsed: true,
	},
], INSRC_VIEW_CONTAINER);

// Welcome content when no repos are added
viewsRegistry.registerViewWelcomeContent(INSRC_SESSIONS_VIEW_ID, {
	content: localize('noRepos', 'No repositories added.\n[Add Repository](command:insrc.addRepo)'),
	order: 0,
});
