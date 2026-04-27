/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { EphemeralEditorInput } from '../shared/ephemeralEditorInput.js';

/**
 * EditorInput for the Artifacts pane
 * (plans/artifact-tasks.md section 2.2). One instance per chat
 * session -- opening again for the same session re-focuses the
 * existing tab via `matches()`.
 *
 * Backed by a 0-byte stub file under `~/.insrc/tmp/artifacts-<sessionId>.md`
 * (see `EphemeralEditorInput`). The pane re-renders entirely from
 * `IInsrcTodosService` on `setInput`; the file is purely a placeholder
 * that keeps the URI resolvable across IDE restarts so editor
 * restoration finds something concrete to open instead of erroring out
 * on an unregistered custom-scheme URI.
 */
export class ArtifactsEditorInput extends EphemeralEditorInput {
	static readonly ID = 'insrc.artifactsInput';

	constructor(sessionId: string) {
		super('artifacts', sessionId, '.md');
	}

	/** Backwards-compat alias for `instanceId`. The pane reaches for `sessionId`. */
	get sessionId(): string {
		return this.instanceId;
	}

	override get typeId(): string {
		return ArtifactsEditorInput.ID;
	}

	override getName(): string {
		return 'Artifacts';
	}

	override getIcon(): ThemeIcon {
		return Codicon.symbolMisc;
	}

	override matches(other: unknown): boolean {
		return other instanceof ArtifactsEditorInput && other.instanceId === this.instanceId;
	}
}
