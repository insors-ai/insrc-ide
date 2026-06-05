/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Bullet extractor (planner-section-task-separation P1.e).
 *
 * Takes a completed WorkingMemoryEntry and produces 5-10
 * prompt-AGNOSTIC key facts that the orchestrator persists to the
 * `working_memory_bullets` LanceDB cache. At the next TODO's shaping
 * step, the updater embeds the next objective and ANN-retrieves the
 * top-K bullets across the run -- this replaces the LLM-based
 * `updateSemantic` call with a cheap vector lookup (Q1.1 mitigation
 * 1, the major Hadoop cost mitigation).
 *
 * Quality contract: bullets are prompt-agnostic. They name concrete
 * findings, class/file/section identifiers, and gaps -- NOT
 * inferences tied to the TODO's specific framing. Otherwise the cache
 * would only ever help the next-similar-prompt and we'd miss
 * cross-TODO relevance.
 *
 * Single LLM call; ~5-10 seconds budget; runs as part of the TODO
 * cleanup step (after section review accepts).
 */

import type { LLMMessage, LLMProvider } from '../../shared/types.js';
import type { WorkingMemoryEntry } from './types.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('working-memory-bullets');

/** Hard ceiling on bullets per TODO. Output prompt asks for 5-10. */
const MAX_BULLETS_PER_TODO = 12;

/** Max output tokens. Each bullet is ~30-50 tokens; 5-10 bullets -> ~500 tokens upper bound. */
const MAX_EXTRACT_TOKENS = 1024;

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

function buildExtractorPrompt(entry: WorkingMemoryEntry, count: { min: number; max: number }): { system: string; user: string } {
	const findings = entry.findings.perRoot.length === 0
		? '(no findings)'
		: entry.findings.perRoot.map(r => `- ${r.rootId}: ${r.content}`).join('\n');
	const user = [
		`## TODO OBJECTIVE (the producing TODO, for context only)`,
		entry.objective,
		'',
		'## FINDINGS',
		findings,
		'',
		'## SECTION DETAIL',
		entry.detail,
		'',
		'## OUTPUT SHAPE (emit EXACTLY this object)',
		'',
		'{',
		`  "bullets": [<${count.min}-${count.max} prompt-agnostic key fact strings>]`,
		'}',
		'',
		'## RULES',
		`  - ${count.min}-${count.max} bullets, each <= 300 chars.`,
		'  - Concrete (cite class / file / section / field / verdict names).',
		'  - Prompt-agnostic (do NOT reference the TODO objective above).',
		'  - No questions, no recommendations, no future-tense plans.',
		'',
		'## TASK',
		'Emit the JSON object now. Begin with "{" and end with "}".',
	].join('\n');
	return { system: EXTRACTOR_ROLE, user };
}

export interface ExtractBulletsOpts {
	/** Minimum bullets to ask the LLM for. Default 5. */
	readonly minCount?: number;
	/** Maximum bullets to ask the LLM for. Default 10. Hard-clamped to MAX_BULLETS_PER_TODO. */
	readonly maxCount?: number;
}

/**
 * Extract prompt-agnostic bullets from a completed entry. Returns an
 * empty array on parse failure (rather than throwing) so a single
 * extraction miss doesn't fail the whole TODO transition.
 */
export async function extractBullets(
	provider: LLMProvider,
	entry: WorkingMemoryEntry,
	opts: ExtractBulletsOpts = {},
): Promise<string[]> {
	const min = Math.max(1, opts.minCount ?? 5);
	const max = Math.min(MAX_BULLETS_PER_TODO, Math.max(min, opts.maxCount ?? 10));
	const { system, user } = buildExtractorPrompt(entry, { min, max });
	const messages: LLMMessage[] = [
		{ role: 'system', content: system },
		{ role: 'user',   content: user   },
	];
	const response = await provider.complete(messages, {
		maxTokens:       MAX_EXTRACT_TOKENS,
		temperature:     0,
		responseFormat:  'json',
		disableThinking: true,
	});
	const bullets = parseBullets(response.text);
	if (bullets.length === 0) {
		log.warn({ todoId: entry.todoId, rawPreview: response.text.slice(0, 200) }, 'bullet extraction returned no bullets');
		return [];
	}
	// Hard clamp at MAX_BULLETS_PER_TODO even when the model overshoots.
	const clamped = bullets.slice(0, MAX_BULLETS_PER_TODO);
	log.info({ todoId: entry.todoId, count: clamped.length }, 'bullets extracted');
	return clamped;
}

function parseBullets(raw: string): string[] {
	let text = raw.trim();
	if (text.startsWith('```')) {
		text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return [];
	}
	const obj = parsed as Record<string, unknown>;
	const bullets = obj['bullets'];
	if (!Array.isArray(bullets)) {
		return [];
	}
	return bullets
		.filter((b): b is string => typeof b === 'string' && b.trim().length > 0)
		.map(b => b.trim());
}

export const _parseBulletsForTest      = parseBullets;
export const _buildExtractorPromptForTest = buildExtractorPrompt;
export const MAX_BULLETS_PER_TODO_VALUE   = MAX_BULLETS_PER_TODO;
