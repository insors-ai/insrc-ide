/**
 * data.source.kv.sample-shape -- Phase 2.2 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: thin typed wrapper over `db_kv_sample_shape`. Samples
 * up to 50 values under a pattern / prefix on a KV connection and
 * infers per-path field types + nullability + frequency.
 *
 * Most useful for mongo / cassandra collections where individual
 * documents have nested structure; redis-style flat values still
 * work but the inferred shape is shallow.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';

interface KvSampleShapeInput {
	readonly connectionId: string;
	readonly pattern?: string;
	readonly prefix?: string;
	readonly limit?: number;
}

interface FieldShape {
	readonly path: string;
	readonly types: readonly string[];
	readonly nullable: boolean;
	readonly frequency: number;
}

interface KvSampleShapeOutput {
	readonly sampleSize: number;
	readonly fields: readonly FieldShape[];
}

const FIELD_SCHEMA = {
	type: 'object',
	properties: {
		path:      { type: 'string' },
		types:     { type: 'array', items: { type: 'string' } },
		nullable:  { type: 'boolean' },
		frequency: { type: 'number' },
	},
	required: ['path', 'types', 'nullable', 'frequency'],
	additionalProperties: false,
} as const;

const KV_FAMILY_TAGS = [
	'kv',
	'redis', 'valkey', 'keydb',
	'mongodb', 'cassandra',
	'nats', 'dynamodb', 'etcd', 'memcached',
] as const;

const skill: Skill<KvSampleShapeInput, KvSampleShapeOutput> = {
	id: 'data.source.kv.sample-shape',
	name: 'KV: sample shape',
	description:
		'Sample up to 50 values under a pattern or prefix on a KV connection and infer per-path types + ' +
		'nullability + frequency. Best fit for document-shaped stores (mongo / cassandra); flat-key stores ' +
		'(redis-style) work but produce a shallow shape.',
	family: 'source-sampling',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			pattern:      { type: 'string' },
			prefix:       { type: 'string' },
			limit:        { type: 'integer', minimum: 1, maximum: 50 },
		},
		required: ['connectionId'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			sampleSize: { type: 'number' },
			fields:     { type: 'array', items: FIELD_SCHEMA },
		},
		required: ['sampleSize', 'fields'],
		additionalProperties: false,
	},
	toolDeps: ['db_kv_sample_shape'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_kv_sample_shape'],
			reason: 'sole tool implementing KV shape inference',
		},
		{
			kind: 'connection-family',
			families: KV_FAMILY_TAGS,
			reason: 'sample-shape is KV-only',
		},
	],

	async execute(input, deps): Promise<SkillResult<KvSampleShapeOutput>> {
		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const limit = clampLimit(input.limit);
		const toolInput: Record<string, unknown> = { connectionId: input.connectionId, limit };
		if (input.pattern !== undefined) toolInput['pattern'] = input.pattern;
		if (input.prefix  !== undefined) toolInput['prefix']  = input.prefix;

		const tool = await deps.runTool({ id: callId, name: 'db_kv_sample_shape', input: toolInput });

		if (tool.isError) {
			return {
				value: emptyShape(),
				confidence: 'low',
				notes: [`db_kv_sample_shape error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}

		const data = tool.data;
		if (!isShapeReport(data)) {
			return {
				value: emptyShape(),
				confidence: 'low',
				notes: ['db_kv_sample_shape returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		return {
			value: { sampleSize: data.sampleSize, fields: data.fields },
			confidence: data.fields.length > 0 ? 'high' : 'medium',
			toolCalls: [],
		};
	},
};

function clampLimit(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return 50;
	return Math.min(Math.max(1, Math.floor(n)), 50);
}

function emptyShape(): KvSampleShapeOutput {
	return { sampleSize: 0, fields: [] };
}

function isShapeReport(v: unknown): v is KvSampleShapeOutput {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['sampleSize'] === 'number' && Array.isArray(o['fields']);
}

export function registerDataSourceKvSampleShapeSkill(): void {
	registerSkill(skill as unknown as Skill);
}
