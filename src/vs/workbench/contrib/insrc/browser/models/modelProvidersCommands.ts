/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ModelProvidersInput } from './modelProvidersInput.js';

const CATEGORY = localize2('insrc', 'insrc');

/**
 * Palette command: open the Model Providers pane.
 * Also invoked by the NOT_CONFIGURED auto-open contribution.
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.openModelProviders',
			title: localize2('insrc.openModelProviders', 'Open Model Providers'),
			f1: true,
			category: CATEGORY,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		await editorService.openEditor(ModelProvidersInput.getInstance());
	}
});
