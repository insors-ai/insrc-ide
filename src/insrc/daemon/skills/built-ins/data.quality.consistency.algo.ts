/**
 * Shared math + IO contract for `data.quality.consistency.{rdbms,file}`
 * (Phase 5d.5 of plans/analyzers/data-analyzer-skills.md).
 *
 * Cross-column rule evaluation. Caller supplies a list of rules
 * `{ name, leftColumn, op, rightColumn }`; we evaluate each rule
 * per row of a 50-row sample and return satisfied / violated /
 * inapplicable counts plus an overall verdict.
 *
 * Operators:
 *   - Pairwise comparison: `<`, `<=`, `=`, `!=`, `>=`, `>`
 *     Either side null -> inapplicable. Numeric / date strings
 *     compare numerically when parseable, else lexicographically
 *     (ISO-format date strings compare correctly that way).
 *   - `and-not-null`: both columns must be non-null.
 *   - `xor-null`: exactly one must be null (mutually exclusive
 *     fields).
 */

const VIOLATION_EXAMPLES = 3;
export const CONSISTENCY_SAMPLE_DEFAULT = 50;

export type ConsistencyOp = '<' | '<=' | '=' | '!=' | '>=' | '>' | 'and-not-null' | 'xor-null';

export interface ConsistencyRule {
	readonly name: string;
	readonly leftColumn: string;
	readonly op: ConsistencyOp;
	readonly rightColumn: string;
}

export interface RuleViolation {
	readonly leftValue: unknown;
	readonly rightValue: unknown;
}

export interface RuleResult {
	readonly name: string;
	readonly leftColumn: string;
	readonly op: ConsistencyOp;
	readonly rightColumn: string;
	readonly satisfied: number;
	readonly violated: number;
	readonly inapplicable: number;
	readonly satisfactionRate: number | null;
	readonly examples: readonly RuleViolation[];
}

export type ConsistencyVerdict = 'consistent' | 'mostly-consistent' | 'mixed' | 'broken' | 'inconclusive';

export interface ConsistencyOutput {
	readonly target: string;
	readonly sampleSize: number;
	readonly rules: readonly RuleResult[];
	readonly verdict: ConsistencyVerdict;
	readonly interpretation: string;
}

export function clampConsistencySample(n: number | undefined): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return CONSISTENCY_SAMPLE_DEFAULT;
	return Math.min(Math.max(1, Math.floor(n)), 50);
}

export function buildConsistency(
	target: string,
	rules: readonly ConsistencyRule[],
	sample: { columns: readonly string[]; rows: readonly Readonly<Record<string, unknown>>[] },
): { output: ConsistencyOutput; missingColumns: readonly string[] } {
	const missing: string[] = [];
	for (const r of rules) {
		if (!sample.columns.includes(r.leftColumn)) missing.push(`${r.name}.left=${r.leftColumn}`);
		if (!sample.columns.includes(r.rightColumn)) missing.push(`${r.name}.right=${r.rightColumn}`);
	}
	if (missing.length > 0) {
		return { output: emptyConsistency(target, rules), missingColumns: missing };
	}

	const ruleResults: RuleResult[] = rules.map(rule => evaluateRule(rule, sample.rows));
	const verdict = classifyVerdict(ruleResults);
	const interpretation = describeVerdict(verdict, ruleResults);

	return {
		output: {
			target,
			sampleSize: sample.rows.length,
			rules: ruleResults,
			verdict,
			interpretation,
		},
		missingColumns: [],
	};
}

export function emptyConsistency(target: string, rules: readonly ConsistencyRule[]): ConsistencyOutput {
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

function evaluateRule(rule: ConsistencyRule, rows: readonly Readonly<Record<string, unknown>>[]): RuleResult {
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

function checkRule(op: ConsistencyOp, lv: unknown, rv: unknown): 'satisfied' | 'violated' | 'inapplicable' {
	const lNull = lv === null || lv === undefined;
	const rNull = rv === null || rv === undefined;
	if (op === 'and-not-null') {
		if (lNull && rNull) return 'inapplicable';
		if (!lNull && !rNull) return 'satisfied';
		return 'violated';
	}
	if (op === 'xor-null') {
		if (lNull !== rNull) return 'satisfied';
		if (lNull && rNull) return 'inapplicable';
		return 'violated';
	}
	if (lNull || rNull) return 'inapplicable';
	const cmp = compareValues(lv, rv);
	if (cmp === undefined) return 'inapplicable';
	switch (op) {
		case '<':  return cmp <  0 ? 'satisfied' : 'violated';
		case '<=': return cmp <= 0 ? 'satisfied' : 'violated';
		case '=':  return cmp === 0 ? 'satisfied' : 'violated';
		case '!=': return cmp !== 0 ? 'satisfied' : 'violated';
		case '>=': return cmp >= 0 ? 'satisfied' : 'violated';
		case '>':  return cmp >  0 ? 'satisfied' : 'violated';
	}
}

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

function classifyVerdict(rules: readonly RuleResult[]): ConsistencyVerdict {
	const rated = rules.filter(r => r.satisfactionRate !== null);
	if (rated.length === 0) return 'inconclusive';
	const minRate = rated.reduce((min, r) => Math.min(min, r.satisfactionRate!), 1);
	if (minRate >= 0.95) return 'consistent';
	if (minRate >= 0.7)  return 'mostly-consistent';
	if (minRate >= 0.5)  return 'mixed';
	return 'broken';
}

function describeVerdict(v: ConsistencyVerdict, rules: readonly RuleResult[]): string {
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

export const CONSISTENCY_RULE_SCHEMA = {
	type: 'object',
	properties: {
		name:        { type: 'string' },
		leftColumn:  { type: 'string' },
		op:          { type: 'string', enum: ['<', '<=', '=', '!=', '>=', '>', 'and-not-null', 'xor-null'] },
		rightColumn: { type: 'string' },
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

export const CONSISTENCY_OUTPUT_SCHEMA: Record<string, unknown> = {
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
};
