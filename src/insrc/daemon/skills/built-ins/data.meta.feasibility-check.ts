/**
 * data.meta.feasibility-check -- Phase 7.3 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Pure helper: walks `assertFeasible(skill, ctx)` over a candidate
 * list of skill ids and returns a structured rejection report. No
 * LLM, no tools.
 *
 * The new planner (Phase 8.1) will call this AFTER
 * `meta.classify-question` to drop infeasible skill ids before any
 * execution starts. Today it can also be invoked directly by callers
 * that want to know whether a skill is callable in the current
 * session before paying for the round-trip.
 */

import { registerSkill, getSkill } from '../registry.js';
import { assertFeasible } from '../feasibility.js';
import type {
	PreconditionFailure,
	Skill,
	SkillContext,
	SkillResult,
} from '../types.js';

interface FeasibilityCheckInput {
	readonly skillIds: readonly string[];
	/** Optional sample-size hint forwarded into the per-skill SkillContext. */
	readonly availableSampleSize?: number | null;
}

interface FeasibleEntry {
	readonly skillId: string;
}

interface InfeasibleEntry {
	readonly skillId: string;
	readonly reasons: readonly { readonly preconditionKind: string; readonly detail: string }[];
}

interface MissingEntry {
	readonly skillId: string;
}

interface FeasibilityCheckOutput {
	readonly feasible:    readonly FeasibleEntry[];
	readonly infeasible:  readonly InfeasibleEntry[];
	readonly missing:     readonly MissingEntry[];
	readonly totalChecked: number;
}

const skill: Skill<FeasibilityCheckInput, FeasibilityCheckOutput> = {
	id: 'data.meta.feasibility-check',
	name: 'Meta: feasibility check',
	description:
		'Walk every skill id through `assertFeasible` and bucket the results into feasible / infeasible / ' +
		'missing-from-registry. Used by the planner to drop infeasible ids before execution; also useful as a ' +
		'pre-flight check from external callers. Pure helper -- no LLM, no tools, no side effects.',
	family: 'meta',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			skillIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
			availableSampleSize: { type: ['number', 'null'] },
		},
		required: ['skillIds'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			feasible: {
				type: 'array',
				items: {
					type: 'object',
					properties: { skillId: { type: 'string' } },
					required: ['skillId'],
					additionalProperties: false,
				},
			},
			infeasible: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						skillId: { type: 'string' },
						reasons: {
							type: 'array',
							items: {
								type: 'object',
								properties: {
									preconditionKind: { type: 'string' },
									detail:           { type: 'string' },
								},
								required: ['preconditionKind', 'detail'],
								additionalProperties: false,
							},
						},
					},
					required: ['skillId', 'reasons'],
					additionalProperties: false,
				},
			},
			missing: {
				type: 'array',
				items: {
					type: 'object',
					properties: { skillId: { type: 'string' } },
					required: ['skillId'],
					additionalProperties: false,
				},
			},
			totalChecked: { type: 'number' },
		},
		required: ['feasible', 'infeasible', 'missing', 'totalChecked'],
		additionalProperties: false,
	},
	toolDeps: [],
	providerAffinity: 'auto',
	// No preconditions on the meta skill itself -- it's the bedrock the
	// planner uses to validate everything else.

	async execute(input, deps): Promise<SkillResult<FeasibilityCheckOutput>> {
		const ctx: SkillContext = {
			session: deps.session,
			...(input.availableSampleSize !== undefined ? { availableSampleSize: input.availableSampleSize } : {}),
		};

		const feasible:   FeasibleEntry[]   = [];
		const infeasible: InfeasibleEntry[] = [];
		const missing:    MissingEntry[]    = [];

		for (const id of input.skillIds) {
			const target = getSkill(id);
			if (target === undefined) {
				missing.push({ skillId: id });
				continue;
			}
			const verdict = assertFeasible(target, ctx);
			if (verdict.ok) {
				feasible.push({ skillId: id });
			} else {
				infeasible.push({
					skillId: id,
					reasons: verdict.reasons.map(r => flattenFailure(r)),
				});
			}
		}

		return {
			value: {
				feasible, infeasible, missing,
				totalChecked: input.skillIds.length,
			},
			confidence: 'high',
			toolCalls: [],
		};
	},
};

function flattenFailure(r: PreconditionFailure): { preconditionKind: string; detail: string } {
	return { preconditionKind: r.precondition.kind, detail: r.detail };
}

export function registerDataMetaFeasibilityCheckSkill(): void {
	registerSkill(skill as unknown as Skill);
}
