/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { EphemeralEditorInput } from '../shared/ephemeralEditorInput.js';

/**
 * EditorInput for the unified prompt notepad pane (plans/todo-framework.md
 * Phase 9 follow-up).
 *
 * Backed by a real file under `~/.insrc/tmp/notepad-<notepadId>.md`
 * (see `EphemeralEditorInput`). The Draft tab attaches the file's text
 * model directly; the workbench's standard text-file pipeline handles
 * read / auto-save / restoration. The TODOs view scopes itself to
 * `chatService.activeSessionId` at render time and refreshes when the
 * active session changes.
 */
const NOTEPAD_TEMPLATE = `# Prompt Notepad
# Write your prompt below. Use Run All (or select a section and Run Selection).
# Variables: \${repo}, \${repoName}, \${file}, \${fileName}, \${selection}, \${line}, \${clipboard}

`;

export class NotepadEditorInput extends EphemeralEditorInput {
	static readonly ID = 'insrc.notepadInput';

	constructor(notepadId: string = '1') {
		super('notepad', notepadId, '.md');
	}

	/** Backwards-compat alias for `instanceId` -- existing callers reach for `notepadId`. */
	get notepadId(): string {
		return this.instanceId;
	}

	override get typeId(): string {
		return NotepadEditorInput.ID;
	}

	override getName(): string {
		return 'Prompt Notepad';
	}

	override getIcon(): ThemeIcon {
		return Codicon.notebook;
	}

	override matches(other: unknown): boolean {
		return other instanceof NotepadEditorInput && other.instanceId === this.instanceId;
	}

	protected override getInitialContent(): string {
		return NOTEPAD_TEMPLATE;
	}
}
