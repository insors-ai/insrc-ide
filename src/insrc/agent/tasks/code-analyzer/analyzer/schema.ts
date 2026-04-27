/**
 * JSON Schema for AnalyzerResult, used as Ollama's `format` constraint
 * to force the local model into shape-correct output instead of
 * relying on prose-then-retry.
 *
 * MUST stay in lockstep with `result-parser.ts`'s validation rules --
 * the schema is the model-side enforcement; the parser is the
 * server-side enforcement; any divergence creates a window where
 * Ollama emits "valid" output the parser still rejects.
 *
 * Notes for evolution:
 *
 *   - `concern` / `severity` / `confidence` enum values mirror
 *     `VALID_CONCERNS` / `VALID_SEVERITIES` / `VALID_CONFIDENCES` in
 *     `result-parser.ts`. Keep them aligned.
 *   - `findings[].citations.minItems = 1` pre-empts the
 *     citations-invariant retry in `runner.ts` -- the model is
 *     forbidden from producing a finding with no citation, so the
 *     downstream retry path becomes a near-noop in practice.
 *   - `additionalProperties` is intentionally NOT set to false at
 *     the top level: Ollama's constrained decoder is documented to
 *     enforce required keys + types, but some draft-7 features
 *     (full $ref, oneOf, etc.) are undocumented. Keeping the schema
 *     within "type/properties/required/enum/minLength/minItems" --
 *     the features explicitly demonstrated in the Ollama docs --
 *     gives us the highest hit rate across model families.
 *
 * Same approach instructor-js (Jason Liu's Instructor TS port) takes
 * for OpenAI's structured-outputs, except we lean on Ollama's native
 * `format: <schema>` API instead of going through an OpenAI compat
 * shim.
 */

const CITATION_SCHEMA = {
	type: 'object',
	properties: {
		entityId: { type: 'string' },
		path:     { type: 'string', minLength: 1 },
		lineStart:{ type: 'number' },
		lineEnd:  { type: 'number' },
		snippet:  { type: 'string' },
	},
	required: ['path'],
} as const;

export const ANALYZER_RESULT_SCHEMA = {
	type: 'object',
	properties: {
		answer: {
			type: 'string',
			minLength: 1,
		},
		findings: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					concern: {
						type: 'string',
						enum: ['duplicates', 'consistency', 'interface-mismatch', 'impact', 'smells'],
					},
					severity: {
						type: 'string',
						enum: ['info', 'warn', 'error'],
					},
					issue: {
						type: 'string',
						minLength: 1,
					},
					file: {
						type: 'string',
					},
					line: {
						type: 'number',
					},
					suggestion: {
						type: 'string',
					},
					citations: {
						type: 'array',
						minItems: 1,
						items: CITATION_SCHEMA,
					},
				},
				required: ['concern', 'severity', 'issue', 'file', 'citations'],
			},
		},
		citations: {
			type: 'array',
			items: CITATION_SCHEMA,
		},
		confidence: {
			type: 'string',
			enum: ['high', 'medium', 'low'],
		},
		toolCalls: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					name:        { type: 'string', minLength: 1 },
					argsHash:    { type: 'string' },
					durationMs:  { type: 'number' },
					resultRows:  { type: 'number' },
					error:       { type: 'string' },
				},
				required: ['name'],
			},
		},
		truncated: {
			type: 'boolean',
		},
	},
	required: ['answer', 'findings', 'citations', 'confidence'],
} as const;
