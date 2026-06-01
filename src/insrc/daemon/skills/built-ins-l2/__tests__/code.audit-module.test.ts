/**
 * code.audit-module unit tests (deterministic-fake provider).
 *
 * Per A6: fake-provider tests pin code-path coverage. The live LLM
 * test in ./live/ exercises the judgment loop.
 *
 * Coverage:
 *   - Input validation rejects missing modulePath / repoPath.
 *   - Sub-call dispatch fires the expected L1 skills per focus.
 *   - Filter reduces repo-wide complexity to module-scoped entries.
 *   - Grounding succeeds when the LLM cites a real ledger entry.
 *   - Grounding drops findings citing unknown file paths.
 *   - Early exit when the module isn't indexed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { closeGraphStore, setGraphStorePath } from '../../../../db/graph/store.js';
import { upsertEntities } from '../../../../db/entities.js';
import { addRepo } from '../../../../db/repos.js';

import { _resetSkillRegistryForTests } from '../../registry.js';
import { _resetRegistryForTests as _resetToolRegistryForTests } from '../../../tools/registry.js';
import { _resetL2RegistryForTests, getL2Skill } from '../../l2/registry.js';
import { registerAllSkills } from '../../index.js';
import { runL2Skill } from '../../l2/runtime.js';
import { DefaultSkillAuditLog } from '../../audit.js';
import { DefaultAccessStore, DefaultAccessAuditLog } from '../../../../shared/access.js';

import type { LLMProvider, LLMResponse } from '../../../../shared/types.js';
import type { Session } from '../../../../agent/session.js';
import type { Entity, EntityKind, Language } from '../../../../shared/types.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const REPO = '/repo/audit-test';
const MODULE = `${REPO}/src/widgets`;

interface Fixture {
	readonly graphDir: string;
	dispose(): Promise<void>;
}

async function setupFixture(): Promise<Fixture> {
	await closeGraphStore();
	_resetSkillRegistryForTests();
	_resetToolRegistryForTests();
	_resetL2RegistryForTests();

	const graphDir = mkdtempSync(join(tmpdir(), 'insrc-audit-module-test-'));
	setGraphStorePath(join(graphDir, 'graph.lmdb'));
	const now = new Date().toISOString();
	await addRepo(null, { path: REPO, name: '', addedAt: now, status: 'pending' });

	registerAllSkills();

	return {
		graphDir,
		async dispose() {
			await closeGraphStore();
			rmSync(graphDir, { recursive: true, force: true });
		},
	};
}

function mkId(repo: string, file: string, kind: string, name: string): string {
	return createHash('sha256').update(`${repo}\x00${file}\x00${kind}\x00${name}`).digest('hex').slice(0, 32);
}

function ent(opts: { kind: EntityKind; name: string; file?: string; body?: string }): Entity {
	const file = opts.file ?? `${MODULE}/${opts.name}.ts`;
	return {
		id:        mkId(REPO, file, opts.kind, opts.name),
		kind:      opts.kind,
		name:      opts.name,
		language:  'typescript' as Language,
		repoId:    1,
		repo:      REPO,
		file,
		startLine: 1,
		endLine:   10,
		body:      opts.body ?? '',
		embedding: [],
		indexedAt: '2026-06-01T00:00:00.000Z',
	};
}

function fakeSession(): Session {
	const stub: Record<string, unknown> = {
		id: 'audit-test', repoPath: REPO, closureRepos: [REPO], startedAt: Date.now(),
		skillAudit:  new DefaultSkillAuditLog(),
		access:      new DefaultAccessStore(),
		accessAudit: new DefaultAccessAuditLog(),
	};
	return stub as unknown as Session;
}

function fakeProvider(toolPayload: Record<string, unknown> | undefined): LLMProvider {
	return {
		complete: async (): Promise<LLMResponse> => {
			if (toolPayload === undefined) {
				return { text: '', stopReason: 'end_turn' as const };
			}
			return {
				text:      '',
				stopReason: 'tool_use' as const,
				toolCalls: [{ id: 'tc-1', name: 'submit_audit', input: toolPayload }],
				usage:     { inputTokens: 100, outputTokens: 200 },
			};
		},
		stream: async function* () { yield ''; },
		embed:  async () => [],
		supportsTools: true,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('audit-module: input validation rejects missing modulePath', async () => {
	const fx = await setupFixture();
	try {
		const skill = getL2Skill('code.audit-module');
		assert.ok(skill);
		const result = await runL2Skill(skill,
			{ input: { repoPath: REPO } as unknown as Parameters<typeof skill.run>[0]['input'], invocationContext: {} },
			{ session: fakeSession(), resolveProvider: () => fakeProvider(undefined) },
		);
		assert.ok(result.rejected);
		assert.equal(result.rejected.reason, 'input-validation');
	} finally { await fx.dispose(); }
});

test('audit-module: early-exit when module not indexed', async () => {
	const fx = await setupFixture();
	try {
		const skill = getL2Skill('code.audit-module');
		assert.ok(skill);
		const result = await runL2Skill(skill,
			{ input: { modulePath: '/never/indexed', repoPath: REPO }, invocationContext: {} },
			{ session: fakeSession(), resolveProvider: () => fakeProvider(undefined) },
		);
		// Early exit returns a valid output; not rejected.
		assert.equal(result.rejected, undefined);
		const v = result.output.value as { findings: unknown[]; summary: string; module: { fileCount: number } };
		assert.equal(v.findings.length, 0);
		assert.equal(v.module.fileCount, 0);
		assert.match(v.summary, /could not run/);
		assert.equal(result.output.confidence, 'low');
	} finally { await fx.dispose(); }
});

test('audit-module: happy path with LLM-emitted finding citing a real file', async () => {
	const fx = await setupFixture();
	try {
		// Populate the module + a function with body so complexity has
		// something to score.
		await upsertEntities(null, [
			ent({ kind: 'file', name: `${MODULE}/Widget.ts`, file: `${MODULE}/Widget.ts` }),
			ent({
				kind: 'function', name: 'render', file: `${MODULE}/Widget.ts`,
				body: 'function render(x: number) { if (x > 0) return x; else return -x; }',
			}),
		]);

		const skill = getL2Skill('code.audit-module');
		assert.ok(skill);
		const llmPayload = {
			findings: [
				{
					kind:     'complexity',
					severity: 'info',
					summary:  'render has measurable cyclomatic complexity',
					file:     `${MODULE}/Widget.ts`,
				},
			],
			summary: 'Module contains one function with measurable complexity.',
		};
		const result = await runL2Skill(skill,
			{ input: { modulePath: MODULE, repoPath: REPO, focus: 'complexity' }, invocationContext: {} },
			{ session: fakeSession(), resolveProvider: () => fakeProvider(llmPayload) },
		);

		assert.equal(result.rejected, undefined, JSON.stringify(result.rejected));
		const v = result.output.value as { findings: Array<{ file: string; kind: string }>; summary: string };
		assert.equal(v.findings.length, 1, 'finding should ground to ledger');
		assert.equal(v.findings[0]!.file, `${MODULE}/Widget.ts`);
		assert.equal(v.findings[0]!.kind, 'complexity');
		assert.ok(result.output.evidence.length >= 1, 'evidence must be populated');
		assert.equal(result.output.confidence, 'high');
	} finally { await fx.dispose(); }
});

test('audit-module: finding citing a phantom file is dropped (grounding)', async () => {
	const fx = await setupFixture();
	try {
		await upsertEntities(null, [
			ent({ kind: 'file', name: `${MODULE}/Real.ts`, file: `${MODULE}/Real.ts` }),
			ent({
				kind: 'function', name: 'real', file: `${MODULE}/Real.ts`,
				body: 'function real(x: number) { if (x) return 1; return 0; }',
			}),
		]);

		const skill = getL2Skill('code.audit-module');
		assert.ok(skill);
		// LLM emits one valid + one phantom citation. The phantom is dropped.
		const llmPayload = {
			findings: [
				{ kind: 'complexity', severity: 'info', summary: 'real has measurable complexity', file: `${MODULE}/Real.ts` },
				{ kind: 'note', severity: 'high', summary: 'phantom warning', file: `${MODULE}/Phantom.ts` },
			],
			summary: 'Mixed findings.',
		};
		const result = await runL2Skill(skill,
			{ input: { modulePath: MODULE, repoPath: REPO, focus: 'complexity' }, invocationContext: {} },
			{ session: fakeSession(), resolveProvider: () => fakeProvider(llmPayload) },
		);

		assert.equal(result.rejected, undefined);
		const v = result.output.value as { findings: Array<{ file: string }> };
		assert.equal(v.findings.length, 1, 'phantom finding should be dropped');
		assert.equal(v.findings[0]!.file, `${MODULE}/Real.ts`);
		// Confidence drops to medium when any finding was dropped.
		assert.equal(result.output.confidence, 'medium');
		assert.ok((result.output.notes ?? []).some(n => /dropped/.test(n)));
	} finally { await fx.dispose(); }
});

test('audit-module: focus="all" dispatches every L1 quality skill', async () => {
	const fx = await setupFixture();
	try {
		await upsertEntities(null, [
			ent({ kind: 'file', name: `${MODULE}/A.ts`, file: `${MODULE}/A.ts` }),
		]);

		const skill = getL2Skill('code.audit-module');
		assert.ok(skill);

		// Track which L1 skills got called via the sub-call events.
		const subCalls: string[] = [];
		const result = await runL2Skill(skill,
			{ input: { modulePath: MODULE, repoPath: REPO, focus: 'all' }, invocationContext: {} },
			{ session: fakeSession(),
			  resolveProvider: () => fakeProvider({ findings: [], summary: 'Empty.' }),
			  emit: (event) => { if (event.kind === 'sub-call-started') subCalls.push(event.targetSkill); } },
		);
		assert.equal(result.rejected, undefined);
		// Must include module.describe + complexity + duplication + unused-exports + cyclic-deps.
		assert.ok(subCalls.includes('code.source.module.describe'),       subCalls.join(','));
		assert.ok(subCalls.includes('code.quality.complexity'),           subCalls.join(','));
		assert.ok(subCalls.includes('code.quality.duplication'),          subCalls.join(','));
		assert.ok(subCalls.includes('code.quality.unused-exports'),       subCalls.join(','));
		assert.ok(subCalls.includes('code.quality.cyclic-deps'),          subCalls.join(','));
	} finally { await fx.dispose(); }
});

test('audit-module: focus="complexity" runs only complexity (skips other quality probes)', async () => {
	const fx = await setupFixture();
	try {
		await upsertEntities(null, [
			ent({ kind: 'file', name: `${MODULE}/A.ts`, file: `${MODULE}/A.ts` }),
		]);

		const skill = getL2Skill('code.audit-module');
		assert.ok(skill);

		const subCalls: string[] = [];
		await runL2Skill(skill,
			{ input: { modulePath: MODULE, repoPath: REPO, focus: 'complexity' }, invocationContext: {} },
			{ session: fakeSession(),
			  resolveProvider: () => fakeProvider({ findings: [], summary: 'Empty.' }),
			  emit: (event) => { if (event.kind === 'sub-call-started') subCalls.push(event.targetSkill); } },
		);
		assert.ok(subCalls.includes('code.source.module.describe'));
		assert.ok(subCalls.includes('code.quality.complexity'));
		assert.equal(subCalls.includes('code.quality.duplication'),    false);
		assert.equal(subCalls.includes('code.quality.unused-exports'), false);
		assert.equal(subCalls.includes('code.quality.cyclic-deps'),    false);
	} finally { await fx.dispose(); }
});

test('audit-module: when LLM returns no tool call, output has empty findings + low confidence', async () => {
	const fx = await setupFixture();
	try {
		await upsertEntities(null, [
			ent({ kind: 'file', name: `${MODULE}/A.ts`, file: `${MODULE}/A.ts` }),
		]);

		const skill = getL2Skill('code.audit-module');
		assert.ok(skill);
		const result = await runL2Skill(skill,
			{ input: { modulePath: MODULE, repoPath: REPO, focus: 'complexity' }, invocationContext: {} },
			{ session: fakeSession(), resolveProvider: () => fakeProvider(undefined) },
		);

		assert.equal(result.rejected, undefined);
		const v = result.output.value as { findings: unknown[]; summary: string };
		assert.equal(v.findings.length, 0);
		// No findings -> no dropped count; but no grounded either; confidence = 'low'.
		assert.equal(result.output.confidence, 'low');
	} finally { await fx.dispose(); }
});
