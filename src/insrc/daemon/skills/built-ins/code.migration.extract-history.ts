/**
 * code.migration.extract-history -- enumerate a repo's migration
 * history with typed DDL operations
 * (code-analyzer-skills.md Phase 3.5).
 *
 * The fourth and last cross-owner code-binding skill on the
 * critical path -- the prerequisite the data-analyzer §3.5 wrapper
 * rides. Closes out the Phase 3 prerequisites blocking the
 * data-analyzer skills routing flag-default-on cutover.
 *
 * Body:
 *   1. Call `code_migration_walk({ tool, repoPath })`.
 *   2. If `detected: false`, return `{ found: false, reason:
 *      'no-migrations-detected' }`.
 *   3. Otherwise pass through the tool's typed `migrations` array.
 *
 * Confidence shaping:
 *   - high   : every migration has at least one parsed operation
 *              (no execute_raw fall-through, OR every migration
 *              has at least one non-raw op)
 *   - medium : some fall through to execute_raw (parser couldn't
 *              classify part of the DDL but the rest is fine)
 *   - low    : most fall through to execute_raw (the parser
 *              couldn't handle the DSL -- callers should treat the
 *              output as a manual-review hint, not authoritative)
 *
 * Skill id: `code.migration.extract-history`. Family:
 * `code-binding`. Owner: `code-analyzer`. Provider affinity:
 * `auto` -- pure tool round-trip, no LLM call.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';

type MigrationTool =
	| 'flyway'
	| 'liquibase'
	| 'knex'
	| 'prisma-migrate'
	| 'alembic'
	| 'rails'
	| 'django';

type OpKind =
	| 'create_table'
	| 'drop_table'
	| 'add_column'
	| 'drop_column'
	| 'alter_column'
	| 'add_index'
	| 'drop_index'
	| 'rename_table'
	| 'rename_column'
	| 'execute_raw';

interface MigrationOp {
	readonly kind:      OpKind;
	readonly table?:    string;
	readonly column?:   string;
	readonly type?:     string;
	readonly nullable?: boolean;
	readonly default?:  string;
	readonly raw?:      string;
}

interface Migration {
	readonly id:         string;
	readonly label:      string;
	readonly path:       string;
	readonly appliedAt?: string;
	readonly operations: readonly MigrationOp[];
}

interface ExtractHistoryInput {
	readonly tool:      MigrationTool | 'auto';
	readonly repoPath:  string;
}

type ExtractHistoryOutput =
	| {
		readonly found:      true;
		readonly tool:       MigrationTool;
		readonly migrations: readonly Migration[];
	}
	| {
		readonly found:  false;
		readonly reason: 'no-migrations-detected';
	};

const codeMigrationExtractHistorySkill: Skill<ExtractHistoryInput, ExtractHistoryOutput> = {
	id: 'code.migration.extract-history',
	name: 'Code: extract migration history with typed DDL ops',
	description:
		'Enumerate a repo\'s migrations + parse the DDL into typed operations. Wraps ' +
		'`code_migration_walk` with a typed-refusal contract: returns `{ found: true, tool, ' +
		'migrations: [...] }` on hit, or `{ found: false, reason: "no-migrations-detected" }` when ' +
		'no migrations directory is present in the repo.',
	family: 'code-binding',
	owner: 'code-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			tool: {
				type: 'string',
				enum: ['flyway', 'liquibase', 'knex', 'prisma-migrate', 'alembic', 'rails', 'django', 'auto'],
				description: 'Migration tool, or "auto" to detect by directory fingerprint.',
			},
			repoPath: { type: 'string', description: 'Repo root absolute path.' },
		},
		required: ['tool', 'repoPath'],
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
					found:      { type: 'boolean', enum: [true] },
					tool:       { type: 'string' },
					migrations: { type: 'array' },
				},
				required: ['found', 'tool', 'migrations'],
			},
			{
				type: 'object',
				properties: {
					found:  { type: 'boolean', enum: [false] },
					reason: { type: 'string', enum: ['no-migrations-detected'] },
				},
				required: ['found', 'reason'],
			},
		],
	},
	toolDeps: ['code_migration_walk'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['code_migration_walk'],
			reason: 'migration enumeration rides the migration-walk tool; without it the skill cannot scan',
		},
	],

	async execute(input: ExtractHistoryInput, deps: SkillDeps): Promise<SkillResult<ExtractHistoryOutput>> {
		const walkResult = await deps.runTool({
			id: makeCallId('walk'),
			name: 'code_migration_walk',
			input: { tool: input.tool, repoPath: input.repoPath },
		});

		if (walkResult.isError) {
			return {
				value: { found: false, reason: 'no-migrations-detected' },
				confidence: 'low',
				notes: [`code_migration_walk returned error: ${walkResult.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}

		if (!isWalkData(walkResult.data)) {
			return {
				value: { found: false, reason: 'no-migrations-detected' },
				confidence: 'low',
				notes: ['code_migration_walk returned a payload without the expected shape'],
				toolCalls: [],
			};
		}

		const walkData = walkResult.data;

		if (walkData.detected === false || walkData.tool === undefined) {
			return {
				value: { found: false, reason: 'no-migrations-detected' },
				confidence: 'high',
				notes: ['No migrations directory found in the repo (looked for prisma/migrations/, db/migrate/, ...).'],
				toolCalls: [],
			};
		}

		// Confidence shaping based on parse coverage.
		const confidence = scoreConfidence(walkData.migrations);

		const result: SkillResult<ExtractHistoryOutput> = {
			value: {
				found:      true,
				tool:       walkData.tool,
				migrations: walkData.migrations,
			},
			confidence,
			notes:     buildNotes(walkData.migrations),
			toolCalls: [],
		};
		return result;
	},
};

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

function scoreConfidence(migrations: readonly Migration[]): 'high' | 'medium' | 'low' {
	if (migrations.length === 0) return 'high'; // a tool was detected but no files; shape is sound
	let totalOps = 0;
	let rawOps   = 0;
	let migrationsWithAnyParsedOp = 0;
	for (const m of migrations) {
		let parsedHere = 0;
		for (const op of m.operations) {
			totalOps++;
			if (op.kind === 'execute_raw') rawOps++;
			else parsedHere++;
		}
		if (parsedHere > 0) migrationsWithAnyParsedOp++;
	}
	if (totalOps === 0) return 'medium'; // tool detected, no ops parsed at all
	if (rawOps === 0)   return 'high';
	if (migrationsWithAnyParsedOp === migrations.length) return 'high'; // every migration has at least one parsed op
	const rawShare = rawOps / totalOps;
	if (rawShare > 0.5) return 'low';
	return 'medium';
}

function buildNotes(migrations: readonly Migration[]): string[] {
	const notes: string[] = [];
	let totalOps = 0;
	let rawOps   = 0;
	for (const m of migrations) {
		for (const op of m.operations) {
			totalOps++;
			if (op.kind === 'execute_raw') rawOps++;
		}
	}
	if (rawOps > 0) {
		const pct = Math.round(100 * rawOps / Math.max(totalOps, 1));
		notes.push(`${rawOps} of ${totalOps} operations (${pct}%) fell through to execute_raw -- the parser couldn't classify the underlying DDL/DSL.`);
	}
	return notes;
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

interface WalkData {
	readonly detected:   boolean;
	readonly tool?:      MigrationTool;
	readonly migrations: readonly Migration[];
}

function isWalkData(v: unknown): v is WalkData {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	if (typeof o['detected']  !== 'boolean') return false;
	if (!Array.isArray(o['migrations']))     return false;
	if (o['detected'] === true && typeof o['tool'] !== 'string') return false;
	return true;
}

let CALL_SEQ = 0;
function makeCallId(stage: string): string {
	CALL_SEQ = (CALL_SEQ + 1) & 0xffff;
	return `code-migration-extract-history:${stage}:${Date.now()}:${CALL_SEQ}`;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerCodeMigrationExtractHistorySkill(): void {
	registerSkill(codeMigrationExtractHistorySkill as unknown as Skill);
}

// Test exports.
export const _codeMigrationExtractHistorySkillForTest = codeMigrationExtractHistorySkill;
export const _scoreConfidenceForTest                  = scoreConfidence;
