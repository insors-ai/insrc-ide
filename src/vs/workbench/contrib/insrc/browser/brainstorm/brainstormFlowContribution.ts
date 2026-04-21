/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IInsrcChatService } from '../../common/chatService.js';
import {
	IInsrcBrainstormSessionService,
	type BrainstormGateKind,
	type BrainstormGateSnapshot,
} from '../../common/brainstormSessionService.js';
import type { EditorInput } from '../../../../common/editor/editorInput.js';
import { BrainstormIdeasInput } from './step/ideasInput.js';
import { BrainstormIdeaChatInput } from './step/ideaChatInput.js';
import { BrainstormIdeaListInput } from './step/ideaListInput.js';
import { BrainstormThemesInput } from './step/themesInput.js';
import { BrainstormThemeDetailsInput } from './step/themeDetailsInput.js';
import { BrainstormPresentationInput } from './step/presentationInput.js';

/**
 * Routes brainstorm gates to the matching per-step editor pane. Every
 * known gate kind has its own concrete pane; unknown kinds are logged
 * and ignored (we never want to land the user in a "mystery" pane).
 */
export class BrainstormFlowContribution extends Disposable {
	static readonly ID = 'insrc.brainstormFlow';

	private _lastOpenedKey: string | undefined;

	constructor(
		@IInsrcChatService private readonly chatService: IInsrcChatService,
		@IInsrcBrainstormSessionService sessionService: IInsrcBrainstormSessionService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._register(sessionService.onDidChangeActiveGate(gate => this._route(gate)));
		this._register(this.chatService.onDidChangeSession(() => { this._lastOpenedKey = undefined; }));
		// Item 25: unified cancel path. When chat service requests a close,
		// iterate every editor and close the brainstorm step inputs. This is
		// how the chat-panel Cancel button reaches out and shuts the pane.
		this._register(this.chatService.onRequestCloseBrainstormPanes(() => this._closeAllBrainstormPanes()));
	}

	private _closeAllBrainstormPanes(): void {
		// Walk every editor in every group; any BrainstormStepInputBase
		// subclass gets closed. Uses the typeId registered on each input
		// (`insrc.brainstormIdeasInput`, `insrc.brainstormIdeaListInput`,
		// etc.) -- no runtime `instanceof` needed.
		const BRAINSTORM_TYPE_IDS = new Set<string>([
			'insrc.brainstormIdeasInput',
			'insrc.brainstormIdeaListInput',
			'insrc.brainstormIdeaChatInput',
			'insrc.brainstormThemesInput',
			'insrc.brainstormThemeDetailsInput',
			'insrc.brainstormPresentationInput',
		]);
		const groups = this.editorGroupsService.groups;
		for (const group of groups) {
			const toClose = group.editors.filter(e => BRAINSTORM_TYPE_IDS.has(e.typeId));
			if (toClose.length === 0) { continue; }
			this.logService.info(`[brainstorm:flow] closing ${toClose.length} brainstorm editor(s) in group ${group.id}`);
			for (const editor of toClose) {
				group.closeEditor(editor, { preserveFocus: true });
			}
		}
		this._lastOpenedKey = undefined;
	}

	private _route(gate: BrainstormGateSnapshot): void {
		const sessionId = this.chatService.activeSessionId ?? 'brainstorm';
		this.logService.info(`[brainstorm:flow] route kind=${gate.kind} sessionId=${sessionId} lastOpenedKey=${this._lastOpenedKey ?? '(none)'}`);

		// intent-confirm is intentionally handled in the chat panel (Item 12).
		// Don't warn -- just let it fall through to the chat-view gate renderer.
		if (gate.kind === 'intent-confirm') {
			this.logService.info(`[brainstorm:flow] intent-confirm routed to chat panel (gateId=${gate.gateId})`);
			return;
		}

		const input = this._inputFor(gate.kind, sessionId);
		if (!input) {
			this.logService.warn(`[brainstorm:flow] unknown gate kind "${gate.kind}" (gateId=${gate.gateId}); ignoring`);
			return;
		}

		// Avoid re-opening the same pane every gate; we only want to switch
		// editors when the KIND changes. Same-kind gate updates are picked up
		// by the pane listening to onDidChangeActiveGate directly.
		const key = `${input.typeId}:${sessionId}`;
		if (key === this._lastOpenedKey) {
			this.logService.info(`[brainstorm:flow] same pane already open, skipping editorService.openEditor`);
			return;
		}
		this.logService.info(`[brainstorm:flow] opening editor input=${input.typeId}`);
		this._lastOpenedKey = key;

		this.editorService.openEditor(input).then(
			ed => this.logService.info(`[brainstorm:flow] openEditor resolved editor=${ed?.getId?.() ?? '(none)'}`),
			err => this.logService.error(`[brainstorm:flow] openEditor failed: ${(err as Error).message}`),
		);
	}

	private _inputFor(kind: BrainstormGateKind, sessionId: string): EditorInput | undefined {
		// Every brainstorm step input is instantiation-service-created so its
		// close handler receives IDialogService + IInsrcChatService +
		// IInsrcBrainstormSessionService via DI.
		switch (kind) {
			case 'intent-confirm':
				// Intent-confirm is rendered inline in the chat panel (Item 12).
				// Returning undefined here tells the flow contribution to skip
				// opening a dedicated pane; the chat-view gate handler picks it up.
				return undefined;
			case 'idea':
				return this.instantiationService.createInstance(BrainstormIdeasInput, sessionId);
			case 'idea-list':
				return this.instantiationService.createInstance(BrainstormIdeaListInput, sessionId);
			case 'idea-discussion':
				return this.instantiationService.createInstance(BrainstormIdeaChatInput, sessionId);
			case 'convergence-review':
				return this.instantiationService.createInstance(BrainstormThemesInput, sessionId);
			case 'theme-spec':
				return this.instantiationService.createInstance(BrainstormThemeDetailsInput, sessionId);
			case 'presentation':
				return this.instantiationService.createInstance(BrainstormPresentationInput, sessionId);
			case 'unknown':
			default:
				return undefined;
		}
	}
}
