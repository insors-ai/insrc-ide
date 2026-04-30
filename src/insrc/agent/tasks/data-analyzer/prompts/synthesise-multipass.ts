/**
 * Multi-pass synthesis prompts for the Data Analyzer.
 *
 * Mirrors agent/tasks/code-analyzer/prompts/synthesise-multipass.ts.
 * The orchestrator's synthesise step calls `generateMultiPass()` (from
 * agent/content-gen/) which:
 *   1. Runs the OUTLINE pass to produce a section list (4-6 sections).
 *   2. Runs the SECTION pass per section to produce the body.
 *   3. Stitches per-section bodies + headings into the final markdown.
 *
 * Drill-down footer: the outline prompt requires the LAST section to
 * be a "Drill down" section. The orchestrator post-processes the
 * outline to inject one synthetically when the model omits it -- so
 * the workbench Report Pane's footer parser always finds something
 * to render.
 */

import type { ScopeSize } from '../../../../shared/classify.js';
import type { SectionBuildArgs } from '../../../content-gen/index.js';
import type { AcceptedTask } from '../state.js';
import type { DataAnalysisTask } from '../types.js';

// ---------------------------------------------------------------------------
// Shared blocks
// ---------------------------------------------------------------------------

/**
 * Citation format examples for the data-analyzer. Two shapes:
 *   - Code cross-references (lineage findings) use the path: scheme
 *     and the existing IOpener (commit 3d1643c0062).
 *   - DB-target citations use the data-conn: scheme (Phase 1.7);
 *     workbench-side opener routes to the dbDrivers pane.
 */
const CODE_REF_FORMAT = '[`src/orders/repo.ts:42-58`](path:src/orders/repo.ts#L42-L58)';
const DATA_REF_FORMAT = '[`primary:orders.customer_email`](data-conn:primary/orders?col=customer_email)';

const UNIVERSAL_OUTPUT_RULES = [
	'',
	'# Output rules',
	'',
	'- Reply with the JSON outline object only -- no fences, no prose, no preamble.',
	'- `id` is a stable slug (letters / digits / hyphen). Section ids appear in cache keys; do not reuse ids.',
	'- `intent` is a SHORT brief telling the section writer what to produce, NOT the section body.',
	'- The LAST section MUST be a drill-down footer with `id: "drill-down"` and `title: "Drill down"`. Its intent should ask for 3-5 candidate next-step analyses.',
	'- Sections are independent unless `dependsOn` is set; favour independence so pass-2 can parallelise.',
].join('\n');

const COMMON_SECTION_RULES = [
	'',
	'# Output rules',
	'',
	'- Markdown body for THIS section ONLY.',
	'- Do NOT include the `## <title>` heading -- the stitcher prepends it.',
	'- Do NOT wrap the reply in code fences (```).',
	'- No prose preamble ("Here is the section:", "Below is...").',
	'- Every claim must trace to a citation when one is available.',
	`- DB-target citations use the data-conn: scheme: ${DATA_REF_FORMAT}.`,
	`- Code cross-reference citations (for lineage findings) use the path: scheme: ${CODE_REF_FORMAT}.`,
	'- When you mention a DB target (table, column, key pattern) by name AND a citation for it exists in the inputs, wrap the name as a clickable data-conn: link instead of just backticks. Same rule for code cross-references -- prefer:',
	`    ${DATA_REF_FORMAT}  (do this for DB targets)`,
	`    ${CODE_REF_FORMAT}      (do this for code cross-refs)`,
	'    `customer_email`                                                       (avoid -- bare backticks render as plain code spans, no navigation)',
	'  Bare backticks are still fine for entity names with NO citation.',
	'- Sample values (PII matches, drift hits) belong INLINE in their citation\'s sampleValue, not in prose. The renderer collapses them under a `Sample` disclosure to keep the primary view clean.',
].join('\n');

// ---------------------------------------------------------------------------
// Tier-specific shape briefs
// ---------------------------------------------------------------------------

const M_OUTLINE_BRIEF = [
	'# Tier brief: M (single table / namespace) report',
	'',
	'Plan 3-5 sections. Required:',
	'  1. `summary`        -- 2-3 sentences; bottom-line answer + the 1-2 highest-impact findings.',
	'  2. `schema`         -- the live shape (table columns + types, KV value shape, file headers). Bullet list or markdown table.',
	'  3+ Optional `findings-<concern>` sections per concern present in the run (PII, drift, consistency).',
	'  N. `drill-down`    -- 3-5 candidate next-step analyses. ALWAYS LAST.',
	'',
	'Density target: 3-6 KB. Prose for the summary; tables and bullets for the rest.',
].join('\n');

const L_OUTLINE_BRIEF = [
	'# Tier brief: L (single connection / full audit) report',
	'',
	'Plan 5-7 sections. Required:',
	'  1. `summary`        -- 3-5 sentences; bottom-line + 2-3 highest-impact findings.',
	'  2. `connection-overview` -- markdown table; one row per table covered. Columns: Table, Rows (approx), Key concerns.',
	'  3+ One or more `table-<slug>` sections -- per-table column-level summary + any findings against the table.',
	'  N. `cross-cutting` (optional, only when warranted -- PII patterns appearing across multiple tables, drift caused by a shared expected source).',
	'  N+1. `drill-down` -- 3-5 candidate next-step analyses. ALWAYS LAST.',
	'',
	'Density target for the final stitched report: 6-10 KB. Bullets and tables, NOT prose paragraphs. Per-section budget ~1500 tokens so the doc stays under the per-section ceiling.',
].join('\n');

const XL_OUTLINE_BRIEF = [
	'# Tier brief: XL (multi-connection / cross-DB) report',
	'',
	'Plan 4-5 sections. Required:',
	'  1. `summary`              -- 2-4 sentences; the cross-DB shape + the most-significant findings.',
	'  2. `connection-map`       -- markdown table. Columns: Connection, Family/Kind, Tables (count), Top concerns.',
	'  3. `cross-connection-findings` -- bullets / tables for findings that span connections (drift, lineage gaps, PII patterns occurring across DBs).',
	'  4. `er` (optional, only when an ER kind was in the plan) -- ER topology over the cited tables.',
	'  5. `drill-down`           -- 3-5 candidate next-step analyses. ALWAYS LAST.',
	'',
	'NO per-row content. NO 30-line code listings. The output is a map, not a data dump. File-level citations (path / connection only, no column) are FINE at this tier.',
].join('\n');

const M_SECTION_BRIEF = [
	'# Tier brief: M section writer',
	'',
	'Per section type:',
	'  - `summary`              -> 2-3 sentences (the only place prose is OK).',
	'  - `schema`               -> markdown table (Column / Type / Nullable / Notes) for RDBMS; bullets for KV value shape; CSV header table for files.',
	'  - `findings-<concern>`   -> bullet list. Per finding:',
	`      - **[severity] <issue>** -- ${DATA_REF_FORMAT}`,
	'  - `drill-down`           -> 3-5 bullets, format:',
	'      - **<one-line question>** -- scope: `<connection | table | key pattern>`',
].join('\n');

const L_SECTION_BRIEF = [
	'# Tier brief: L section writer',
	'',
	'Density: bullets + tables. NO multi-paragraph prose. If you find yourself writing a third paragraph in a row, replace it with a bullet list.',
	'',
	'Per section type:',
	'  - `summary`             -> 3-5 sentences (the only place prose is OK).',
	'  - `connection-overview` -> markdown table (Table / Rows / Key concerns).',
	'  - `table-*`             -> column-level bullets:',
	`      - \`column_name\` (type, nullable) -- ${DATA_REF_FORMAT}`,
	'      followed by a per-finding bullet list (severity / concern / one-line issue).',
	'  - `cross-cutting`       -> bullet list of cross-cutting findings + the tables they touch.',
	'  - `drill-down`          -> 3-5 bullets, format:',
	'      - **<one-line question>** -- scope: `<connection | table | key pattern>`',
].join('\n');

const XL_SECTION_BRIEF = [
	'# Tier brief: XL section writer',
	'',
	'Connection-level shape; tables and bullets only. NO per-finding paragraphs. NO per-line citations -- file-level (path / connection only) or table-level only.',
	'',
	'Per section type:',
	'  - `summary`                       -> 2-4 sentences.',
	'  - `connection-map`                -> markdown table (Connection / Family / Kind / Tables / Top concerns).',
	'  - `cross-connection-findings`     -> bullets `<finding>` -- spans <connection-A>, <connection-B>.',
	'  - `er`                            -> ER topology table or link to the artifact.',
	'  - `drill-down`                    -> 3-5 bullets, format:',
	'      - **<one-line question>** -- scope: `<connection | table | key pattern>`',
].join('\n');

function outlineBriefForTier(tier: ScopeSize): string {
	switch (tier) {
		case 'S':
		case 'M':
			return M_OUTLINE_BRIEF;
		case 'L':
			return L_OUTLINE_BRIEF;
		case 'XL':
		case 'XXL':
		case 'XXXL':
		case 'XXXXL':
			return XL_OUTLINE_BRIEF;
	}
}

function sectionBriefForTier(tier: ScopeSize): string {
	switch (tier) {
		case 'S':
		case 'M':
			return M_SECTION_BRIEF;
		case 'L':
			return L_SECTION_BRIEF;
		case 'XL':
		case 'XXL':
		case 'XXXL':
		case 'XXXXL':
			return XL_SECTION_BRIEF;
	}
}

// ---------------------------------------------------------------------------
// Outline pass
// ---------------------------------------------------------------------------

export interface MultipassOutlineInput {
	readonly system: string;
	readonly user: string;
	readonly maxSections: number;
	readonly maxTokens: number;
}

/**
 * Build the OUTLINE-pass prompts. The model returns a JSON outline
 * (1-12 sections); the orchestrator injects a synthetic drill-down
 * section if the model didn't include one.
 */
export function buildMultipassOutlineInput(
	request: string,
	acceptedResults: readonly AcceptedTask[],
	plannedTasks: readonly DataAnalysisTask[],
	tier: ScopeSize,
): MultipassOutlineInput {
	const system = [
		'You are the structural planner for a Data Analyzer report. Plan the section list a writer will fill in pass 2.',
		'',
		outlineBriefForTier(tier),
		UNIVERSAL_OUTPUT_RULES,
	].join('\n');

	const planSummary = plannedTasks.length === 0
		? '(empty)'
		: plannedTasks.map((t, i) => `  ${i + 1}. [${t.kind}] ${t.question}`).join('\n');

	const findingsSummary = acceptedResults.length === 0
		? '(no accepted results)'
		: acceptedResults
			.map(({ task, result }, i) =>
				`  [${i + 1}] ${task.kind} -- ${task.question} (confidence=${result.confidence}; ${result.findings.length} findings; ${result.citations.length} citations)`,
			)
			.join('\n');

	const user = [
		`# Run tier: ${tier}`,
		'',
		'# Original request',
		request,
		'',
		'# Plan summary (in original order)',
		planSummary,
		'',
		'# Accepted findings summary',
		findingsSummary,
		'',
		'# Output',
		'Plan the report\'s section list now. Reply with the JSON outline object only.',
	].join('\n');

	return {
		system,
		user,
		// Tier briefs ask for 3-7 sections; allow headroom up to 8 but
		// keep the schema's hard cap of 12 in play.
		maxSections: 8,
		maxTokens:   1200,
	};
}

// ---------------------------------------------------------------------------
// Section pass
// ---------------------------------------------------------------------------

/**
 * Build a `SectionPromptBuilder` closure that captures the run's
 * request + findings and produces system + user prompts per section.
 */
export function makeSectionBuilder(
	request: string,
	acceptedResults: readonly AcceptedTask[],
	tier: ScopeSize,
): (args: SectionBuildArgs) => { system: string; user: string } {
	const findingsBlock = renderFindingsBlock(acceptedResults);
	const sectionBrief  = sectionBriefForTier(tier);

	return (args: SectionBuildArgs): { system: string; user: string } => {
		const system = [
			`You are the section writer for one section of a Data Analyzer report (tier ${tier}).`,
			'',
			sectionBrief,
			COMMON_SECTION_RULES,
		].join('\n');

		const priorBodies = renderPriorBodies(args);

		const user = [
			`# Run tier: ${tier}`,
			'',
			'# Original request',
			request,
			'',
			`# This section: ${args.section.title}`,
			`# Section id:  ${args.section.id}`,
			'# Section intent',
			args.section.intent,
			...(priorBodies.length > 0 ? ['', '# Bodies of dependent sections (already drafted)', priorBodies] : []),
			'',
			'# Accepted findings',
			findingsBlock,
			'',
			'# Output',
			'Write the body of THIS section only. Markdown. Do not include the `## ' + args.section.title + '` heading.',
		].join('\n');

		return { system, user };
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderFindingsBlock(acceptedResults: readonly AcceptedTask[]): string {
	if (acceptedResults.length === 0) {
		return '(no accepted results)';
	}
	return acceptedResults
		.map(({ task, result }, i) => {
			const head = `[${i + 1}] ${task.kind} -- ${task.question} (confidence=${result.confidence})`;
			const body = JSON.stringify(
				{
					answer: result.answer,
					findings: result.findings,
					citations: result.citations,
				},
				null,
				2,
			);
			return `${head}\n${body}`;
		})
		.join('\n\n');
}

function renderPriorBodies(args: SectionBuildArgs): string {
	const dependsOn = args.section.dependsOn ?? [];
	if (dependsOn.length === 0) {
		return '';
	}
	const lines: string[] = [];
	for (const depId of dependsOn) {
		const r = args.prior.get(depId);
		if (r === undefined) {
			lines.push(`### ${depId}\n_(not yet available)_`);
			continue;
		}
		lines.push(`### ${depId}\n${r.body}`);
	}
	return lines.join('\n\n');
}

// ---------------------------------------------------------------------------
// Drill-down footer fallback
// ---------------------------------------------------------------------------

/**
 * Synthetic drill-down section the orchestrator can append when the
 * outline LLM omits one. Caller checks `outline.sections` for an
 * existing drill-down (id `drill-down` OR title `/drill[-\s]?down/i`)
 * and only appends this when none is present.
 */
export const DRILL_DOWN_FALLBACK_SECTION = {
	id: 'drill-down',
	title: 'Drill down',
	intent: '3-5 candidate next-step analyses the user could run as scoped child runs. Each bullet: **<one-line question>** -- scope: `<connection | table | key pattern>`.',
} as const;
