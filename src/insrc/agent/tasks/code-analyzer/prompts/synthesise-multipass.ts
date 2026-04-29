/**
 * Multi-pass synthesis prompts for the Code Analyzer L/XL/XXL+ tiers
 * (plans/analyzers/code-analyzer.md §5.4 + plans/content-generator.md).
 *
 * The single-pass `prompts/synthesise.ts` handles S/M tiers cleanly --
 * the doc fits in one local-model output window. L+ tiers blow past
 * devstral's `num_predict` ceiling (F10 hit "Unterminated string in
 * JSON at position 13186" on a 13 KB single-pass output). This file
 * supplies the prompts the orchestrator hands to
 * `generateMultiPass()`:
 *
 *   1. `buildMultipassOutlineInput(request, accepted, planned, tier)`
 *      -> system + user prompts the OUTLINE pass uses to plan the
 *         report's section list (5-7 sections at L/XL; 4-5 at XXL+).
 *
 *   2. `makeSectionBuilder(request, accepted, tier)` returns a
 *      `SectionPromptBuilder` (the closure `runSections` calls per
 *      section). Each call composes the system + user prompts for
 *      one section body, given the section plan + its dependencies'
 *      bodies + the full outline.
 *
 * Drill-down footer: the outline prompt requires the LAST section to
 * be a "Drill down" section. The orchestrator post-processes the
 * outline to inject one synthetically when the model omits it -- so
 * the workbench Report Pane's footer parser always finds something
 * to render.
 */

import type { ScopeSize } from '../../../../shared/classify.js';
import type { SectionBuildArgs } from '../../../content-gen/index.js';
import type { AnalysisTask, AnalyzerResult } from '../types.js';

// ---------------------------------------------------------------------------
// Shared blocks
// ---------------------------------------------------------------------------

const CITATION_FORMAT = '[`src/auth/token.ts:42-58`](path:src/auth/token.ts#L42-L58)';

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
	`- Use the path:line citation format the IDE recognises: ${CITATION_FORMAT}.`,
	'- When you mention an entity (function, class, method, type) by name AND a citation for it exists in the inputs, wrap the entity name as a clickable link instead of just backticks. Prefer:',
	`    ${CITATION_FORMAT}  (do this)`,
	'    `functionName`                                     (avoid -- bare backticks render as plain code spans, no navigation)',
	'  Bare backticks are still fine for entity names that have NO citation, or for inline keywords / language tokens.',
].join('\n');

// ---------------------------------------------------------------------------
// Tier-specific shape briefs
// ---------------------------------------------------------------------------

const L_XL_OUTLINE_BRIEF = [
	'# Tier brief: L / XL report',
	'',
	'Plan 5-7 sections. Required:',
	'  1. `summary`        -- 3-5 sentences; bottom-line answer + 2-3 highest-impact findings.',
	'  2. `module-overview` -- markdown table; one row per module / package covered. Columns: Module, Role, Key entities, Notes.',
	'  3+ One or more `module-detail-<slug>` sections -- signature-level bullets per module (NOT prose).',
	'  N. `cross-cutting` (optional, only when warranted).',
	'  N+1. `drill-down`   -- 3-5 candidate next-step analyses. ALWAYS LAST.',
	'',
	'Density target for the final stitched report: 6-10 KB. Bullets and tables, NOT prose paragraphs. The local writer model truncates above ~8 KB single-pass; pass-2 sections are budgeted at ~1500 tokens each so the doc stays under the per-section ceiling.',
].join('\n');

const XXL_OUTLINE_BRIEF = [
	'# Tier brief: XXL+ report',
	'',
	'Plan 4-5 sections. Required:',
	'  1. `summary`              -- 2-4 sentences; the architectural shape, not findings.',
	'  2. `module-map`           -- markdown table. Columns: Module, Path, Lines, Responsibility. File-level citations are fine; line ranges not required.',
	'  3. `responsibility-matrix` -- markdown table. One row per concern (auth, persistence, routing, ...) and a column per major module showing owns/uses/exposes.',
	'  4. `dependency-edges`     -- bullet list of structural deps. Format: `module-A` -> `module-B` -- one-line reason.',
	'  5. `drill-down`           -- 3-5 candidate next-step analyses. ALWAYS LAST.',
	'',
	'NO per-finding paragraphs. NO per-line citations. The structure IS the finding.',
].join('\n');

const L_XL_SECTION_BRIEF = [
	'# Tier brief: L / XL section writer',
	'',
	'Density: bullets + tables. NO multi-paragraph prose. If you find yourself writing a third paragraph in a row, replace it with a bullet list.',
	'',
	'Per section type:',
	'  - `summary`           -> 3-5 sentences (the only place prose is OK).',
	'  - `module-overview`   -> markdown table (Module / Role / Key entities / Notes).',
	'  - `module-detail-*`   -> signature-level bullets:',
	'      - `functionName(args)` -- one-line role.',
	`        ${CITATION_FORMAT}`,
	'  - `cross-cutting`     -> bullet list of cross-cutting concerns + the modules they touch.',
	'  - `drill-down`        -> 3-5 bullets, format:',
	'      - **<one-line question>** -- scope: `<path | module | entity>`',
].join('\n');

const XXL_SECTION_BRIEF = [
	'# Tier brief: XXL+ section writer',
	'',
	'Structural shape; tables and bullets only. NO per-finding paragraphs. NO per-line citations -- file-level or module-level only.',
	'',
	'Per section type:',
	'  - `summary`               -> 2-4 sentences.',
	'  - `module-map`            -> markdown table (Module / Path / Lines / Responsibility).',
	'  - `responsibility-matrix` -> markdown table (Concern / module-A / module-B / ...).',
	'  - `dependency-edges`      -> bullets `module-A` -> `module-B` -- reason.',
	'  - `drill-down`            -> 3-5 bullets, format:',
	'      - **<one-line question>** -- scope: `<path | module | entity>`',
].join('\n');

function outlineBriefForTier(tier: ScopeSize): string {
	switch (tier) {
		case 'L':
		case 'XL':
			return L_XL_OUTLINE_BRIEF;
		case 'XXL':
		case 'XXXL':
		case 'XXXXL':
			return XXL_OUTLINE_BRIEF;
		default:
			// S / M shouldn't reach here -- the orchestrator routes them
			// through single-pass synthesise. Defensive default.
			return L_XL_OUTLINE_BRIEF;
	}
}

function sectionBriefForTier(tier: ScopeSize): string {
	switch (tier) {
		case 'L':
		case 'XL':
			return L_XL_SECTION_BRIEF;
		case 'XXL':
		case 'XXXL':
		case 'XXXXL':
			return XXL_SECTION_BRIEF;
		default:
			return L_XL_SECTION_BRIEF;
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
	acceptedResults: readonly { task: AnalysisTask; result: AnalyzerResult }[],
	plannedTasks: readonly AnalysisTask[],
	tier: ScopeSize,
): MultipassOutlineInput {
	const system = [
		'You are the structural planner for a Code Analyzer report. Plan the section list a writer will fill in pass 2.',
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
				`  [${i + 1}] ${task.kind} -- ${task.question} (confidence=${result.confidence}; ${result.findings.length} findings)`,
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
		// Tier brief asks for 4-7 sections; allow a bit of headroom but
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
	acceptedResults: readonly { task: AnalysisTask; result: AnalyzerResult }[],
	tier: ScopeSize,
): (args: SectionBuildArgs) => { system: string; user: string } {
	const findingsBlock = renderFindingsBlock(acceptedResults);
	const sectionBrief  = sectionBriefForTier(tier);

	return (args: SectionBuildArgs): { system: string; user: string } => {
		const system = [
			`You are the section writer for one section of a Code Analyzer report (tier ${tier}).`,
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

function renderFindingsBlock(
	acceptedResults: readonly { task: AnalysisTask; result: AnalyzerResult }[],
): string {
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
 * and only appends this when none is present. Keeps the Report Pane
 * footer parser working even on a model that ignored the rule.
 */
export const DRILL_DOWN_FALLBACK_SECTION = {
	id: 'drill-down',
	title: 'Drill down',
	intent: '3-5 candidate next-step analyses the user could run as scoped child runs. Each bullet: **<one-line question>** -- scope: `<path | module | entity>`.',
} as const;
