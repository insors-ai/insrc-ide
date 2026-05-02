/**
 * data.synth.field-table -- Phase 6.2 of
 * plans/analyzers/data-analyzer-skills.md.
 *
 * Pure-template skill: renders a typed SchemaDescription (output of
 * `data.source.rdbms.describe-table` / `data.source.file.describe`)
 * as a markdown fragment. No LLM, no tool calls -- the body is a
 * deterministic template.
 *
 * Adds a header + summary line + per-row [PK] / [FK] / [nullable]
 * tags that the bare tool markdown doesn't carry. Synthesise renderers
 * are deliberately richer than the underlying tool's `content`
 * markdown -- the tool's version is a debug-grade fallback.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillResult } from '../types.js';

interface ForeignKey {
	readonly table: string;
	readonly column: string;
}

interface Column {
	readonly name: string;
	readonly type: string;
	readonly nullable?: boolean;
	readonly primaryKey?: boolean;
	readonly foreignKey?: ForeignKey;
}

interface FieldTableInput {
	readonly target: string;
	readonly columns: readonly Column[];
	readonly source?: 'introspect' | 'prisma' | 'header' | 'inferred';
}

interface FieldTableOutput {
	readonly markdown: string;
}

const skill: Skill<FieldTableInput, FieldTableOutput> = {
	id: 'data.synth.field-table',
	name: 'Synth: field table',
	description:
		'Render a SchemaDescription (target + columns + types + nullability + PK/FK) as a markdown table ' +
		'with header + summary line. Pure template, no LLM. Pair with describe-table / file.describe ' +
		'outputs to produce report-ready markdown.',
	family: 'synthesis',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			target:  { type: 'string' },
			columns: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						name:       { type: 'string' },
						type:       { type: 'string' },
						nullable:   { type: 'boolean' },
						primaryKey: { type: 'boolean' },
						foreignKey: {
							type: 'object',
							properties: {
								table:  { type: 'string' },
								column: { type: 'string' },
							},
							required: ['table', 'column'],
							additionalProperties: false,
						},
					},
					required: ['name', 'type'],
					additionalProperties: false,
				},
			},
			source: { type: 'string', enum: ['introspect', 'prisma', 'header', 'inferred'] },
		},
		required: ['target', 'columns'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			markdown: { type: 'string' },
		},
		required: ['markdown'],
		additionalProperties: false,
	},
	toolDeps: [],
	providerAffinity: 'auto',

	async execute(input): Promise<SkillResult<FieldTableOutput>> {
		const cols = input.columns;
		const nullCount = cols.filter(c => c.nullable === true).length;
		const pkCount   = cols.filter(c => c.primaryKey === true).length;
		const fkCount   = cols.filter(c => c.foreignKey !== undefined).length;
		const sourceTag = input.source !== undefined ? ` (${input.source})` : '';

		const lines: string[] = [
			`**${input.target}**${sourceTag}`,
			'',
			`${cols.length} column${cols.length === 1 ? '' : 's'}` +
				` -- ${nullCount} nullable, ${pkCount} primary key${pkCount === 1 ? '' : 's'}, ${fkCount} foreign key${fkCount === 1 ? '' : 's'}`,
			'',
			'| column | type | tags |',
			'|---|---|---|',
		];
		for (const c of cols) {
			const tags: string[] = [];
			if (c.primaryKey === true)        tags.push('PK');
			if (c.foreignKey !== undefined)   tags.push(`FK -> ${c.foreignKey.table}.${c.foreignKey.column}`);
			if (c.nullable === true)          tags.push('nullable');
			lines.push(`| \`${c.name}\` | ${c.type} | ${tags.length > 0 ? tags.join(', ') : '-'} |`);
		}

		return {
			value: { markdown: lines.join('\n') },
			confidence: cols.length > 0 ? 'high' : 'medium',
			toolCalls: [],
		};
	},
};

export function registerDataSynthFieldTableSkill(): void {
	registerSkill(skill as unknown as Skill);
}
