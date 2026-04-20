/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput } from '../../../../../common/editor/editorInput.js';
import { URI } from '../../../../../../base/common/uri.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';

/**
 * Shared base for every per-gate brainstorm editor input. Each subclass picks
 * its own scheme path so VSCode's editor group doesn't dedupe two different
 * steps as the same document. Matching is identity-on-sessionId -- we only
 * ever want one instance of a given step open per session.
 */
export abstract class BrainstormStepInputBase extends EditorInput {
	constructor(readonly sessionId: string) {
		super();
	}

	abstract override get typeId(): string;
	abstract override getName(): string;

	/** Route path inside the `insrc-brainstorm` scheme (e.g. `/ideas`, `/themes`). */
	protected abstract get stepPath(): string;

	override get resource(): URI {
		return URI.from({ scheme: 'insrc-brainstorm', path: `${this.stepPath}/${this.sessionId}` });
	}

	override getIcon(): ThemeIcon {
		return Codicon.lightbulb;
	}

	override matches(other: unknown): boolean {
		return other instanceof BrainstormStepInputBase
			&& other.typeId === this.typeId
			&& other.sessionId === this.sessionId;
	}
}
