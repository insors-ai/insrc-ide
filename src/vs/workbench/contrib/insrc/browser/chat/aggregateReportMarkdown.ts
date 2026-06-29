/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * AggregateReport -> markdown formatter.
 *
 * Renders the daemon's structured AggregateReport ({ summary, findings,
 * metadata }) into a markdown document the workbench's standard
 * markdown editor + preview surface can display directly.
 *
 * Layout:
 *
 *   # Analysis report
 *
 *   <one or more paragraphs of summary>
 *
 *   _<target> / <scope> / <runId> / <N tasks analyzed>_
 *
 *   ## Findings
 *
 *   ### 1. <title>
 *
 *   <detail markdown>
 *
 *   Sources: t01, t04
 *
 *   ### 2. ...
 *
 * No external markdown library used -- the body is built from string
 * fragments. The detail field is passed through verbatim (the daemon-
 * side aggregator prompt already constrains it to markdown without
 * images / HTML / outer-fenced blocks).
 */

/** Shape we expect on the wire from the daemon's analyze.run.start
 *  terminal frame's `result.finalReport`. Tolerant of missing fields. */
export interface AggregateReportLike {
	readonly summary?: string;
	readonly findings?: ReadonlyArray<{
		readonly title?: string;
		readonly detail?: string;
		readonly sources?: ReadonlyArray<string>;
	}>;
	readonly metadata?: {
		readonly target?: string;
		readonly scope?: string;
		readonly runId?: string;
		readonly tasksAnalyzed?: number;
	};
}

export function formatAggregateReport(report: AggregateReportLike | undefined): string {
	if (report === undefined || report === null) {
		return '# Analysis report\n\n_(No report payload was provided.)_\n';
	}

	const lines: string[] = [];
	lines.push('# Analysis report');
	lines.push('');

	const summary = (report.summary ?? '').trim();
	if (summary.length > 0) {
		lines.push(summary);
	} else {
		lines.push('_(No summary returned by the aggregator.)_');
	}
	lines.push('');

	const meta = report.metadata;
	if (meta !== undefined) {
		const parts: string[] = [];
		if (meta.target !== undefined) { parts.push(meta.target); }
		if (meta.scope !== undefined) { parts.push(meta.scope); }
		if (meta.runId !== undefined) { parts.push(`run \`${meta.runId}\``); }
		if (meta.tasksAnalyzed !== undefined) { parts.push(`${meta.tasksAnalyzed} task${meta.tasksAnalyzed === 1 ? '' : 's'} analyzed`); }
		if (parts.length > 0) {
			lines.push(`_${parts.join(' · ')}_`);
			lines.push('');
		}
	}

	const findings = report.findings ?? [];
	lines.push('## Findings');
	lines.push('');
	if (findings.length === 0) {
		lines.push('_(The aggregator emitted no findings.)_');
		lines.push('');
	} else {
		for (let i = 0; i < findings.length; i++) {
			const f = findings[i]!;
			const title = (f.title ?? '').trim() || '(untitled finding)';
			const detail = (f.detail ?? '').trim();
			const sources = (f.sources ?? []).filter(s => s.length > 0);

			lines.push(`### ${i + 1}. ${title}`);
			lines.push('');
			if (detail.length > 0) {
				lines.push(detail);
				lines.push('');
			}
			if (sources.length > 0) {
				lines.push(`Sources: ${sources.join(', ')}`);
				lines.push('');
			}
		}
	}

	// Trailing newline so the file ends cleanly.
	return lines.join('\n').replace(/\n+$/, '\n');
}
