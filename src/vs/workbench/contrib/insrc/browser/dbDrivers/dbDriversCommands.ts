/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { DbDriversInput } from './dbDriversInput.js';

const CATEGORY = localize2('insrc', 'insrc');

/**
 * Palette command: open the Data Sources pane.
 * Mirrors `insrc.openModelProviders`.
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.openDataSources',
			title: localize2('insrc.openDataSources', 'Open Data Sources'),
			f1: true,
			category: CATEGORY,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		await editorService.openEditor(DbDriversInput.getInstance());
	}
});
