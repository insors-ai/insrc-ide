/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput } from '../../../../common/editor/editorInput.js';
import { URI } from '../../../../../base/common/uri.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';

let _instance: SetupWizardInput | undefined;

export class SetupWizardInput extends EditorInput {
	static readonly ID = 'insrc.setupWizardInput';

	readonly resource = URI.from({ scheme: 'insrc-setup', path: 'wizard' });

	static getInstance(): SetupWizardInput {
		if (!_instance || _instance.isDisposed()) {
			_instance = new SetupWizardInput();
		}
		return _instance;
	}

	override get typeId(): string {
		return SetupWizardInput.ID;
	}

	override getName(): string {
		return 'insrc Setup';
	}

	override getIcon(): ThemeIcon {
		return Codicon.gear;
	}

	override matches(other: unknown): boolean {
		return other instanceof SetupWizardInput;
	}
}
