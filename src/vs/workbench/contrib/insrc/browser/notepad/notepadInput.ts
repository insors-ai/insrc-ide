/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput } from '../../../../common/editor/editorInput.js';
import { URI } from '../../../../../base/common/uri.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';

/**
 * EditorInput for the unified prompt notepad pane (plans/todo-framework.md
 * Phase 9 follow-up).
 *
 * The notepad is a single tabbed pane with two views:
 * - **Draft**: Monaco markdown editor backed by the existing
 *   `PromptNotepadProvider` text model (`insrc-prompt:` scheme).
 * - **TODOs**: structured user-owned TODO lists scoped to the active
 *   chat session. Edits via the same `IInsrcTodosService` the agent
 *   pane reads from.
 *
 * The notepadId is global (defaults to `'1'`) so the markdown content
 * persists across sessions / windows; the TODOs view scopes itself to
 * `chatService.activeSessionId` at render time and refreshes when the
 * active session changes.
 */
export class NotepadEditorInput extends EditorInput {
	static readonly ID = 'insrc.notepadInput';

	constructor(readonly notepadId: string = '1') {
		super();
	}

	override get typeId(): string {
		return NotepadEditorInput.ID;
	}

	override getName(): string {
		return 'Prompt Notepad';
	}

	override get resource(): URI {
		return URI.from({ scheme: 'insrc-notepad', path: `/notepad/${this.notepadId}` });
	}

	override getIcon(): ThemeIcon {
		return Codicon.notebook;
	}

	override matches(other: unknown): boolean {
		return other instanceof NotepadEditorInput && other.notepadId === this.notepadId;
	}
}
