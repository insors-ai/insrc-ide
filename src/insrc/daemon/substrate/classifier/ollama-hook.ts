/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Ollama-backed Layer 2 hook for the user-assertion classifier
 * (M1.4 of plans/memory-context.md; G1-G3 + G7 of design/memory-context.html).
 *
 * The substrate's classifier accepts an `LlmClassifyHook` as an injectable -- the
 * default returns 'defer' so the substrate stays LLM-free. This module produces
 * a hook backed by a real `LLMProvider` (Ollama in production, scripted in tests),
 * with structured output constrained via `responseFormat: { schema }` so the LLM
 * emits well-formed JSON the parser can consume.
 *
 * Output schema constrains:
 *   - `subject` to the closed `PreferenceSubject` enum (G3)
 *   - `verdict` to 'accept' | 'reject' | 'defer'
 *   - `relationship.kind` to G7 discriminator
 *
 * No semantic decisions are taken here. The hook:
 *   1. Builds the prompt + schema.
 *   2. Calls `provider.complete(...)` with `responseFormat: { schema: ... }`.
 *   3. Parses the JSON response.
 *   4. Translates to the substrate's `UserAssertionPayload` shape (legacy fields
 *      filled from the structured output; G3/G4/G7 fields populated verbatim).
 *
 * Live-LLM testing: see `__tests__/ollama-hook.live.test.ts`. Run with
 *   `OLLAMA_MODEL=qwen3-coder npx tsx --test daemon/substrate/__tests__/ollama-hook.live.test.ts`.
 */

import { Type } from '@sinclair/typebox';
import type { LLMProvider } from '../../../shared/types.js';
import { getLogger } from '../../../shared/logger.js';

import {
	PREFERENCE_SUBJECTS,
	PREFERENCE_SUBJECT_DESCRIPTIONS,
	isPreferenceSubject,
	type AssertionRelationship,
	type PreferenceSubject,
} from '../taxonomy/preference-subjects.js';

import type {
	AssertionPolarity,
	AssertionScope,
	LlmClassifyHook,
	UserAssertionPayload,
} from './user-assertion.js';

const log = getLogger('substrate:classifier:ollama-hook');


// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CreateOllamaHookOpts {
	readonly provider: LLMProvider;
	/** Optional: existing same-subject same-owner entries for relationship classification (G7). */
	readonly findRelatedEntries?: (span: string) => Promise<readonly { id: string; canonicalText: string; subject: PreferenceSubject }[]>;
}

/**
 * Build a Layer 2 hook backed by `opts.provider`. Pass the constructed hook to
 * `createDefaultClassifier({ llmClassify: hook })` in the substrate runtime
 * wiring (M1's substrate boot path).
 */
export function createOllamaLayer2Hook(opts: CreateOllamaHookOpts): LlmClassifyHook {
	return async (span, hints) => {
		const relatedEntries = opts.findRelatedEntries !== undefined
			? await opts.findRelatedEntries(span).catch(err => {
				log.warn({ err: (err as Error).message }, 'findRelatedEntries threw; treating as empty');
				return [] as readonly { id: string; canonicalText: string; subject: PreferenceSubject }[];
			})
			: [];

		const prompt = buildClassifyPrompt(span, relatedEntries);

		// plans/structured-output.md Phase C.4. provider.completeStructured
		// guarantees the response conforms to TYPEBOX_SCHEMA at the wire
		// layer (Ollama format field; cloud providers' native structured
		// output for future cloud-Layer-2 surfaces). normalizeParsedShape
		// applies the post-processing (clamp confidence, normalise
		// relationship discriminator) the legacy parseClassifyResponse
		// did inline.
		let parsed: ParsedResponse;
		try {
			const raw = await opts.provider.completeStructured<Record<string, unknown>>(
				[
					{ role: 'system', content: SYSTEM_PROMPT },
					{ role: 'user',   content: prompt },
				],
				TYPEBOX_SCHEMA,
				{ temperature: 0.1, maxTokens: 512 },
			);
			parsed = normalizeParsedShape(raw);
		} catch (err) {
			log.warn({ err: (err as Error).message, span: span.slice(0, 80) }, 'Layer 2 LLM call failed; deferring');
			return { kind: 'defer', reason: `LLM call failed: ${(err as Error).message}` };
		}

		if (parsed.verdict === 'reject') {
			return { kind: 'reject', reason: parsed.rationale };
		}

		if (parsed.verdict === 'defer') {
			return { kind: 'defer', reason: parsed.rationale };
		}

		// verdict === 'accept'
		const payload = buildPayload(span, parsed, hints.turnId);
		return { kind: 'accept', payload };
	};
}


// ---------------------------------------------------------------------------
// JSON schema sent to Ollama as responseFormat constraint.
//
// Format: JSON Schema draft-2020-12 (Ollama accepts this directly per their
// docs; deeper schemas reduce to the supported subset internally).
// ---------------------------------------------------------------------------

// plans/structured-output.md Phase C.4. TypeBox schema replaces the
// hand-rolled JSON Schema map. The shape is identical; typebox just
// gives us compile-time validation against ParsedResponse shape +
// uniform wire-layer enforcement via provider.completeStructured.
const TYPEBOX_SCHEMA = Type.Object({
	verdict:     Type.Union(['accept', 'reject', 'defer'].map(v => Type.Literal(v as 'accept' | 'reject' | 'defer'))),
	confidence:  Type.Number({ minimum: 0, maximum: 1 }),
	rationale:   Type.String(),
	subject:     Type.Optional(Type.Union(
		PREFERENCE_SUBJECTS.map(s => Type.Literal(s)),
	)),
	canonicalText: Type.Optional(Type.String()),
	categories:    Type.Optional(Type.Array(Type.String())),
	repoPaths:     Type.Optional(Type.Array(Type.String())),
	relationship:  Type.Optional(Type.Object({
		kind:        Type.Union([
			Type.Literal('independent'), Type.Literal('exact'),
			Type.Literal('refinement'),  Type.Literal('weakening'),
			Type.Literal('contradiction'),
		]),
		existingRef: Type.Optional(Type.String()),
	})),
});


// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
	const subjectLines = PREFERENCE_SUBJECTS.map(s => `  - ${s}: ${PREFERENCE_SUBJECT_DESCRIPTIONS[s]}`).join('\n');
	return `You classify whether a user's utterance contains a durable preference -- a rule the user wants the system to follow across sessions. Examples of valid preferences: "always include unit tests", "never use hasattr in Python code", "prefer functional over class components in React".

Output ONLY a JSON object matching the response schema. No prose.

Rules:
1. verdict: 'accept' if the utterance is a clear durable preference; 'reject' if it is conversational, tactical, or task-local; 'defer' if you are uncertain.
2. confidence: your own self-reported certainty about the verdict, 0..1.
3. subject (REQUIRED on accept): pick exactly one from the enum below. The descriptions disambiguate the categories -- read them before picking. Tests, mocking, coverage, and fixtures belong to 'test-policy', NOT 'code-style'. Naming, formatting, and structural conventions belong to 'code-style'.
4. canonicalText (on accept): the preference rephrased as an imperative-form rule. Remove project-specific details; keep the core principle.
5. categories (on accept, optional): when the preference applies to specific plan categories like 'implementation' or 'migration', list them. Omit if it applies broadly.
6. repoPaths (on accept, optional): when the preference applies only to certain repos, list absolute paths. Omit if it applies to all repos.
7. relationship (on accept): if you see any related existing entries provided in the prompt, classify the relationship: 'exact' (same intent, same content), 'refinement' (adds detail), 'weakening' (relaxes), 'contradiction' (opposes). Otherwise 'independent'. When the relationship is non-independent, include 'existingRef' pointing at the entry it relates to.
8. rationale: 1-2 sentences explaining your verdict for debugging.

Subject categories (pick exactly one on accept):
${subjectLines}

Bias toward 'defer' when uncertain. Bias toward 'reject' for conversational filler.`;
}

const SYSTEM_PROMPT = buildSystemPrompt();


function buildClassifyPrompt(
	span: string,
	relatedEntries: readonly { id: string; canonicalText: string; subject: PreferenceSubject }[],
): string {
	const parts: string[] = [];
	parts.push('User utterance to classify:');
	parts.push(`"${span}"`);
	parts.push('');
	if (relatedEntries.length > 0) {
		parts.push('Existing preferences potentially related (consider for relationship classification):');
		for (const entry of relatedEntries) {
			parts.push(`  - id="${entry.id}" subject="${entry.subject}" text="${entry.canonicalText}"`);
		}
		parts.push('');
	}
	parts.push('Respond with the JSON object per the schema.');
	return parts.join('\n');
}


// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

interface ParsedResponse {
	readonly verdict:       'accept' | 'reject' | 'defer';
	readonly confidence:    number;
	readonly rationale:     string;
	readonly subject?:      PreferenceSubject | undefined;
	readonly canonicalText?: string | undefined;
	readonly categories?:   readonly string[] | undefined;
	readonly repoPaths?:    readonly string[] | undefined;
	readonly relationship?: AssertionRelationship | undefined;
}


/**
 * plans/structured-output.md Phase C.4. Post-processes the already-
 * schema-validated raw output from provider.completeStructured:
 *   - clamps confidence to [0, 1] (the schema constrains it but a
 *     model that emits 1.000001 would slip through);
 *   - extracts the optional G3/G4/G7 fields with defensive type guards
 *     since the schema marks them optional;
 *   - normalises the relationship discriminator so unsupported shapes
 *     (e.g. kind='exact' without existingRef) decay to undefined
 *     rather than throwing.
 *
 * Replaces the legacy parseClassifyResponse(text) function -- the
 * text-level recovery (fence-stripping, regex extraction) is no
 * longer needed because provider.completeStructured guarantees the
 * payload arrives schema-conformant.
 */
function normalizeParsedShape(r: Record<string, unknown>): ParsedResponse {
	const verdict = r.verdict;
	if (verdict !== 'accept' && verdict !== 'reject' && verdict !== 'defer') {
		throw new Error(`invalid verdict: ${String(verdict)}`);
	}
	const confidence = typeof r.confidence === 'number' ? Math.max(0, Math.min(1, r.confidence)) : 0;
	const rationale = typeof r.rationale === 'string' ? r.rationale : '';

	const out: {
		verdict: 'accept' | 'reject' | 'defer';
		confidence: number;
		rationale: string;
		subject?: PreferenceSubject;
		canonicalText?: string;
		categories?: readonly string[];
		repoPaths?: readonly string[];
		relationship?: AssertionRelationship;
	} = { verdict, confidence, rationale };

	if (typeof r.subject === 'string' && isPreferenceSubject(r.subject)) {
		out.subject = r.subject;
	}
	if (typeof r.canonicalText === 'string' && r.canonicalText.length > 0) {
		out.canonicalText = r.canonicalText;
	}
	if (Array.isArray(r.categories) && r.categories.every(c => typeof c === 'string')) {
		out.categories = r.categories as readonly string[];
	}
	if (Array.isArray(r.repoPaths) && r.repoPaths.every(p => typeof p === 'string')) {
		out.repoPaths = r.repoPaths as readonly string[];
	}
	if (typeof r.relationship === 'object' && r.relationship !== null) {
		const rel = r.relationship as Record<string, unknown>;
		const kind = rel.kind;
		const existingRef = typeof rel.existingRef === 'string' ? rel.existingRef : undefined;
		if (kind === 'independent') {
			out.relationship = { kind: 'independent' };
		} else if (
			(kind === 'exact' || kind === 'refinement' || kind === 'weakening' || kind === 'contradiction')
			&& existingRef !== undefined
		) {
			out.relationship = { kind, existingRef };
		}
	}

	return out;
}


// ---------------------------------------------------------------------------
// Payload construction
// ---------------------------------------------------------------------------

function buildPayload(span: string, parsed: ParsedResponse, _turnId: string): UserAssertionPayload {
	// Legacy fields filled from the structured output for back-compat with the
	// existing runtime / index path. New (G3/G4/G7) fields populated directly.
	const legacySubject  = parsed.subject ?? 'unknown';
	const legacyPolarity = derivePolarityFromText(parsed.canonicalText ?? span);
	const legacyScope:   AssertionScope    = 'workspace';

	const base = {
		text:         span,
		subject:      legacySubject,
		polarity:     legacyPolarity,
		scope:        legacyScope,
		targetOwners: [],
		confidence:   parsed.confidence,
	};

	// Optionally include the G3/G4/G7 extensions.
	const extensions: Partial<UserAssertionPayload> = {};
	if (parsed.subject       !== undefined) { (extensions as { preferenceSubject?: PreferenceSubject }).preferenceSubject = parsed.subject; }
	if (parsed.canonicalText !== undefined) { (extensions as { canonicalText?: string }).canonicalText = parsed.canonicalText; }
	if (parsed.categories    !== undefined) { (extensions as { categories?: readonly string[] }).categories = parsed.categories; }
	if (parsed.repoPaths     !== undefined) { (extensions as { repoPaths?: readonly string[] }).repoPaths = parsed.repoPaths; }
	if (parsed.relationship  !== undefined) { (extensions as { relationship?: AssertionRelationship }).relationship = parsed.relationship; }
	if (parsed.rationale     !== '')        { (extensions as { reason?: string }).reason = parsed.rationale; }

	return { ...base, ...extensions };
}

/** Heuristic polarity derivation for the legacy field; the new code-path doesn't rely on it. */
function derivePolarityFromText(text: string): AssertionPolarity {
	const lower = text.toLowerCase();
	if (/\b(never|don'?t|do not|avoid|stop)\b/.test(lower)) { return 'avoid'; }
	if (/\b(always|require|must|need to|should)\b/.test(lower)) { return 'do'; }
	if (/\b(prefer|use|favor)\b/.test(lower)) { return 'preference'; }
	return 'preference';
}
