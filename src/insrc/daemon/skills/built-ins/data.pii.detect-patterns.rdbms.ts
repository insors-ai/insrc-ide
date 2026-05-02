/**
 * data.pii.detect-patterns.rdbms -- Phase 5e.1 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic skill: samples values from one RDBMS column and applies a
 * built-in set of PII regex patterns. Returns per-pattern hit count
 * + hit rate + up to three example matches, sorted by hit rate
 * descending. Provider affinity `local` -- the regex match runs in
 * the daemon, no LLM involvement.
 *
 * The regex set is **deliberately conservative**: each pattern is
 * anchored with `^...$` so a column containing "user@example.com,
 * also call 555-1234" doesn't double-match. PII columns in practice
 * carry one canonical value per row; a column that mixes formats is
 * a separate finding the caller can flag.
 *
 * False positives are surfaced as `examples`; a 60% hit rate over a
 * 50-row sample with three plausible-looking emails IS a strong PII
 * signal, but the caller (typically `pii.column-classifier` from
 * Phase 5e.2) is responsible for combining this with column-name
 * heuristics before issuing a sensitivity finding.
 *
 * Sample size: the underlying `db_sql_sample` tool clamps at 50.
 * Default `sampleSize` is 50; lower values give faster results but
 * worse precision. **No min-sample-size precondition** -- even one
 * match is informative for PII detection (security-sensitive lean).
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';

interface PiiDetectPatternsInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
	readonly sampleSize?: number;
}

interface PiiDetection {
	readonly pattern: string;
	readonly hitCount: number;
	readonly hitRate: number;        // hitCount / sampleSize
	readonly examples: readonly string[];  // up to 3 samples that matched
}

interface PiiDetectPatternsOutput {
	readonly target: string;
	readonly column: string;
	readonly sampleSize: number;
	readonly detections: readonly PiiDetection[];
	readonly topPattern: string | null;
}

const DETECTION_SCHEMA = {
	type: 'object',
	properties: {
		pattern:  { type: 'string' },
		hitCount: { type: 'number' },
		hitRate:  { type: 'number' },
		examples: { type: 'array', items: { type: 'string' } },
	},
	required: ['pattern', 'hitCount', 'hitRate', 'examples'],
	additionalProperties: false,
} as const;

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

/**
 * Built-in PII pattern set. Each entry is anchored (`^...$`) so it
 * matches only when the column value is a single canonical PII
 * token. The patterns are intentionally tight; we tolerate false
 * negatives (a "loose" email regex would match "x@y" which produces
 * many false positives in source-data columns containing usernames
 * with `@` in them).
 */
const PII_PATTERNS: ReadonlyArray<{ readonly name: string; readonly re: RegExp }> = [
	{ name: 'email',           re: /^[\w.+-]+@[\w-]+\.[\w.-]+$/ },
	{ name: 'ssn-us',          re: /^\d{3}-\d{2}-\d{4}$/ },
	{ name: 'phone-us',        re: /^(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}$/ },
	{ name: 'credit-card',     re: /^(?:\d{4}[- ]?){3}\d{4}$/ },
	{ name: 'jwt',             re: /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/ },
	{ name: 'ipv4',            re: /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/ },
	{ name: 'iban',            re: /^[A-Z]{2}\d{2}[A-Z0-9]{4,30}$/ },
	{ name: 'aws-access-key',  re: /^AKIA[0-9A-Z]{16}$/ },
	{ name: 'github-token',    re: /^(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}$/ },
	{ name: 'uuid',            re: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/ },
];

const skill: Skill<PiiDetectPatternsInput, PiiDetectPatternsOutput> = {
	id: 'data.pii.detect-patterns.rdbms',
	name: 'PII: detect patterns (RDBMS)',
	description:
		'Sample values from one RDBMS column and apply a built-in set of PII regex patterns: email / ssn-us / ' +
		'phone-us / credit-card / jwt / ipv4 / iban / aws-access-key / github-token / uuid. Returns per-pattern ' +
		'hit count + rate + examples. Anchored regex (single-token columns); false positives surface as examples ' +
		'for the caller to verify.',
	family: 'sensitivity',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			column:       { type: 'string' },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50, description: 'Default 50 (the tool cap).' },
		},
		required: ['connectionId', 'target', 'column'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			target:      { type: 'string' },
			column:      { type: 'string' },
			sampleSize:  { type: 'number' },
			detections:  { type: 'array', items: DETECTION_SCHEMA },
			topPattern:  { type: ['string', 'null'] },
		},
		required: ['target', 'column', 'sampleSize', 'detections', 'topPattern'],
		additionalProperties: false,
	},
	toolDeps: ['db_sql_sample'],
	providerAffinity: 'local',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_sample'],
			reason: 'sole tool that supplies the value sample we regex over',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only; file / kv variants ship as separate skills',
		},
	],

	async execute(input, deps): Promise<SkillResult<PiiDetectPatternsOutput>> {
		const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampSample(input.sampleSize);

		const tool = await deps.runTool({
			id: callId,
			name: 'db_sql_sample',
			input: {
				connectionId: input.connectionId,
				target: input.target,
				limit: sampleSize,
			},
		});

		if (tool.isError) {
			return {
				value: emptyResult(input.target, input.column, sampleSize),
				confidence: 'low',
				notes: [`db_sql_sample error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}
		const data = tool.data;
		if (!isSampleResult(data)) {
			return {
				value: emptyResult(input.target, input.column, sampleSize),
				confidence: 'low',
				notes: ['db_sql_sample returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}
		if (!data.columns.includes(input.column)) {
			return {
				value: emptyResult(input.target, input.column, sampleSize),
				confidence: 'low',
				notes: [`column '${input.column}' not present in sample (available: ${data.columns.join(', ')})`],
				toolCalls: [],
			};
		}

		// Build value list: skip nulls / undefined; stringify the rest.
		const values: string[] = [];
		for (const row of data.rows) {
			const v = row[input.column];
			if (v === null || v === undefined) continue;
			values.push(typeof v === 'string' ? v : String(v));
		}
		const actualN = values.length;
		const detections: PiiDetection[] = [];
		for (const { name, re } of PII_PATTERNS) {
			let hits = 0;
			const examples: string[] = [];
			for (const v of values) {
				if (re.test(v)) {
					hits++;
					if (examples.length < 3) examples.push(v);
				}
			}
			if (hits === 0) continue;
			detections.push({
				pattern: name,
				hitCount: hits,
				hitRate: actualN > 0 ? hits / actualN : 0,
				examples,
			});
		}
		// Sort by hit rate desc, then by name asc for determinism.
		detections.sort((a, b) => b.hitRate - a.hitRate || a.pattern.localeCompare(b.pattern));
		const topPattern = detections.length > 0 ? detections[0]!.pattern : null;

		return {
			value: {
				target: data.target,
				column: input.column,
				sampleSize: actualN,
				detections,
				topPattern,
			},
			// `high` when at least one pattern matched; `medium` when no
			// pattern matched on a non-empty sample (clean signal); `low`
			// when the sample itself was empty (can't conclude anything).
			confidence: detections.length > 0 ? 'high' : (actualN > 0 ? 'medium' : 'low'),
			toolCalls: [],
		};
	},
};

function clampSample(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return 50;
	return Math.min(Math.max(1, Math.floor(n)), 50);
}

function emptyResult(target: string, column: string, sampleSize: number): PiiDetectPatternsOutput {
	return { target, column, sampleSize, detections: [], topPattern: null };
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

export function registerDataPiiDetectPatternsRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
