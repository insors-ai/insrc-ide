/**
 * Shared math + IO contract for `data.distribution.modes.{rdbms,file}`
 * (Phase 5b.7 of plans/analyzers/data-analyzer-skills.md).
 *
 * Sample-based multimodal detection. Bin into a fixed-width
 * histogram, smooth with a 3-point moving average, find local
 * maxima above a prominence threshold, collapse adjacent-bin
 * plateaus.
 */

interface AggregateSpec {
	readonly column: string;
	readonly function: string;
}

export const MODES_SAMPLE_DEFAULT = 50;
export const MODES_BINS_DEFAULT = 10;
export const MODES_PROMINENCE_DEFAULT = 0.5;

export interface HistogramBin {
	readonly lower: number;
	readonly upper: number;
	readonly count: number;
	readonly density: number;
}

export interface ModePeak {
	readonly binIndex: number;
	readonly lower: number;
	readonly upper: number;
	readonly count: number;
	readonly prominence: number;
}

export type Modality = 'unimodal' | 'bimodal' | 'multimodal' | 'inconclusive';

export interface ModesOutput {
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

export function clampModesSample(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return MODES_SAMPLE_DEFAULT;
	return Math.min(Math.max(1, Math.floor(n)), 50);
}
export function clampModesBins(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return MODES_BINS_DEFAULT;
	return Math.min(Math.max(4, Math.floor(n)), 50);
}
export function clampModesProminence(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return MODES_PROMINENCE_DEFAULT;
	return Math.min(Math.max(0.1, n), 1);
}

export function modesAggregationsFor(column: string): AggregateSpec[] {
	return [
		{ column, function: 'count_non_null' },
		{ column, function: 'min' },
		{ column, function: 'max' },
		{ column, function: 'avg' },
	];
}

export function buildModes(
	target: string,
	column: string,
	binCount: number,
	minProminence: number,
	aggValues: Readonly<Record<string, number | null>>,
	sample: { columns: readonly string[]; rows: readonly Readonly<Record<string, unknown>>[] },
): ModesOutput {
	const min = aggValues[`${column}__min`] ?? null;
	const max = aggValues[`${column}__max`] ?? null;
	const mean = aggValues[`${column}__avg`] ?? null;

	const values: number[] = [];
	if (sample.columns.includes(column)) {
		for (const row of sample.rows) {
			const raw = row[column];
			if (raw === null || raw === undefined) continue;
			const num = typeof raw === 'number' ? raw : Number(raw);
			if (Number.isFinite(num)) values.push(num);
		}
	}

	const baseShell = (interp: string): ModesOutput => ({
		target, column,
		sampleSize: values.length,
		min, max, mean,
		bins: [], modes: [],
		modality: 'inconclusive',
		interpretation: interp,
	});

	if (values.length < 4) {
		return baseShell(`sample too small (n=${values.length}); need at least 4 numeric observations`);
	}

	const lo = (min !== null) ? min : Math.min(...values);
	const hi = (max !== null) ? max : Math.max(...values);
	if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
		return baseShell('column is constant or has no measurable range; modality undefined');
	}

	const binWidth = (hi - lo) / binCount;
	const counts = new Array<number>(binCount).fill(0);
	for (const v of values) {
		let idx = Math.floor((v - lo) / binWidth);
		if (idx >= binCount) idx = binCount - 1;
		if (idx < 0) idx = 0;
		counts[idx]!++;
	}
	const total = values.length;
	const bins: HistogramBin[] = counts.map((count, i) => ({
		lower: lo + i * binWidth,
		upper: lo + (i + 1) * binWidth,
		count,
		density: total > 0 ? count / total : 0,
	}));

	const smoothed = smoothMovingAvg(counts);
	const peakValue = smoothed.reduce((a, b) => Math.max(a, b), 0);
	const minSmoothed = peakValue * minProminence;

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
		target, column,
		sampleSize: values.length,
		min, max, mean,
		bins, modes: collapsed,
		modality, interpretation,
	};
}

function smoothMovingAvg(counts: readonly number[]): number[] {
	const out = new Array<number>(counts.length);
	for (let i = 0; i < counts.length; i++) {
		if (i === 0 || i === counts.length - 1) out[i] = counts[i]!;
		else out[i] = (counts[i - 1]! + counts[i]! + counts[i + 1]!) / 3;
	}
	return out;
}

export function emptyModes(target: string, column: string): ModesOutput {
	return {
		target, column,
		sampleSize: 0,
		min: null, max: null, mean: null,
		bins: [], modes: [],
		modality: 'inconclusive',
		interpretation: '',
	};
}

const HIST_BIN_SCHEMA = {
	type: 'object',
	properties: {
		lower: { type: 'number' }, upper: { type: 'number' },
		count: { type: 'number' }, density: { type: 'number' },
	},
	required: ['lower', 'upper', 'count', 'density'],
	additionalProperties: false,
} as const;

const MODE_PEAK_SCHEMA = {
	type: 'object',
	properties: {
		binIndex: { type: 'number' },
		lower: { type: 'number' }, upper: { type: 'number' },
		count: { type: 'number' }, prominence: { type: 'number' },
	},
	required: ['binIndex', 'lower', 'upper', 'count', 'prominence'],
	additionalProperties: false,
} as const;

export const MODES_OUTPUT_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		target:         { type: 'string' },
		column:         { type: 'string' },
		sampleSize:     { type: 'number' },
		min:            { type: ['number', 'null'] },
		max:            { type: ['number', 'null'] },
		mean:           { type: ['number', 'null'] },
		bins:           { type: 'array', items: HIST_BIN_SCHEMA },
		modes:          { type: 'array', items: MODE_PEAK_SCHEMA },
		modality:       { type: 'string', enum: ['unimodal', 'bimodal', 'multimodal', 'inconclusive'] },
		interpretation: { type: 'string' },
	},
	required: ['target', 'column', 'sampleSize', 'min', 'max', 'mean',
	           'bins', 'modes', 'modality', 'interpretation'],
	additionalProperties: false,
};
