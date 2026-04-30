/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput } from '../../../../common/editor/editorInput.js';
import { URI } from '../../../../../base/common/uri.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';

let _instance: AccessApprovalsInput | undefined;

/**
 * Singleton editor input for the Approvals pane (one workspace, one
 * surface that reads the active session's approval state). Mirrors
 * `DbDriversInput`.
 */
export class AccessApprovalsInput extends EditorInput {
	static readonly ID = 'insrc.accessApprovalsInput';

	readonly resource = URI.from({ scheme: 'insrc-settings', path: 'access-approvals' });

	static getInstance(): AccessApprovalsInput {
		if (_instance === undefined || _instance.isDisposed()) {
			_instance = new AccessApprovalsInput();
		}
		return _instance;
	}

	override get typeId(): string {
		return AccessApprovalsInput.ID;
	}

	override getName(): string {
		return 'Access Approvals';
	}

	override getIcon(): ThemeIcon {
		return Codicon.shield;
	}

	override matches(other: unknown): boolean {
		return other instanceof AccessApprovalsInput;
	}
}
