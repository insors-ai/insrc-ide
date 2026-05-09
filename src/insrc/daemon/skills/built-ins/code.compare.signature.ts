/**
 * code.compare.signature -- entity-to-entity signature diff
 * (code-analyzer-skills.md Phase 4.1).
 *
 * Composite skill: pulls two entity summaries via
 * `code.entity.summary` and surfaces the per-field differences as a
 * typed change list. The fields compared are the ones that affect
 * source-level compatibility:
 *
 *   - name        (renames)
 *   - kind        (method <-> function reclassification)
 *   - signature   (parameter / return-type changes)
 *   - language    (rare; flags accidental cross-language compares)
 *   - isExported  (visibility flips)
 *   - isAbstract  / isAsync   (modifier flips)
 *
 * Output is a flat `changes: [{ field, from, to }]` array so
 * downstream renderers (Phase 6.2 findings-table) can pretty-print
 * without re-walking the structure. `changed` is true iff any field
 * differs.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';

interface CompareSignatureInput {
	readonly aEntityId: string;
	readonly bEntityId: string;
}

interface SignatureChange {
	readonly field: 'name' | 'kind' | 'signature' | 'language' | 'isExported' | 'isAbstract' | 'isAsync';
	readonly from?: string | boolean;
	readonly to?:   string | boolean;
}

type CompareSignatureOutput =
	| {
		readonly found:      true;
		readonly aEntityId:  string;
		readonly bEntityId:  string;
		readonly changed:    boolean;
		readonly changes:    readonly SignatureChange[];
	}
	| {
		readonly found:  false;
		readonly reason: 'a-not-found' | 'b-not-found';
	};

const skill: Skill<CompareSignatureInput, CompareSignatureOutput> = {
	id: 'code.compare.signature',
	name: 'Code: signature diff between two entities',
	description:
		'Pull two entity summaries and surface the differences across name / kind / signature / ' +
		'language / visibility / async / abstract flags. Returns `{ found: false, reason }` when ' +
		'either entity id misses.',
	family: 'comparison-diff',
	owner: 'code-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			aEntityId: { type: 'string', minLength: 32, maxLength: 32 },
			bEntityId: { type: 'string', minLength: 32, maxLength: 32 },
		},
		required: ['aEntityId', 'bEntityId'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: { found: { type: 'boolean' } },
		required: ['found'],
		oneOf: [
			{
				type: 'object',
				properties: {
					found:     { type: 'boolean', enum: [true] },
					aEntityId: { type: 'string' },
					bEntityId: { type: 'string' },
					changed:   { type: 'boolean' },
					changes:   { type: 'array' },
				},
				required: ['found', 'aEntityId', 'bEntityId', 'changed', 'changes'],
			},
			{
				type: 'object',
				properties: {
					found:  { type: 'boolean', enum: [false] },
					reason: { type: 'string', enum: ['a-not-found', 'b-not-found'] },
				},
				required: ['found', 'reason'],
			},
		],
	},
	toolDeps: [],
	skillDeps: ['code.entity.summary'],
	providerAffinity: 'auto',

	async execute(input: CompareSignatureInput, deps: SkillDeps): Promise<SkillResult<CompareSignatureOutput>> {
		const a = await deps.runSkill<{ entityId: string }, EntitySummary>('code.entity.summary', { entityId: input.aEntityId });
		if (!a.value.found) {
			return {
				value: { found: false, reason: 'a-not-found' },
				confidence: 'low',
				notes: [`Entity '${input.aEntityId}' not in the graph.`],
				toolCalls: [],
			};
		}
		const b = await deps.runSkill<{ entityId: string }, EntitySummary>('code.entity.summary', { entityId: input.bEntityId });
		if (!b.value.found) {
			return {
				value: { found: false, reason: 'b-not-found' },
				confidence: 'low',
				notes: [`Entity '${input.bEntityId}' not in the graph.`],
				toolCalls: [],
			};
		}

		const A = a.value;
		const B = b.value;
		const changes: SignatureChange[] = [];
		stringDiff(changes, 'name',     A.name,     B.name);
		stringDiff(changes, 'kind',     A.kind,     B.kind);
		stringDiff(changes, 'signature', A.signature, B.signature);
		stringDiff(changes, 'language', A.language, B.language);
		boolDiff(changes,  'isExported', A.isExported, B.isExported);
		boolDiff(changes,  'isAbstract', A.isAbstract, B.isAbstract);
		boolDiff(changes,  'isAsync',    A.isAsync,    B.isAsync);

		return {
			value: {
				found:      true,
				aEntityId:  input.aEntityId,
				bEntityId:  input.bEntityId,
				changed:    changes.length > 0,
				changes,
			},
			confidence: 'high',
			notes: [],
			toolCalls: [],
		};
	},
};

interface EntitySummary {
	readonly found:      boolean;
	readonly name:       string;
	readonly kind:       string;
	readonly language:   string;
	readonly signature?: string;
	readonly isExported?: boolean;
	readonly isAbstract?: boolean;
	readonly isAsync?:    boolean;
}

function stringDiff(out: SignatureChange[], field: SignatureChange['field'], a: string | undefined, b: string | undefined): void {
	const av = a ?? '';
	const bv = b ?? '';
	if (av !== bv) {
		const change: SignatureChange = { field };
		if (av !== '') (change as { from?: string }).from = av;
		if (bv !== '') (change as { to?: string }).to   = bv;
		out.push(change);
	}
}

function boolDiff(out: SignatureChange[], field: SignatureChange['field'], a: boolean | undefined, b: boolean | undefined): void {
	const av = a === true;
	const bv = b === true;
	if (av !== bv) {
		out.push({ field, from: av, to: bv });
	}
}

export function registerCodeCompareSignatureSkill(): void {
	registerSkill(skill as unknown as Skill);
}
