/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Chat module registration.
 *
 * The chat lives in its OWN view container pinned to the secondary
 * side bar (the right-side activity bar). It used to sit inside the
 * Explorer alongside Sessions / Runs, but that cramped the panel +
 * forced the user to share screen real-estate with the file tree.
 * Moving it to the AuxiliaryBar gives it a dedicated full-height
 * column on the right that the user can pin / unpin via the
 * standard sidebar toggle (Cmd/Ctrl+Alt+B).
 *
 * Two things wire up here:
 *
 *   1. A new ViewContainer (id = 'insrc.chat.container') registered
 *      at ViewContainerLocation.AuxiliaryBar with a chat icon. The
 *      container hosts the InsrcChatViewPane.
 *
 *   2. The AnalyzeReportInput ephemeral editor pane serializer, so
 *      a user's open report editor tab restores after IDE restart.
 *
 * insrc.contribution.ts already imports this file; pre-rebuild that
 * import pointed at a missing path.
 */

import { localize, localize2 } from '../../../../../nls.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import {
	Extensions as ViewExtensions,
	IViewContainersRegistry,
	IViewsRegistry,
	ViewContainer,
	ViewContainerLocation,
} from '../../../../common/views.js';
import { ViewPaneContainer } from '../../../../browser/parts/views/viewPaneContainer.js';

import { AnalyzeReportInput } from './analyzeReportInput.js';
import { InsrcChatViewPane, INSRC_CHAT_VIEW_ID } from './chatViewPane.js';
import { registerEphemeralEditorSerializer } from '../shared/ephemeralEditorInput.js';

// ---------------------------------------------------------------------------
// Dedicated view container in the secondary side bar
// ---------------------------------------------------------------------------

export const INSRC_CHAT_CONTAINER_ID = 'insrc.chat.container';

const viewContainersRegistry = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);

const containerTitle = localize2('insrcChat', 'Insrc Chat');

const chatContainer: ViewContainer = viewContainersRegistry.registerViewContainer(
	{
		id: INSRC_CHAT_CONTAINER_ID,
		title: containerTitle,
		icon: Codicon.commentDiscussion,
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [
			INSRC_CHAT_CONTAINER_ID,
			{ mergeViewWithContainerWhenSingleView: true },
		]),
		storageId: INSRC_CHAT_CONTAINER_ID,
		hideIfEmpty: false,
		order: 100,
	},
	ViewContainerLocation.AuxiliaryBar,
);

// ---------------------------------------------------------------------------
// View registration inside the container
// ---------------------------------------------------------------------------

const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);

viewsRegistry.registerViews(
	[
		{
			id: INSRC_CHAT_VIEW_ID,
			name: localize2('chat', 'Chat'),
			containerIcon: chatContainer.icon,
			containerTitle: containerTitle.value,
			singleViewPaneContainerTitle: containerTitle.value,
			ctorDescriptor: new SyncDescriptor(InsrcChatViewPane),
			canToggleVisibility: false,
			canMoveView: true,
			order: 0,
		},
	],
	chatContainer,
);

// ---------------------------------------------------------------------------
// Welcome content when no chat history yet (covers the first-launch case
// before the user sends a prompt)
// ---------------------------------------------------------------------------

viewsRegistry.registerViewWelcomeContent(INSRC_CHAT_VIEW_ID, {
	content: localize(
		'chatWelcome',
		'Open a workspace folder, then type a prompt below to start an analyze run.',
	),
	order: 0,
});

// ---------------------------------------------------------------------------
// Ephemeral editor input serializer (for restoring an open report
// editor tab across IDE restarts).
// ---------------------------------------------------------------------------

registerEphemeralEditorSerializer(
	AnalyzeReportInput.ID,
	(instanceId) => new AnalyzeReportInput(instanceId),
);
