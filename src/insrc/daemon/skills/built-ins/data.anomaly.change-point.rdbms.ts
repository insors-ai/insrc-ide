/**
 * data.anomaly.change-point.rdbms -- Phase 5f.3 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic drift skill: detects a single change point in a numeric
 * column observed over time. Sorts the (timestamp, value) sample
 * by timestamp, then for every interior split index `k` computes
 * the mean shift between values[:k] and values[k:]. The k that
 * maximises the standardised shift is the candidate change point.
 *
 * Statistic: |meanLeft - meanRight| / pooledStddev
 *
 * The skill returns the change-point timestamp + the shift
 * magnitude + a significance verdict driven by the standardised
 * statistic. This is a sample-based, single-change-point detector
 * -- adequate for "did something change once, and roughly when?"
 * questions. Multi-change detection (e.g. PELT) is out of scope.
 *
 * Pairs with:
 *   - drift.distribution.rdbms (compares two pre-defined windows;
 *     this skill *finds* the best split for you)
 *   - timeseries.trend.rdbms (a smooth trend coexists with a
 *     change point; the trend skill captures the slope, this one
 *     captures the discontinuity)
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';

const SAMPLE_DEFAULT = 50;
const MIN_SIDE = 4;  // each side of the split needs at least 4 points for a meaningful mean

interface ChangePointInput {
	readonly connectionId: string;
	readonly target: string;
	readonly timestampColumn: string;
	readonly valueColumn: string;
	readonly sampleSize?: number;
}

type Verdict = 'no-change' | 'subtle-change' | 'clear-change' | 'inconclusive';

interface ChangePointOutput {
	readonly target: string;
	readonly timestampColumn: string;
	readonly valueColumn: string;
	readonly sampleSize: number;
	readonly changePointIndex: number | null;     // 0-based index in the sorted sample; left side is [:k], right is [k:]
	readonly changePointTimestamp: number | null; // epoch-ms midpoint between the two adjacent observations
	readonly leftMean: number | null;
	readonly rightMean: number | null;
	readonly leftN: number | null;
	readonly rightN: number | null;
	readonly shiftMagnitude: number | null;       // |meanLeft - meanRight|
	readonly standardisedShift: number | null;    // |shift| / pooledStddev
	readonly verdict: Verdict;
	readonly interpretation: string;
}

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<ChangePointInput, ChangePointOutput> = {
	id: 'data.anomaly.change-point.rdbms',
	name: 'Anomaly: change-point detection (RDBMS)',
	description:
		'Single change-point detection over a sorted (timestamp, value) sample. Scans every interior split, ' +
		'returns the k that maximises the standardised mean shift |L-R|/pooledStddev. Verdict: clear-change ' +
		'(>=2σ) / subtle-change (>=1σ) / no-change / inconclusive. Pairs with drift.distribution which ' +
		'compares two pre-chosen windows -- this skill *finds* the best split.',
	family: 'drift',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId:    { type: 'string' },
			target:          { type: 'string' },
			timestampColumn: { type: 'string' },
			valueColumn:     { type: 'string' },
			sampleSize:      { type: 'integer', minimum: 10, maximum: 50 },
		},
		required: ['connectionId', 'target', 'timestampColumn', 'valueColumn'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			target:                { type: 'string' },
			timestampColumn:       { type: 'string' },
			valueColumn:           { type: 'string' },
			sampleSize:            { type: 'number' },
			changePointIndex:      { type: ['number', 'null'] },
			changePointTimestamp:  { type: ['number', 'null'] },
			leftMean:              { type: ['number', 'null'] },
			rightMean:             { type: ['number', 'null'] },
			leftN:                 { type: ['number', 'null'] },
			rightN:                { type: ['number', 'null'] },
			shiftMagnitude:        { type: ['number', 'null'] },
			standardisedShift:     { type: ['number', 'null'] },
			verdict:               { type: 'string', enum: ['no-change', 'subtle-change', 'clear-change', 'inconclusive'] },
			interpretation:        { type: 'string' },
		},
		required: ['target', 'timestampColumn', 'valueColumn', 'sampleSize',
		           'changePointIndex', 'changePointTimestamp',
		           'leftMean', 'rightMean', 'leftN', 'rightN',
		           'shiftMagnitude', 'standardisedShift',
		           'verdict', 'interpretation'],
		additionalProperties: false,
	},
	toolDeps: ['db_sql_sample'],
	providerAffinity: 'local',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_sample'],
			reason: 'sample provides the (timestamp, value) pairs to scan for the best split',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only',
		},
	],

	async execute(input, deps): Promise<SkillResult<ChangePointOutput>> {
		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampSample(input.sampleSize);

		const tool = await deps.runTool({
			id: callId,
			name: 'db_sql_sample',
			input: { connectionId: input.connectionId, target: input.target, limit: sampleSize },
		});

		if (tool.isError) {
			return {
				value: empty(input),
				confidence: 'low',
				notes: [`db_sql_sample error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}
		const data = tool.data;
		if (!isSampleResult(data)) {
			return {
				value: empty(input),
				confidence: 'low',
				notes: ['anomaly.change-point: tool result missing structured data'],
				toolCalls: [],
			};
		}

		// Build (t, v) pairs from the sample.
		const pairs: { t: number; v: number }[] = [];
		const haveCols = data.columns.includes(input.timestampColumn)
			&& data.columns.includes(input.valueColumn);
		if (haveCols) {
			for (const row of data.rows) {
				const tRaw = row[input.timestampColumn];
				const vRaw = row[input.valueColumn];
				if (tRaw === null || tRaw === undefined || vRaw === null || vRaw === undefined) continue;
				const t = parseTimestamp(tRaw);
				const v = typeof vRaw === 'number' ? vRaw : Number(vRaw);
				if (t === null || !Number.isFinite(v)) continue;
				pairs.push({ t, v });
			}
		}
		pairs.sort((a, b) => a.t - b.t);
		const n = pairs.length;

		// Need enough points on each side of any candidate split.
		if (n < MIN_SIDE * 2) {
			return {
				value: {
					...empty(input),
					sampleSize: n,
					interpretation: `sample too small (n=${n}); need at least ${MIN_SIDE * 2} valid (timestamp, value) pairs for a meaningful split`,
				},
				confidence: 'medium',
				toolCalls: [],
			};
		}

		// Pre-compute prefix sums for O(n) per-split mean evaluation.
		const sums = new Array<number>(n + 1).fill(0);
		const sumsSq = new Array<number>(n + 1).fill(0);
		for (let i = 0; i < n; i++) {
			sums[i + 1] = sums[i]! + pairs[i]!.v;
			sumsSq[i + 1] = sumsSq[i]! + pairs[i]!.v * pairs[i]!.v;
		}
		const totalSum = sums[n]!;
		const totalSumSq = sumsSq[n]!;
		const totalMean = totalSum / n;
		const totalVar  = totalSumSq / n - totalMean * totalMean;
		const totalStddev = totalVar > 0 ? Math.sqrt(totalVar) : 0;

		// Scan splits k in [MIN_SIDE .. n - MIN_SIDE]; find max
		// standardised mean shift. We use the OVERALL sample stddev
		// as the scale -- it's stable across splits and matches the
		// CUSUM-style normalised statistic.
		let bestK = -1;
		let bestStat = -1;
		for (let k = MIN_SIDE; k <= n - MIN_SIDE; k++) {
			const leftSum  = sums[k]!;
			const rightSum = totalSum - leftSum;
			const leftMean = leftSum  / k;
			const rightMean = rightSum / (n - k);
			const shift = Math.abs(leftMean - rightMean);
			const stat = totalStddev > 0 ? shift / totalStddev : 0;
			if (stat > bestStat) {
				bestStat = stat;
				bestK = k;
			}
		}

		const k = bestK;
		const leftSum  = sums[k]!;
		const rightSum = totalSum - leftSum;
		const leftN    = k;
		const rightN   = n - k;
		const leftMean  = leftSum  / leftN;
		const rightMean = rightSum / rightN;
		const shiftMagnitude = Math.abs(leftMean - rightMean);
		const standardisedShift = bestStat;

		// Midpoint timestamp between the two observations adjacent to the split.
		const tBefore = pairs[k - 1]!.t;
		const tAfter  = pairs[k]!.t;
		const cpTimestamp = (tBefore + tAfter) / 2;

		let verdict: Verdict;
		let interpretation: string;
		if (totalStddev === 0) {
			verdict = 'no-change';
			interpretation = 'value column is constant across the sample; no change point exists';
		} else if (standardisedShift >= 2.0) {
			verdict = 'clear-change';
			interpretation = `clear change at sample index ${k}: leftMean=${leftMean.toFixed(2)} (n=${leftN}), rightMean=${rightMean.toFixed(2)} (n=${rightN}); standardised shift = ${standardisedShift.toFixed(2)}σ`;
		} else if (standardisedShift >= 1.0) {
			verdict = 'subtle-change';
			interpretation = `subtle change at sample index ${k}: leftMean=${leftMean.toFixed(2)}, rightMean=${rightMean.toFixed(2)}; standardised shift = ${standardisedShift.toFixed(2)}σ`;
		} else {
			verdict = 'no-change';
			interpretation = `best split has standardised shift only ${standardisedShift.toFixed(2)}σ; no clear change point`;
		}

		return {
			value: {
				target: data.target,
				timestampColumn: input.timestampColumn,
				valueColumn: input.valueColumn,
				sampleSize: n,
				changePointIndex: k,
				changePointTimestamp: cpTimestamp,
				leftMean, rightMean,
				leftN, rightN,
				shiftMagnitude, standardisedShift,
				verdict,
				interpretation,
			},
			confidence: 'high',
			toolCalls: [],
		};
	},
};

function parseTimestamp(raw: unknown): number | null {
	if (raw instanceof Date) return raw.getTime();
	if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
	if (typeof raw === 'string') {
		const ms = Date.parse(raw);
		return Number.isFinite(ms) ? ms : null;
	}
	if (typeof raw === 'bigint') return Number(raw);
	return null;
}

function clampSample(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return SAMPLE_DEFAULT;
	return Math.min(Math.max(10, Math.floor(n)), 50);
}

function empty(input: ChangePointInput): ChangePointOutput {
	return {
		target: input.target,
		timestampColumn: input.timestampColumn,
		valueColumn: input.valueColumn,
		sampleSize: 0,
		changePointIndex: null, changePointTimestamp: null,
		leftMean: null, rightMean: null, leftN: null, rightN: null,
		shiftMagnitude: null, standardisedShift: null,
		verdict: 'inconclusive',
		interpretation: '',
	};
}

interface SampleResultRaw {
	readonly target: string;
	readonly columns: readonly string[];
	readonly rows: readonly Readonly<Record<string, unknown>>[];
}

function isSampleResult(v: unknown): v is SampleResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& Array.isArray(o['columns'])
		&& Array.isArray(o['rows']);
}

export function registerDataAnomalyChangePointRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
