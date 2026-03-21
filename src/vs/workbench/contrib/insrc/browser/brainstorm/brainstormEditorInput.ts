/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput } from '../../../../common/editor/editorInput.js';
import { URI } from '../../../../../base/common/uri.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';

export class BrainstormEditorInput extends EditorInput {
	static readonly ID = 'insrc.brainstormEditorInput';

	constructor(
		readonly sessionId: string,
		readonly repoPath: string,
	) {
		super();
	}

	readonly resource = URI.from({ scheme: 'insrc-brainstorm', path: '/session' });

	override get typeId(): string {
		return BrainstormEditorInput.ID;
	}

	override getName(): string {
		return 'Brainstorm';
	}

	override getIcon(): ThemeIcon {
		return Codicon.lightbulb;
	}

	override matches(other: unknown): boolean {
		return other instanceof BrainstormEditorInput && other.sessionId === this.sessionId;
	}
}
