/**
 * data.sensitivity.policy-check.rdbms -- Phase 5e.3 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Composite skill: cross-references the connection's declared PII
 * column list against the per-column verdict from
 * `data.pii.column-classifier.rdbms`. Surfaces:
 *
 *   - Declared and detected -> conformant
 *   - Declared but NOT detected -> over-declared (false positive
 *     in the connection config; mask runs but data isn't actually
 *     PII-shaped)
 *   - Undeclared but detected -> missing declaration (data-leak
 *     risk; PII is reaching consumers without masking)
 *   - Undeclared and likely-PII -> review needed
 *   - Undeclared and not-PII -> clean
 *
 * The skill takes `declaredPiiColumns` as required input -- the
 * caller (typically the data-analyzer orchestrator) is expected to
 * pull the list from the daemon's connection registry. Exposing
 * connection config through a tool surface is a separate decision;
 * this skill stays family-agnostic about where the policy lives.
 *
 * Per-column dispatch is parallel via `Promise.all` over
 * `runSkill` -- registry depth accounting still applies.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';

interface PolicyCheckInput {
	readonly connectionId: string;
	readonly target: string;
	readonly columns: readonly string[];
	readonly declaredPiiColumns: readonly string[];
	readonly sampleSize?: number;
}

type Status =
	| 'declared-and-detected'
	| 'declared-not-detected'
	| 'undeclared-detected'
	| 'undeclared-likely'
	| 'clean';

interface ColumnStatus {
	readonly column: string;
	readonly declared: boolean;
	readonly verdict: 'pii' | 'likely-pii' | 'not-pii';
	readonly status: Status;
	readonly evidence: readonly string[];
}

interface PolicySummary {
	readonly conformant: number;
	readonly overDeclared: number;
	readonly missing: number;
	readonly reviewNeeded: number;
	readonly clean: number;
}

interface PolicyCheckOutput {
	readonly target: string;
	readonly declared: readonly string[];
	readonly columns: readonly ColumnStatus[];
	readonly summary: PolicySummary;
	readonly verdict: 'conformant' | 'mismatch' | 'gaps';
}

const COLUMN_STATUS_SCHEMA = {
	type: 'object',
	properties: {
		column:   { type: 'string' },
		declared: { type: 'boolean' },
		verdict:  { type: 'string', enum: ['pii', 'likely-pii', 'not-pii'] },
		status:   { type: 'string', enum: ['declared-and-detected', 'declared-not-detected',
		                                     'undeclared-detected', 'undeclared-likely', 'clean'] },
		evidence: { type: 'array', items: { type: 'string' } },
	},
	required: ['column', 'declared', 'verdict', 'status', 'evidence'],
	additionalProperties: false,
} as const;

const skill: Skill<PolicyCheckInput, PolicyCheckOutput> = {
	id: 'data.sensitivity.policy-check.rdbms',
	name: 'Sensitivity: policy check (RDBMS)',
	description:
		'Compare the per-column PII verdict (from pii.column-classifier.rdbms) against the connection\'s ' +
		'declared PII column list. Returns a per-column status (declared-and-detected / declared-not-detected ' +
		'/ undeclared-detected / undeclared-likely / clean) plus a summary count. Verdict: conformant / ' +
		'mismatch / gaps. The "missing" bucket is the security-relevant signal -- PII shapes that the config ' +
		'doesn\'t mask.',
	family: 'sensitivity',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId:       { type: 'string' },
			target:             { type: 'string' },
			columns:            { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 },
			declaredPiiColumns: { type: 'array', items: { type: 'string' } },
			sampleSize:         { type: 'integer', minimum: 1, maximum: 50 },
		},
		required: ['connectionId', 'target', 'columns', 'declaredPiiColumns'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			target:   { type: 'string' },
			declared: { type: 'array', items: { type: 'string' } },
			columns:  { type: 'array', items: COLUMN_STATUS_SCHEMA },
			summary: {
				type: 'object',
				properties: {
					conformant:   { type: 'number' },
					overDeclared: { type: 'number' },
					missing:      { type: 'number' },
					reviewNeeded: { type: 'number' },
					clean:        { type: 'number' },
				},
				required: ['conformant', 'overDeclared', 'missing', 'reviewNeeded', 'clean'],
				additionalProperties: false,
			},
			verdict: { type: 'string', enum: ['conformant', 'mismatch', 'gaps'] },
		},
		required: ['target', 'declared', 'columns', 'summary', 'verdict'],
		additionalProperties: false,
	},
	toolDeps: [],
	skillDeps: ['data.pii.column-classifier.rdbms'],
	providerAffinity: 'local',
	preconditions: [
		// Sub-skill's connection-family precondition transitively gates
		// this composite. We don't repeat it here.
	],

	async execute(input, deps): Promise<SkillResult<PolicyCheckOutput>> {
		const declaredSet = new Set(input.declaredPiiColumns);

		// Parallel dispatch -- each column is independent, the
		// classifier sub-skill handles its own caching / dedup.
		const subResults = await Promise.all(input.columns.map(col =>
			deps.runSkill<unknown, ClassifierOutput>(
				'data.pii.column-classifier.rdbms',
				{
					connectionId: input.connectionId,
					target:       input.target,
					column:       col,
					...(input.sampleSize !== undefined ? { sampleSize: input.sampleSize } : {}),
				},
			),
		));

		const columns: ColumnStatus[] = [];
		const summary: PolicySummary = {
			conformant: 0, overDeclared: 0, missing: 0, reviewNeeded: 0, clean: 0,
		};
		let mutableSummary = { ...summary };

		for (let i = 0; i < input.columns.length; i++) {
			const col = input.columns[i]!;
			const sub = subResults[i]!;
			const isDeclared = declaredSet.has(col);

			let verdict: 'pii' | 'likely-pii' | 'not-pii' = 'not-pii';
			let evidence: readonly string[] = [];
			if (isClassifierOutput(sub.value)) {
				verdict = sub.value.verdict;
				evidence = sub.value.evidence;
			}

			let status: Status;
			if (isDeclared && (verdict === 'pii' || verdict === 'likely-pii')) {
				status = 'declared-and-detected';
				mutableSummary.conformant++;
			} else if (isDeclared && verdict === 'not-pii') {
				status = 'declared-not-detected';
				mutableSummary.overDeclared++;
			} else if (!isDeclared && verdict === 'pii') {
				status = 'undeclared-detected';
				mutableSummary.missing++;
			} else if (!isDeclared && verdict === 'likely-pii') {
				status = 'undeclared-likely';
				mutableSummary.reviewNeeded++;
			} else {
				status = 'clean';
				mutableSummary.clean++;
			}

			columns.push({ column: col, declared: isDeclared, verdict, status, evidence });
		}

		// Verdict: missing > 0 dominates (data-leak indicator).
		// Otherwise: any over-declaration or review-needed -> mismatch;
		// fully aligned -> conformant.
		let topVerdict: 'conformant' | 'mismatch' | 'gaps';
		if (mutableSummary.missing > 0) topVerdict = 'gaps';
		else if (mutableSummary.overDeclared > 0 || mutableSummary.reviewNeeded > 0) topVerdict = 'mismatch';
		else topVerdict = 'conformant';

		return {
			value: {
				target: input.target,
				declared: input.declaredPiiColumns,
				columns,
				summary: mutableSummary,
				verdict: topVerdict,
			},
			// `high` when the verdict landed cleanly (all sub-skills
			// returned classifier shapes); `medium` if any sub-skill
			// returned a degraded shape (we couldn't classify some
			// columns confidently).
			confidence: subResults.every(s => isClassifierOutput(s.value)) ? 'high' : 'medium',
			toolCalls: [],
		};
	},
};

interface ClassifierOutput {
	readonly target: string;
	readonly column: string;
	readonly verdict: 'pii' | 'likely-pii' | 'not-pii';
	readonly nameMatches: readonly string[];
	readonly valueMatches: readonly string[];
	readonly evidence: readonly string[];
}

function isClassifierOutput(v: unknown): v is ClassifierOutput {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['target'] === 'string'
		&& typeof o['column'] === 'string'
		&& (o['verdict'] === 'pii' || o['verdict'] === 'likely-pii' || o['verdict'] === 'not-pii')
		&& Array.isArray(o['evidence']);
}

export function registerDataSensitivityPolicyCheckRdbmsSkill(): void {
	registerSkill(skill as unknown as Skill);
}
