/**
 * memory-update writers v1 -- three local-tier per-layer updaters used
 * by the working-memory incremental updater.
 *
 *   - memory-update.summary
 *   - memory-update.recent
 *   - memory-update.semantic
 *
 * Migrated from `agent/working-memory/updater.ts`'s SUMMARY_ROLE /
 * RECENT_ROLE / SEMANTIC_ROLE constants as part of Phase 0 of
 * `plans/section-flow-architecture-redesign.md`. The user-prompt
 * construction stays in updater.ts (it's call-site-specific and
 * branches by layer); these writers wrap just the system prompts and
 * give the registry a single-source-of-truth for the layer roles.
 */

import type { LLMMessage } from '../../../shared/types.js';
import type { PromptWriter } from '../types.js';

export type MemoryUpdateLayer = 'summary' | 'recent' | 'semantic';

export interface MemoryUpdateWriterInput {
	readonly layer:    MemoryUpdateLayer;
	readonly userBody: string;
}

const COMMON_SYSTEM_HEADER = [
	'You are the LOCAL CONTEXT-ASSEMBLY model performing a SINGLE-LAYER',
	'incremental update on an existing working-memory bundle. Emit a JSON',
	'object with EXACTLY ONE string field. No prose, no markdown fences.',
].join('\n');

const L2_FALLBACK_RULE = [
	'',
	'## L2-FALLBACK HANDLING (critical)',
	'If a TODO carries an `!! L2 FALLBACK !!` marker in its findings, it',
	'produced NO concrete investigation data -- only a stub from the L2',
	'dispatcher. You MUST explicitly note the gap so the next TODO\'s',
	'planner knows not to rely on that TODO\'s output. Use phrasing like:',
	'"TODO X (objective: ...) routed to L2 fallback; the question of {...}',
	'remains unanswered." Do NOT paraphrase L2-stub content as if it were',
	'real evidence. Do NOT carry forward any specific claims sourced',
	'solely from an L2-fallback\'d TODO.',
].join('\n');

const SUMMARY_ROLE = [
	COMMON_SYSTEM_HEADER,
	'',
	'You update the `summary` layer. Read the prior summary + the newly-',
	'completed TODO\'s detail+findings. Emit an updated 1-2 paragraph',
	'TL;DR that captures the essentials of the accumulated memory so far.',
	'Do NOT cite section titles. Do NOT duplicate the recent or semantic',
	'layers (those are filled separately).',
	L2_FALLBACK_RULE,
].join('\n');

const RECENT_ROLE = [
	COMMON_SYSTEM_HEADER,
	'',
	'You update the `recent` layer. Read the deterministic slice of the',
	'last 2-3 entries\' findings + the NEXT TODO\'s objective. Emit a',
	'bullet list of the salient findings from those entries, biased toward',
	'items the next TODO will need. Cite section/finding sources by name.',
	L2_FALLBACK_RULE,
].join('\n');

const SEMANTIC_ROLE = [
	COMMON_SYSTEM_HEADER,
	'',
	'You update the `semantic` layer. Read the prior semantic content +',
	'the newly-completed entry\'s findings + the NEXT TODO\'s objective.',
	'Emit a bullet list of items from across the accumulated memory that',
	'bear specifically on the NEXT objective. Cite section/finding sources.',
	'Keep prior items only if they are still relevant; add items from the',
	'new entry if they bear on the next objective. CRITICAL: Before keeping',
	'a prior item, verify the new entry does not contradict or reframe it;',
	'if the new entry overrides the prior, REPLACE the item with one',
	'derived from the new entry. Do NOT preserve prior items by changing',
	'their label.',
	L2_FALLBACK_RULE,
].join('\n');

function roleFor(layer: MemoryUpdateLayer): string {
	switch (layer) {
		case 'summary':  return SUMMARY_ROLE;
		case 'recent':   return RECENT_ROLE;
		case 'semantic': return SEMANTIC_ROLE;
	}
}

export const memoryUpdateWriterV1: PromptWriter<MemoryUpdateWriterInput, readonly LLMMessage[]> = {
	id:      'memory-update',
	version: 1,
	tier:    'local',
	summary: 'Incremental single-layer working-memory update (summary / recent / semantic).',

	build(input: MemoryUpdateWriterInput): readonly LLMMessage[] {
		return [
			{ role: 'system', content: roleFor(input.layer) },
			{ role: 'user',   content: input.userBody },
		];
	},
};
