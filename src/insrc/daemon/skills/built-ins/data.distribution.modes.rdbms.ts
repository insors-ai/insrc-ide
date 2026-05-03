/**
 * data.distribution.modes.rdbms -- Phase 5b.7 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic distribution skill: sample-based multimodal detection.
 * Pulls 50 numeric values from the column, bins them into a fixed-
 * width histogram (default 10 bins), smooths the bin counts with a
 * 3-point moving average, then finds local maxima with prominence
 * above a threshold (default 50% of the global peak).
 *
 * **Sample-based.** The plan's row 5b.7 calls for a server-side
 * histogram via `db_sql_histogram`, which doesn't exist yet
 * (Phase 0.2 is pending). This v1 ships sample-based detection
 * over 50 rows; output documents the precision limit. The same
 * skill body will work over a server-built histogram once the
 * tool lands -- the mode-finding logic doesn't change.
 *
 * Modality verdict ladder:
 *   1 peak    -> unimodal
 *   2 peaks   -> bimodal
 *   3+ peaks  -> multimodal
 *   0 peaks   -> inconclusive (constant column, all-null sample)
 *
 * Use cases: spotting hidden categories in a numeric column ("rating
 * is 1-5 but actually clusters at 1, 3, 5"), confirming Gaussian-
 * shape assumptions for Z-score outlier detection, finding gaps in
 * binned data ("scores cluster at 0-50 and 80-100, nothing in
 * between").
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult, SkillToolResult } from '../types.js';

const SAMPLE_DEFAULT = 50;
const BINS_DEFAULT = 10;
const PROMINENCE_DEFAULT = 0.5;

interface ModesInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
	readonly sampleSize?: number;
	readonly bins?: number;
	readonly minProminence?: number;
}

interface HistogramBin {
	readonly lower: number;
	readonly upper: number;
	readonly count: number;
	readonly density: number;  // count / total
}

interface ModePeak {
	readonly binIndex: number;
	readonly lower: number;
	readonly upper: number;
	readonly count: number;
	readonly prominence: number;  // smoothed-count / global-peak (after smoothing)
}

type Modality = 'unimodal' | 'bimodal' | 'multimodal' | 'inconclusive';

interface ModesOutput {
	readonly target: string;
	readonly column: string;
	readonly sampleSize: number;
	readonly min: number | null;
	readonly max: number | null;
	readonly mean: number | null;
	readonly bins: readonly HistogramBin[];
	readonly modes: readonly ModePeak[];
	readonly modality: Modality;
	readonly interpretation: string;
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<ModesInput, ModesOutput> = {
	id: 'data.distribution.modes.rdbms',
	name: 'Distribution: modes (RDBMS)',
	description:
		'Sample-based multimodal detection on a numeric column. Pulls 50 values, bins into a fixed-width ' +
		'histogram (default 10 bins), smooths, finds local maxima with prominence > 50% of the global peak. ' +
		'Returns the histogram + per-mode location + a modality verdict (unimodal / bimodal / multimodal / ' +
		'inconclusive). Sample-based; the plan calls for a server-side histogram via db_sql_histogram which ' +
		'is pending.',
	family: 'distribution',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId:  { type: 'string' },
			target:        { type: 'string' },
			column:        { type: 'string' },
			sampleSize:    { type: 'integer', minimum: 1, maximum: 50 },
			bins:          { type: 'integer', minimum: 4, maximum: 50, description: 'Histogram bin count; default 10.' },
			minProminence: { type: 'number',  minimum: 0.1, maximum: 1, description: 'Fraction of global peak required to be a mode; default 0.5.' },
		},
		required: ['connectionId', 'target', 'column'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			target:     { type: 'string' },
			column:     { type: 'string' },
			sampleSize: { type: 'number' },
			min:        { type: ['number', 'null'] },
			max:        { type: ['number', 'null'] },
			mean:       { type: ['number', 'null'] },
			bins: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						lower:   { type: 'number' },
						upper:   { type: 'number' },
						count:   { type: 'number' },
						density: { type: 'number' },
					},
					required: ['lower', 'upper', 'count', 'density'],
					additionalProperties: false,
				},
			},
			modes: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						binIndex:   { type: 'number' },
						lower:      { type: 'number' },
						upper:      { type: 'number' },
						count:      { type: 'number' },
						prominence: { type: 'number' },
					},
					required: ['binIndex', 'lower', 'upper', 'count', 'prominence'],
					additionalProperties: false,
				},
			},
			modality:       { type: 'string', enum: ['unimodal', 'bimodal', 'multimodal', 'inconclusive'] },
			interpretation: { type: 'string' },
		},
		required: ['target', 'column', 'sampleSize', 'min', 'max', 'mean',
		           'bins', 'modes', 'modality', 'interpretation'],
		additionalProperties: false,
	},
	toolDeps: ['db_sql_aggregate', 'db_sql_sample'],
	providerAffinity: 'local',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_aggregate', 'db_sql_sample'],
			reason: 'aggregate gives min / max / mean for histogram framing; sample gives values to bin',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only',
		},
	],

	async execute(input, deps): Promise<SkillResult<ModesOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampSample(input.sampleSize);
		const binCount = clampBins(input.bins);
		const minProminence = clampProminence(input.minProminence);
		const col = input.column;

		const [aggTool, sampleTool] = await Promise.all([
			deps.runTool({
				id: `${callBase}-agg`,
				name: 'db_sql_aggregate',
				input: {
					connectionId: input.connectionId,
					target: input.target,
					aggregations: [
						{ column: col, function: 'count_non_null' },
						{ column: col, function: 'min' },
						{ column: col, function: 'max' },
						{ column: col, function: 'avg' },
					],
				},
			}),
			deps.runTool({
				id: `${callBase}-sample`,
				name: 'db_sql_sample',
				input: { connectionId: input.connectionId, target: input.target, limit: sampleSize },
			}),
		]);

		const errors = collectToolErrors([['db_sql_aggregate', aggTool], ['db_sql_sample', sampleTool]]);
		if (errors.length > 0) {
			return {
				value: empty(input.target, col),
				confidence: 'low',
				notes: errors,
				toolCalls: [],
			};
		}

		const aggData = aggTool.data;
		const sampleData = sampleTool.data;
		if (!isAggregateResult(aggData) || !isSampleResult(sampleData)) {
			return {
				value: empty(input.target, col),
				confidence: 'low',
				notes: ['modes: tool result missing structured data'],
				toolCalls: [],
			};
		}

		const min  = aggData.values[`${col}__min`] ?? null;
		const max  = aggData.values[`${col}__max`] ?? null;
		const mean = aggData.values[`${col}__avg`] ?? null;

		// Pull numeric sample values.
		const values: number[] = [];
		if (sampleData.columns.includes(col)) {
			for (const row of sampleData.rows) {
				const raw = row[col];
				if (raw === null || raw === undefined) continue;
				const num = typeof raw === 'number' ? raw : Number(raw);
				if (Number.isFinite(num)) values.push(num);
			}
		}

		const emptyWithCounts = (): ModesOutput => ({
			target: aggData.target,
			column: col,
			sampleSize: values.length,
			min, max, mean,
			bins: [],
			modes: [],
			modality: 'inconclusive',
			interpretation: '',
		});

		if (values.length < 4) {
			return {
				value: { ...emptyWithCounts(), interpretation: `sample too small (n=${values.length}); need at least 4 numeric observations` },
				confidence: 'medium',
				toolCalls: [],
			};
		}

		// Choose framing range. Prefer server-side min/max for stable
		// bin edges across repeated runs; fall back to sample min/max
		// when min/max didn't come back as numbers.
		const lo = (min !== null) ? min : Math.min(...values);
		const hi = (max !== null) ? max : Math.max(...values);
		if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
			return {
				value: { ...emptyWithCounts(), interpretation: 'column is constant or has no measurable range; modality undefined' },
				confidence: 'medium',
				toolCalls: [],
			};
		}

		const binWidth = (hi - lo) / binCount;
		const counts = new Array<number>(binCount).fill(0);
		for (const v of values) {
			let idx = Math.floor((v - lo) / binWidth);
			if (idx >= binCount) idx = binCount - 1;  // values exactly at hi
			if (idx < 0)         idx = 0;
			counts[idx]!++;
		}
		const total = values.length;
		const bins: HistogramBin[] = counts.map((count, i) => ({
			lower: lo + i * binWidth,
			upper: lo + (i + 1) * binWidth,
			count,
			density: total > 0 ? count / total : 0,
		}));

		// Smooth with a 3-point moving average to suppress single-bin noise.
		const smoothed = smoothMovingAvg(counts);
		const peakValue = smoothed.reduce((a, b) => Math.max(a, b), 0);
		const minSmoothed = peakValue * minProminence;

		// Local maxima -- a bin is a peak when its smoothed value is
		// >= both neighbours and >= minProminence threshold.
		// Edge bins use the single-neighbour comparison.
		const modes: ModePeak[] = [];
		for (let i = 0; i < smoothed.length; i++) {
			const cur = smoothed[i]!;
			if (cur < minSmoothed) continue;
			const left  = i > 0 ? smoothed[i - 1]! : -Infinity;
			const right = i < smoothed.length - 1 ? smoothed[i + 1]! : -Infinity;
			if (cur >= left && cur >= right && cur > 0) {
				const bin = bins[i]!;
				modes.push({
					binIndex: i,
					lower: bin.lower,
					upper: bin.upper,
					count: bin.count,
					prominence: peakValue > 0 ? cur / peakValue : 0,
				});
			}
		}

		// Tie-handling: when two adjacent bins have equal smoothed
		// values both qualify as local maxima above. Collapse adjacent
		// peaks (within 1 bin) by keeping the one with the higher raw
		// count -- a plateau is one mode, not two.
		const collapsed: ModePeak[] = [];
		for (const m of modes) {
			const prev = collapsed[collapsed.length - 1];
			if (prev !== undefined && m.binIndex === prev.binIndex + 1) {
				if (m.count > prev.count) collapsed[collapsed.length - 1] = m;
			} else {
				collapsed.push(m);
			}
		}

		let modality: Modality;
		let interpretation: string;
		if (collapsed.length === 0) {
			modality = 'inconclusive';
			interpretation = 'no peak above prominence threshold; the data may be uniform or too noisy at n=50';
		} else if (collapsed.length === 1) {
			modality = 'unimodal';
			const m = collapsed[0]!;
			interpretation = `single peak in [${m.lower.toFixed(2)}, ${m.upper.toFixed(2)}); typical of normally-distributed data`;
		} else if (collapsed.length === 2) {
			modality = 'bimodal';
			interpretation = `two peaks detected -- the data may have hidden categories or come from two distinct populations`;
		} else {
			modality = 'multimodal';
			interpretation = `${collapsed.length} peaks detected -- complex distribution; consider profiling subgroups`;
		}

		return {
			value: {
				target: aggData.target,
				column: col,
				sampleSize: values.length,
				min, max, mean,
				bins,
				modes: collapsed,
				modality,
				interpretation,
			},
			// `high` when we got a sample + classified the modality;
			// `medium` when the sample / range was too sparse to call.
			confidence: modality === 'inconclusive' ? 'medium' : 'high',
			toolCalls: [],
		};
	},
};

/** 3-point moving average; edges keep the original value. */
function smoothMovingAvg(counts: readonly number[]): number[] {
	const out = new Array<number>(counts.length);
	for (let i = 0; i < counts.length; i++) {
		if (i === 0 || i === counts.length - 1) {
			out[i] = counts[i]!;
		} else {
			out[i] = (counts[i - 1]! + counts[i]! + counts[i + 1]!) / 3;
		}
	}
	return out;
}

function clampSample(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return SAMPLE_DEFAULT;
	return Math.min(Math.max(1, Math.floor(n)), 50);
}

function clampBins(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return BINS_DEFAULT;
	return Math.min(Math.max(4, Math.floor(n)), 50);
}

function clampProminence(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return PROMINENCE_DEFAULT;
	return Math.min(Math.max(0.1, n), 1);
}

function empty(target: string, column: string): ModesOutput {
	return {
		target, column,
		sampleSize: 0,
		min: null, max: null, mean: null,
		bins: [], modes: [],
		modality: 'inconclusive',
		interpretation: '',
	};
}

function collectToolErrors(
	pairs: readonly (readonly [string, SkillToolResult])[],
): string[] {
	const out: string[] = [];
	for (const [name, res] of pairs) {
		if (res.isError) out.push(`${name} error: ${res.content.slice(0, 200)}`);
	}
	return out;
}

interface AggregateResultRaw {
	readonly target: string;
	readonly values: Readonly<Record<string, number | null>>;
}

interface SampleResultRaw {
	readonly target: string;
	readonly columns: readonly string[];
	readonly rows: readonly Readonly<Record<string, unknown>>[];
}

function isAggregateResult(v: unknown): v is AggregateResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string' && typeof o['values'] === 'object' && o['values'] !== null;
}

function isSampleResult(v: unknown): v is SampleResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& Array.isArray(o['columns'])
		&& Array.isArray(o['rows']);
}

export function registerDataDistributionModesRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
