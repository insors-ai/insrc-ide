/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput } from '../../../../common/editor/editorInput.js';
import { URI } from '../../../../../base/common/uri.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';

/**
 * EditorInput for the Artifacts pane
 * (plans/artifact-tasks.md section 2.2). One instance per chat
 * session -- opening again for the same session re-focuses the
 * existing tab via `matches()`.
 *
 * Unlike the ephemeral Analysis Report Pane from the code-analyzer
 * design, this pane is durable: the list of artifacts per session
 * is an audit trail worth restoring across window reloads.
 */
export class ArtifactsEditorInput extends EditorInput {
	static readonly ID = 'insrc.artifactsInput';

	constructor(readonly sessionId: string) {
		super();
	}

	override get typeId(): string {
		return ArtifactsEditorInput.ID;
	}

	override getName(): string {
		return 'Artifacts';
	}

	override get resource(): URI {
		return URI.from({ scheme: 'insrc-artifacts', path: `/session/${this.sessionId}` });
	}

	override getIcon(): ThemeIcon {
		return Codicon.symbolMisc;
	}

	override matches(other: unknown): boolean {
		return other instanceof ArtifactsEditorInput && other.sessionId === this.sessionId;
	}
}
