/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IEditorGroup } from '../../../../../services/editor/common/editorGroupsService.js';
import { ITelemetryService } from '../../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IInsrcChatService } from '../../../common/chatService.js';
import {
	IInsrcBrainstormSessionService,
	type BrainstormGateKind,
	type BrainstormGateSnapshot,
	type BrainstormIdea,
} from '../../../common/brainstormSessionService.js';
import { BrainstormCardWidget, type CardDiscussionMessage } from '../brainstormCardWidget.js';
import { BrainstormPaneBase } from './brainstormPaneBase.js';

/**
 * Idea-discussion pane. Reached when the user clicks Discuss... on an
 * idea card in IdeasPane; the backend emits `idea-discussion` gates
 * carrying both the focused idea and a running discussion history.
 *
 * Actions: accept / reject / refine / respond / back. The refine and
 * respond actions open inline prompt panels (BrainstormCardWidget
 * handles that uniformly); back/accept/reject are single-shot.
 */
export class BrainstormIdeaChatPane extends BrainstormPaneBase {
	static readonly ID = 'insrc.brainstormIdeaChatPane';

	private _cardWidget: BrainstormCardWidget | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IInsrcChatService chatService: IInsrcChatService,
		@IInsrcBrainstormSessionService sessionService: IInsrcBrainstormSessionService,
		@ILogService logService: ILogService,
	) {
		super(BrainstormIdeaChatPane.ID, group, telemetryService, themeService, storageService, chatService, sessionService, logService);
	}

	protected override get _paneTitle(): string { return 'Discussion'; }
	protected override get _gateKind(): BrainstormGateKind { return 'idea-discussion'; }

	protected override _renderGate(gate: BrainstormGateSnapshot): void {
		const idea = gate.item as BrainstormIdea | undefined;
		this.logService.info(`[brainstorm:pane:idea-discussion] _renderGate gateId=${gate.gateId} ideaId=${idea?.id?.slice(0, 8) ?? '(none)'} extraKeys=[${Object.keys(gate.extra ?? {}).join(',')}]`);
		if (!idea || !idea.title) {
			this.logService.warn('[brainstorm:pane:idea-discussion] _renderGate aborted: idea payload missing');
			this._emptyState.textContent = 'Discussion gate missing idea payload.';
			this._emptyState.classList.remove('hidden');
			return;
		}

		const messages = this._parseMessages(gate.extra?.['messages']);
		this.logService.info(`[brainstorm:pane:idea-discussion] parsed messages count=${messages.length}`);

		if (this._cardWidget) {
			this._cardWidget.dispose();
			this._cardWidget = undefined;
		}

		this._cardWidget = this.instantiationService.createInstance(
			BrainstormCardWidget,
			this._cardArea,
			{
				id: idea.id,
				title: idea.title,
				body: idea.body,
				references: idea.references.map(r => ({ ...r })),
				status: idea.status,
				tags: [...idea.tags],
				reviewVerdict: idea.reviewVerdict,
				reviewRationale: idea.reviewRationale,
				messages,
			},
			gate.actions.slice(),
			(action, feedback) => {
				this.logService.info(`[brainstorm:pane:idea-discussion] dispatch action=${action} feedbackLen=${feedback?.length ?? 0} gateId=${gate.gateId}`);
				this.chatService.replyToGate(gate.gateId, action, feedback).then(
					() => this.logService.info(`[brainstorm:pane:idea-discussion] replyToGate resolved action=${action}`),
					err => this.logService.error(`[brainstorm:pane:idea-discussion] replyToGate failed action=${action}: ${(err as Error).message}`),
				);
			},
		);
	}

	private _parseMessages(raw: unknown): CardDiscussionMessage[] {
		if (!Array.isArray(raw)) { return []; }
		const out: CardDiscussionMessage[] = [];
		for (const m of raw) {
			if (!m || typeof m !== 'object') { continue; }
			const role = (m as { role?: unknown }).role;
			const content = (m as { content?: unknown }).content;
			if ((role === 'user' || role === 'assistant') && typeof content === 'string') {
				out.push({ role, content });
			}
		}
		return out;
	}
}
