/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { EphemeralEditorInput } from '../shared/ephemeralEditorInput.js';

/**
 * EditorInput for the Code Analyzer's report pane (plans/analyzers/code-analyzer.md
 * Phase 2.1).
 *
 * One pane per analysis run, keyed on the synthesised TodoList's
 * `listId`. The plan text says "sessionId equality" but each
 * `/code-analyze` run creates its own list, so listId is the proper
 * unit of work; sessionId is along for the ride for surfaces that
 * want to filter by session ("show me reports from this chat
 * session").
 *
 * Backed by `~/.insrc/tmp/code-analysis-report-<listId>.md` per the
 * `EphemeralEditorInput` contract -- but this pane intentionally does
 * NOT register an editor serializer, so the workbench drops the tab
 * across IDE restarts (per design section10.2 ephemeral semantics). The
 * ephemeral-pane orphan reconciler (`ephemeralPaneContribution.ts`)
 * cleans the backing file on next startup. The list.body persists in
 * the framework's LanceDB, so the user re-opens via the todos pane's
 * "Open report" action.
 *
 * Initial content is the list.body markdown captured at construction
 * time -- the open-command + flow contribution both look up the list
 * and pass it in.
 */
export class AnalysisReportInput extends EphemeralEditorInput {
	static readonly ID = 'insrc.analysisReportInput';

	constructor(
		readonly sessionId: string,
		listId: string,
		private readonly _initialBody: string = '',
		/**
		 * Per-report display name shown in the editor tab. Defaults to
		 * the generic "Code Analysis Report" when callers don't pass a
		 * title (resume / serializer paths). Production callers (the
		 * flow contribution + the openReport command) thread the
		 * `TodoList.title` here so each report gets a distinct tab
		 * name -- otherwise multiple reports in a session look
		 * identical in the tab strip.
		 */
		private readonly _displayName?: string,
	) {
		super('code-analysis-report', listId, '.md');
	}

	/** Backwards-compat accessor for callers that reach for `listId` directly. */
	get listId(): string {
		return this.instanceId;
	}

	override get typeId(): string {
		return AnalysisReportInput.ID;
	}

	override getName(): string {
		return this._displayName !== undefined && this._displayName.length > 0
			? this._displayName
			: 'Code Analysis Report';
	}

	override getIcon(): ThemeIcon {
		return Codicon.fileSubmodule;
	}

	override matches(other: unknown): boolean {
		return other instanceof AnalysisReportInput && other.listId === this.listId;
	}

	protected override getInitialContent(): string {
		return this._initialBody;
	}
}
