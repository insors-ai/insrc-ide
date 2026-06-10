/**
 * memory-shape writers v1 -- three local-tier writers used by the
 * working-memory shaper.
 *
 *   - memory-shape.single    Single-call path (memory fits one window).
 *   - memory-shape.map       Per-chunk map step in the chunked path.
 *   - memory-shape.reduce    Final consolidation across chunk partials.
 *
 * Migrated from `agent/working-memory/shaper.ts`'s SHAPING_ROLE /
 * MAP_ROLE / REDUCE_ROLE + their build functions as part of Phase 0 of
 * `plans/section-flow-architecture-redesign.md`. Behaviour-preserving.
 */

import type { LLMMessage } from '../../../shared/types.js';
import type { PromptWriter } from '../types.js';

// Mirror the shaper's TokenBudget shape without importing it (the
// shaper module's types stay private to working-memory; writers
// receive the budget as an input field).
export interface MemoryShapeTokenBudget {
	readonly system:   number;
	readonly summary:  number;
	readonly recent:   number;
	readonly semantic: number;
	readonly code:     number;
}

// ---------------------------------------------------------------------------
// memory-shape.single
// ---------------------------------------------------------------------------

export interface MemoryShapeSingleWriterInput {
	readonly memory:    string;
	readonly objective: string;
	readonly budget:    MemoryShapeTokenBudget;
}

const SHAPING_ROLE = [
	'You are the LOCAL CONTEXT-ASSEMBLY model for an agentic reporting system.',
	'Given a WORKING MEMORY file (chronological prior-turn outputs) and an',
	'INPUT PROMPT, you produce a SINGLE JSON object that packs the memory',
	'into 5 layered context slots for a downstream planner. You always emit',
	'exactly the schema you are given, with no prose, no markdown fences.',
].join('\n');

function buildShapingSchema(budget: MemoryShapeTokenBudget): string {
	return [
		'## OUTPUT SHAPE (emit EXACTLY this object, NO other keys)',
		'',
		'{',
		`  "system":   <string, max ${budget.system} tokens>,`,
		`  "summary":  <string, max ${budget.summary} tokens>,`,
		`  "recent":   <string, max ${budget.recent} tokens>,`,
		`  "semantic": <string, max ${budget.semantic} tokens>,`,
		`  "code":     <string, max ${budget.code} tokens>`,
		'}',
		'',
		'## FIELD CONTRACT (every field MUST be filled when source content exists)',
		'',
		'  system    Fixed evergreen context: project name, primary subject, file',
		'            kinds the memory refers to. Stable across iterations.',
		'',
		'  summary   Rolling 1-2 paragraph TL;DR of what the accumulated memory',
		'            says so far. The bullet-point essentials. No citations.',
		'',
		'  recent    REQUIRED if memory has more than one turn. Bullet list of',
		'            salient findings from the LAST 2-3 sections/turns. Cite',
		'            section titles by name. DO NOT leave empty.',
		'',
		'  semantic  REQUIRED if any memory content relates to the INPUT PROMPT.',
		'            Bullet list of items from ANY turn (not just recent) that bear',
		'            on the INPUT PROMPT. Cite section titles. DO NOT leave empty.',
		'',
		'  code      Code / data shapes / schemas / field tables found in memory.',
		'            Verbatim quotes or tight summaries.',
		'',
		'## RULES',
		'  - Token caps are HARD. ~3 chars ~= 1 token. Stay under each cap.',
		'  - Empty string "" ONLY when the source truly has nothing for that field.',
		'  - Do not duplicate content across layers.',
		'  - Do not invent content not in the memory.',
	].join('\n');
}

function buildShapingUser(input: MemoryShapeSingleWriterInput): string {
	return [
		'## INPUT PROMPT',
		input.objective,
		'',
		'## WORKING MEMORY',
		input.memory,
		'',
		buildShapingSchema(input.budget),
		'',
		'## TASK',
		'Emit the JSON object now. Begin with "{" and end with "}".',
	].join('\n');
}

export const memoryShapeWriterV1: PromptWriter<MemoryShapeSingleWriterInput, readonly LLMMessage[]> = {
	id:      'memory-shape.single',
	version: 1,
	tier:    'local',
	summary: 'Single-call working-memory shaper: pack memory into the 5-layer bundle.',

	build(input: MemoryShapeSingleWriterInput): readonly LLMMessage[] {
		return [
			{ role: 'system', content: SHAPING_ROLE },
			{ role: 'user',   content: buildShapingUser(input) },
		];
	},
};

// ---------------------------------------------------------------------------
// memory-shape.map
// ---------------------------------------------------------------------------

export interface MemoryShapeMapWriterInput {
	readonly chunkContent: string;
	readonly chunkIndex:   number;
	readonly total:        number;
	readonly objective:    string;
	readonly perFieldCharCap: number;
}

const MAP_ROLE = [
	'You are distilling ONE slice of a larger working-memory document.',
	'Given one CHUNK plus the INPUT PROMPT that the orchestrator is planning',
	'against, you emit a SINGLE JSON object with four distilled fields. You',
	'output exactly the schema given, with no prose, no markdown fences.',
].join('\n');

function buildMapSchema(perFieldCharCap: number): string {
	return [
		'## OUTPUT SHAPE (emit EXACTLY this object, NO other keys)',
		'',
		'{',
		`  "summary":  <string, ~${perFieldCharCap} chars>,`,
		`  "recent":   <string, ~${perFieldCharCap} chars>,`,
		`  "semantic": <string, ~${perFieldCharCap} chars>,`,
		`  "code":     <string, ~${perFieldCharCap} chars>`,
		'}',
		'',
		'## FIELD CONTRACT (fill every field that has source content)',
		'',
		'  summary   1-2 sentence TL;DR of THIS chunk.',
		'  recent    Bullet list of salient findings from this chunk. Cite',
		'            section/heading names. REQUIRED unless chunk is empty.',
		'  semantic  Bullet list of items in this chunk relevant to the INPUT',
		'            PROMPT. REQUIRED if anything in the chunk relates to it.',
		'  code      Code / data shapes / schemas / field tables in this chunk.',
		'',
		'## RULES',
		'  - Use empty string "" ONLY when the chunk truly has nothing for that field.',
		'  - Do not invent content not in the chunk.',
		'  - This is one of many chunks; do not speculate about content you have not seen.',
	].join('\n');
}

function buildMapUser(input: MemoryShapeMapWriterInput): string {
	return [
		'## INPUT PROMPT',
		input.objective,
		'',
		`## CHUNK ${input.chunkIndex + 1}/${input.total}`,
		input.chunkContent,
		'',
		buildMapSchema(input.perFieldCharCap),
		'',
		'## TASK',
		`Emit the JSON object for chunk ${input.chunkIndex + 1}/${input.total} now. Begin with "{" and end with "}".`,
	].join('\n');
}

export const memoryShapeMapWriterV1: PromptWriter<MemoryShapeMapWriterInput, readonly LLMMessage[]> = {
	id:      'memory-shape.map',
	version: 1,
	tier:    'local',
	summary: 'Per-chunk map step in the chunked working-memory shaper.',

	build(input: MemoryShapeMapWriterInput): readonly LLMMessage[] {
		return [
			{ role: 'system', content: MAP_ROLE },
			{ role: 'user',   content: buildMapUser(input) },
		];
	},
};

// ---------------------------------------------------------------------------
// memory-shape.reduce
// ---------------------------------------------------------------------------

export interface ChunkPartial {
	readonly summary:  string;
	readonly recent:   string;
	readonly semantic: string;
	readonly code:     string;
}

export interface MemoryShapeReduceWriterInput {
	readonly partials:  readonly ChunkPartial[];
	readonly objective: string;
	readonly budget:    MemoryShapeTokenBudget;
}

const REDUCE_ROLE = [
	'You are the LOCAL CONTEXT-ASSEMBLY model.',
	'Given a list of PER-CHUNK DISTILLATIONS and the INPUT PROMPT the',
	'orchestrator is planning against, you consolidate them into a SINGLE',
	'JSON object packing 5 layered context slots for a downstream planner.',
	'You always emit exactly the schema you are given, with no prose, no',
	'markdown fences.',
].join('\n');

function buildReduceSchema(budget: MemoryShapeTokenBudget, chunkCount: number): string {
	return [
		'## OUTPUT SHAPE (emit EXACTLY this object, NO other keys)',
		'',
		'{',
		`  "system":   <string, max ${budget.system} tokens>,`,
		`  "summary":  <string, max ${budget.summary} tokens>,`,
		`  "recent":   <string, max ${budget.recent} tokens>,`,
		`  "semantic": <string, max ${budget.semantic} tokens>,`,
		`  "code":     <string, max ${budget.code} tokens>`,
		'}',
		'',
		'## FIELD CONTRACT (every field MUST be filled when source content exists)',
		'',
		'  system    Fixed evergreen context: project name, primary subject, file',
		'            kinds. Infer from distillations. Stable across iterations.',
		'',
		'  summary   Rolling TL;DR. Merge the per-chunk `summary` fields into a',
		'            coherent 1-2 paragraph overview.',
		'',
		`  recent    REQUIRED. Bullet list. Pull the per-chunk \`recent\` entries`,
		`            from the LAST ~3 of ${chunkCount} chunk(s) (the most recent`,
		'            turns). DO NOT leave empty if any later chunk had `recent`',
		'            content. This is the single most important field for the',
		'            downstream planner.',
		'',
		'  semantic  REQUIRED. Bullet list. Pull per-chunk `semantic` entries',
		'            from ANY chunk -- these are items relevant to the INPUT',
		'            PROMPT regardless of chunk position. DO NOT leave empty if',
		'            any chunk had `semantic` content.',
		'',
		'  code      Code / schemas / field tables from any chunk\'s `code`',
		'            field. Verbatim or tight summary.',
		'',
		'## RULES',
		'  - Token caps are HARD. ~3 chars ~= 1 token. Stay under each cap.',
		'  - Empty string "" ONLY when NO chunk has content for that field.',
		'  - Do not duplicate content across layers.',
		'  - Do not invent content beyond what the distillations contain.',
	].join('\n');
}

function buildReduceUser(input: MemoryShapeReduceWriterInput): string {
	const partialsBlock = input.partials.map((p, i) => [
		`--- chunk ${i + 1}/${input.partials.length} ---`,
		`summary:  ${p.summary}`,
		`recent:   ${p.recent}`,
		`semantic: ${p.semantic}`,
		`code:     ${p.code}`,
	].join('\n')).join('\n\n');

	return [
		'## INPUT PROMPT',
		input.objective,
		'',
		'## PER-CHUNK DISTILLATIONS',
		partialsBlock,
		'',
		buildReduceSchema(input.budget, input.partials.length),
		'',
		'## TASK',
		'Emit the consolidated JSON object now. Begin with "{" and end with "}".',
	].join('\n');
}

export const memoryShapeReduceWriterV1: PromptWriter<MemoryShapeReduceWriterInput, readonly LLMMessage[]> = {
	id:      'memory-shape.reduce',
	version: 1,
	tier:    'local',
	summary: 'Reduce step in the chunked working-memory shaper: consolidate per-chunk partials.',

	build(input: MemoryShapeReduceWriterInput): readonly LLMMessage[] {
		return [
			{ role: 'system', content: REDUCE_ROLE },
			{ role: 'user',   content: buildReduceUser(input) },
		];
	},
};
