/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { EphemeralEditorInput } from '../shared/ephemeralEditorInput.js';

/**
 * EditorInput for the Data Analyzer's report pane (plans/analyzers/data-analyzer.md
 * Phase 2.1).
 *
 * One pane per data-analysis run, keyed on the synthesised TodoList's
 * `listId`. Mirrors `AnalysisReportInput` -- the data-analyzer
 * orchestrator (`daemon/controllers/data-analyzer-orchestrator.ts`)
 * writes its synthesised markdown to `list.body` via `updateListBody`
 * at the end of `queueSynthesise`; the workbench-side flow
 * contribution opens this input as soon as the body lands.
 *
 * Backed by `~/.insrc/tmp/data-analysis-report-<listId>.md` per the
 * `EphemeralEditorInput` contract. Like the code-analyzer's pane this
 * intentionally does NOT register an editor serializer, so the
 * workbench drops the tab across IDE restarts (per the design's
 * ephemeral semantics). The ephemeral-pane orphan reconciler
 * (`ephemeralPaneContribution.ts`) cleans the backing file on next
 * startup. The list.body persists in the framework's LanceDB, so the
 * user re-opens via the todos pane's "Open report" action or the
 * `insrc.dataAnalyzer.openReport` palette command.
 */
export class DataAnalysisReportInput extends EphemeralEditorInput {
	static readonly ID = 'insrc.dataAnalysisReportInput';

	constructor(
		readonly sessionId: string,
		listId: string,
		private readonly _initialBody: string = '',
		/**
		 * Per-report display name shown in the editor tab. Defaults to
		 * the generic "Data Analysis Report" when callers don't pass
		 * one (resume / serializer paths). Production callers thread
		 * `TodoList.title` here so each report gets a distinct tab
		 * name -- otherwise multiple reports look identical in the tab
		 * strip.
		 */
		private readonly _displayName?: string,
	) {
		super('data-analysis-report', listId, '.md');
	}

	/** Backwards-compat accessor for callers that reach for `listId` directly. */
	get listId(): string {
		return this.instanceId;
	}

	override get typeId(): string {
		return DataAnalysisReportInput.ID;
	}

	override getName(): string {
		return this._displayName !== undefined && this._displayName.length > 0
			? this._displayName
			: 'Data Analysis Report';
	}

	override getIcon(): ThemeIcon {
		return Codicon.database;
	}

	override matches(other: unknown): boolean {
		return other instanceof DataAnalysisReportInput && other.listId === this.listId;
	}

	protected override getInitialContent(): string {
		return this._initialBody;
	}
}
