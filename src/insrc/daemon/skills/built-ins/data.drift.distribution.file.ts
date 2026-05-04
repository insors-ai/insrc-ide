/**
 * data.drift.distribution.file -- Phase 5f.1 (file-side variant).
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';
import {
	type DriftDistributionOutput,
	type DriftWhereClauseIn,
	DRIFT_OUTPUT_SCHEMA,
	DRIFT_WHERE_SCHEMA,
	buildDrift,
	clampDriftBins,
	clampDriftSample,
	collectToolErrors,
	emptyDrift,
	extractNumbers,
	isSampleLike,
} from './data.drift.distribution.algo.js';

interface DriftDistributionFileInput {
	readonly connectionId: string;
	readonly column: string;
	readonly windowAWhere: readonly DriftWhereClauseIn[];
	readonly windowBWhere: readonly DriftWhereClauseIn[];
	readonly target?: string;
	readonly sampleSize?: number;
	readonly bins?: number;
}

const FILE_FAMILY_TAGS = [
	'file',
	'csv', 'tsv', 'jsonl', 'ndjson', 'json',
	'parquet', 'arrow', 'feather',
	'avro', 'bson', 'fixed-width', 'xlsx',
] as const;

const skill: Skill<DriftDistributionFileInput, DriftDistributionOutput> = {
	id: 'data.drift.distribution.file',
	name: 'Drift: distribution divergence (file)',
	description:
		'Jensen-Shannon divergence between two sample windows of a numeric column on a file connection. ' +
		'Same shape as the RDBMS variant; caller supplies two WhereClause[] filters defining windows.',
	family: 'drift',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId:  { type: 'string' },
			column:        { type: 'string' },
			windowAWhere:  DRIFT_WHERE_SCHEMA,
			windowBWhere:  DRIFT_WHERE_SCHEMA,
			target:        { type: 'string', description: 'Optional. xlsx: sheet name.' },
			sampleSize:    { type: 'integer', minimum: 1, maximum: 50 },
			bins:          { type: 'integer', minimum: 4, maximum: 50, description: 'Histogram bin count; default 10.' },
		},
		required: ['connectionId', 'column', 'windowAWhere', 'windowBWhere'],
		additionalProperties: false,
	},
	outputs: DRIFT_OUTPUT_SCHEMA,
	toolDeps: ['db_file_sample'],
	providerAffinity: 'local',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_file_sample'], reason: 'two parallel samples (one per window) feed the histograms' },
		{ kind: 'connection-family', families: FILE_FAMILY_TAGS, reason: 'file-only' },
	],

	async execute(input, deps): Promise<SkillResult<DriftDistributionOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampDriftSample(input.sampleSize);
		const binCount = clampDriftBins(input.bins);
		const col = input.column;
		const sheet = input.target !== undefined && input.target.length > 0 ? input.target : undefined;

		const buildSampleInput = (where: readonly DriftWhereClauseIn[]): Record<string, unknown> => {
			const base: Record<string, unknown> = { connectionId: input.connectionId, limit: sampleSize, where };
			if (sheet !== undefined) base['target'] = sheet;
			return base;
		};

		const [aTool, bTool] = await Promise.all([
			deps.runTool({ id: `${callBase}-a`, name: 'db_file_sample', input: buildSampleInput(input.windowAWhere) }),
			deps.runTool({ id: `${callBase}-b`, name: 'db_file_sample', input: buildSampleInput(input.windowBWhere) }),
		]);

		const errors = collectToolErrors([['db_file_sample (A)', aTool], ['db_file_sample (B)', bTool]]);
		if (errors.length > 0) {
			return { value: emptyDrift(input.target ?? '', col, binCount), confidence: 'low', notes: errors, toolCalls: [] };
		}
		if (!isSampleLike(aTool.data) || !isSampleLike(bTool.data)) {
			return {
				value: emptyDrift(input.target ?? '', col, binCount),
				confidence: 'low',
				notes: ['drift-distribution: one or both sample tool results were missing structured data'],
				toolCalls: [],
			};
		}

		const aValues = extractNumbers(aTool.data, col);
		const bValues = extractNumbers(bTool.data, col);
		const built = buildDrift(aTool.data.target, col, aValues, bValues, binCount);
		if (built.degradedConfidence !== null) {
			return { value: built.output, confidence: built.degradedConfidence, notes: [...built.notes], toolCalls: [] };
		}
		return { value: built.output, confidence: 'high', toolCalls: [] };
	},
};

export function registerDataDriftDistributionFileSkill(): void {
	registerSkill(skill as unknown as Skill);
}
