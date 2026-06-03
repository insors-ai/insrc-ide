/**
 * shared.compare.fields-vs-shape -- align a class field list with a
 * data file's column shape and emit a structured mapping (P5 of
 * plans/planner-skill-tree.md).
 *
 * The canonical composition skill: the planner wires
 * `code.class.extract-fields` and a data-side describe / sample-shape
 * into this skill's inputs, and the OUTPUT is the alignment table the
 * report drafter cites. The drafter no longer has to invent
 * correspondences in prose -- the matching is computed in code from
 * structured evidence.
 *
 * Liberal input shape: accepts either `{name, type, nullable}` (from
 * `data.source.file.describe.columns[*]`) or `{path, types, nullable}`
 * (from `data.source.file.sample-shape.fields[*]`) for the data side.
 * Class fields use the `code.class.extract-fields.fields[*]` shape.
 *
 * No LLM, no tools, no preconditions. Pure synthesis -- the same
 * inputs always produce the same alignment.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

interface ClassFieldIn {
	readonly name:     string;
	readonly type?:    string;
	readonly nullable?: boolean;
}

interface DataColumnIn {
	// One of `name` (describe) or `path` (sample-shape) must be present.
	readonly name?: string;
	readonly path?: string;
	// One of `type` (describe -- single) or `types` (sample-shape -- multi) must be present.
	readonly type?:  string;
	readonly types?: readonly string[];
	readonly nullable?: boolean;
}

interface FieldsVsShapeInput {
	readonly classFields: readonly ClassFieldIn[];
	readonly dataShape:   readonly DataColumnIn[];
	readonly className?:  string;
	readonly dataLabel?:  string;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

type AlignmentMatch =
	| 'exact'           // names match (after normalization), types compatible
	| 'name-only'       // names match but types diverge (caller must inspect)
	| 'type-only'       // a rare structural-match-but-name-differs (unused in v1)
	| 'class-only'      // class declares this field; no matching data column
	| 'data-only'       // data has this column; no matching class field
	| 'rename';         // names match after a case-fold (snake_case <-> camelCase) -- review-worthy

interface AlignmentEntry {
	readonly classField?: string;
	readonly classType?:  string;
	readonly dataKey?:    string;
	readonly dataType?:   string;
	readonly match:       AlignmentMatch;
	readonly note?:       string;
}

interface AlignmentSummary {
	readonly classFieldCount: number;
	readonly dataColumnCount: number;
	readonly exact:           number;
	readonly nameOnly:        number;
	readonly renames:         number;
	readonly classOnly:       number;
	readonly dataOnly:        number;
}

interface FieldsVsShapeOutput {
	readonly className?:  string;
	readonly dataLabel?:  string;
	readonly alignment:   readonly AlignmentEntry[];
	readonly summary:     AlignmentSummary;
	/** Human-readable headline; surfaced in auto-rendered sections. */
	readonly headline:    string;
}

// ---------------------------------------------------------------------------
// Alignment logic (pure, deterministic, fully tested)
// ---------------------------------------------------------------------------

/**
 * Normalize a name for case-insensitive snake_case <-> camelCase
 * comparison. `vendor_details` and `vendorDetails` both reduce to
 * `vendordetails`. Hyphens and dots become nothing as well (legitimate
 * inputs use `_`/case-camel only, so the rest are defensive).
 */
function normalize(name: string): string {
	return name.toLowerCase().replace(/[_\-.]/g, '');
}

/**
 * Compare a class type string with a data column type string and decide
 * whether they're loosely compatible. The class type comes from a
 * pydantic / Java / TS annotation; the data type comes from a schema
 * introspection. We want a quick pass/fail that's correct for the 90%
 * case (str <-> VARCHAR, int <-> BIGINT, float <-> DOUBLE, datetime
 * <-> TIMESTAMP, complex types fall through to a 'check' verdict).
 */
function typesCompatible(classType: string | undefined, dataType: string | undefined): 'match' | 'mismatch' | 'check' {
	if (classType === undefined || dataType === undefined) return 'check';
	const c = stripOptional(classType).toLowerCase();
	const d = dataType.toLowerCase();

	// Strings
	if (/^(str|string)$/.test(c) && /(varchar|string|text|json)/.test(d))         return 'match';
	// Integers
	if (/^(int|integer|long)$/.test(c) && /(bigint|integer|int|long|smallint)/.test(d)) return 'match';
	// Floats / decimals
	if (/^(float|decimal|double)$/.test(c) && /(double|float|decimal|numeric|real)/.test(d)) return 'match';
	// Booleans
	if (/^bool(ean)?$/.test(c) && /bool/.test(d))                                 return 'match';
	// Datetime / timestamps -- data side typically marks these as 'TIMESTAMP' or 'object'
	if (/^(datetime|date|time)$/.test(c) && /(timestamp|datetime|date|object|struct)/.test(d)) return 'match';
	// Complex / collection types -- can't infer compatibility without deeper inspection.
	if (/list|sequence|tuple|set/.test(c)) return /array|list/.test(d) ? 'match' : 'check';
	if (/dict|map|record/.test(c))         return /struct|object|map/.test(d) ? 'match' : 'check';
	// Nested pydantic model -- always 'check'; the caller must inspect the struct.
	if (/^[A-Z]/.test(classType) && !/^(str|int|float|bool|datetime|date|time|list|dict)/.test(c)) return 'check';

	// Fallthrough -- types don't match any pattern; flag for human review.
	return 'mismatch';
}

function stripOptional(t: string): string {
	// Optional[X], Union[X, None], X | None -> X
	let s = t.trim();
	const opt = /^Optional\[(.+)\]$/i.exec(s);
	if (opt !== null && opt[1] !== undefined) s = opt[1];
	const un  = /^Union\[(.+),\s*None\]$/i.exec(s);
	if (un  !== null && un[1]  !== undefined) s = un[1];
	const pipe = /^(.+?)\s*\|\s*None$/i.exec(s);
	if (pipe !== null && pipe[1] !== undefined) s = pipe[1];
	return s.trim();
}

function dataKeyOf(c: DataColumnIn): string | undefined {
	if (c.name !== undefined && c.name.length > 0) return c.name;
	if (c.path !== undefined && c.path.length > 0) return c.path;
	return undefined;
}

function dataTypeOf(c: DataColumnIn): string | undefined {
	if (c.type !== undefined && c.type.length > 0) return c.type;
	if (c.types !== undefined && c.types.length > 0) {
		// Multi-type columns -- pick the first non-null type, or join.
		const filtered = c.types.filter(t => t.toLowerCase() !== 'null');
		if (filtered.length === 1) return filtered[0];
		if (filtered.length > 1)   return filtered.join('|');
	}
	return undefined;
}

/**
 * Compute the alignment. Pure function -- exported for direct testing
 * without the skill machinery.
 */
export function alignFieldsAndShape(input: FieldsVsShapeInput): FieldsVsShapeOutput {
	// Build keyed lookups. We index BOTH the raw key and the normalized
	// key so a single pass can detect exact and rename matches.
	type ClassEntry = { name: string; norm: string; type: string | undefined; matched: boolean };
	type DataEntry  = { key: string;  norm: string; type: string | undefined; matched: boolean };

	const classEntries: ClassEntry[] = input.classFields.map(f => ({
		name: f.name,
		norm: normalize(f.name),
		type: f.type,
		matched: false,
	}));
	const dataEntries:  DataEntry[]  = input.dataShape
		.map(c => {
			const key = dataKeyOf(c);
			if (key === undefined) return undefined;
			return { key, norm: normalize(key), type: dataTypeOf(c), matched: false };
		})
		.filter((e): e is DataEntry => e !== undefined);

	const alignment: AlignmentEntry[] = [];
	let exact = 0, nameOnly = 0, renames = 0;

	for (const cf of classEntries) {
		// First try an exact-case match by raw name.
		let de = dataEntries.find(d => !d.matched && d.key === cf.name);
		let isRename = false;

		// Fall back to case/underscore-normalized name match.
		if (de === undefined) {
			de = dataEntries.find(d => !d.matched && d.norm === cf.norm);
			if (de !== undefined && de.key !== cf.name) isRename = true;
		}

		if (de === undefined) {
			alignment.push({
				classField: cf.name,
				...(cf.type !== undefined ? { classType: cf.type } : {}),
				match: 'class-only',
				note:  'declared by the class; no matching column in the data shape',
			});
			continue;
		}

		cf.matched = true;
		de.matched = true;

		const verdict = typesCompatible(cf.type, de.type);
		const match: AlignmentMatch =
			isRename
				? 'rename'
				: verdict === 'match'
					? 'exact'
					: 'name-only';
		// Note priority: rename signal wins (the reader needs to see the
		// case/underscore mismatch even if the types are compatible);
		// then type-mismatch (loud problem); then type-check (advisory).
		const note =
			isRename
				? `name differs by case/underscore: class="${cf.name}" vs data="${de.key}"` +
				  (verdict === 'mismatch' ? `; type mismatch: class=${cf.type ?? '?'} vs data=${de.type ?? '?'}` : '') +
				  (verdict === 'check'    ? '; types require inspection'                                       : '')
				: verdict === 'mismatch'
					? `type mismatch: class=${cf.type ?? '?'} vs data=${de.type ?? '?'}`
					: verdict === 'check'
						? 'type pairing requires inspection (nested struct, generic, or unmappable)'
						: undefined;

		if (match === 'exact')    exact += 1;
		else if (match === 'rename') renames += 1;
		else                      nameOnly += 1;

		alignment.push({
			classField: cf.name,
			...(cf.type !== undefined ? { classType: cf.type } : {}),
			dataKey:   de.key,
			...(de.type !== undefined ? { dataType:  de.type  } : {}),
			match,
			...(note !== undefined ? { note } : {}),
		});
	}

	// Unmatched data columns -> data-only.
	let dataOnly = 0;
	for (const de of dataEntries) {
		if (de.matched) continue;
		dataOnly += 1;
		alignment.push({
			dataKey: de.key,
			...(de.type !== undefined ? { dataType: de.type } : {}),
			match: 'data-only',
			note:  'present in the data shape; no corresponding class field declared',
		});
	}

	// Unmatched class fields already pushed; no second pass needed.
	const summary: AlignmentSummary = {
		classFieldCount: classEntries.length,
		dataColumnCount: dataEntries.length,
		exact,
		nameOnly,
		renames,
		classOnly: classEntries.filter(c => !c.matched).length,
		dataOnly,
	};

	const total = classEntries.length + dataOnly;
	const matchedTotal = exact + nameOnly + renames;
	const pct = total === 0 ? 0 : Math.round((matchedTotal / total) * 100);
	const lhs = input.className ?? 'class';
	const rhs = input.dataLabel ?? 'data';
	const headline =
		`${lhs} ↔ ${rhs}: ${matchedTotal}/${total} fields mapped (${pct}%); ` +
		`${summary.classOnly} class-only, ${summary.dataOnly} data-only` +
		(summary.renames > 0 ? `, ${summary.renames} rename${summary.renames === 1 ? '' : 's'}` : '') +
		(summary.nameOnly > 0 ? `, ${summary.nameOnly} type-issue${summary.nameOnly === 1 ? '' : 's'}` : '') + '.';

	return {
		...(input.className !== undefined ? { className: input.className } : {}),
		...(input.dataLabel !== undefined ? { dataLabel: input.dataLabel } : {}),
		alignment,
		summary,
		headline,
	};
}

// ---------------------------------------------------------------------------
// Skill definition
// ---------------------------------------------------------------------------

const INPUT_SCHEMA = {
	type: 'object',
	properties: {
		classFields: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					name:     { type: 'string', minLength: 1 },
					type:     { type: 'string' },
					nullable: { type: 'boolean' },
				},
				required: ['name'],
			},
			minItems: 0,
			maxItems: 256,
		},
		dataShape: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					name:     { type: 'string' },
					path:     { type: 'string' },
					type:     { type: 'string' },
					types:    { type: 'array', items: { type: 'string' } },
					nullable: { type: 'boolean' },
				},
			},
			minItems: 0,
			maxItems: 256,
		},
		className: { type: 'string' },
		dataLabel: { type: 'string' },
	},
	required: ['classFields', 'dataShape'],
	additionalProperties: false,
} as const;

const OUTPUT_SCHEMA = {
	type: 'object',
	properties: {
		className: { type: 'string' },
		dataLabel: { type: 'string' },
		alignment: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					classField: { type: 'string' },
					classType:  { type: 'string' },
					dataKey:    { type: 'string' },
					dataType:   { type: 'string' },
					match:      { type: 'string', enum: ['exact', 'name-only', 'type-only', 'class-only', 'data-only', 'rename'] },
					note:       { type: 'string' },
				},
				required: ['match'],
			},
		},
		summary: {
			type: 'object',
			properties: {
				classFieldCount: { type: 'number' },
				dataColumnCount: { type: 'number' },
				exact:           { type: 'number' },
				nameOnly:        { type: 'number' },
				renames:         { type: 'number' },
				classOnly:       { type: 'number' },
				dataOnly:        { type: 'number' },
			},
			required: ['classFieldCount', 'dataColumnCount', 'exact', 'nameOnly', 'renames', 'classOnly', 'dataOnly'],
		},
		headline: { type: 'string' },
	},
	required: ['alignment', 'summary', 'headline'],
} as const;

const compareSkill: Skill<FieldsVsShapeInput, FieldsVsShapeOutput> = {
	id:          'shared.compare.fields-vs-shape',
	name:        'Fields vs Shape',
	description: 'Align a class field list with a data file\'s column shape; emit a structured mapping with class-only / data-only / rename / type-mismatch verdicts.',
	family:      'synthesis',
	owner:       'shared',
	version:     1,
	inputs:      INPUT_SCHEMA as unknown as Record<string, unknown>,
	outputs:     OUTPUT_SCHEMA as unknown as Record<string, unknown>,
	toolDeps:    [],
	providerAffinity: 'auto',
	async execute(input: FieldsVsShapeInput, _deps: SkillDeps): Promise<SkillResult<FieldsVsShapeOutput>> {
		void _deps;
		const value = alignFieldsAndShape(input);
		return { value, confidence: 'high', toolCalls: [] };
	},
};

export function registerSharedCompareFieldsVsShapeSkill(): void {
	registerSkill(compareSkill as unknown as Skill);
}
