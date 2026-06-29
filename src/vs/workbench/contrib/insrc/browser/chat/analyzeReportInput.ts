/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * EditorInput for an analyze-run terminal report.
 *
 * Backed by a real file under `~/.insrc/tmp/analyze-report-<runId>.md`
 * (see EphemeralEditorInput). When the chat pane sees the streaming
 * RPC's terminal `analyze-result` frame, it formats the AggregateReport
 * into markdown, writes it to this file, then opens an instance of
 * this input via the workbench's editor service -- the user gets the
 * report in a regular markdown editor tab.
 *
 * The instanceId is the runId, so re-opening the same run's report
 * dedupes via `matches()`. The Phase-6 reconciler in
 * `EphemeralPaneInitContribution` reaps any backing file that no open
 * editor references on startup, so abandoned reports don't accumulate.
 */

import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { EphemeralEditorInput } from '../shared/ephemeralEditorInput.js';

export class AnalyzeReportInput extends EphemeralEditorInput {
	static readonly ID = 'insrc.analyzeReportInput';

	constructor(runId: string) {
		super('analyze-report', runId, '.md');
	}

	/** Backwards-compat alias for `instanceId`. */
	get runId(): string {
		return this.instanceId;
	}

	override get typeId(): string {
		return AnalyzeReportInput.ID;
	}

	override getName(): string {
		return `Analysis report (${this.shortRunId()})`;
	}

	override getIcon(): ThemeIcon {
		return Codicon.report;
	}

	override matches(other: unknown): boolean {
		return other instanceof AnalyzeReportInput && other.instanceId === this.instanceId;
	}

	/** Default content shown when the editor is opened before the
	 *  chat pane has written the formatted report. The pane overwrites
	 *  this immediately when the terminal analyze-result frame arrives. */
	protected override getInitialContent(): string {
		return '# Analysis report\n\n_(Report will appear here when the run completes.)_\n';
	}

	private shortRunId(): string {
		const id = this.instanceId;
		return id.length <= 12 ? id : `${id.slice(0, 8)}…`;
	}
}
