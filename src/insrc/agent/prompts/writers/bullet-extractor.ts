/**
 * bullet-extractor writer v1 -- local-tier extractor that pulls
 * prompt-agnostic key facts from a completed working-memory entry
 * for caching in the bullet cache.
 *
 * Migrated from `agent/working-memory/bullet-extractor.ts`'s inline
 * EXTRACTOR_ROLE + buildExtractorPrompt as part of Phase 0 of
 * `plans/section-flow-architecture-redesign.md`. Behaviour-preserving.
 */

import type { LLMMessage } from '../../../shared/types.js';
import type { WorkingMemoryEntry } from '../../working-memory/types.js';
import type { PromptWriter } from '../types.js';

export interface BulletExtractorWriterInput {
	readonly entry: WorkingMemoryEntry;
	readonly count: { min: number; max: number };
}

const EXTRACTOR_ROLE = [
	'You are extracting prompt-AGNOSTIC key facts from one completed',
	'investigation TODO. The facts you emit will be cached as semantic',
	'memory and retrieved when a FUTURE, DIFFERENT prompt asks a related',
	'question. They MUST be useful across many possible follow-up',
	'questions, not just the one this TODO answered.',
	'',
	'GOOD bullets (concrete, transferable):',
	'  - "NameNode persists namespace via FSImage + EditLog;',
	'    BlockManager owns BlocksMap and triggers replication"',
	'  - "DataNode write pipeline: BlockReceiver -> upstream node; checksums',
	'    verified per packet"',
	'',
	'BAD bullets (prompt-coupled, narrow):',
	'  - "Yes, the next subsystem to investigate is DataNode" (tied to',
	'    one specific question)',
	'  - "We have not yet covered RPC details" (a gap-statement that',
	'    only makes sense in the original framing)',
	'',
	'Emit a SINGLE JSON object with one key `bullets`: an array of 5-10',
	'short strings. No prose, no markdown fences, no preamble.',
].join('\n');

function buildExtractorUser(input: BulletExtractorWriterInput): string {
	const findings = input.entry.findings.perRoot.length === 0
		? '(no findings)'
		: input.entry.findings.perRoot.map(r => `- ${r.rootId}: ${r.content}`).join('\n');
	return [
		`## TODO OBJECTIVE (the producing TODO, for context only)`,
		input.entry.objective,
		'',
		'## FINDINGS',
		findings,
		'',
		'## SECTION DETAIL',
		input.entry.detail,
		'',
		'## OUTPUT SHAPE (emit EXACTLY this object)',
		'',
		'{',
		`  "bullets": [<${input.count.min}-${input.count.max} prompt-agnostic key fact strings>]`,
		'}',
		'',
		'## RULES',
		`  - ${input.count.min}-${input.count.max} bullets, each <= 300 chars.`,
		'  - Concrete (cite class / file / section / field / verdict names).',
		'  - Prompt-agnostic (do NOT reference the TODO objective above).',
		'  - No questions, no recommendations, no future-tense plans.',
		'',
		'## TASK',
		'Emit the JSON object now. Begin with "{" and end with "}".',
	].join('\n');
}

export const bulletExtractorWriterV1: PromptWriter<BulletExtractorWriterInput, readonly LLMMessage[]> = {
	id:      'bullet-extractor',
	version: 1,
	tier:    'local',
	summary: 'Extract prompt-agnostic key facts from a completed TODO for the bullet cache.',

	build(input: BulletExtractorWriterInput): readonly LLMMessage[] {
		return [
			{ role: 'system', content: EXTRACTOR_ROLE },
			{ role: 'user',   content: buildExtractorUser(input) },
		];
	},
};
