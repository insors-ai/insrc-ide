/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../../nls.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { Extensions as ViewContainerExtensions, IViewsRegistry } from '../../../../common/views.js';
import { VIEW_CONTAINER } from '../../../files/browser/explorerViewlet.js';
import { InsrcSessionsViewPane } from './sessionsView.js';
import { InsrcRunsViewPane } from './runsView.js';

// ---------------------------------------------------------------------------
// View IDs
// ---------------------------------------------------------------------------

export const INSRC_SESSIONS_VIEW_ID = 'insrc.sessions';
export const INSRC_RUNS_VIEW_ID = 'insrc.runs';

// ---------------------------------------------------------------------------
// Register insrc panes inside the Explorer container
// ---------------------------------------------------------------------------
// The Explorer already shows workspace folders (file trees).
// We add Sessions and Runs as collapsible panes below it. Step Providers
// moved out of the explorer into the status-bar popup ("insrc" at the
// bottom-left); it opens the dedicated editor on demand via the
// `insrc.openStepProviders` command.
// ---------------------------------------------------------------------------

const viewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);

viewsRegistry.registerViews([
	{
		id: INSRC_SESSIONS_VIEW_ID,
		name: localize2('sessions', 'Sessions'),
		ctorDescriptor: new SyncDescriptor(InsrcSessionsViewPane),
		canToggleVisibility: true,
		canMoveView: false,
		order: 100,        // after Explorer file view (order 1) and Open Editors (order 0)
		weight: 20,
		collapsed: true,
	},
	{
		id: INSRC_RUNS_VIEW_ID,
		name: localize2('runs', 'Runs'),
		ctorDescriptor: new SyncDescriptor(InsrcRunsViewPane),
		canToggleVisibility: true,
		canMoveView: false,
		order: 101,
		weight: 15,
		collapsed: true,
	},
], VIEW_CONTAINER);

// Welcome content when no repos are added
viewsRegistry.registerViewWelcomeContent(INSRC_SESSIONS_VIEW_ID, {
	content: localize('noRepos', 'No repositories added.\n[Add Repository](command:insrc.addRepo)'),
	order: 0,
});
