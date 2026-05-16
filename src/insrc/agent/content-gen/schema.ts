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
 *   - `objective`       one-sentence GOAL the local model expands against
 *                       (the local model picks tools / skills itself; the
 *                       objective MUST NOT name skills, files, or modules)
 *   - `maxBudgetTokens` cap for the local expander's draft (clamped at
 *                       send time to the global per-action ceiling)
 *   - `reviewCriteria`  3-5 bullets the reviewer scores against
 *
 * NOTE: there is no `evidence` field. The cloud planner does not see
 * skill executions; the local model picks evidence at expand time.
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
					maxBudgetTokens: { type: 'number' },
					reviewCriteria: {
						type: 'array',
						minItems: 1,
						maxItems: 8,
						items: { type: 'string', minLength: 1 },
					},
				},
				required: ['id', 'title', 'objective', 'reviewCriteria'],
			},
		},
	},
	required: ['intentBrief', 'actions'],
} as const;

/**
 * Review verdict schema (per-action cloud reviewer). Phase E of
 * plans/code-analyzer-structured-review.md: replaced the single
 * `refine.hint` string with a typed work-item list.
 *
 * Verdict shape:
 *   - `accept`: the draft adequately satisfies the review criteria.
 *     `workItems` MUST be empty. `accepted.markdown` MAY contain a
 *     polished rewrite preserving all clickable citations.
 *   - `needs-work`: the draft has concrete heterogeneous issues.
 *     `workItems` MUST be non-empty (1-6 items). The orchestrator
 *     hands the work-item list to a patch loop that addresses each
 *     item against the draft.
 *
 * Work-item kinds:
 *   - `fix`     -- factually wrong claim in the draft (gates shipping).
 *   - `enhance` -- correct but thin (missing citations / vague).
 *   - `add`     -- required coverage missing.
 *   - `trim`    -- redundant / off-topic; cut in place.
 */
export const REVIEW_ACTION_SCHEMA = {
	type: 'object',
	properties: {
		verdict:  { type: 'string', enum: ['accept', 'needs-work'] },
		workItems: {
			type: 'array',
			minItems: 0,
			maxItems: 6,
			items: {
				type: 'object',
				properties: {
					id:     { type: 'string', minLength: 1, maxLength: 16 },
					kind:   { type: 'string', enum: ['fix', 'enhance', 'add', 'trim'] },
					where:  { type: 'string', minLength: 1, maxLength: 64 },
					// Phase K.3: cap issue/action to keep the reviewer's
					// output within the K.2 budget (~450 chars/item raw).
					// 200 is a soft cap; the prompt asks for ≤150.
					issue:  { type: 'string', minLength: 1, maxLength: 200 },
					action: { type: 'string', minLength: 1, maxLength: 200 },
					evidenceRefs: {
						type: 'array',
						items: { type: 'string' },
					},
				},
				required: ['id', 'kind', 'where', 'issue', 'action'],
			},
		},
		accepted: {
			type: 'object',
			properties: {
				markdown: { type: 'string' },
			},
			required: ['markdown'],
		},
		notes: {
			type: 'array',
			items: { type: 'string' },
		},
	},
	required: ['verdict'],
} as const;
