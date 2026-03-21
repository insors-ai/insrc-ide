/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput } from '../../../../common/editor/editorInput.js';
import { URI } from '../../../../../base/common/uri.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';

let _instance: StepProviderEditorInput | undefined;

export class StepProviderEditorInput extends EditorInput {
	static readonly ID = 'insrc.stepProviderEditorInput';

	readonly resource = URI.from({ scheme: 'insrc-settings', path: 'step-providers' });

	static getInstance(): StepProviderEditorInput {
		if (!_instance || _instance.isDisposed()) {
			_instance = new StepProviderEditorInput();
		}
		return _instance;
	}

	override get typeId(): string {
		return StepProviderEditorInput.ID;
	}

	override getName(): string {
		return 'Step Providers';
	}

	override getIcon(): ThemeIcon {
		return Codicon.settingsGear;
	}

	override matches(other: unknown): boolean {
		return other instanceof StepProviderEditorInput;
	}
}
