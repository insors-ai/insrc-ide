/**
 * data.pii.column-classifier.rdbms -- Phase 5e.2 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Composite skill: combines `data.pii.detect-patterns.rdbms` (regex
 * over sampled values) with a column-name heuristic to produce a
 * per-column PII verdict. The dual signal is exactly the
 * 2026-04-30 lessons-learned fix -- a column literally named
 * `email` is highly suggestive even when the sample happens to be
 * empty; conversely, a column with PII-shaped values but a
 * non-PII name is the data-leak case worth flagging.
 *
 * Verdict ladder:
 *
 *   - **pii**         -- name AND values both match the same
 *                        canonical pattern (e.g. column `email`
 *                        contains email-shaped strings).
 *   - **likely-pii**  -- one of:
 *                        (a) name matches but values don't (column
 *                            named `ssn` but the sample is empty
 *                            or all-null),
 *                        (b) values match but the column name is
 *                            generic (PII content in a generic
 *                            column = leak indicator).
 *   - **not-pii**     -- neither signal triggers.
 *
 * The skill DOES NOT decide policy (block / mask / encrypt). That
 * lives in `sensitivity.policy-check` (Phase 5e.3) which compares
 * the verdict against the connection's pii config.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';

interface PiiColumnClassifierInput {
	readonly connectionId: string;
	readonly target: string;
	readonly column: string;
	readonly sampleSize?: number;
}

type Verdict = 'pii' | 'likely-pii' | 'not-pii';

interface PiiColumnClassifierOutput {
	readonly target: string;
	readonly column: string;
	readonly verdict: Verdict;
	readonly nameMatches: readonly string[];     // canonical pattern names matched by the column name
	readonly valueMatches: readonly string[];    // canonical pattern names matched by sampled values
	readonly evidence: readonly string[];        // human-readable reasons feeding the verdict
}

/**
 * Map canonical pattern names to column-name regex patterns. The
 * values in the inner regex are word-boundary-anchored substrings
 * to keep `email_verified_at` matching the `email` family without
 * also eating false positives in unrelated columns.
 *
 * Some entries (`name`, `address`, `password`, `dob`) have no
 * corresponding value-pattern in `pii.detect-patterns.rdbms` --
 * these match the column name only. Their verdict on a name-only
 * match is `likely-pii`.
 */
const COLUMN_NAME_RULES: ReadonlyArray<{ readonly canonical: string; readonly re: RegExp }> = [
	{ canonical: 'email',           re: /\b(?:e_?mail|mail|contact_email)\b/i },
	{ canonical: 'phone-us',        re: /\b(?:phone|mobile|tel|cell|fax)\b/i },
	{ canonical: 'ssn-us',          re: /\b(?:ssn|social_?sec|tax_?id)\b/i },
	{ canonical: 'credit-card',     re: /\b(?:card_?num|cc_?num|pan|credit_?card)\b/i },
	{ canonical: 'jwt',             re: /\b(?:jwt|access_?token|id_?token)\b/i },
	{ canonical: 'ipv4',            re: /\b(?:ip_?addr|client_?ip|ipv4)\b/i },
	{ canonical: 'iban',            re: /\b(?:iban|bank_?account)\b/i },
	{ canonical: 'aws-access-key',  re: /\b(?:aws_?access_?key|access_?key_?id)\b/i },
	{ canonical: 'github-token',    re: /\b(?:github_?token|gh_?token)\b/i },
	{ canonical: 'uuid',            re: /\b(?:uuid|guid)\b/i },
	// Name-only PII (no value pattern in 5e.1 set):
	{ canonical: 'password',        re: /\b(?:password|passwd|pwd|secret|api_?key|hash)\b/i },
	{ canonical: 'person-name',     re: /\b(?:first_?name|last_?name|full_?name|fname|lname|surname)\b/i },
	{ canonical: 'address',         re: /\b(?:address|addr|street|city|zip|postal_?code|postcode)\b/i },
	{ canonical: 'dob',             re: /\b(?:dob|date_?of_?birth|birth_?date|birthdate)\b/i },
];

const skill: Skill<PiiColumnClassifierInput, PiiColumnClassifierOutput> = {
	id: 'data.pii.column-classifier.rdbms',
	name: 'PII: column classifier (RDBMS)',
	description:
		'Per-column PII verdict combining value-regex detection (data.pii.detect-patterns.rdbms) with a ' +
		'column-name heuristic. Surfaces both data-leak (value match, generic name) and missing-data ' +
		'(named-PII column, empty sample) cases. Returns one of: pii / likely-pii / not-pii.',
	family: 'sensitivity',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId: { type: 'string' },
			target:       { type: 'string' },
			column:       { type: 'string' },
			sampleSize:   { type: 'integer', minimum: 1, maximum: 50 },
		},
		required: ['connectionId', 'target', 'column'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			target:       { type: 'string' },
			column:       { type: 'string' },
			verdict:      { type: 'string', enum: ['pii', 'likely-pii', 'not-pii'] },
			nameMatches:  { type: 'array', items: { type: 'string' } },
			valueMatches: { type: 'array', items: { type: 'string' } },
			evidence:     { type: 'array', items: { type: 'string' } },
		},
		required: ['target', 'column', 'verdict', 'nameMatches', 'valueMatches', 'evidence'],
		additionalProperties: false,
	},
	toolDeps: [],
	skillDeps: ['data.pii.detect-patterns.rdbms'],
	providerAffinity: 'local',
	preconditions: [
		// Sub-skill's connection-family precondition transitively gates
		// this composite. We don't need to repeat it here.
	],

	async execute(input, deps): Promise<SkillResult<PiiColumnClassifierOutput>> {
		// Step 1: column-name heuristic (no tools, fast).
		const nameMatches: string[] = [];
		for (const rule of COLUMN_NAME_RULES) {
			if (rule.re.test(input.column)) nameMatches.push(rule.canonical);
		}

		// Step 2: dispatch to the value-regex sub-skill.
		const sub = await deps.runSkill<unknown, PatternsResult>(
			'data.pii.detect-patterns.rdbms',
			{
				connectionId: input.connectionId,
				target:       input.target,
				column:       input.column,
				...(input.sampleSize !== undefined ? { sampleSize: input.sampleSize } : {}),
			},
		);
		const valueMatches: string[] = isPatternsResult(sub.value)
			? sub.value.detections.map(d => d.pattern)
			: [];

		// Step 3: derive verdict from the two signals.
		const valueSet = new Set(valueMatches);
		const intersection = nameMatches.filter(n => valueSet.has(n));
		const evidence: string[] = [];

		let verdict: Verdict;
		if (intersection.length > 0) {
			verdict = 'pii';
			for (const m of intersection) {
				const detection = isPatternsResult(sub.value)
					? sub.value.detections.find(d => d.pattern === m)
					: undefined;
				const rateText = detection !== undefined
					? ` (${(detection.hitRate * 100).toFixed(0)}% of sample)`
					: '';
				evidence.push(`column name + value pattern both match '${m}'${rateText}`);
			}
		} else if (nameMatches.length > 0 && valueMatches.length === 0) {
			verdict = 'likely-pii';
			evidence.push(
				`column name suggests PII (${nameMatches.join(', ')}) but no value pattern matched ` +
				`(sample size ${isPatternsResult(sub.value) ? sub.value.sampleSize : 0})`,
			);
		} else if (nameMatches.length === 0 && valueMatches.length > 0) {
			verdict = 'likely-pii';
			evidence.push(
				`column name is generic but values match PII patterns (${valueMatches.join(', ')}) ` +
				`-- possible data-leak indicator`,
			);
		} else if (nameMatches.length > 0 && valueMatches.length > 0) {
			// Disjoint matches (e.g. column 'phone' contains JWTs)
			verdict = 'likely-pii';
			evidence.push(
				`column name suggests ${nameMatches.join(', ')} but values match different patterns ` +
				`(${valueMatches.join(', ')}) -- mismatch worth investigating`,
			);
		} else {
			verdict = 'not-pii';
			evidence.push('no PII signal from column name or sampled values');
		}

		// `high` only when both signals agree on PII; `medium` for any
		// degraded path. Sub-skill confidence is independently clamped
		// by the registry's calibration.
		const confidence = verdict === 'pii' ? 'high' : 'medium';

		return {
			value: {
				target:       input.target,
				column:       input.column,
				verdict,
				nameMatches,
				valueMatches,
				evidence,
			},
			confidence,
			toolCalls: [],
		};
	},
};

interface PatternsResult {
	readonly target: string;
	readonly column: string;
	readonly sampleSize: number;
	readonly detections: readonly { pattern: string; hitCount: number; hitRate: number; examples: readonly string[] }[];
	readonly topPattern: string | null;
}

function isPatternsResult(v: unknown): v is PatternsResult {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& typeof o['column'] === 'string'
		&& typeof o['sampleSize'] === 'number'
		&& Array.isArray(o['detections']);
}

export function registerDataPiiColumnClassifierRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
