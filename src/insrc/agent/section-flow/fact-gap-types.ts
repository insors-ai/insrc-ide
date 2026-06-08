/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Fact-gap analysis types -- Phase alpha of
 * plans/section-flow-fact-gap-loop.md.
 *
 * The per-TODO fact-gap loop starts with a "what facts do I need vs
 * what do I have" analysis (Stage 0 in the plan). The cloud LLM
 * returns a `FactGapAnalysis` -- a structured list of required facts
 * with their availability status. The loop's downstream stages
 * (discovery-plan expansion, cycle review, synthesis) all read this
 * artifact as the canonical "what coverage are we trying to achieve".
 *
 * Phase alpha ships the TYPES only -- no LLM call, no caller wired.
 * Phase beta implements `runFactGapAnalysis` and the prompt.
 *
 * Design rules:
 *
 *   - A `RequiredFact` carries enough metadata for both the cycle
 *     reviewer (to judge whether a fact was acquired) AND the
 *     synthesis stage (to render a structured handoff when a fact
 *     remained absent at loop termination). See Decision #14 in
 *     the plan.
 *   - `suggestedSkills` is the bridge between fact-gap analysis and
 *     the discovery-plan expansion: a fact's suggested skills inform
 *     which `PlannedSkillCall.skillId` values the Stage-1 planner
 *     emits. The Stage-1 planner is free to pick differently if it
 *     judges another skill more suitable; suggestions are advisory.
 *   - `status` is computed by Stage 0 against the memory bundle: if
 *     the analyzer can point to a memory layer / prior-TODO that
 *     contains the fact, it's `present` or `partial`; otherwise
 *     `absent`. Stages 1-3 only target the `absent` and `partial`
 *     facts.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Provenance for a fact the analyzer judges already-present in
 * working memory or in a prior TODO's output. The cycle reviewer
 * uses this to verify the claim (and the synthesis stage can cite
 * the source if useful).
 */
export interface FactSourceRef {
	readonly kind:    'memory-layer' | 'prior-todo';
	/** Set when kind === 'memory-layer'. */
	readonly layer?:  'summary' | 'recent' | 'semantic' | 'code' | undefined;
	/** Set when kind === 'prior-todo'. The TodoSpec.id from an earlier WorkingMemoryEntry. */
	readonly todoId?: string | undefined;
	/** Up to 200 chars verbatim from the source; lets the reviewer verify. */
	readonly excerpt?: string | undefined;
}

/**
 * One fact the TODO needs to produce its section. Stage 0 emits an
 * array of these; the downstream cycle loop targets `absent` and
 * `partial` facts via `DiscoveryStep.targetsCriteria` (indexing into
 * the requiredFacts array by position).
 */
export interface RequiredFact {
	/** Stable kebab-case id, used by DiscoveryStep.targetsCriteria indexing. */
	readonly id:       string;
	/** Human-readable fact name; rendered into Stage 6 unmet-gap blocks. */
	readonly fact:     string;
	/** Why this fact is needed for the TODO; rendered into Stage 6 unmet-gap blocks. */
	readonly why:      string;
	readonly status:   'present' | 'partial' | 'absent';
	/** Present only when status !== 'absent'. */
	readonly sourceRef?: FactSourceRef | undefined;
	/**
	 * Catalog skill ids the analyzer suggests for acquiring this fact.
	 * Advisory -- the Stage-1 planner is the authority. Empty / absent
	 * is fine for `present` facts; should be non-empty for `absent`
	 * facts (Stage 0 prompt enforces).
	 */
	readonly suggestedSkills?: readonly string[] | undefined;
}

/**
 * Stage 0 output. The cycle loop's required-facts target list +
 * a short rationale (for telemetry; not rendered into downstream
 * prompts).
 */
export interface FactGapAnalysis {
	readonly requiredFacts:  readonly RequiredFact[];
	readonly reasoning:      string;
}

// ---------------------------------------------------------------------------
// Status helpers (pure)
// ---------------------------------------------------------------------------

/**
 * Filter the requiredFacts list to only the gap facts (absent or
 * partial). Stage 1 (discovery-plan expansion) targets only these;
 * Stage 6 (synthesis) renders only the still-absent ones as handoff
 * blocks.
 */
export function gapFacts(analysis: FactGapAnalysis): readonly RequiredFact[] {
	return analysis.requiredFacts.filter(f => f.status === 'absent' || f.status === 'partial');
}

/**
 * Compute the fast-path predicate: is the TODO trivial enough that no
 * discovery is needed? True when every required fact is `present`
 * (the answer is fully in working memory). The orchestrator skips
 * Stages 1-5 in this case and goes straight to Stage 6 synthesis.
 */
export function isTrivialFastPath(analysis: FactGapAnalysis): boolean {
	return analysis.requiredFacts.length > 0
		&& analysis.requiredFacts.every(f => f.status === 'present');
}

// ---------------------------------------------------------------------------
// JSON Schema (used as `responseFormat.schema` on the Stage 0 LLM call
// in Phase beta -- shipped here so the types and schema land together).
// ---------------------------------------------------------------------------

/**
 * Schema for the cloud's Stage 0 emission (runFactGapAnalysis).
 *
 * Caps chosen to bound prompt-payload bloat at the downstream stages:
 *
 *   - 1-12 required facts per TODO (matches the DiscoveryStep cap so
 *     a single discovery cycle can address every gap if needed)
 *   - 200-char fact name, 300-char why (rendered into Stage 6
 *     handoff blocks; longer phrasing belongs in the synthesis
 *     output)
 *   - 32-char id (kebab-case typical: "ingrn-class-fields",
 *     "json-vendor-shape", ...)
 *   - 200-char excerpt (lets the reviewer verify a `present`
 *     claim without bloating the prompt)
 *   - 1-6 suggested skills per fact (catalog ids are short; a fact
 *     needing more than 6 candidate skills is likely too coarse and
 *     should be split)
 */
export const FACT_GAP_ANALYSIS_SCHEMA: Record<string, unknown> = {
	type: 'object',
	required: ['requiredFacts', 'reasoning'],
	additionalProperties: false,
	properties: {
		requiredFacts: {
			type: 'array',
			minItems: 1,
			maxItems: 12,
			items: {
				type: 'object',
				required: ['id', 'fact', 'why', 'status'],
				additionalProperties: false,
				properties: {
					id:     { type: 'string', minLength: 1, maxLength: 32 },
					fact:   { type: 'string', minLength: 5, maxLength: 200 },
					why:    { type: 'string', minLength: 5, maxLength: 300 },
					status: { type: 'string', enum: ['present', 'partial', 'absent'] },
					sourceRef: {
						type: 'object',
						required: ['kind'],
						additionalProperties: false,
						properties: {
							kind:    { type: 'string', enum: ['memory-layer', 'prior-todo'] },
							layer:   { type: 'string', enum: ['summary', 'recent', 'semantic', 'code'] },
							todoId:  { type: 'string', maxLength: 64 },
							excerpt: { type: 'string', maxLength: 200 },
						},
					},
					suggestedSkills: {
						type: 'array',
						maxItems: 6,
						uniqueItems: true,
						items: { type: 'string', minLength: 5, maxLength: 80 },
					},
				},
			},
		},
		reasoning: { type: 'string', minLength: 5, maxLength: 600 },
	},
};
