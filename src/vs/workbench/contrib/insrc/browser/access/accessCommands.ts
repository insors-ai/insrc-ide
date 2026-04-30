/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { AccessApprovalsInput } from './accessInput.js';

const CATEGORY = localize2('insrc', 'insrc');

/**
 * Palette command: open the Approvals pane (plans/access-gate.md
 * Phase 5.3). Mirrors `insrc.openDataSources`.
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.openAccessApprovals',
			title: localize2('insrc.openAccessApprovals', 'Open Access Approvals'),
			f1: true,
			category: CATEGORY,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		await editorService.openEditor(AccessApprovalsInput.getInstance());
	}
});
