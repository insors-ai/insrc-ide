/**
 * data.profile.temporal.file -- Phase 5a.3 of
 * plans/analyzers/data-analyzer-skills.md (file-side variant).
 *
 * Mirrors `data.profile.temporal.rdbms`; same algo module, same
 * deferred-math caveat. Calls `db_file_aggregate`. `target` is
 * optional (xlsx sheet name; ignored elsewhere).
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';
import {
	type ProfileTemporalOutput,
	TEMPORAL_DEFERRED_NOTE,
	TEMPORAL_PROFILE_OUTPUT_SCHEMA,
	buildTemporalProfile,
	emptyTemporalProfile,
	isAggregateResult,
	temporalAggregationsFor,
} from './data.profile.temporal.algo.js';

interface ProfileTemporalFileInput {
	readonly connectionId: string;
	readonly column: string;
	readonly target?: string;
}

const FILE_FAMILY_TAGS = [
	'file',
	'csv', 'tsv', 'jsonl', 'ndjson', 'json',
	'parquet', 'arrow', 'feather',
	'avro', 'bson', 'fixed-width', 'xlsx',
] as const;

const skill: Skill<ProfileTemporalFileInput, ProfileTemporalOutput> = {
	id: 'data.profile.temporal.file',
	name: 'Profile: temporal column (file)',
	description:
		'Server-side temporal-column profile for a file connection: count + null rate + distinct cardinality. ' +
		'Min / max range and gap / period inference are deferred (same caveat as the RDBMS variant).',
	family: 'quality-profile',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			column:       { type: 'string' },
			target:       { type: 'string', description: 'Optional. xlsx: sheet name.' },
		},
		required: ['connectionId', 'column'],
		additionalProperties: false,
	},
	outputs: TEMPORAL_PROFILE_OUTPUT_SCHEMA,
	toolDeps: ['db_file_aggregate'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_file_aggregate'],
			reason: 'count + non-null + distinct via the DuckDB-backed file driver',
		},
		{
			kind: 'connection-family',
			families: FILE_FAMILY_TAGS,
			reason: 'file-only; RDBMS connections route through `data.profile.temporal.rdbms`',
		},
	],

	async execute(input, deps): Promise<SkillResult<ProfileTemporalOutput>> {
		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const toolInput: Record<string, unknown> = {
			connectionId: input.connectionId,
			aggregations: temporalAggregationsFor(input.column),
		};
		if (input.target !== undefined && input.target.length > 0) {
			toolInput['path'] = input.target;
		}

		const tool = await deps.runTool({
			id: callId,
			name: 'db_file_aggregate',
			input: toolInput,
		});

		if (tool.isError) {
			return {
				value: emptyTemporalProfile(input.target ?? '', input.column),
				confidence: 'low',
				notes: [`db_file_aggregate error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}
		if (!isAggregateResult(tool.data)) {
			return {
				value: emptyTemporalProfile(input.target ?? '', input.column),
				confidence: 'low',
				notes: ['db_file_aggregate returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		const profile = buildTemporalProfile(tool.data.target, input.column, tool.data.values);
		return {
			value: profile,
			confidence: (profile.nonNullCount ?? 0) > 0 ? 'high' : 'medium',
			notes: [TEMPORAL_DEFERRED_NOTE],
			toolCalls: [],
		};
	},
};

export function registerDataProfileTemporalFileSkill(): void {
	registerSkill(skill as unknown as Skill);
}
