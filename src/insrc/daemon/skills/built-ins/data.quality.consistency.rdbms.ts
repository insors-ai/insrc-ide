/**
 * data.quality.consistency.rdbms -- Phase 5d.5 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Atomic quality skill: cross-column consistency rule checks. The
 * caller supplies a list of rules (`{ name, leftColumn, op,
 * rightColumn }`); the skill samples 50 rows, evaluates each rule
 * per row, and returns satisfied / violated / inapplicable counts
 * plus an overall verdict.
 *
 * Supported operators:
 *   - Pairwise comparison: `<`, `<=`, `=`, `!=`, `>=`, `>`
 *     Either side null -> inapplicable (the comparison is
 *     undefined). For numeric / date-shaped columns the
 *     comparison parses to Number when possible, else compares
 *     lexicographically (ISO-format date strings compare
 *     correctly that way).
 *   - `and-not-null`: both columns must be non-null. Useful for
 *     "if X is set then Y must be set too" -- expressed as the
 *     equivalence "both filled together". Reports inapplicable
 *     when both are null (no signal either way).
 *   - `xor-null`: exactly one must be null (mutually exclusive
 *     fields). Useful for "either A or B but not both".
 *
 * Sample-based -- precise full-table consistency would need
 * per-rule SQL of the form `SELECT COUNT(*) WHERE NOT (rule)`,
 * which the current `db_sql_aggregate` doesn't expose. The 50-row
 * sample is the v1 compromise; output documents this. The skill
 * surfaces up to 3 violation examples per rule for diagnosis.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';

const SAMPLE_DEFAULT = 50;
const VIOLATION_EXAMPLES = 3;

type ConsistencyOp = '<' | '<=' | '=' | '!=' | '>=' | '>' | 'and-not-null' | 'xor-null';

interface ConsistencyRule {
	readonly name: string;
	readonly leftColumn: string;
	readonly op: ConsistencyOp;
	readonly rightColumn: string;
}

interface ConsistencyInput {
	readonly connectionId: string;
	readonly target: string;
	readonly rules: readonly ConsistencyRule[];
	readonly sampleSize?: number;
}

interface RuleViolation {
	readonly leftValue: unknown;
	readonly rightValue: unknown;
}

interface RuleResult {
	readonly name: string;
	readonly leftColumn: string;
	readonly op: ConsistencyOp;
	readonly rightColumn: string;
	readonly satisfied: number;
	readonly violated: number;
	readonly inapplicable: number;
	readonly satisfactionRate: number | null;  // satisfied / (satisfied + violated); null if no applicable rows
	readonly examples: readonly RuleViolation[];
}

type Verdict = 'consistent' | 'mostly-consistent' | 'mixed' | 'broken' | 'inconclusive';

interface ConsistencyOutput {
	readonly target: string;
	readonly sampleSize: number;
	readonly rules: readonly RuleResult[];
	readonly verdict: Verdict;
	readonly interpretation: string;
}

const RULE_SCHEMA = {
	type: 'object',
	properties: {
		name:         { type: 'string' },
		leftColumn:   { type: 'string' },
		op:           { type: 'string', enum: ['<', '<=', '=', '!=', '>=', '>', 'and-not-null', 'xor-null'] },
		rightColumn:  { type: 'string' },
	},
	required: ['name', 'leftColumn', 'op', 'rightColumn'],
	additionalProperties: false,
} as const;

const RULE_RESULT_SCHEMA = {
	type: 'object',
	properties: {
		name:             { type: 'string' },
		leftColumn:       { type: 'string' },
		op:               { type: 'string' },
		rightColumn:      { type: 'string' },
		satisfied:        { type: 'number' },
		violated:         { type: 'number' },
		inapplicable:     { type: 'number' },
		satisfactionRate: { type: ['number', 'null'] },
		examples: {
			type: 'array',
			items: {
				type: 'object',
				properties: { leftValue: {}, rightValue: {} },
				required: ['leftValue', 'rightValue'],
				additionalProperties: false,
			},
		},
	},
	required: ['name', 'leftColumn', 'op', 'rightColumn',
	           'satisfied', 'violated', 'inapplicable', 'satisfactionRate', 'examples'],
	additionalProperties: false,
} as const;

const RDBMS_FAMILY_TAGS = [
	'rdbms', 'postgres', 'cockroachdb',
	'mysql', 'mariadb', 'sqlite',
	'mssql', 'oracle', 'clickhouse',
] as const;

const skill: Skill<ConsistencyInput, ConsistencyOutput> = {
	id: 'data.quality.consistency.rdbms',
	name: 'Quality: cross-column consistency (RDBMS)',
	description:
		'Evaluates caller-supplied cross-column rules over a 50-row sample. Operators: comparison ' +
		'(< <= = != >= >) with null-aware inapplicable handling, plus and-not-null (both must be filled) ' +
		'and xor-null (exactly one must be null). Returns per-rule satisfied/violated/inapplicable counts + ' +
		'satisfaction rate + up to 3 violation examples. Verdict: consistent / mostly-consistent / mixed / ' +
		'broken / inconclusive. Sample-based; precise per-rule full-table counts need a count-where ' +
		'aggregate not yet shipped.',
	family: 'quality-profile',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			rules:        { type: 'array', items: RULE_SCHEMA, minItems: 1, maxItems: 20 },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50 },
		},
		required: ['connectionId', 'target', 'rules'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			target:         { type: 'string' },
			sampleSize:     { type: 'number' },
			rules:          { type: 'array', items: RULE_RESULT_SCHEMA },
			verdict:        { type: 'string', enum: ['consistent', 'mostly-consistent', 'mixed', 'broken', 'inconclusive'] },
			interpretation: { type: 'string' },
		},
		required: ['target', 'sampleSize', 'rules', 'verdict', 'interpretation'],
		additionalProperties: false,
	},
	toolDeps: ['db_sql_sample'],
	providerAffinity: 'local',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['db_sql_sample'],
			reason: 'sole tool that supplies the rows we evaluate rules over',
		},
		{
			kind: 'connection-family',
			families: RDBMS_FAMILY_TAGS,
			reason: 'RDBMS-only',
		},
	],

	async execute(input, deps): Promise<SkillResult<ConsistencyOutput>> {
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
				value: empty(input.target, input.rules),
				confidence: 'low',
				notes: [`db_sql_sample error: ${tool.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}
		const data = tool.data;
		if (!isSampleResult(data)) {
			return {
				value: empty(input.target, input.rules),
				confidence: 'low',
				notes: ['db_sql_sample returned a result without the expected structured data shape'],
				toolCalls: [],
			};
		}

		// Validate every rule's columns are present in the sample.
		const missing: string[] = [];
		for (const r of input.rules) {
			if (!data.columns.includes(r.leftColumn)) missing.push(`${r.name}.left=${r.leftColumn}`);
			if (!data.columns.includes(r.rightColumn)) missing.push(`${r.name}.right=${r.rightColumn}`);
		}
		if (missing.length > 0) {
			return {
				value: empty(input.target, input.rules),
				confidence: 'low',
				notes: [`columns missing from sample: ${missing.join(', ')}; available: ${data.columns.join(', ')}`],
				toolCalls: [],
			};
		}

		const ruleResults: RuleResult[] = input.rules.map(rule => evaluateRule(rule, data.rows));

		const verdict = classifyVerdict(ruleResults);
		const interpretation = describeVerdict(verdict, ruleResults);

		return {
			value: {
				target: data.target,
				sampleSize: data.rows.length,
				rules: ruleResults,
				verdict,
				interpretation,
			},
			confidence: verdict === 'inconclusive' ? 'medium' : 'high',
			toolCalls: [],
		};
	},
};

function evaluateRule(
	rule: ConsistencyRule,
	rows: readonly Readonly<Record<string, unknown>>[],
): RuleResult {
	let satisfied = 0;
	let violated = 0;
	let inapplicable = 0;
	const examples: RuleViolation[] = [];
	for (const row of rows) {
		const lv = row[rule.leftColumn];
		const rv = row[rule.rightColumn];
		const verdict = checkRule(rule.op, lv, rv);
		if (verdict === 'satisfied') satisfied++;
		else if (verdict === 'violated') {
			violated++;
			if (examples.length < VIOLATION_EXAMPLES) examples.push({ leftValue: lv, rightValue: rv });
		} else inapplicable++;
	}
	const applicable = satisfied + violated;
	const satisfactionRate = applicable > 0 ? satisfied / applicable : null;
	return {
		name: rule.name,
		leftColumn: rule.leftColumn,
		op: rule.op,
		rightColumn: rule.rightColumn,
		satisfied, violated, inapplicable,
		satisfactionRate,
		examples,
	};
}

function checkRule(
	op: ConsistencyOp, lv: unknown, rv: unknown,
): 'satisfied' | 'violated' | 'inapplicable' {
	const lNull = lv === null || lv === undefined;
	const rNull = rv === null || rv === undefined;
	if (op === 'and-not-null') {
		if (lNull && rNull) return 'inapplicable';
		if (!lNull && !rNull) return 'satisfied';
		return 'violated';
	}
	if (op === 'xor-null') {
		if (lNull !== rNull) return 'satisfied';
		// Both null OR both filled -> the rule wants exactly one null.
		// If both filled the row violates xor; if both null we treat as
		// inapplicable (no information either way).
		if (lNull && rNull) return 'inapplicable';
		return 'violated';
	}
	// Comparison ops require both sides non-null.
	if (lNull || rNull) return 'inapplicable';
	const cmp = compareValues(lv, rv);
	if (cmp === undefined) return 'inapplicable';  // incomparable types
	switch (op) {
		case '<':  return cmp <  0 ? 'satisfied' : 'violated';
		case '<=': return cmp <= 0 ? 'satisfied' : 'violated';
		case '=':  return cmp === 0 ? 'satisfied' : 'violated';
		case '!=': return cmp !== 0 ? 'satisfied' : 'violated';
		case '>=': return cmp >= 0 ? 'satisfied' : 'violated';
		case '>':  return cmp >  0 ? 'satisfied' : 'violated';
	}
}

/**
 * Tri-comparison: returns -1 / 0 / +1 if comparable, undefined otherwise.
 * Numeric < numeric uses numeric ordering. String < string uses
 * lexicographic ordering (ISO-format date strings compare correctly).
 * Mixed types compare by stringification -- consistent but probably
 * not meaningful; the "incomparable" case is returned for objects /
 * arrays where stringification varies by content.
 */
function compareValues(a: unknown, b: unknown): -1 | 0 | 1 | undefined {
	if (typeof a === 'number' && typeof b === 'number') {
		if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
		return a < b ? -1 : a > b ? 1 : 0;
	}
	if (typeof a === 'bigint' && typeof b === 'bigint') {
		return a < b ? -1 : a > b ? 1 : 0;
	}
	if (typeof a === 'boolean' && typeof b === 'boolean') {
		return a === b ? 0 : a ? 1 : -1;
	}
	if (typeof a === 'string' && typeof b === 'string') {
		return a < b ? -1 : a > b ? 1 : 0;
	}
	// Numeric on one side, string on the other -- try parsing the string.
	if (typeof a === 'number' && typeof b === 'string') {
		const bn = Number(b);
		if (Number.isFinite(bn)) return a < bn ? -1 : a > bn ? 1 : 0;
	}
	if (typeof a === 'string' && typeof b === 'number') {
		const an = Number(a);
		if (Number.isFinite(an)) return an < b ? -1 : an > b ? 1 : 0;
	}
	return undefined;
}

function classifyVerdict(rules: readonly RuleResult[]): Verdict {
	const rated = rules.filter(r => r.satisfactionRate !== null);
	if (rated.length === 0) return 'inconclusive';
	const minRate = rated.reduce((min, r) => Math.min(min, r.satisfactionRate!), 1);
	if (minRate >= 0.95) return 'consistent';
	if (minRate >= 0.7)  return 'mostly-consistent';
	if (minRate >= 0.5)  return 'mixed';
	return 'broken';
}

function describeVerdict(v: Verdict, rules: readonly RuleResult[]): string {
	if (v === 'inconclusive') return 'no rules had any applicable rows; sample may be too small or mostly-null';
	const worst = [...rules]
		.filter(r => r.satisfactionRate !== null)
		.sort((a, b) => (a.satisfactionRate! - b.satisfactionRate!))[0]!;
	const worstPct = (worst.satisfactionRate! * 100).toFixed(0);
	if (v === 'consistent') return `all ${rules.length} rules satisfied >= 95%; lowest: '${worst.name}' at ${worstPct}%`;
	if (v === 'mostly-consistent') return `lowest-satisfied rule: '${worst.name}' at ${worstPct}%; some violations but no rule is broken`;
	if (v === 'mixed') return `lowest-satisfied rule: '${worst.name}' at ${worstPct}%; mixed adherence -- worth investigating`;
	return `rule '${worst.name}' satisfied only ${worstPct}% of applicable rows; data appears to violate the cross-column constraint frequently`;
}

function clampSample(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return SAMPLE_DEFAULT;
	return Math.min(Math.max(1, Math.floor(n)), 50);
}

function empty(target: string, rules: readonly ConsistencyRule[]): ConsistencyOutput {
	return {
		target,
		sampleSize: 0,
		rules: rules.map(r => ({
			name: r.name,
			leftColumn: r.leftColumn,
			op: r.op,
			rightColumn: r.rightColumn,
			satisfied: 0, violated: 0, inapplicable: 0,
			satisfactionRate: null,
			examples: [],
		})),
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

export function registerDataQualityConsistencyRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
