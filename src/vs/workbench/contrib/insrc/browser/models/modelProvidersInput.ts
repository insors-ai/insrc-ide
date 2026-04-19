/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput } from '../../../../common/editor/editorInput.js';
import { URI } from '../../../../../base/common/uri.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import type { ProviderName } from '../../common/configService.js';

let _instance: ModelProvidersInput | undefined;

export class ModelProvidersInput extends EditorInput {
	static readonly ID = 'insrc.modelProvidersInput';

	readonly resource = URI.from({ scheme: 'insrc-settings', path: 'model-providers' });

	/** Optional starting provider tab (e.g. from a NOT_CONFIGURED auto-open). */
	initialProvider?: ProviderName;

	static getInstance(initialProvider?: ProviderName): ModelProvidersInput {
		if (!_instance || _instance.isDisposed()) {
			_instance = new ModelProvidersInput();
		}
		_instance.initialProvider = initialProvider;
		return _instance;
	}

	override get typeId(): string {
		return ModelProvidersInput.ID;
	}

	override getName(): string {
		return 'Model Providers';
	}

	override getIcon(): ThemeIcon {
		return Codicon.cloud;
	}

	override matches(other: unknown): boolean {
		return other instanceof ModelProvidersInput;
	}
}
