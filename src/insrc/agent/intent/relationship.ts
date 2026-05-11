/**
 * Relationship-typed classifier output (Phase 4 of
 * plans/intent-classification-consolidation.md).
 *
 * The cold-path classifier picks a primary intent AND -- when memory
 * is available -- a typed relationship describing how the prompt
 * relates to recent conversation activity. This file holds the
 * shared enum + descriptions consumed by:
 *   - `agent/classify/intent.ts` (passes the enum to the generic
 *     classifier; pulls the descriptions into the system prompt)
 *   - `agent/intent/resolver.ts` (hydrates citation keys into
 *     MemoryCitation[] objects and surfaces a typed `relationship`
 *     on ResolvedIntent)
 *
 * Order matters: `RELATIONSHIP_KINDS[0]` is the safe default the
 * generic classifier picks when the LLM omits / malforms the
 * relationship block. We put 'NEW' first so that "no memory ->
 * fresh ask" is the natural fallback.
 */

export const RELATIONSHIP_KINDS = [
	'NEW',
	'FOLLOWUP',
	'DRILL_DOWN',
	'RESPONSE_TO',
	'CONTINUATION',
	'CORRECTION',
	'COMPARE_WITH',
	'TANGENT',
] as const;

export type RelationshipKind = typeof RELATIONSHIP_KINDS[number];

/**
 * One-line description per kind, surfaced verbatim in the classifier
 * system prompt. Authoritative source for the meaning of each kind --
 * documentation rendered into the LLM and downstream consumers (UI
 * tooltips, telemetry hover) should reuse these strings to stay in
 * lock-step.
 */
export const RELATIONSHIP_DESCRIPTIONS: Readonly<Record<RelationshipKind, string>> = {
	NEW:           'independent of any prior turn -- treat the prompt as a fresh ask, ignore the recent context',
	FOLLOWUP:      'continues / refines a prior USER request (rephrasing, elaborating, narrowing, broadening)',
	DRILL_DOWN:    'zooms into a specific entity / module / topic that a prior ASSISTANT response surfaced (cite the segment)',
	RESPONSE_TO:   'answers a clarification or gate the assistant asked',
	CONTINUATION:  'literal "continue", "go on", "more", "next"',
	CORRECTION:    'corrects / overrides a prior assistant claim',
	COMPARE_WITH:  'explicit comparison to an earlier topic',
	TANGENT:       'new topic in the same session, no relevant prior',
};

export function isRelationshipKind(value: unknown): value is RelationshipKind {
	return typeof value === 'string' && (RELATIONSHIP_KINDS as readonly string[]).includes(value);
}
