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
