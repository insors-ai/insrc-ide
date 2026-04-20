/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IInsrcChatService } from '../../common/chatService.js';
import {
	IInsrcBrainstormSessionService,
	type BrainstormGateKind,
	type BrainstormGateSnapshot,
} from '../../common/brainstormSessionService.js';
import type { EditorInput } from '../../../../common/editor/editorInput.js';
import { BrainstormIdeasInput } from './step/ideasInput.js';
import { BrainstormEditorInput } from './brainstormEditorInput.js';

/**
 * Routes brainstorm gates to the matching per-step editor pane. Replaces the
 * old BrainstormAutoOpenContribution which opened one pane and mutated it
 * through phase changes.
 *
 * Migration is incremental: kinds we've already rewritten open their new
 * pane; anything else falls through to the legacy BrainstormEditorPane so the
 * flow keeps working while panes are ported.
 */
export class BrainstormFlowContribution extends Disposable {
	static readonly ID = 'insrc.brainstormFlow';

	private _lastOpenedKey: string | undefined;

	constructor(
		@IInsrcChatService private readonly chatService: IInsrcChatService,
		@IInsrcBrainstormSessionService sessionService: IInsrcBrainstormSessionService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();

		this._register(sessionService.onDidChangeActiveGate(gate => this._route(gate)));
		this._register(this.chatService.onDidChangeSession(() => { this._lastOpenedKey = undefined; }));
	}

	private _route(gate: BrainstormGateSnapshot): void {
		const sessionId = this.chatService.activeSessionId ?? 'brainstorm';
		const input = this._inputFor(gate.kind, sessionId);
		if (!input) { return; }

		// Avoid re-opening the same pane every gate; we only want to switch
		// editors when the KIND changes. Same-kind gate updates are picked up
		// by the pane listening to onDidChangeActiveGate directly.
		const key = `${input.typeId}:${sessionId}`;
		if (key === this._lastOpenedKey) { return; }
		this._lastOpenedKey = key;

		this.editorService.openEditor(input);
	}

	private _inputFor(kind: BrainstormGateKind, sessionId: string): EditorInput | undefined {
		switch (kind) {
			case 'idea':
				return new BrainstormIdeasInput(sessionId);

			// Not yet migrated -- keep using the legacy monolithic pane so the
			// user-visible flow doesn't break mid-rewrite.
			case 'idea-list':
			case 'idea-discussion':
			case 'convergence-review':
			case 'theme-spec':
			case 'presentation':
				return new BrainstormEditorInput(sessionId, this.chatService.activeRepo ?? '');

			default:
				return undefined;
		}
	}
}
