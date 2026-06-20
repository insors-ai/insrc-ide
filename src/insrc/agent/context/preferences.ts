/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * L1 preferences section -- pulls active-owner user-asserted preferences out of the
 * substrate, applies G4 hard scope filter + G7 noise threshold, optionally curates
 * relevance via local LLM (G5-style; chat-side equivalent uses session rolling
 * topic instead of step intent per G9), and renders a markdown block to be
 * concatenated with the static L1 system context.
 *
 * Plan ref: M1.8 of plans/memory-context.md. Design ref: G4 / G5 / G7 / G9 of
 * design/memory-context.html.
 *
 * Behaviour without substrate: returns '' silently. Behaviour without local
 * provider: returns the unfiltered (post-G4, post-G7) preferences. Behaviour
 * with both: curated subset.
 */

import { Type } from '@sinclair/typebox';
import type { LLMProvider, LLMMessage } from '../../shared/types.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('agent:context:preferences');


// ---------------------------------------------------------------------------
// Types (subset of substrate types; defined locally to keep agent/context
// free of a hard substrate dep). The shape mirrors `UserAssertionPayload`'s
// optional G3/G4 fields populated by the Ollama hook.
// ---------------------------------------------------------------------------

export interface PreferenceCandidate {
	readonly subject:        string;          // PreferenceSubject when populated by Ollama; legacy free-form otherwise
	readonly canonicalText:  string;
	readonly categories?:    readonly string[] | undefined;
	readonly repoPaths?:     readonly string[] | undefined;
	readonly confidence:     number;
}

export interface BuildPreferencesOpts {
	/** Active owner's preferences pulled from substrate (post-noise-threshold). */
	readonly candidates:     readonly PreferenceCandidate[];
	/** Active session repo path. Used for the G4 hard scope filter. */
	readonly repoPath:       string;
	/**
	 * Session "rolling topic" -- short string describing what the conversation
	 * is currently about. Used as the G5 relevance signal for local-LLM
	 * curation. Pass an empty string to skip the curation pass (returns the
	 * scope-filtered list).
	 */
	readonly sessionTopic:   string;
	/** Local LLM provider for relevance curation. Undefined = skip curation. */
	readonly localProvider?: LLMProvider | undefined;
}


// ---------------------------------------------------------------------------
// Build the preferences markdown section
// ---------------------------------------------------------------------------

export async function buildOwnerPreferencesSection(opts: BuildPreferencesOpts): Promise<string> {
	// Stage 1: G4 hard scope filter (repoPaths).
	const scoped = opts.candidates.filter(c => matchesRepoScope(c, opts.repoPath));
	if (scoped.length === 0) {
		return '';
	}

	// Stage 2: G5-style local-LLM relevance curation when a provider is wired.
	// Skip when there's no provider (curation absent), no topic (no signal to
	// rank against), or scoped.length === 1 (nothing to filter).
	let curated: readonly PreferenceCandidate[] = scoped;
	if (opts.localProvider !== undefined && opts.sessionTopic.length > 0 && scoped.length > 1) {
		try {
			curated = await curateByRelevance(scoped, opts.sessionTopic, opts.localProvider);
		} catch (err) {
			log.warn({ err: (err as Error).message }, 'preferences relevance curation failed; using scope-filtered list');
			curated = scoped;
		}
	}
	if (curated.length === 0) {
		// Curator dropped everything -- bias toward inclusion: fall back to the
		// scope-filtered set so we never silently lose preferences (G5 inclusion bias).
		log.warn('curation produced empty set; falling back to scope-filtered list');
		curated = scoped;
	}

	return renderPreferencesMarkdown(curated);
}


function matchesRepoScope(c: PreferenceCandidate, currentRepoPath: string): boolean {
	if (c.repoPaths === undefined || c.repoPaths.length === 0) {
		// Preference has no repo restriction -> applies everywhere.
		return true;
	}
	return c.repoPaths.includes(currentRepoPath);
}


// ---------------------------------------------------------------------------
// Local-LLM relevance curation (G5-style, applied to chat session topic)
// ---------------------------------------------------------------------------

interface CurationResponse {
	readonly relevant_indices: readonly number[];
}

// plans/structured-output.md Phase C.3. TypeBox schema replaces the
// hand-rolled JSON Schema map so the wire layer enforces shape via
// provider.completeStructured.
const CURATION_SCHEMA = Type.Object({
	relevant_indices: Type.Array(Type.Integer({ minimum: 0 }), { uniqueItems: true }),
});

const CURATION_SYSTEM_PROMPT = `You filter a list of user preferences for relevance to the current conversation.

You will see:
  1. A short summary of what the user's session is currently about (the "topic").
  2. A numbered list of preferences (each: subject + canonical text).

Output ONLY a JSON object: { "relevant_indices": [<indices of preferences to include>] }.

Rules:
  - BIAS TOWARD INCLUSION. When in doubt, include. The cost of including an irrelevant rule is a few tokens; the cost of dropping a relevant rule is silently violating user guidance.
  - Include a preference if it COULD apply to the topic, even loosely.
  - Drop only preferences that are clearly orthogonal (e.g. a deploy-timing rule when the topic is purely about code style).
  - Index from 0.

If the topic is empty or unclear, include everything.`;


async function curateByRelevance(
	candidates: readonly PreferenceCandidate[],
	topic:      string,
	provider:   LLMProvider,
): Promise<readonly PreferenceCandidate[]> {
	const numbered = candidates.map((c, i) => `${i}. [${c.subject}] ${c.canonicalText}`).join('\n');
	const messages: LLMMessage[] = [
		{ role: 'system', content: CURATION_SYSTEM_PROMPT },
		{ role: 'user',   content: `Topic:\n${topic}\n\nPreferences:\n${numbered}` },
	];

	// plans/structured-output.md Phase C.3. provider.completeStructured
	// guarantees the response conforms to CURATION_SCHEMA. The retry
	// helper handles transient drift; unrecoverable failure degrades
	// to inclusion bias (G5 bias from memory-context M-C M1.8).
	let parsed: CurationResponse;
	try {
		parsed = await provider.completeStructured<CurationResponse>(
			messages,
			CURATION_SCHEMA,
			{ temperature: 0.1, maxTokens: 512 },
		);
	} catch (err) {
		log.warn({ err: (err as Error).message }, 'curator failed; including all (inclusion bias)');
		return candidates;
	}

	const include = new Set(parsed.relevant_indices);
	return candidates.filter((_c, i) => include.has(i));
}


// ---------------------------------------------------------------------------
// Render the curated list as markdown
// ---------------------------------------------------------------------------

function renderPreferencesMarkdown(curated: readonly PreferenceCandidate[]): string {
	const lines: string[] = [];
	lines.push('## Active user preferences');
	lines.push('');
	lines.push('The user has stated these durable preferences (apply them when relevant):');
	lines.push('');
	for (const c of curated) {
		lines.push(`- **[${c.subject}]** ${c.canonicalText}`);
	}
	return lines.join('\n');
}
