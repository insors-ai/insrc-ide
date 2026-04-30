/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Drill-down footer parser for analyzer reports.
 *
 * Both the Code Analyzer (Phase 5.D) and the Data Analyzer (Phase 5.3)
 * synthesise prompts emit a final `## Drill down` section listing 3-5
 * candidate next-step analyses. Their report panes parse that section
 * here and render each candidate as a clickable button that fires
 * `insrc.<family>Analyzer.drillDown`.
 *
 * Expected shape:
 *
 *     ## Drill down
 *
 *     - **<one-line candidate question>** -- scope: `<path | module | entity | connection>`
 *     - **<one-line candidate question>** -- scope: `<...>`
 *     ...
 *
 * Tolerant of:
 *   - case variation in the heading (`## Drill down`, `## Drill Down`,
 *     `## Drill-down`),
 *   - extra blank lines between heading and bullets,
 *   - prose lines mixed with bullets (non-bullets are ignored),
 *   - missing `-- scope:` segment (item still kept; scope falls back
 *     to the empty string so the drillDown command can still fire).
 */

export interface DrillDownItem {
	readonly question: string;
	readonly scope: string;
}

export interface ParsedReport {
	/** Body up to (but not including) the `## Drill down` heading. */
	readonly main: string;
	/** Parsed footer items. Empty when no `## Drill down` section was
	 *  found OR the section had no parseable bullets. */
	readonly items: readonly DrillDownItem[];
}

const HEADING_RE = /^##\s+drill[-\s]?down\s*$/im;

/**
 * Bullet shape: `- **<question>** -- scope: \`<scope>\``. The
 * `--` separator is matched loosely (ASCII `--`, U+2014 em dash,
 * U+2013 en dash). Unicode dashes are encoded via \u escapes so the
 * file stays ASCII-clean for the workbench's hygiene check.
 */
const BULLET_RE = /^\s*[-*]\s+\*\*([\s\S]+?)\*\*\s*(?:--|\u2014|\u2013)\s*scope\s*:\s*`([^`]+)`\s*$/i;

/**
 * Looser fallback: bullet with bolded question but no recognisable
 * scope segment. Captures the question; scope returns ''. Used so a
 * model that drops the scope hint still surfaces a clickable button.
 */
const BULLET_NO_SCOPE_RE = /^\s*[-*]\s+\*\*([\s\S]+?)\*\*\s*$/;

/**
 * Parse an analyzer report body into the part above the drill-down
 * footer + the parsed footer items. When no `## Drill down` section
 * is present, returns the body untouched and an empty items array.
 */
export function parseDrillDownFooter(body: string): ParsedReport {
	const match = HEADING_RE.exec(body);
	if (!match) {
		return { main: body, items: [] };
	}
	const headingStart = match.index;
	const main = body.slice(0, headingStart).replace(/\s+$/, '');
	const footerSection = body.slice(headingStart + match[0].length);
	const items = parseFooterBullets(footerSection);
	return { main, items };
}

function parseFooterBullets(section: string): DrillDownItem[] {
	const items: DrillDownItem[] = [];
	const lines = section.split(/\r?\n/);
	for (const rawLine of lines) {
		const line = rawLine.trimEnd();
		if (line.length === 0) {
			continue;
		}
		// Stop if a new heading starts -- the Drill-down section is
		// always last per the synthesise prompt, but be defensive.
		if (/^#{1,6}\s/.test(line)) {
			break;
		}

		const m = BULLET_RE.exec(line);
		if (m && typeof m[1] === 'string' && typeof m[2] === 'string') {
			const question = m[1].trim();
			const scope = m[2].trim();
			if (question.length > 0) {
				items.push({ question, scope });
			}
			continue;
		}
		const m2 = BULLET_NO_SCOPE_RE.exec(line);
		if (m2 && typeof m2[1] === 'string') {
			const question = m2[1].trim();
			if (question.length > 0) {
				items.push({ question, scope: '' });
			}
		}
	}
	return items;
}
