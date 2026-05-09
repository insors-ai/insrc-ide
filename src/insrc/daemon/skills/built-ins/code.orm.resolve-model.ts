/**
 * code.orm.resolve-model -- locate a single ORM model by name and
 * return its normalised columns / relations
 * (code-analyzer-skills.md Phase 3.3).
 *
 * The third cross-owner code-binding skill -- the prerequisite the
 * data-analyzer §3.3 wrapper rides, and the substrate for all of
 * data-analyzer Phase 4 (lineage / cardinality / quality skills
 * that need a model -> table -> column mapping).
 *
 * Body:
 *   1. Call `code_orm_scan({ orm, repoPath })`. When `orm: 'auto'`,
 *      the tool may return models from multiple dialects.
 *   2. Filter to `model.name === input.model` (case-sensitive).
 *      Zero matches -> `{ found: false, nearest }` with the closest
 *      model names by levenshtein distance.
 *   3. Exactly one match -> `{ found: true, model }`.
 *   4. Multiple matches across dialects -> `{ found: false,
 *      ambiguity: { kind: 'multiple-matches', alternatives } }`
 *      per the data-analyzer-skills §7.2 ambiguity convention.
 *
 * Output normalisation: the tool's per-dialect column / relation
 * shape is already uniform (see daemon/tools/builtins/code/orm/
 * types.ts), so the skill is mostly a thin filter + nearest-match
 * fallback. Future dialects added to `code_orm_scan` flow through
 * here without per-dialect skill changes.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';

type OrmDialect =
	| 'prisma'
	| 'typeorm'
	| 'sequelize'
	| 'sqlalchemy'
	| 'django'
	| 'hibernate'
	| 'activerecord';

interface ResolveModelInput {
	readonly orm:        OrmDialect | 'auto';
	readonly model:      string;
	readonly repoPath:   string;
}

interface OrmColumn {
	readonly name:      string;
	readonly type?:     string;
	readonly nullable?: boolean;
	readonly default?:  string;
	readonly isPrimary?: boolean;
	readonly isUnique?:  boolean;
}

interface OrmRelation {
	readonly kind:      'belongs_to' | 'has_many' | 'has_one' | 'many_to_many';
	readonly target:    string;
	readonly through?:  string;
	readonly fieldName?: string;
}

interface NormalisedModel {
	readonly name:      string;
	readonly table?:    string;
	readonly columns:   readonly OrmColumn[];
	readonly relations: readonly OrmRelation[];
	readonly indexes:   readonly { readonly name: string; readonly columns: readonly string[]; readonly unique: boolean }[];
	readonly path:      string;
	readonly line:      number;
	readonly dialect:   OrmDialect;
}

interface NearestModel {
	readonly name:    string;
	readonly dialect: OrmDialect;
	readonly score:   number;
}

interface Ambiguity {
	readonly kind:        'multiple-matches';
	readonly alternatives: readonly string[];
}

type ResolveModelOutput =
	| { readonly found: true;  readonly model: NormalisedModel }
	| { readonly found: false; readonly nearest: readonly NearestModel[]; readonly ambiguity?: Ambiguity };

const NEAREST_LIMIT = 3;

const codeOrmResolveModelSkill: Skill<ResolveModelInput, ResolveModelOutput> = {
	id: 'code.orm.resolve-model',
	name: 'Code: resolve an ORM model by name',
	description:
		'Locate a single ORM model by name in a repo. Wraps `code_orm_scan` with a name filter ' +
		'and uniform output shape. Returns `{ found: true, model: { name, table?, columns, ' +
		'relations, path, line, dialect, indexes } }` on hit, or `{ found: false, nearest: [...] }` ' +
		'on miss (typo / unknown). Multi-dialect ties surface as `{ found: false, ambiguity: ' +
		'{ kind: "multiple-matches", alternatives: ["<dialect>:<name>", ...] } }`.',
	family: 'code-binding',
	owner: 'code-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			orm: {
				type: 'string',
				enum: ['prisma', 'typeorm', 'sequelize', 'sqlalchemy', 'django', 'hibernate', 'activerecord', 'auto'],
				description: 'ORM dialect, or "auto" to probe every supported one.',
			},
			model:    { type: 'string', description: 'Model class name as referenced in the schema / source.' },
			repoPath: { type: 'string', description: 'Repo root absolute path.' },
		},
		required: ['orm', 'model', 'repoPath'],
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
					found: { type: 'boolean', enum: [true] },
					model: { type: 'object' },
				},
				required: ['found', 'model'],
			},
			{
				type: 'object',
				properties: {
					found:   { type: 'boolean', enum: [false] },
					nearest: { type: 'array' },
					ambiguity: { type: 'object' },
				},
				required: ['found', 'nearest'],
			},
		],
	},
	toolDeps: ['code_orm_scan'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['code_orm_scan'],
			reason: 'model resolution rides the orm-scan tool; without it the skill cannot enumerate models',
		},
	],

	async execute(input: ResolveModelInput, deps: SkillDeps): Promise<SkillResult<ResolveModelOutput>> {
		const scanResult = await deps.runTool({
			id: makeCallId('scan'),
			name: 'code_orm_scan',
			input: { orm: input.orm, repoPath: input.repoPath },
		});

		if (scanResult.isError) {
			return {
				value: { found: false, nearest: [] },
				confidence: 'low',
				notes: [`code_orm_scan returned error: ${scanResult.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}

		if (!isScanData(scanResult.data)) {
			return {
				value: { found: false, nearest: [] },
				confidence: 'low',
				notes: ['code_orm_scan returned a payload without the expected shape'],
				toolCalls: [],
			};
		}

		const allModels = scanResult.data.models;
		const matches = allModels.filter(m => m.name === input.model);

		// Exact match path.
		if (matches.length === 1) {
			return {
				value: { found: true, model: normaliseModel(matches[0]!) },
				confidence: 'high',
				notes: [],
				toolCalls: [],
			};
		}

		// Multi-dialect ambiguity.
		if (matches.length > 1) {
			const alternatives = matches.map(m => `${m.dialect}:${m.name}`);
			return {
				value: {
					found: false,
					nearest: [],
					ambiguity: { kind: 'multiple-matches', alternatives },
				},
				confidence: 'high',
				notes: [
					`'${input.model}' resolved to ${matches.length} models across dialects: ${alternatives.join(', ')}. ` +
					`Pass a specific dialect via the 'orm' input to disambiguate.`,
				],
				toolCalls: [],
			};
		}

		// No matches -> typed refusal with nearest candidates.
		const nearest = pickNearest(input.model, allModels);
		return {
			value: { found: false, nearest },
			confidence: 'high',
			notes: nearest.length > 0
				? [`model '${input.model}' not found; nearest: ${nearest.map(n => `${n.dialect}:${n.name}`).join(', ')}`]
				: [`model '${input.model}' not found; no nearby models in the index. ` +
				   (scanResult.data.detected.orms.length === 0
					   ? 'No ORM detected in the repo -- check that prisma/schema.prisma or @Entity classes exist.'
					   : `Detected dialects: ${scanResult.data.detected.orms.join(', ')}.`)],
			toolCalls: [],
		};
	},
};

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

interface ScanModel {
	readonly name:      string;
	readonly table?:    string;
	readonly columns:   readonly OrmColumn[];
	readonly relations: readonly OrmRelation[];
	readonly path:      string;
	readonly line:      number;
	readonly dialect:   OrmDialect;
}

function normaliseModel(m: ScanModel): NormalisedModel {
	// v1: indexes are not surfaced by `code_orm_scan` (Prisma's
	// @@index / @@unique blocks land in a future iteration); synthesise
	// per-column single-field indexes from `isUnique` so callers that
	// need a "unique columns" enumeration don't have to re-scan.
	const indexes = m.columns
		.filter(c => c.isUnique === true)
		.map(c => ({
			name:    `${m.name}_${c.name}_unique`,
			columns: [c.name],
			unique:  true,
		}));

	const out: NormalisedModel = {
		name:      m.name,
		columns:   m.columns,
		relations: m.relations,
		indexes,
		path:      m.path,
		line:      m.line,
		dialect:   m.dialect,
	};
	return m.table !== undefined ? { ...out, table: m.table } : out;
}

// ---------------------------------------------------------------------------
// Nearest-match
// ---------------------------------------------------------------------------

function pickNearest(target: string, models: readonly ScanModel[]): NearestModel[] {
	const lcTarget = target.toLowerCase();
	const scored: NearestModel[] = [];
	const seen = new Set<string>();
	for (const m of models) {
		const key = `${m.dialect}:${m.name}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const score = similarity(lcTarget, m.name.toLowerCase());
		if (score <= 0) continue;
		scored.push({ name: m.name, dialect: m.dialect, score });
	}
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, NEAREST_LIMIT);
}

function similarity(a: string, b: string): number {
	if (a === b) return 1;
	const maxLen = Math.max(a.length, b.length);
	if (maxLen === 0) return 0;
	const dist = levenshtein(a, b);
	if (dist > maxLen * 0.6) return 0;
	const editScore = 1 - (dist / maxLen);
	const prefix    = commonPrefixLen(a, b);
	const prefixBoost = (prefix / maxLen) * 0.2;
	return Math.min(1, Math.max(0, editScore * 0.8 + prefixBoost));
}

function commonPrefixLen(a: string, b: string): number {
	const n = Math.min(a.length, b.length);
	let i = 0;
	while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
	return i;
}

function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	const m = a.length;
	const n = b.length;
	const v0 = new Array<number>(n + 1);
	const v1 = new Array<number>(n + 1);
	for (let i = 0; i <= n; i++) v0[i] = i;
	for (let i = 0; i < m; i++) {
		v1[0] = i + 1;
		for (let j = 0; j < n; j++) {
			const cost = a.charCodeAt(i) === b.charCodeAt(j) ? 0 : 1;
			v1[j + 1] = Math.min(v1[j]! + 1, v0[j + 1]! + 1, v0[j]! + cost);
		}
		for (let i2 = 0; i2 <= n; i2++) v0[i2] = v1[i2]!;
	}
	return v0[n]!;
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

interface ScanData {
	readonly detected: { readonly orms: readonly OrmDialect[] };
	readonly models:   readonly ScanModel[];
}

function isScanData(v: unknown): v is ScanData {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	if (typeof o['detected'] !== 'object' || o['detected'] === null) return false;
	const det = o['detected'] as Record<string, unknown>;
	if (!Array.isArray(det['orms'])) return false;
	if (!Array.isArray(o['models'])) return false;
	return true;
}

let CALL_SEQ = 0;
function makeCallId(stage: string): string {
	CALL_SEQ = (CALL_SEQ + 1) & 0xffff;
	return `code-orm-resolve-model:${stage}:${Date.now()}:${CALL_SEQ}`;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerCodeOrmResolveModelSkill(): void {
	registerSkill(codeOrmResolveModelSkill as unknown as Skill);
}

// Test exports.
export const _codeOrmResolveModelSkillForTest = codeOrmResolveModelSkill;
export const _normaliseModelForTest           = normaliseModel;
export const _pickNearestForTest              = pickNearest;
export const _similarityForTest               = similarity;
