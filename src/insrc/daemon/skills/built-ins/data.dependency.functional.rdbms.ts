/**
 * data.dependency.functional.rdbms -- Phase 5c.3 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic dependency skill: pairwise functional dependency over a
 * 50-row sample. For every ordered pair (A, B) we ask "does A
 * determine B?" -- i.e. does each value of A map to exactly one
 * value of B?
 *
 * Per-pair logic:
 *   1. Skip rows where A is null (FD is undefined for an unknown
 *      key). Rows where B is null still count -- "A always maps
 *      to NULL" is a valid determination.
 *   2. Group remaining rows by A's value. For each group, count
 *      distinct B values.
 *   3. determinationScore = groups where (distinct B = 1)
 *                           / total groups
 *   4. A `determines` B = (score >= 0.95 AND informativeGroups >= 3)
 *      where informativeGroups = groups with size >= 2 -- the
 *      ones that can actually violate the FD. Without enough
 *      informative groups the claim is too weak even at 100%.
 *
 * Asymmetric: A->B is checked separately from B->A. Both directions
 * appear in the output. Sample-based -- a precise full-table
 * answer requires SQL of the form `SELECT a, COUNT(DISTINCT b)
 * GROUP BY a HAVING COUNT(DISTINCT b) > 1` which the current
 * `db_sql_aggregate` doesn't expose.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';

const COL_CAP = 10;            // ordered pairs grow O(n^2 * 2); 10 cols = 90 pairs
const PAIR_OUTPUT_CAP = 50;
const DETERMINES_THRESHOLD = 0.95;
const MIN_INFORMATIVE_GROUPS = 3;

interface FunctionalDepInput {
	readonly connectionId: string;
	readonly target: string;
	readonly columns?: readonly string[];
	readonly sampleSize?: number;
}

interface FdViolation {
	readonly fromValue: unknown;
	readonly toValues: readonly unknown[];
}

interface FdResult {
	readonly from: string;
	readonly to: string;
	readonly fromDistinctCount: number;
	readonly informativeGroups: number;
	readonly avgValuesPerFrom: number;
	readonly maxValuesPerFrom: number;
	readonly determinationScore: number;
	readonly determines: boolean;
	readonly violations: readonly FdViolation[];
}

interface FunctionalDepOutput {
	readonly target: string;
	readonly sampleSize: number;
	readonly columns: readonly string[];
	readonly fds: readonly FdResult[];
	readonly truncated: boolean;
}

const FD_SCHEMA = {
	type: 'object',
	properties: {
		from:               { type: 'string' },
		to:                 { type: 'string' },
		fromDistinctCount:  { type: 'number' },
		informativeGroups:  { type: 'number' },
		avgValuesPerFrom:   { type: 'number' },
		maxValuesPerFrom:   { type: 'number' },
		determinationScore: { type: 'number' },
		determines:         { type: 'boolean' },
		violations: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					fromValue: {},
					toValues:  { type: 'array' },
				},
				required: ['fromValue', 'toValues'],
				additionalProperties: false,
			},
		},
	},
	required: ['from', 'to', 'fromDistinctCount', 'informativeGroups',
	           'avgValuesPerFrom', 'maxValuesPerFrom', 'determinationScore',
	           'determines', 'violations'],
	additionalProperties: false,
} as const;

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<FunctionalDepInput, FunctionalDepOutput> = {
	id: 'data.dependency.functional.rdbms',
	name: 'Dependency: pairwise functional dependency (RDBMS)',
	description:
		'Pairwise functional dependency check ("does A determine B?") over a 50-row sample. For every ' +
		'ordered pair, groups rows by A, counts distinct B values per group, and reports ' +
		'determinationScore + a determines flag (score >= 0.95 AND informativeGroups >= 3). Sample-based; ' +
		'precise full-table FD checks need a count-distinct-grouped aggregate not yet shipped. Cap: 10 ' +
		'columns / 90 ordered pairs per call.',
	family: 'dependency',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			columns:      { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 10 },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50 },
		},
		required: ['connectionId', 'target'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			target:     { type: 'string' },
			sampleSize: { type: 'number' },
			columns:    { type: 'array', items: { type: 'string' } },
			fds:        { type: 'array', items: FD_SCHEMA },
			truncated:  { type: 'boolean' },
		},
		required: ['target', 'sampleSize', 'columns', 'fds', 'truncated'],
		additionalProperties: false,
	},
	toolDeps: ['db_sql_describe', 'db_sql_sample'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_describe', 'db_sql_sample'],
			reason: 'describe gives the column list; sample gives the rows we group by',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only',
		},
	],

	async execute(input, deps): Promise<SkillResult<FunctionalDepOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampSample(input.sampleSize);
		const notes: string[] = [];

		const cols = await resolveColumns(input, deps, callBase);
		if (typeof cols === 'string') {
			return { value: empty(input.target), confidence: 'low', notes: [cols], toolCalls: [] };
		}
		if (cols.length < 2) {
			return {
				value: { target: input.target, sampleSize: 0, columns: cols, fds: [], truncated: false },
				confidence: 'medium',
				notes: ['functional dependency needs at least 2 columns'],
				toolCalls: [],
			};
		}

		const truncated = cols.length > COL_CAP;
		const usedCols = truncated ? cols.slice(0, COL_CAP) : cols;
		if (truncated) {
			notes.push(
				`functional dependency truncated: ${cols.length} columns -> profiling first ${COL_CAP}. ` +
				`Pass explicit \`columns\` to slice differently.`,
			);
		}

		const sampleResult = await deps.runTool({
			id: `${callBase}-sample`,
			name: 'db_sql_sample',
			input: { connectionId: input.connectionId, target: input.target, limit: sampleSize },
		});
		if (sampleResult.isError) {
			return {
				value: empty(input.target),
				confidence: 'low',
				notes: [...notes, `db_sql_sample error: ${sampleResult.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}
		const sampleData = sampleResult.data;
		if (!isSampleResult(sampleData)) {
			return {
				value: empty(input.target),
				confidence: 'low',
				notes: [...notes, 'db_sql_sample returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		const presentCols = usedCols.filter(c => sampleData.columns.includes(c));
		if (presentCols.length < 2) {
			return {
				value: { target: sampleData.target, sampleSize: sampleData.rows.length, columns: presentCols, fds: [], truncated },
				confidence: 'medium',
				notes: [...notes, `functional dependency: < 2 of the requested columns present in sample`],
				toolCalls: [],
			};
		}

		const fds: FdResult[] = [];
		for (const from of presentCols) {
			for (const to of presentCols) {
				if (from === to) continue;
				fds.push(computeFD(from, to, sampleData.rows));
			}
		}

		// Sort: determines=true first, then by determinationScore desc,
		// then by informativeGroups desc, then alphabetically.
		fds.sort((a, b) => {
			if (a.determines !== b.determines) return a.determines ? -1 : 1;
			if (a.determinationScore !== b.determinationScore) return b.determinationScore - a.determinationScore;
			if (a.informativeGroups !== b.informativeGroups) return b.informativeGroups - a.informativeGroups;
			const ak = `${a.from}->${a.to}`;
			const bk = `${b.from}->${b.to}`;
			return ak.localeCompare(bk);
		});
		const cappedFds = fds.length > PAIR_OUTPUT_CAP ? fds.slice(0, PAIR_OUTPUT_CAP) : fds;
		if (fds.length > PAIR_OUTPUT_CAP) {
			notes.push(`functional dependency: ${fds.length} ordered pairs computed; output capped at ${PAIR_OUTPUT_CAP}`);
		}

		const anyInformative = fds.some(f => f.informativeGroups > 0);
		return {
			value: {
				target: sampleData.target,
				sampleSize: sampleData.rows.length,
				columns: presentCols,
				fds: cappedFds,
				truncated,
			},
			// `high` when at least one pair had informative groups (we
			// have signal worth surfacing). `medium` when every pair
			// had at most singletons -- the FD claims are weak.
			confidence: anyInformative ? 'high' : 'medium',
			...(notes.length > 0 ? { notes } : {}),
			toolCalls: [],
		};
	},
};

/**
 * Compute one ordered FD A -> B over the sample. Skips rows where
 * A is null (FD undefined for an unknown key); rows where B is
 * null are kept (null is a real B observation).
 */
function computeFD(
	from: string,
	to: string,
	rows: readonly Readonly<Record<string, unknown>>[],
): FdResult {
	// Group rows by stringified A value. We use JSON.stringify rather
	// than === so object / array values group correctly; primitives
	// stringify trivially.
	const groups = new Map<string, unknown[]>(); // a-key -> list of b-values
	let totalCounted = 0;
	for (const row of rows) {
		const aRaw = row[from];
		if (aRaw === null || aRaw === undefined) continue;
		const aKey = canonical(aRaw);
		const existing = groups.get(aKey);
		const bRaw = row[to];
		if (existing === undefined) groups.set(aKey, [bRaw]);
		else existing.push(bRaw);
		totalCounted++;
	}

	let consistentGroups = 0;
	let informativeGroups = 0;
	let totalDistinctB = 0;
	let maxDistinctB = 0;
	const violations: FdViolation[] = [];

	for (const [aKey, bValues] of groups) {
		const distinctB = new Set(bValues.map(canonical));
		const distinctCount = distinctB.size;
		totalDistinctB += distinctCount;
		if (distinctCount > maxDistinctB) maxDistinctB = distinctCount;
		if (bValues.length >= 2) informativeGroups++;
		if (distinctCount === 1) consistentGroups++;
		else if (violations.length < 3) {
			// Reconstruct the original (un-canonicalized) values for
			// the violation example. The keys are canonical strings;
			// use the first row's actual values.
			violations.push({
				fromValue: revive(aKey, bValues, from, rows, to),
				toValues: [...new Set(bValues.map(canonical))].slice(0, 5).map(s => reviveValue(s, bValues)),
			});
		}
	}

	const fromDistinctCount = groups.size;
	const determinationScore = fromDistinctCount > 0
		? consistentGroups / fromDistinctCount
		: 0;
	const avgValuesPerFrom = fromDistinctCount > 0
		? totalDistinctB / fromDistinctCount
		: 0;
	const determines = determinationScore >= DETERMINES_THRESHOLD
		&& informativeGroups >= MIN_INFORMATIVE_GROUPS;

	return {
		from, to,
		fromDistinctCount,
		informativeGroups,
		avgValuesPerFrom,
		maxValuesPerFrom: maxDistinctB,
		determinationScore,
		determines,
		violations,
	};
}

/** Stable string key for value comparison. */
function canonical(v: unknown): string {
	if (v === null || v === undefined) return ' NULL ';
	if (typeof v === 'string') return `s:${v}`;
	if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return `p:${String(v)}`;
	try { return `o:${JSON.stringify(v)}`; }
	catch { return `o:${String(v)}`; }
}

/** Find the first un-canonicalized value matching a canonical key
 *  in the sampled rows (best-effort; falls back to the canonical
 *  string when the key can't be located, which shouldn't happen). */
function revive(
	canonicalKey: string,
	_bValues: readonly unknown[],
	from: string,
	rows: readonly Readonly<Record<string, unknown>>[],
	_to: string,
): unknown {
	for (const row of rows) {
		const v = row[from];
		if (v === null || v === undefined) continue;
		if (canonical(v) === canonicalKey) return v;
	}
	return canonicalKey;
}

function reviveValue(canonicalKey: string, bValues: readonly unknown[]): unknown {
	for (const v of bValues) {
		if (canonical(v) === canonicalKey) return v;
	}
	return canonicalKey;
}

function clampSample(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return 50;
	return Math.min(Math.max(1, Math.floor(n)), 50);
}

async function resolveColumns(
	input: FunctionalDepInput,
	deps: SkillDeps,
	callBase: string,
): Promise<readonly string[] | string> {
	if (input.columns !== undefined && input.columns.length > 0) return input.columns;
	const describe = await deps.runTool({
		id: `${callBase}-desc`,
		name: 'db_sql_describe',
		input: { connectionId: input.connectionId, target: input.target },
	});
	if (describe.isError) {
		return `db_sql_describe error: ${describe.content.slice(0, 200)}`;
	}
	const data = describe.data;
	if (typeof data !== 'object' || data === null || !Array.isArray((data as { columns: unknown }).columns)) {
		return 'db_sql_describe returned a result without the expected structured data shape';
	}
	const cols = (data as { columns: { name: string }[] }).columns
		.map(c => c.name)
		.filter(n => typeof n === 'string' && n.length > 0);
	if (cols.length === 0) return `target '${input.target}' has no columns`;
	return cols;
}

function empty(target: string): FunctionalDepOutput {
	return { target, sampleSize: 0, columns: [], fds: [], truncated: false };
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

export function registerDataDependencyFunctionalRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
