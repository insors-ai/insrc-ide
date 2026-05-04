/**
 * data.profile.numeric.file -- Phase 5a.1 of
 * plans/analyzers/data-analyzer-skills.md (file-side variant of the
 * RDBMS profiler).
 *
 * Atomic skill: server-side numeric profile of one column on a file
 * connection. Mirrors `data.profile.numeric.rdbms` -- same algorithm,
 * same output shape, same single-tool-round-trip cost. Only the
 * transport differs: this wrapper calls `db_file_aggregate` and
 * accepts file-family connections (csv / tsv / jsonl / ndjson / json
 * / parquet / arrow / feather / avro / bson / fixed-width / xlsx --
 * the consolidated DuckDB-backed file driver covers all 12).
 *
 * `target` is OPTIONAL on the file side -- the connection's `path`
 * field already names the file or directory. Caller passes `target`
 * only when selecting an xlsx sheet (which the file-aggregate tool
 * accepts under the `path` parameter name -- a tool-surface
 * inconsistency tracked in plans/analyzers/data-analyzer-skills.md
 * "Open cleanup work" §1).
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';
import {
	type ProfileNumericOutput,
	NUMERIC_PROFILE_OUTPUT_SCHEMA,
	buildNumericProfile,
	emptyNumericProfile,
	isAggregateResult,
	numericAggregationsFor,
} from './data.profile.numeric.algo.js';

interface ProfileNumericFileInput {
	readonly connectionId: string;
	readonly column: string;
	/** Optional. xlsx: sheet name. Other file kinds usually ignore. */
	readonly target?: string;
}

const FILE_FAMILY_TAGS = [
	'file',
	'csv', 'tsv', 'jsonl', 'ndjson', 'json',
	'parquet', 'arrow', 'feather',
	'avro', 'bson', 'fixed-width', 'xlsx',
] as const;

const skill: Skill<ProfileNumericFileInput, ProfileNumericOutput> = {
	id: 'data.profile.numeric.file',
	name: 'Profile: numeric column (file)',
	description:
		'Server-side numeric profile of one file-connection column. Same shape as the RDBMS variant ' +
		'(count + null rate + distinct cardinality + min / max / avg / stddev / variance + p50 / p95). ' +
		'Single tool round-trip via `db_file_aggregate` (DuckDB-backed). Covers every file kind the ' +
		'consolidated driver supports. xlsx sheet selection via the optional `target` field.',
	family: 'quality-profile',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			column:       { type: 'string' },
			target:       { type: 'string', description: 'Optional. xlsx: sheet name. Other file kinds usually ignore.' },
		},
		required: ['connectionId', 'column'],
		additionalProperties: false,
	},
	outputs: NUMERIC_PROFILE_OUTPUT_SCHEMA,
	toolDeps: ['db_file_aggregate'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_file_aggregate'],
			reason: 'numeric profile pushes every aggregation server-side via the DuckDB-backed file driver',
		},
		{
			kind: 'connection-family',
			families: FILE_FAMILY_TAGS,
			reason: 'file-only; RDBMS connections route through `data.profile.numeric.rdbms`',
		},
	],

	async execute(input, deps): Promise<SkillResult<ProfileNumericOutput>> {
		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		// db_file_aggregate's `target` semantics live under the `path`
		// field name (xlsx sheet selector for that kind, ignored
		// elsewhere). We translate at the boundary so the skill input
		// stays uniformly named `target` across the .rdbms / .file pair.
		const toolInput: Record<string, unknown> = {
			connectionId: input.connectionId,
			aggregations: numericAggregationsFor(input.column),
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
				value: emptyNumericProfile(input.target ?? '', input.column),
				confidence: 'low',
				notes: [`db_file_aggregate error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}
		if (!isAggregateResult(tool.data)) {
			return {
				value: emptyNumericProfile(input.target ?? '', input.column),
				confidence: 'low',
				notes: ['db_file_aggregate returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		const profile = buildNumericProfile(tool.data.target, input.column, tool.data.values);
		const confidence = (profile.nonNullCount ?? 0) > 0 ? 'high' : 'medium';
		return { value: profile, confidence, toolCalls: [] };
	},
};

export function registerDataProfileNumericFileSkill(): void {
	registerSkill(skill as unknown as Skill);
}
