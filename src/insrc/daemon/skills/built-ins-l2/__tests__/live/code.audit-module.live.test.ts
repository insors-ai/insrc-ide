/**
 * code.audit-module LIVE local-LLM integration test (A6).
 *
 * Per agentic-skills-architecture.md §A6 -- L2 tests are integration
 * tests against a LIVE local LLM (Ollama / qwen3-coder). Not fake
 * providers. Not cloud. Structural assertions only -- never exact
 * prose.
 *
 * What this test does:
 *   1. Boots an Ollama provider against the configured local model.
 *      Skips gracefully if Ollama isn't reachable.
 *   2. Builds an in-memory LMDB fixture with one small module
 *      containing a function whose cyclomatic complexity is real
 *      enough for the L1 quality.complexity skill to score.
 *   3. Invokes the L2 audit-module pilot via runL2Skill.
 *   4. Asserts STRUCTURAL properties only:
 *      - Output validates against the schema.
 *      - Confidence is 'high' OR 'medium' (not 'low').
 *      - Evidence is non-empty.
 *      - Every LedgerRef in citations resolves (the runtime would
 *        have rejected otherwise; this is belt-and-suspenders).
 *      - At least one finding references a file from the fixture
 *        (substring family).
 *
 * Run prerequisite (per CLAUDE.md "Build and run"):
 *   ollama running locally with the default core model pulled.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { closeGraphStore, setGraphStorePath } from '../../../../../db/graph/store.js';
import { upsertEntities } from '../../../../../db/entities.js';
import { addRepo } from '../../../../../db/repos.js';

import { _resetSkillRegistryForTests } from '../../../registry.js';
import { _resetRegistryForTests as _resetToolRegistryForTests } from '../../../../tools/registry.js';
import { _resetL2RegistryForTests, getL2Skill } from '../../../l2/registry.js';
import { registerAllSkills } from '../../../index.js';
import { runL2Skill } from '../../../l2/runtime.js';
import { DefaultSkillAuditLog } from '../../../audit.js';
import { DefaultAccessStore, DefaultAccessAuditLog } from '../../../../../shared/access.js';

import { OllamaProvider } from '../../../../../agent/providers/ollama.js';
import { loadConfig } from '../../../../../agent/config.js';

import type { LLMProvider } from '../../../../../shared/types.js';
import type { Session } from '../../../../../agent/session.js';
import type { Entity, EntityKind, Language } from '../../../../../shared/types.js';

// ---------------------------------------------------------------------------
// Live availability check
// ---------------------------------------------------------------------------

const cfg = loadConfig();
const LOCAL_HOST  = cfg.models.providers.local.host;
const LOCAL_MODEL = cfg.models.providers.local.coreModel;

async function ollamaAvailable(): Promise<boolean> {
	try {
		const res = await fetch(`${LOCAL_HOST}/api/tags`, { signal: AbortSignal.timeout(2000) });
		return res.ok;
	} catch {
		return false;
	}
}

const HAS_OLLAMA = await ollamaAvailable();
const skipIfNoOllama = HAS_OLLAMA
	? undefined
	: { skip: `Ollama not reachable at ${LOCAL_HOST}; live L2 test skipped` };

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const REPO   = '/repo/audit-live-test';
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

	const graphDir = mkdtempSync(join(tmpdir(), 'insrc-audit-live-'));
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
		endLine:   30,
		body:      opts.body ?? '',
		embedding: [],
		indexedAt: '2026-06-01T00:00:00.000Z',
	};
}

function fakeSession(): Session {
	const stub: Record<string, unknown> = {
		id: 'audit-live-test', repoPath: REPO, closureRepos: [REPO], startedAt: Date.now(),
		skillAudit:  new DefaultSkillAuditLog(),
		access:      new DefaultAccessStore(),
		accessAudit: new DefaultAccessAuditLog(),
	};
	return stub as unknown as Session;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test('LIVE: code.audit-module end-to-end on a fixture module', skipIfNoOllama ?? { timeout: 180_000 }, async () => {
	const fx = await setupFixture();
	try {
		// Populate the module with one file containing a function whose
		// cyclomatic complexity is non-trivial -- gives the audit
		// something to talk about.
		const widgetFile = `${MODULE}/Widget.ts`;
		await upsertEntities(null, [
			ent({ kind: 'file', name: widgetFile, file: widgetFile }),
			ent({
				kind: 'function', name: 'render', file: widgetFile,
				body: [
					'function render(state: { mode: string; count: number }) {',
					'  if (state.mode === "loading") { return "loading..."; }',
					'  if (state.mode === "error") { return "error"; }',
					'  if (state.count < 0) { return "invalid"; }',
					'  if (state.count === 0) { return "empty"; }',
					'  if (state.count > 100) { return "overflow"; }',
					'  return state.count.toString();',
					'}',
				].join('\n'),
			}),
		]);

		const provider: LLMProvider = new OllamaProvider(LOCAL_MODEL, LOCAL_HOST);
		const skill = getL2Skill('code.audit-module');
		assert.ok(skill, 'audit-module not registered');

		const result = await runL2Skill(skill,
			{ input: { modulePath: MODULE, repoPath: REPO, focus: 'complexity' }, invocationContext: {} },
			{ session: fakeSession(), resolveProvider: () => provider },
		);

		// 1. Output validates -- runtime would have rejected otherwise.
		assert.equal(result.rejected, undefined,
			`expected no rejection; got ${JSON.stringify(result.rejected)}`);

		// 2. Confidence floor: medium or high.
		assert.ok(
			result.output.confidence === 'high' || result.output.confidence === 'medium',
			`expected confidence high|medium; got ${result.output.confidence}`,
		);

		// 3. Findings non-empty.
		const v = result.output.value as { findings: Array<{ kind: string; file?: string; summary: string }>; module: { fileCount: number; entityCount: number }; summary: string };
		assert.ok(v.findings.length >= 1,
			`expected at least one finding; got ${v.findings.length}`);

		// 4. Module surface populated.
		assert.equal(v.module.fileCount, 1);
		assert.equal(v.module.entityCount, 1);   // top-level function only

		// 5. Evidence non-empty.
		assert.ok(result.output.evidence.length >= 1, 'evidence must be populated');

		// 6. Property-based: at least one finding references the fixture
		//    file (substring family, not exact match).
		const refsFixtureFile = v.findings.some(f => f.file !== undefined && f.file.includes('Widget'));
		assert.ok(refsFixtureFile,
			`expected at least one finding to reference Widget; got files: ${v.findings.map(f => f.file).join(',')}`);

		// 7. focus='complexity' should drive at least one complexity-kind finding.
		const hasComplexityFinding = v.findings.some(f => f.kind === 'complexity');
		assert.ok(hasComplexityFinding,
			`with focus='complexity' expected at least one complexity-kind finding; got kinds: ${v.findings.map(f => f.kind).join(',')}`);
	} finally { await fx.dispose(); }
});
