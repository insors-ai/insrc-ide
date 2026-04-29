/**
 * Analyzer-family @-mention parser
 * (plans/analyzers/code-analyzer.md Phase 4.3).
 *
 * Lets users target a specific analyzer family explicitly in chat:
 *
 *   @code-analyzer       what calls authMiddleware?
 *   @data-analyzer       describe the users table
 *   @deployment-analyzer compare staging and prod env vars
 *
 * The chat-handler's family-direct dispatcher recognises these
 * prefixes and routes the inner prompt to the named family. Distinct
 * from `agent/framework/provider-mention.ts` (which handles LLM
 * provider overrides like `@local` / `@anthropic` for the next step
 * within an agent run): provider mentions live INSIDE an analyzer
 * run; family mentions choose which analyzer the run belongs to.
 *
 * Sibling families (data-analyzer, deployment-analyzer) haven't
 * shipped yet -- the dispatcher recognises their mentions and
 * surfaces a "not yet registered" message so the user sees the
 * mention was understood. When those families ship, their
 * registration adds the routing target and the same dispatcher
 * fires their flow without further changes here.
 */

export type AnalyzerFamily = 'code-analyzer' | 'data-analyzer' | 'deployment-analyzer';

const FAMILY_TOKENS: readonly AnalyzerFamily[] = [
	'code-analyzer',
	'data-analyzer',
	'deployment-analyzer',
];

/**
 * Match `@<family> <prompt>` at the start of a message. Capture
 * groups: 1 = family token, 2 = remaining prompt (may be empty).
 */
const FAMILY_MENTION_RE = /^@(code-analyzer|data-analyzer|deployment-analyzer)(?:\s+([\s\S]+))?$/i;

export interface ParsedAnalyzerMention {
	readonly family: AnalyzerFamily;
	/** Prompt text after the `@<family>` prefix (trimmed). May be empty. */
	readonly prompt: string;
}

/**
 * Parse an analyzer-family @-mention from the start of a message.
 * Returns null when no recognised family mention is present.
 */
export function parseAnalyzerMention(message: string): ParsedAnalyzerMention | null {
	const trimmed = message.trim();
	const match = FAMILY_MENTION_RE.exec(trimmed);
	if (!match) {
		return null;
	}
	const familyRaw = (match[1] ?? '').toLowerCase();
	if (!isAnalyzerFamily(familyRaw)) {
		return null;
	}
	const prompt = (match[2] ?? '').trim();
	return { family: familyRaw, prompt };
}

export function isAnalyzerFamily(value: string): value is AnalyzerFamily {
	return (FAMILY_TOKENS as readonly string[]).includes(value);
}
