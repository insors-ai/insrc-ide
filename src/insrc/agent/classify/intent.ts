/**
 * Primary-intent classification wrapper.
 *
 * Thin glue between the generic `classify()` module and the top-level
 * chat pipeline: handles the `/intent` + `@provider` prefix overrides
 * (which bypass LLM classification entirely) and returns the unified
 * shape all callers (chat-handler, agent/index, agent/cli) expect.
 *
 * The wrapper exists because prefix parsing is a pipeline concern that
 * shouldn't leak into the generic classifier. Without it every caller
 * would have to duplicate the same "parse prefixes, skip LLM if
 * override set" dance.
 */

import type { ExplicitProvider, Intent } from '../../shared/types.js';
import type { Session } from '../session.js';
import type { ScopeSize } from '../../shared/classify.js';
import { parsePrefix } from '../prefix.js';
import { classify } from './index.js';
import { resolveClassifierProvider } from './provider.js';
import { INTENT_CLASSES } from '../../shared/intent-classes.js';
import { SLASH_COMMANDS } from '../../shared/slash-commands.js';

export interface IntentClassifyResult {
  /** Resolved primary intent. */
  readonly intent: Intent;
  /** 0..1 confidence (1.0 for prefix-override path). */
  readonly confidence: number;
  /** Explicit provider override if the user prefixed @<provider>. */
  readonly explicit?: ExplicitProvider | undefined;
  /** Message body with prefixes stripped. */
  readonly message: string;
  /** One-sentence reasoning from the LLM. Empty for prefix overrides. */
  readonly reasoning: string;
  /**
   * Scope / size estimate produced alongside the class. 'M' for prefix
   * overrides (no LLM call -- callers can re-classify if they need a
   * real scope) and fallback paths.
   */
  readonly scope: ScopeSize;
  /** True when the classifier errored and fell back to classes[0]. */
  readonly fallback: boolean;
}

/**
 * Classify the primary intent of a user message.
 *
 * 1. Parse `/intent <name>` and `@<provider>` prefixes off the front.
 * 2. If the user set `/intent` explicitly, short-circuit with
 *    `confidence = 1.0` and skip the LLM call.
 * 3. Otherwise run the generic classifier against INTENT_CLASSES using
 *    the session's classifier provider (resolver cascade: per-step
 *    override -> active cloud -> local).
 */
export async function classifyPrimaryIntent(
  raw: string,
  session: Session,
): Promise<IntentClassifyResult> {
  const prefix = parsePrefix(raw);

  if (prefix.intentOverride) {
    return {
      intent: prefix.intentOverride,
      confidence: 1.0,
      explicit: prefix.explicit,
      message: prefix.message,
      reasoning: 'explicit /intent override',
      scope: 'M',
      fallback: false,
    };
  }

  const result = await classify(
    {
      role: 'intent classifier for a coding assistant',
      classes: INTENT_CLASSES,
      text: prefix.message,
      context: buildClassifierContext(session),
    },
    resolveClassifierProvider(session, 'classify'),
  );

  return {
    intent: result.id as Intent,
    confidence: result.confidence,
    explicit: prefix.explicit,
    message: prefix.message,
    reasoning: result.reasoning,
    scope: result.scope,
    fallback: result.fallback,
  };
}

/**
 * Build the classifier context block the LLM sees alongside the
 * intent-class list. Three sections:
 *
 *   1. Active repo signal -- if the session has a repo loaded, this
 *      is a strong prior that the user is asking about THIS code,
 *      which makes `code-analysis` the default for ambiguous prompts
 *      and `research` only correct when the user is explicitly
 *      asking about something OUTSIDE the repo.
 *
 *   2. Research vs. code-analysis tiebreaker -- the failure mode
 *      that drove this hint: bare follow-ups like "describe HDFS
 *      Core" landed in `research` because the LLM saw the
 *      research-shaped verb "describe" without context. The rule
 *      below biases the classifier toward `code-analysis` when the
 *      noun is plausibly an in-repo entity / module / file / class.
 *
 *   3. Slash-command awareness -- existing block. Helps with `/foo`
 *      typos so the classifier doesn't topic-classify a near-miss
 *      slash literal into a tangentially-related intent.
 */
function buildClassifierContext(session: Session): string {
	const lines: string[] = [];

	const repoPath = session.repoPath ?? '';
	if (repoPath.length > 0) {
		lines.push(`Active repository: \`${repoPath}\` (the user has a repo loaded; questions about this code default to code-analysis).`);
		lines.push('');
	}

	lines.push('Research vs. code-analysis tiebreaker:');
	lines.push('- `research` is for EXTERNAL information lookup ONLY: web search, third-party package docs, external API references, library / framework behaviour, vendor specs, blog posts. Pick `research` ONLY when the user is explicitly asking about something the project itself cannot answer.');
	lines.push('- `code-analysis` is the DEFAULT for any read-only question about THIS project -- "describe X", "what does X do", "summarise X", "where is X", "how does X work", "explain the auth flow", "list the modules", "find callers of X". A follow-up that names a module / file / class / function from a prior in-repo answer is also `code-analysis`, even when it is one short verb plus a noun.');
	lines.push('- A research-shaped verb (describe, summarise, explain) does NOT make a prompt research. The deciding question is "is the answer inside this repo?" -- if yes, code-analysis. If the answer requires consulting external sources, research.');
	lines.push('');

	lines.push('Registered chat slash commands (these are exact-match-only on the dispatcher):');
	for (const cmd of SLASH_COMMANDS) {
		lines.push(`- /${cmd.id}: ${cmd.description}`);
	}
	lines.push('');
	lines.push('If the input begins with `/<name>` (the leading slash is a strong signal), the user is attempting a slash command:');
	lines.push('- If `<name>` matches one of the registered ids verbatim, the dispatcher already handled it -- you will not see that message.');
	lines.push('- If `<name>` is close to a registered id (typo), the dispatcher emitted a "did you mean" hint -- you will not see that message either.');
	lines.push('- If `<name>` is unfamiliar AND not close to any registered id, classify by the user\'s INTENT (what they\'re asking for after the slash), not by the slash literal itself. Do NOT route on the slash text alone.');
	return lines.join('\n');
}
