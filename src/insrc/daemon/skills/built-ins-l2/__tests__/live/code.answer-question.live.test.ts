/**
 * code.answer-question LIVE local-LLM integration test (A6).
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
 *      containing a function and an indexed file.
 *   3. Invokes the L2 answer-question pilot via runL2Skill, asking a
 *      "what entities are defined in this file?" question.
 *   4. Asserts STRUCTURAL properties only:
 *      - Output validates against the schema.
 *      - Confidence is 'high' OR 'medium' (not 'low').
 *      - At least one section returned.
 *      - At least one evidence entry.
 *      - dispatched is non-empty.
 *      - At least one section mentions the fixture file (substring family).
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
import { upsertRelations } from '../../../../../db/relations.js';
import { addRepo } from '../../../../../db/repos.js';

import { _resetSkillRegistryForTests } from '../../../registry.js';
import { _resetRegistryForTests as _resetToolRegistryForTests } from '../../../../tools/registry.js';
import { _resetL2RegistryForTests, getL2Skill } from '../../../l2/registry.js';
import { registerAllSkills } from '../../../index.js';
import { registerSkillTools } from '../../../../tools/builtins/skills/invoke-skill.js';
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

const REPO = '/repo/aq-live-test';
const FILE = `${REPO}/src/widgets/Widget.ts`;

interface Fixture {
	readonly graphDir: string;
	dispose(): Promise<void>;
}

async function setupFixture(): Promise<Fixture> {
	await closeGraphStore();
	_resetSkillRegistryForTests();
	_resetToolRegistryForTests();
	_resetL2RegistryForTests();

	const graphDir = mkdtempSync(join(tmpdir(), 'insrc-aq-live-'));
	setGraphStorePath(join(graphDir, 'graph.lmdb'));
	const now = new Date().toISOString();
	await addRepo(null, { path: REPO, name: '', addedAt: now, status: 'pending' });

	registerAllSkills();
	registerSkillTools();

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
	const file = opts.file ?? FILE;
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
		id: 'aq-live-test', repoPath: REPO, closureRepos: [REPO], startedAt: Date.now(),
		skillAudit:  new DefaultSkillAuditLog(),
		access:      new DefaultAccessStore(),
		accessAudit: new DefaultAccessAuditLog(),
	};
	return stub as unknown as Session;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test('LIVE: code.answer-question end-to-end on a fixture file', skipIfNoOllama ?? { timeout: 300_000 }, async () => {
	const fx = await setupFixture();
	try {
		const fileEnt = ent({ kind: 'file', name: FILE, file: FILE });
		const funcEnt = ent({
			kind: 'function', name: 'render', file: FILE,
			body: 'function render(x: number) { if (x > 0) return x; return -x; }',
		});
		await upsertEntities(null, [fileEnt, funcEnt]);
		// DEFINES edge file -> function so code.source.file.describe
		// finds the function via findDefinedIn(fileId).
		await upsertRelations(null, [
			{ kind: 'DEFINES', from: fileEnt.id, to: funcEnt.id, resolved: true },
		]);

		const provider: LLMProvider = new OllamaProvider(LOCAL_MODEL, LOCAL_HOST);
		const skill = getL2Skill('code.answer-question');
		assert.ok(skill, 'answer-question not registered');

		const result = await runL2Skill(skill,
			{ input: {
				question:       `What entities are defined in ${FILE}?`,
				activeRepoPath: REPO,
				repoMeta:       { primaryLanguages: ['typescript'] },
			  }, invocationContext: {} },
			{ session: fakeSession(), resolveProvider: () => provider },
		);

		// 1. Output validates -- runtime would have rejected otherwise.
		assert.equal(result.rejected, undefined,
			`expected no rejection; got ${JSON.stringify(result.rejected)}`);

		// 2. Confidence floor: medium or high.
		assert.ok(
			result.output.confidence === 'high' || result.output.confidence === 'medium',
			`expected confidence high|medium; got ${result.output.confidence} (notes: ${JSON.stringify(result.output.notes)})`,
		);

		const v = result.output.value as {
			question:     string;
			questionType: string;
			sections:     Array<{ title: string; body: string; details?: unknown }>;
			dispatched:   Array<{ skillId: string; goal: string }>;
		};

		// 3. Sections non-empty (drafted + grounded).
		assert.ok(v.sections.length >= 1,
			`expected at least one section; got ${v.sections.length}`);

		// 4. Evidence non-empty.
		assert.ok(result.output.evidence.length >= 1, 'evidence must be populated');

		// 5. Dispatched non-empty -- something must have actually run for
		//    the LLM to have evidence to ground against.
		assert.ok(v.dispatched.length >= 1,
			`expected at least one dispatched sub-skill; got ${v.dispatched.length}`);

		// 6. Property-based: at least one section mentions the fixture
		//    file (substring family, not exact match).
		const refsFile = v.sections.some(s => s.body.includes('Widget') || s.title.includes('Widget'));
		assert.ok(refsFile,
			`expected at least one section to mention Widget; got titles: ${v.sections.map(s => s.title).join(' | ')}`);
	} finally { await fx.dispose(); }
});
