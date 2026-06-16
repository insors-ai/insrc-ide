/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { EphemeralEditorInput } from '../shared/ephemeralEditorInput.js';

/**
 * EditorInput for the handoff report pane (plans/external-agent-integration.md
 * post-MVP, modelled on the data-analyzer report pane).
 *
 * One pane per handoff run, keyed on the synthesised TodoList's
 * `listId`. The handoff orchestrator (`src/insrc/handoff/index.ts`)
 * creates a list with owner=`handoff` at the start of the pipeline
 * and writes the synthesised report markdown to `list.body` via
 * `updateListBody` at `handoff-final` / `handoff-error`. The
 * workbench-side `HandoffFlowContribution` opens this input as soon
 * as the body lands.
 *
 * Backed by `~/.insrc/tmp/handoff-report-<listId>.md` per the
 * `EphemeralEditorInput` contract. No editor serializer is
 * registered, so the workbench drops the tab across IDE restarts
 * (the orphan reconciler cleans the backing file). The body itself
 * persists in the todos framework's storage, so the user re-opens
 * the report via the todos pane's "Open report" action or the
 * `insrc.handoff.openReport` palette command.
 */
export class HandoffReportInput extends EphemeralEditorInput {
	static readonly ID = 'insrc.handoffReportInput';

	constructor(
		readonly sessionId: string,
		listId: string,
		private readonly _initialBody: string = '',
		/**
		 * Per-report display name. Defaults to "Handoff Report" when
		 * callers don't pass one (resume / serializer paths).
		 * Production callers thread `TodoList.title` so each pane gets
		 * a distinct tab name.
		 */
		private readonly _displayName?: string,
	) {
		super('handoff-report', listId, '.md');
	}

	/** Backwards-compat accessor mirroring the data-analyzer's pane. */
	get listId(): string {
		return this.instanceId;
	}

	override get typeId(): string {
		return HandoffReportInput.ID;
	}

	override getName(): string {
		return this._displayName !== undefined && this._displayName.length > 0
			? this._displayName
			: 'Handoff Report';
	}

	override getIcon(): ThemeIcon {
		return Codicon.arrowSwap;
	}

	override matches(other: unknown): boolean {
		return other instanceof HandoffReportInput && other.listId === this.listId;
	}

	protected override getInitialContent(): string {
		return this._initialBody;
	}
}
