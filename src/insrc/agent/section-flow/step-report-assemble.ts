/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Final report assembler (planner-section-task-separation P4, part 1).
 *
 * Takes every completed `WorkingMemoryEntry.detail` markdown block in
 * investigation-plan order and produces a coherent report -- an intro
 * tying the question to what was covered, the per-TODO sections in
 * order, and a conclusion stitching their findings together. One LLM
 * call.
 *
 * Q7 sub-Q7a: whole-report LLM rewrite (not diff/patch). The model
 * sees the user question + every section markdown verbatim and emits
 * the final report markdown directly. No JSON envelope -- the
 * response IS the report.
 *
 * Defensive behaviour:
 *   - 0 entries -> short-circuit with a structured empty marker.
 *   - LLM returns empty -> fall back to deterministic concatenation
 *     (each entry's detail wrapped with a `## {objective}` header).
 *     The report review (Q7 part 2) still runs and can flag the
 *     fallback as revise-edits / revise-structural.
 */

import type { LLMMessage, LLMProvider } from '../../shared/types.js';
import type { WorkingMemoryEntry } from '../working-memory/types.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('section-flow:report-assemble');

/**
 * Output budget for the LLM call. Reports are typically 5-7 sections
 * with ~500-800 tokens each plus intro/conclusion -- 16k gives plenty
 * of headroom without inviting padding.
 */
const MAX_ASSEMBLE_TOKENS = 16_384;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ReportAssembleInput {
	readonly question: string;
	readonly entries:  readonly WorkingMemoryEntry[];
	readonly provider: LLMProvider;
}

export interface ReportAssembleResult {
	readonly report:        string;
	/** True when the LLM produced an empty body and we fell back to deterministic concat. */
	readonly usedFallback:  boolean;
}

export async function assembleReport(
	input: ReportAssembleInput,
): Promise<ReportAssembleResult> {
	if (input.entries.length === 0) {
		log.warn('assembleReport: zero entries -> empty marker');
		return {
			report:       `_(no sections were produced for this report)_`,
			usedFallback: true,
		};
	}

	const messages: LLMMessage[] = [
		{ role: 'system', content: ASSEMBLE_ROLE },
		{ role: 'user',   content: buildAssembleUser(input) },
	];
	const response = await input.provider.complete(messages, {
		maxTokens:       MAX_ASSEMBLE_TOKENS,
		temperature:     0,
		disableThinking: true,
		// NOT responseFormat: 'json' -- the output is markdown, not JSON.
	});
	const text = response.text.trim();
	if (text.length === 0) {
		log.warn({ entryCount: input.entries.length }, 'assembleReport: empty LLM response -> deterministic fallback');
		return {
			report:       deterministicConcat(input.question, input.entries),
			usedFallback: true,
		};
	}
	return {
		report:       text,
		usedFallback: false,
	};
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const ASSEMBLE_ROLE = [
	'You are the REPORT ASSEMBLER. You receive the user\'s original',
	'question plus a sequence of completed section markdown blocks (one',
	'per investigation TODO, in execution order). You emit the FULL',
	'final report markdown -- no JSON envelope, no preamble, no',
	'commentary.',
	'',
	'Structure the report as:',
	'  1. A short intro paragraph that names the question and previews',
	'     what the sections cover.',
	'  2. The sections IN ORDER, each preserved as a top-level',
	'     markdown block. You may add a `##` heading per section using',
	'     the TODO\'s objective if the section\'s own markdown lacks one.',
	'  3. A short conclusion that synthesises the sections\' findings',
	'     and answers the original question.',
	'',
	'Preserve the content of each section as-is. You may add transition',
	'sentences at section boundaries and rewrite intro/conclusion freely,',
	'but do not invent findings the sections do not contain.',
].join('\n');

function buildAssembleUser(input: ReportAssembleInput): string {
	const sectionsBlock = input.entries.map((e, i) => {
		return [
			`### Section ${i + 1} (TODO ${e.todoId})`,
			`Objective: ${e.objective}`,
			'',
			'```markdown',
			e.detail,
			'```',
		].join('\n');
	}).join('\n\n');

	return [
		'## USER QUESTION',
		input.question,
		'',
		'## COMPLETED SECTIONS (in execution order)',
		sectionsBlock,
		'',
		'## TASK',
		'Emit the full final report markdown now. No JSON envelope, no',
		'preamble, no commentary -- just the markdown.',
	].join('\n');
}

// ---------------------------------------------------------------------------
// Deterministic fallback
// ---------------------------------------------------------------------------

function deterministicConcat(question: string, entries: readonly WorkingMemoryEntry[]): string {
	const parts: string[] = [`# Report\n\n_(Assembled deterministically; the LLM assembler returned an empty body.)_\n\n## Question\n\n${question}\n`];
	for (const e of entries) {
		parts.push(`## ${e.objective}\n\n${e.detail}`);
	}
	return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _buildAssembleUserForTest    = buildAssembleUser;
export const _deterministicConcatForTest  = deterministicConcat;
