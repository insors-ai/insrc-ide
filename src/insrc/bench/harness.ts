/**
 * Benchmark harness for the LMDB + Lance substrate.
 *
 * Phase 7.3 of plans/storage-migration-lmdb-lance.md. Promotes the
 * Phase 0.4 spike scripts from one-off scale-validation to a
 * permanent CI regression gate.
 *
 * Two tiers:
 *
 *   smoke -- 100k edges + 50k vectors, ~30 s total. Runs on every PR.
 *   full  -- 1M / 10M edges + 1M vectors, multi-minute. Manual /
 *            nightly only.
 *
 * Each run produces an `OpResult` per measured operation with
 * count + percentile latencies, plus a `RunResult` with peak RSS,
 * file sizes, and metadata. Compared against a recorded baseline
 * JSON file; regression = p99 latency > 1.30x baseline OR any file
 * size > 1.30x baseline.
 *
 * `--update-baselines` records the current run as the new baseline
 * (manual decision, requires reviewer sign-off per the plan's
 * "baselines refreshed quarterly" note).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Tier = 'smoke' | 'full';

export interface OpResult {
	readonly name:        string;
	readonly count:       number;
	readonly p50_ms:      number;
	readonly p95_ms:      number;
	readonly p99_ms:      number;
	readonly max_ms:      number;
}

export interface RunResult {
	readonly tier:           Tier;
	readonly timestamp:      string;
	readonly nodeVersion:    string;
	readonly peakRssMb:      number;
	readonly fileSizesMb:    Record<string, number>;
	readonly ops:            OpResult[];
}

// ---------------------------------------------------------------------------
// Bench
// ---------------------------------------------------------------------------

export class Bench {
	private peakRssMb = 0;
	private readonly ops:         OpResult[]              = [];
	private readonly fileSizesMb: Record<string, number>  = {};

	constructor(public readonly tier: Tier) {
		this.samplePeak();
	}

	/**
	 * Run `fn` once and record its elapsed time as a single-sample op.
	 * Use for bulk operations (e.g. "insert 100k entities") where the
	 * per-call cost dominates the per-row cost.
	 */
	async runOnce(name: string, fn: () => Promise<void>): Promise<OpResult> {
		const t0 = process.hrtime.bigint();
		await fn();
		const dt = Number(process.hrtime.bigint() - t0) / 1e6;
		this.samplePeak();
		const result: OpResult = {
			name, count: 1,
			p50_ms: dt, p95_ms: dt, p99_ms: dt, max_ms: dt,
		};
		this.ops.push(result);
		return result;
	}

	/**
	 * Run `fn` `n` times and record per-call latency. Returns
	 * percentile summary.
	 */
	async run(name: string, n: number, fn: () => Promise<void>): Promise<OpResult> {
		const samples: number[] = new Array(n);
		for (let i = 0; i < n; i++) {
			const t0 = process.hrtime.bigint();
			await fn();
			samples[i] = Number(process.hrtime.bigint() - t0) / 1e6;
		}
		this.samplePeak();
		samples.sort((a, b) => a - b);
		const result: OpResult = {
			name, count: n,
			p50_ms: percentile(samples, 0.50),
			p95_ms: percentile(samples, 0.95),
			p99_ms: percentile(samples, 0.99),
			max_ms: samples[samples.length - 1]!,
		};
		this.ops.push(result);
		return result;
	}

	recordFileSizeMb(label: string, mb: number): void {
		this.fileSizesMb[label] = mb;
	}

	private samplePeak(): void {
		const rss = Math.round(process.memoryUsage().rss / 1024 / 1024);
		if (rss > this.peakRssMb) this.peakRssMb = rss;
	}

	finalize(): RunResult {
		return {
			tier:        this.tier,
			timestamp:   new Date().toISOString(),
			nodeVersion: process.version,
			peakRssMb:   this.peakRssMb,
			fileSizesMb: { ...this.fileSizesMb },
			ops:         [...this.ops],
		};
	}
}

// ---------------------------------------------------------------------------
// Percentiles
// ---------------------------------------------------------------------------

/**
 * Linear-interpolation percentile (0 ≤ p ≤ 1). Input must be sorted
 * ascending. Empty input returns 0; single-sample returns that value.
 */
export function percentile(sorted: readonly number[], p: number): number {
	if (sorted.length === 0) return 0;
	if (sorted.length === 1) return sorted[0]!;
	const idx = (sorted.length - 1) * p;
	const lo  = Math.floor(idx);
	const hi  = Math.ceil(idx);
	if (lo === hi) return sorted[lo]!;
	const frac = idx - lo;
	return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

// ---------------------------------------------------------------------------
// Baseline I/O + diff
// ---------------------------------------------------------------------------

export interface BaselineDiff {
	readonly tier:        Tier;
	readonly regressed:   boolean;
	readonly opDeltas:    OpDelta[];
	readonly fileDeltas:  FileDelta[];
	readonly missingOps:  string[];
	readonly newOps:      string[];
}

export interface OpDelta {
	readonly name:           string;
	readonly baseline_p99:   number;
	readonly current_p99:    number;
	readonly ratio:          number;   // current / baseline
	readonly regressed:      boolean;  // ratio > REGRESSION_THRESHOLD
}

export interface FileDelta {
	readonly label:          string;
	readonly baselineMb:     number;
	readonly currentMb:      number;
	readonly ratio:          number;
	readonly regressed:      boolean;
}

export const REGRESSION_THRESHOLD = 1.30; // 30% slower / bigger fails

export function loadBaseline(path: string): RunResult | null {
	if (!existsSync(path)) return null;
	const raw = readFileSync(path, 'utf8');
	return JSON.parse(raw) as RunResult;
}

export function saveBaseline(path: string, result: RunResult): void {
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(path, JSON.stringify(result, null, 2) + '\n');
}

export function diffAgainstBaseline(
	current:  RunResult,
	baseline: RunResult | null,
): BaselineDiff {
	if (baseline === null) {
		return {
			tier:       current.tier,
			regressed:  false,
			opDeltas:   [],
			fileDeltas: [],
			missingOps: [],
			newOps:     current.ops.map(o => o.name),
		};
	}

	const baselineByOp = new Map(baseline.ops.map(o => [o.name, o] as const));
	const currentByOp  = new Map(current.ops.map(o => [o.name, o] as const));

	const opDeltas: OpDelta[] = [];
	const newOps:   string[]  = [];
	for (const cur of current.ops) {
		const base = baselineByOp.get(cur.name);
		if (base === undefined) {
			newOps.push(cur.name);
			continue;
		}
		const ratio = base.p99_ms === 0 ? 1 : cur.p99_ms / base.p99_ms;
		opDeltas.push({
			name:         cur.name,
			baseline_p99: base.p99_ms,
			current_p99:  cur.p99_ms,
			ratio,
			regressed:    ratio > REGRESSION_THRESHOLD,
		});
	}

	const missingOps: string[] = [];
	for (const base of baseline.ops) {
		if (!currentByOp.has(base.name)) missingOps.push(base.name);
	}

	const fileDeltas: FileDelta[] = [];
	for (const [label, currentMb] of Object.entries(current.fileSizesMb)) {
		const baselineMb = baseline.fileSizesMb[label] ?? 0;
		const ratio = baselineMb === 0 ? 1 : currentMb / baselineMb;
		fileDeltas.push({
			label, baselineMb, currentMb, ratio,
			regressed: baselineMb > 0 && ratio > REGRESSION_THRESHOLD,
		});
	}

	const regressed = opDeltas.some(d => d.regressed) || fileDeltas.some(d => d.regressed);

	return { tier: current.tier, regressed, opDeltas, fileDeltas, missingOps, newOps };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export function renderRunResult(result: RunResult): string {
	const lines: string[] = [];
	lines.push(`# Bench result: ${result.tier} tier`);
	lines.push(`Recorded: ${result.timestamp}  (Node ${result.nodeVersion})`);
	lines.push(`Peak RSS: ${result.peakRssMb} MiB`);
	if (Object.keys(result.fileSizesMb).length > 0) {
		lines.push('File sizes:');
		for (const [label, mb] of Object.entries(result.fileSizesMb)) {
			lines.push(`  ${label}: ${mb} MiB`);
		}
	}
	lines.push('');
	lines.push('| Operation | count | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) |');
	lines.push('|---|---:|---:|---:|---:|---:|');
	for (const op of result.ops) {
		lines.push(`| ${op.name} | ${op.count} | ${fmt(op.p50_ms)} | ${fmt(op.p95_ms)} | ${fmt(op.p99_ms)} | ${fmt(op.max_ms)} |`);
	}
	return lines.join('\n');
}

export function renderDiff(diff: BaselineDiff): string {
	const lines: string[] = [];
	lines.push(`# Baseline diff: ${diff.tier} tier  (threshold: ${((REGRESSION_THRESHOLD - 1) * 100).toFixed(0)}%)`);
	lines.push('');
	if (diff.opDeltas.length === 0 && diff.fileDeltas.length === 0 && diff.newOps.length === 0) {
		lines.push('_no comparable measurements_');
		return lines.join('\n');
	}
	if (diff.opDeltas.length > 0) {
		lines.push('| Op | baseline p99 | current p99 | ratio | status |');
		lines.push('|---|---:|---:|---:|---|');
		for (const d of diff.opDeltas) {
			const status = d.regressed ? '**REGRESSED**' : 'ok';
			lines.push(`| ${d.name} | ${fmt(d.baseline_p99)} | ${fmt(d.current_p99)} | ${d.ratio.toFixed(2)}x | ${status} |`);
		}
		lines.push('');
	}
	if (diff.fileDeltas.length > 0) {
		lines.push('| File | baseline (MiB) | current (MiB) | ratio | status |');
		lines.push('|---|---:|---:|---:|---|');
		for (const d of diff.fileDeltas) {
			const status = d.regressed ? '**REGRESSED**' : 'ok';
			lines.push(`| ${d.label} | ${d.baselineMb} | ${d.currentMb} | ${d.ratio.toFixed(2)}x | ${status} |`);
		}
		lines.push('');
	}
	if (diff.newOps.length > 0) {
		lines.push(`New ops (no baseline yet): ${diff.newOps.join(', ')}`);
	}
	if (diff.missingOps.length > 0) {
		lines.push(`Ops missing from current run (in baseline): ${diff.missingOps.join(', ')}`);
	}
	lines.push(diff.regressed ? '\n**OVERALL: REGRESSED**' : '\n**OVERALL: OK**');
	return lines.join('\n');
}

function fmt(ms: number): string {
	return ms < 10 ? ms.toFixed(2)
		: ms < 1000 ? ms.toFixed(0)
		: (ms / 1000).toFixed(2) + ' s';
}
