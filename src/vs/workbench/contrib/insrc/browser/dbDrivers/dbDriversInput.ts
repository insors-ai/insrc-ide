/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput } from '../../../../common/editor/editorInput.js';
import { URI } from '../../../../../base/common/uri.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';

let _instance: DbDriversInput | undefined;

/**
 * Singleton editor input for the Data Sources pane (one workspace,
 * one configuration surface). Mirrors `ModelProvidersInput`.
 */
export class DbDriversInput extends EditorInput {
	static readonly ID = 'insrc.dbDriversInput';

	readonly resource = URI.from({ scheme: 'insrc-settings', path: 'data-sources' });

	static getInstance(): DbDriversInput {
		if (_instance === undefined || _instance.isDisposed()) {
			_instance = new DbDriversInput();
		}
		return _instance;
	}

	override get typeId(): string {
		return DbDriversInput.ID;
	}

	override getName(): string {
		return 'Data Sources';
	}

	override getIcon(): ThemeIcon {
		return Codicon.database;
	}

	override matches(other: unknown): boolean {
		return other instanceof DbDriversInput;
	}
}
