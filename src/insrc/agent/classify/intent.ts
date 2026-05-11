/**
 * Primary-intent classification -- INTERNAL implementation only.
 *
 * **STANDING RULE** (plans/intent-classification-consolidation.md,
 * Phase 7): the SOLE legal caller of `classifyPrimaryIntent` is
 * `agent/intent/resolver.ts:resolveIntent`. New code that wants to
 * pick an intent for a user message imports `resolveIntent` from
 * `agent/intent/resolver.ts`. No other module classifies intent.
 *
 * The function stays exported (not module-private) because the
 * regression suite in `__tests__/intent.test.ts` exercises its
 * prompt rendering directly. CI enforces the rule via a grep-based
 * assert in `__tests__/funnel-enforcement.test.ts`: any production
 * module outside the resolver that imports this function fails
 * the build.
 *
 * Historical note: before Phase 6 this function was called from
 * three additional places (daemon/chat-handler.ts:1803,
 * agent/cli.ts:172, agent/index.ts:284). Each had its own subset
 * of context (active repo / prior intent tag / memory) and drifted
 * independently -- the trigger bug ("elaborate on X" misclassified
 * as research) lived in exactly that drift. The resolver is now
 * the single funnel; this module is its implementation detail.
 */

import type { ExplicitProvider, Intent } from '../../shared/types.js';
import type { Session } from '../session.js';
import type { ClassifyRelationship, ScopeSize } from '../../shared/classify.js';
import { parsePrefix } from '../prefix.js';
import { classify } from './index.js';
import { resolveClassifierProvider } from './provider.js';
import { INTENT_CLASSES } from '../../shared/intent-classes.js';
import { SLASH_COMMANDS } from '../../shared/slash-commands.js';
import type { ClassifierMemory } from '../intent/classifier-memory.js';
import { RELATIONSHIP_KINDS, type RelationshipKind } from '../intent/relationship.js';

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
  /**
   * Relationship to recent conversation activity. Present iff `memory`
   * was supplied with at least one turn or segment hit (the cold path
   * in the resolver). The `kind` is one of `RELATIONSHIP_KINDS`;
   * `citations` are RAW string keys (e.g. ["t1", "s2"]) -- the resolver
   * is responsible for hydrating them into MemoryCitation objects via
   * `hydrateRelationshipCitations`.
   */
  readonly relationship?: ClassifyRelationship & { kind: RelationshipKind } | undefined;
}

/**
 * Classify the primary intent of a user message.
 *
 * 1. Parse `/intent <name>` and `@<provider>` prefixes off the front.
 * 2. If the user set `/intent` explicitly, short-circuit with
 *    `confidence = 1.0` and skip the LLM call.
 * 3. Otherwise run the generic classifier against INTENT_CLASSES using
 *    the session's classifier provider (resolver cascade: per-step
 *    override -> active cloud -> local). When `memory` is supplied
 *    AND non-empty, the prompt grows a `## Recent context` block AND
 *    the response schema grows a `relationship` block (Phase 4 of
 *    plans/intent-classification-consolidation.md).
 */
export async function classifyPrimaryIntent(
  raw: string,
  session: Session,
  memory?: ClassifierMemory,
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

  const memoryHasHits = memory !== undefined
    && (memory.turns.length > 0 || memory.segments.length > 0);

  const baseContext = buildClassifierContext(session);
  const memoryContext = memoryHasHits ? renderMemoryContextBlock(memory!) : '';
  const fullContext = memoryContext.length > 0
    ? `${baseContext}\n\n${memoryContext}`
    : baseContext;

  const result = await classify(
    {
      role: 'intent classifier for a coding assistant',
      classes: INTENT_CLASSES,
      text: prefix.message,
      context: fullContext,
      ...(memoryHasHits ? { relationshipEnum: RELATIONSHIP_KINDS } : {}),
    },
    resolveClassifierProvider(session, 'classify'),
  );

  // Project the generic ClassifyRelationship into the typed
  // RelationshipKind shape. Defensive: if memory was empty we never
  // asked for a relationship, so leave the field undefined.
  const relationship = (memoryHasHits && result.relationship !== undefined)
    ? {
        ...result.relationship,
        kind: (RELATIONSHIP_KINDS as readonly string[]).includes(result.relationship.kind)
          ? result.relationship.kind as typeof RELATIONSHIP_KINDS[number]
          : RELATIONSHIP_KINDS[0],
      }
    : undefined;

  return {
    intent: result.id as Intent,
    confidence: result.confidence,
    explicit: prefix.explicit,
    message: prefix.message,
    reasoning: result.reasoning,
    scope: result.scope,
    fallback: result.fallback,
    ...(relationship !== undefined ? { relationship } : {}),
  };
}

/**
 * Render the classifier-memory bundle as a `## Recent context`
 * block. Format mirrors the spec in
 * plans/intent-classification-consolidation.md Phase 4.1: each
 * turn / segment item is prefixed with a stable [tN] / [sN]
 * citation key so the LLM's `relationship.citations` array can
 * point back to specific memory items.
 *
 * Returns an empty string when both lists are empty (caller should
 * have already filtered, but defensive).
 */
function renderMemoryContextBlock(memory: ClassifierMemory): string {
  if (memory.turns.length === 0 && memory.segments.length === 0) return '';

  const lines: string[] = [];
  lines.push('## Recent context');
  if (memory.turns.length > 0) {
    lines.push(`### Recent turns (${memory.turns.length}, sorted by recency)`);
    memory.turns.forEach((t, i) => {
      const ageStr = formatRelativeAge(t.timestamp);
      const role   = t.role.toUpperCase();
      const rel    = t.relevance.toFixed(2);
      lines.push(
        `[t${i + 1}] (${ageStr}, ${role}, relevance ${rel}, id=${t.turnId})`,
        `      > ${t.excerpt.replace(/\n/g, '\n      > ')}`,
      );
    });
  }
  if (memory.segments.length > 0) {
    lines.push(`### Relevant segments from prior responses (${memory.segments.length}, by relevance)`);
    memory.segments.forEach((s, i) => {
      const rel = s.relevance.toFixed(2);
      lines.push(
        `[s${i + 1}] (turn ${s.turnId} segment ${s.segmentIdx}, relevance ${rel}, id=${s.segmentId})`,
        `      > ${s.text.replace(/\n/g, '\n      > ')}`,
      );
    });
  }
  return lines.join('\n');
}

function formatRelativeAge(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return 'unknown age';
  const deltaMs = Date.now() - epochMs;
  if (deltaMs < 0) return 'just now';
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60)         return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60)         return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24)          return `${hr} hr ago`;
  const day = Math.floor(hr / 24);
  return `${day} day${day === 1 ? '' : 's'} ago`;
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
