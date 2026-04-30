/**
 * JSON Schema for DataAnalyzerResult, used as Ollama's `format`
 * constraint to force the local model into shape-correct output
 * instead of relying on prose-then-retry.
 *
 * MUST stay in lockstep with `result-parser.ts`'s validation rules.
 * Mirrors agent/tasks/code-analyzer/analyzer/schema.ts -- same
 * structure, data-specific enums + citation discriminator.
 */

/**
 * Discriminated union for the four citation kinds. Ollama's
 * constrained decoder reliably handles enums + per-branch property
 * sets; we use a top-level `kind` enum + per-kind `required` lists
 * matching what result-parser.ts validates.
 *
 * NB: oneOf / anyOf are NOT used -- Ollama's decoder support for
 * draft-7 dispatch keywords is undocumented. We declare the union
 * shape with the SUPERSET of possible properties + the kind enum;
 * the parser does the per-branch required-field check server-side.
 * Less precise as a constraint than oneOf, but rounder fewer
 * model-output rejection rates in practice.
 */
const CITATION_SCHEMA = {
	type: 'object',
	properties: {
		kind: {
			type: 'string',
			enum: ['rdbms', 'kv', 'file-source', 'code-ref'],
		},
		// Common fields across some kinds:
		connectionId: { type: 'string' },
		// rdbms-specific:
		schema: { type: 'string' },
		table: { type: 'string' },
		column: { type: 'string' },
		introspectionVersion: { type: 'string' },
		// kv-specific:
		keyPattern: { type: 'string' },
		fieldPath: { type: 'string' },
		// file-source-specific:
		path: { type: 'string' },
		// code-ref-specific:
		lineStart: { type: 'number' },
		lineEnd: { type: 'number' },
		snippet: { type: 'string' },
		entityId: { type: 'string' },
		// Shared sample inline:
		sampleValue: { type: 'string' },
	},
	required: ['kind'],
} as const;

export const DATA_ANALYZER_RESULT_SCHEMA = {
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
						enum: ['schema-drift', 'pii-exposure', 'lineage-gap', 'consistency', 'capacity-risk'],
					},
					severity: {
						type: 'string',
						enum: ['info', 'warn', 'error'],
					},
					issue: {
						type: 'string',
						minLength: 1,
					},
					citations: {
						type: 'array',
						items: CITATION_SCHEMA,
						minItems: 1,
					},
				},
				required: ['concern', 'severity', 'issue', 'citations'],
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
					name: { type: 'string' },
					argsHash: { type: 'string' },
					durationMs: { type: 'number' },
					resultRows: { type: 'number' },
					error: { type: 'string' },
				},
				required: ['name'],
			},
		},
		truncated: { type: 'boolean' },
	},
	required: ['answer', 'findings', 'citations', 'confidence'],
} as const;
