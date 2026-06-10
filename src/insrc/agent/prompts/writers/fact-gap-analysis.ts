/**
 * fact-gap-analysis writer v1 -- Stage 0 of the section-flow per-TODO
 * loop. Cloud LLM enumerates the facts a TODO needs and marks each as
 * present / partial / absent against the accumulated working memory.
 *
 * Migrated from `agent/section-flow/step-fact-gap-analysis.ts`'s inline
 * ANALYZER_ROLE + buildAnalyzerUser as part of Phase 0 of
 * `plans/section-flow-architecture-redesign.md`. Behaviour-preserving;
 * the test in `__tests__/step-fact-gap-analysis.test.ts` continues to
 * assert the same structural properties of the rendered prompt.
 */

import type { LLMMessage } from '../../../shared/types.js';
import type { CatalogSkill } from '../../content-gen/plan-tree-runner.js';
import type { CloudMemoryView } from '../../working-memory/index.js';
import type { TodoSpec } from '../../section-flow/types.js';
import type { PromptWriter } from '../types.js';

export interface FactGapAnalysisWriterInput {
	readonly todo:               TodoSpec;
	/**
	 * Cloud-tier memory view. The renderer reads the five legacy
	 * fields (system / summary / recent / semantic / code) verbatim
	 * AND -- when present -- a closing `FACT LEDGER` block sourced
	 * from `view.factLedger`. The artifact TOC is intentionally NOT
	 * rendered here: fact-gap analysis runs BEFORE any step has
	 * executed for this TODO, so the TOC is either empty or carries
	 * only cross-TODO artifacts the analyzer can't reason about
	 * without distracting noise.
	 */
	readonly memory:             CloudMemoryView;
	readonly catalog:            readonly CatalogSkill[];
	readonly isRetry:            boolean;
	readonly priorFailureReason: string | undefined;
}

const ANALYZER_ROLE = [
	'You are the FACT-GAP ANALYZER for one TODO of an investigation report.',
	'You read the TODO\'s objective + the accumulated working memory and',
	'enumerate the FACTS needed to answer the TODO, marking each as already',
	'present in memory or absent (a gap to acquire).',
	'',
	'Your output is a SINGLE JSON object matching the schema. No prose,',
	'no markdown fences, no preamble.',
].join('\n');

function buildAnalyzerUser(input: FactGapAnalysisWriterInput): string {
	const memoryBlock  = renderMemory(input.memory);
	const catalogBlock = renderCatalogSummary(input.catalog);
	const retryAddendum = input.isRetry
		? [
			'',
			'## RETRY CORRECTION',
			`Your previous response was rejected: ${input.priorFailureReason ?? 'unknown'}`,
			'Emit a new JSON object that satisfies every rule below.',
			'',
		].join('\n')
		: '';

	return [
		'## TODO OBJECTIVE',
		input.todo.objective,
		'',
		'## WORKING MEMORY (L1-L5 bundle)',
		memoryBlock,
		'',
		'## ANALYSIS TASK',
		'Enumerate the FACTS needed to fully answer the TODO objective. For',
		'EACH fact, decide its current availability status:',
		'',
		'  - `present`  : the fact is already in working memory (verbatim or',
		'                  paraphrased; cite the source via sourceRef).',
		'  - `partial`  : memory has SOME of the fact but not enough to',
		'                  answer the TODO completely; needs supplementation.',
		'  - `absent`   : memory does not contain the fact; must be acquired',
		'                  via a skill call.',
		'',
		'For `absent` facts (and `partial` if helpful), suggest 1-3 catalog',
		'skill ids that could acquire the fact. Suggestions are advisory --',
		'the downstream planner is the authority on skill selection.',
		'',
		'## OUTPUT SHAPE',
		'Emit a JSON object with EXACTLY these two top-level keys (literal names):',
		'  - `reasoning`     (string): one short sentence describing how you',
		'                     decided which facts the TODO needs.',
		'  - `requiredFacts` (array of 1-12 objects): the facts themselves.',
		'',
		'Each object inside `requiredFacts` MUST have these keys (literal names):',
		'  - `id`        (string): kebab-case, unique within this response',
		'                 (e.g. "ingrn-class-fields", "json-vendor-shape").',
		'  - `fact`      (string): the claim itself, written as a self-',
		'                 contained sentence (e.g. "INGRN declares 21 fields").',
		'  - `why`       (string): one sentence on the role of this fact',
		'                 in answering the TODO.',
		'  - `status`    (string): "present" | "partial" | "absent".',
		'  - `sourceRef` (optional object): REQUIRED when status is',
		'                 "present" or "partial". One of:',
		'                   { "kind": "memory-layer", "layer": "summary"|"recent"|"semantic"|"code", "excerpt": "..." }',
		'                   { "kind": "prior-todo",   "todoId": "<earlier-todo-id>",                    "excerpt": "..." }',
		'                 `excerpt` is short (≤200 chars) so the reviewer can verify.',
		'  - `suggestedSkills` (optional array of skill-id strings):',
		'                 used for "absent"/"partial"; omit or empty for "present".',
		'                 MUST be ids drawn from the SKILL CATALOG section below.',
		'',
		'Example skeleton (illustrative -- replace contents, do NOT copy verbatim):',
		'```',
		'{',
		'  "reasoning": "Need both the INGRN class shape and a sample JSON row to map them.",',
		'  "requiredFacts": [',
		'    {',
		'      "id":     "ingrn-class-fields",',
		'      "fact":   "INGRN declares the field list and types for a goods-receipt-note row.",',
		'      "why":    "Baseline mapping target -- without it, no JSON-to-class mapping is possible.",',
		'      "status": "absent",',
		'      "suggestedSkills": ["code.class.extract-fields"]',
		'    }',
		'  ]',
		'}',
		'```',
		'',
		'## RULES',
		'  - Emit 1-12 entries in `requiredFacts`. Fewer is better -- each',
		'    entry should be a distinct piece of evidence the TODO needs,',
		'    not a granular sub-claim.',
		'  - Do NOT mark an entry `status: "present"` based on optimism --',
		'    if memory only HINTS at the fact, mark it `partial` or `absent`.',
		'    Misclassifying a gap as present causes the loop to skip',
		'    acquisition and the synthesis stage to lack evidence.',
		'  - `suggestedSkills` MUST contain only ids from the SKILL CATALOG.',
		'  - Do NOT invent extra top-level keys (no `todoId`, no `objective`,',
		'    no `facts`). Only `reasoning` and `requiredFacts`.',
		retryAddendum,
		'',
		catalogBlock,
		'',
		'## EMIT',
		'Return a single JSON object matching the OUTPUT SHAPE above.',
		'Begin with "{" and end with "}". No prose, no markdown fences.',
	].join('\n');
}

function renderMemory(memory: CloudMemoryView): string {
	const lines: string[] = [];
	if (memory.system.length > 0)     { lines.push('### system\n' + memory.system); }
	if (memory.summary.length > 0)    { lines.push('### summary\n' + memory.summary); }
	if (memory.recent.length > 0)     { lines.push('### recent\n' + memory.recent); }
	if (memory.semantic.length > 0)   { lines.push('### semantic\n' + memory.semantic); }
	if (memory.code.length > 0)       { lines.push('### code\n' + memory.code); }
	if (memory.factLedger.length > 0) { lines.push('### factLedger\n' + memory.factLedger); }
	return lines.length > 0 ? lines.join('\n\n') : '(empty -- this is the first TODO of the report)';
}

function renderCatalogSummary(catalog: readonly CatalogSkill[]): string {
	if (catalog.length === 0) { return '## SKILL CATALOG (empty)'; }
	const lines: string[] = [`## SKILL CATALOG (${catalog.length} skills available)`];
	for (const s of catalog) {
		const desc = s.description.replace(/\s+/g, ' ').trim().slice(0, 120);
		lines.push(`- \`${s.id}\` -- ${desc}`);
	}
	return lines.join('\n');
}

export const factGapAnalysisWriterV1: PromptWriter<FactGapAnalysisWriterInput, readonly LLMMessage[]> = {
	id:      'fact-gap-analysis',
	version: 1,
	tier:    'cloud',
	summary: 'Stage 0: enumerate the facts a TODO needs and mark each present / partial / absent against working memory.',

	build(input: FactGapAnalysisWriterInput): readonly LLMMessage[] {
		return [
			{ role: 'system', content: ANALYZER_ROLE },
			{ role: 'user',   content: buildAnalyzerUser(input) },
		];
	},
};

export const _buildAnalyzerUserForTest   = buildAnalyzerUser;
export const _renderMemoryForTest        = renderMemory;
export const _renderCatalogSummaryForTest = renderCatalogSummary;
