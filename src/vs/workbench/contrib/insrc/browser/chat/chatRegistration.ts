/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../../nls.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { Extensions as ViewContainerExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../../common/views.js';
import { ViewPaneContainer } from '../../../../browser/parts/views/viewPaneContainer.js';
import { registerAction2, Action2 } from '../../../../../platform/actions/common/actions.js';
import { FileAccess } from '../../../../../base/common/network.js';
import { KeyMod, KeyCode } from '../../../../../base/common/keyCodes.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { Categories } from '../../../../../platform/action/common/actionCommonCategories.js';
import { InsrcChatViewPane } from './chatView.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const INSRC_CHAT_VIEW_CONTAINER_ID = 'insrc.chatContainer';
export const INSRC_CHAT_VIEW_ID = 'insrc.chatView';

const chatIcon = FileAccess.asBrowserUri('vs/workbench/contrib/insrc/browser/media/insrc-chat-28.png' as `vs/workbench/${string}`);

// ---------------------------------------------------------------------------
// Register ViewContainer in auxiliary bar (right sidebar)
// ---------------------------------------------------------------------------

const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);
const viewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);

const CHAT_VIEW_CONTAINER = viewContainerRegistry.registerViewContainer({
	id: INSRC_CHAT_VIEW_CONTAINER_ID,
	title: localize2('chat', 'Chat'),
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [INSRC_CHAT_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: 'insrc.chat.views.state',
	icon: chatIcon,
	hideIfEmpty: false,
	order: 0,
}, ViewContainerLocation.AuxiliaryBar);

viewsRegistry.registerViews([{
	id: INSRC_CHAT_VIEW_ID,
	name: localize2('chat', 'Chat'),
	ctorDescriptor: new SyncDescriptor(InsrcChatViewPane),
	canToggleVisibility: false,
	canMoveView: false,
	order: 0,
}], CHAT_VIEW_CONTAINER);

// ---------------------------------------------------------------------------
// Open Chat command
// ---------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.chat.open',
			title: localize2('insrc.chat.open', 'Open Chat'),
			category: Categories.View,
			f1: true,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyC,
				weight: 200,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		await viewsService.openView(INSRC_CHAT_VIEW_ID, true);
	}
});

// ---------------------------------------------------------------------------
// Prefill chat input command -- used by the analysis report pane's
// "Send to chat" action to seed the composer with a selected snippet.
// Opens the chat view (focusing it) then calls the view's public
// prefillInput method.
// ---------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.chat.prefillInput',
			title: localize2('insrc.chat.prefillInput', 'Insrc: Prefill Chat Input'),
			category: Categories.View,
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, args?: { text?: string; append?: boolean }): Promise<void> {
		if (!args || typeof args.text !== 'string' || args.text.length === 0) {
			return;
		}
		const viewsService = accessor.get(IViewsService);
		const view = await viewsService.openView<InsrcChatViewPane>(INSRC_CHAT_VIEW_ID, true);
		if (view && typeof view.prefillInput === 'function') {
			view.prefillInput(args.text, args.append === true ? { append: true } : undefined);
		}
	}
});
