/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Chat module registration.
 *
 * Two things wire up here:
 *
 * 1. The `insrc.chatView` sidebar view, hosting InsrcChatViewPane.
 *    The view ID is the same one sessionsView already opens via
 *    `viewsService.openView(INSRC_CHAT_VIEW_ID)` -- click on a
 *    session there + the chat view comes alive.
 *
 * 2. The `AnalyzeReportInput` ephemeral editor pane serializer, so a
 *    user's open report editor tab restores after IDE restart. The
 *    pane class itself is the workbench's standard markdown editor
 *    (we don't ship a custom editor pane -- the input is just a
 *    file-backed EphemeralEditorInput with .md extension, which
 *    routes to whichever editor handles `*.md`).
 *
 * insrc.contribution.ts already imports this file (`./chat/chatRegistration.js`).
 * Pre-U1 that import pointed at a non-existent file -- this commit
 * fills the gap.
 */

import { localize2 } from '../../../../../nls.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { Extensions as ViewContainerExtensions, IViewsRegistry } from '../../../../common/views.js';
import { VIEW_CONTAINER } from '../../../files/browser/explorerViewlet.js';

import { AnalyzeReportInput } from './analyzeReportInput.js';
import { InsrcChatViewPane, INSRC_CHAT_VIEW_ID } from './chatViewPane.js';
import { registerEphemeralEditorSerializer } from '../shared/ephemeralEditorInput.js';

// ---------------------------------------------------------------------------
// Sidebar view registration
// ---------------------------------------------------------------------------

const viewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);

viewsRegistry.registerViews([
	{
		id: INSRC_CHAT_VIEW_ID,
		name: localize2('chat', 'Chat'),
		ctorDescriptor: new SyncDescriptor(InsrcChatViewPane),
		canToggleVisibility: true,
		canMoveView: false,
		order: 102,   // after Sessions (100) and Runs (101)
		weight: 25,
		collapsed: true,
	},
], VIEW_CONTAINER);

// ---------------------------------------------------------------------------
// Ephemeral editor input serializer (for restoring an open report
// editor tab across IDE restarts).
// ---------------------------------------------------------------------------

registerEphemeralEditorSerializer(
	AnalyzeReportInput.ID,
	(instanceId) => new AnalyzeReportInput(instanceId),
);
