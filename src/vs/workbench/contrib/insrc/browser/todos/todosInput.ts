/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput } from '../../../../common/editor/editorInput.js';
import { URI } from '../../../../../base/common/uri.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';

/**
 * EditorInput for the read-only Todos pane (plans/todo-framework.md
 * Phase 5a). One instance per chat session -- opening again for the
 * same session re-focuses the existing tab via `matches()`.
 *
 * The pane it opens renders everything the IInsrcTodosService has
 * cached for the session (seeded via `todos.listForSession`, kept
 * fresh by the `todos.subscribe` stream).
 */
export class TodosEditorInput extends EditorInput {
	static readonly ID = 'insrc.todosInput';

	constructor(readonly sessionId: string) {
		super();
	}

	override get typeId(): string {
		return TodosEditorInput.ID;
	}

	override getName(): string {
		return 'Todos';
	}

	override get resource(): URI {
		return URI.from({ scheme: 'insrc-todos', path: `/session/${this.sessionId}` });
	}

	override getIcon(): ThemeIcon {
		return Codicon.checklist;
	}

	override matches(other: unknown): boolean {
		return other instanceof TodosEditorInput && other.sessionId === this.sessionId;
	}
}
