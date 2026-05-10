/**
 * JSON Schemas for the multi-pass content generator
 * (plans/content-generator.md commit 1).
 *
 * The outline schema constrains pass-1 output to a strictly-shaped
 * `OutlineResult`. Ollama natively supports `format: <schema>` and
 * the constrained decoder emits only output matching the shape;
 * cloud providers without server-side support ignore the hint and
 * we rely on the parse + retry path to catch violations.
 */

/**
 * Outline-pass schema. Caps `sections` at 12 by construction --
 * larger outlines are an anti-pattern (the doc would benefit from
 * being split into multiple multi-pass runs instead). A 12-cap
 * leaves headroom for the hard `--max-sections` cap the caller
 * passes in via `outline.maxSections`.
 */
export const OUTLINE_SCHEMA = {
	type: 'object',
	properties: {
		title: { type: 'string' },
		sections: {
			type: 'array',
			minItems: 1,
			maxItems: 12,
			items: {
				type: 'object',
				properties: {
					id: { type: 'string', minLength: 1 },
					title: { type: 'string', minLength: 1 },
					intent: { type: 'string', minLength: 1 },
					budgetTokens: { type: 'number' },
					dependsOn: {
						type: 'array',
						items: { type: 'string' },
					},
				},
				required: ['id', 'title', 'intent'],
			},
		},
	},
	required: ['title', 'sections'],
} as const;

/**
 * Plan-actions schema (cloud-plan / local-expand / cloud-review
 * synthesis flow, plans/analyzers/cloud-plan-local-expand-cloud-review.md).
 *
 * Hard cap of 32 actions matches the largest tier (XXXXL). Per-tier
 * action budgets are enforced by the caller before validation -- the
 * schema here is the absolute ceiling.
 *
 * Each action carries:
 *   - `id`              stable section key (kebab-case, deduped)
 *   - `title`           user-facing heading
 *   - `objective`       one-sentence statement of what this section answers
 *   - `evidence`        skill-execution refs the expander is allowed to use
 *   - `maxBudgetTokens` cap for the local expander's draft (clamped at
 *                       send time to the global per-action ceiling)
 *   - `reviewCriteria`  3-5 bullets the reviewer scores against
 */
export const PLAN_ACTIONS_SCHEMA = {
	type: 'object',
	properties: {
		intentBrief: { type: 'string', minLength: 1 },
		actions: {
			type: 'array',
			minItems: 0,
			maxItems: 32,
			items: {
				type: 'object',
				properties: {
					id:        { type: 'string', minLength: 1 },
					title:     { type: 'string', minLength: 1 },
					objective: { type: 'string', minLength: 1 },
					evidence: {
						type: 'array',
						minItems: 0,
						maxItems: 16,
						items: {
							type: 'object',
							properties: {
								skillId:      { type: 'string', minLength: 1 },
								executionIdx: { type: 'number' },
								highlight:    { type: 'string' },
							},
							required: ['skillId', 'executionIdx'],
						},
					},
					maxBudgetTokens: { type: 'number' },
					reviewCriteria: {
						type: 'array',
						minItems: 1,
						maxItems: 8,
						items: { type: 'string', minLength: 1 },
					},
				},
				required: ['id', 'title', 'objective', 'evidence', 'reviewCriteria'],
			},
		},
	},
	required: ['intentBrief', 'actions'],
} as const;

/**
 * Review verdict schema (per-action cloud reviewer). The reviewer
 * picks `accept` (optionally with a polished rewrite under
 * `accepted.markdown`) or `refine` (one focused hint the local
 * expander uses on its second pass). Second-pass `refine` verdicts
 * are binding -- the orchestrator accepts the second draft regardless
 * and stamps a note.
 */
export const REVIEW_ACTION_SCHEMA = {
	type: 'object',
	properties: {
		verdict:  { type: 'string', enum: ['accept', 'refine'] },
		accepted: {
			type: 'object',
			properties: {
				markdown: { type: 'string' },
			},
			required: ['markdown'],
		},
		refine: {
			type: 'object',
			properties: {
				hint: { type: 'string', minLength: 1 },
			},
			required: ['hint'],
		},
		notes: {
			type: 'array',
			items: { type: 'string' },
		},
	},
	required: ['verdict'],
} as const;
