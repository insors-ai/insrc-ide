/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput } from '../../../../common/editor/editorInput.js';
import { URI } from '../../../../../base/common/uri.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';

/**
 * EditorInput for the notepad's user-owned TODOs pane (plans/todo-
 * framework.md Phase 9). One instance per chat session; same
 * match-by-sessionId convention as the agent todos pane. Lives under
 * the `insrc-notepad-todos:` scheme so the editor group can tell it
 * apart from the agent-owned surface at `insrc-todos:`.
 */
export class NotepadTodosEditorInput extends EditorInput {
	static readonly ID = 'insrc.notepadTodosInput';

	constructor(readonly sessionId: string) {
		super();
	}

	override get typeId(): string {
		return NotepadTodosEditorInput.ID;
	}

	override getName(): string {
		return 'Notepad: My TODOs';
	}

	override get resource(): URI {
		return URI.from({ scheme: 'insrc-notepad-todos', path: `/session/${this.sessionId}` });
	}

	override getIcon(): ThemeIcon {
		return Codicon.notebook;
	}

	override matches(other: unknown): boolean {
		return other instanceof NotepadTodosEditorInput && other.sessionId === this.sessionId;
	}
}
