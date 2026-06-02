/**
 * runAnswerQuestionTask LIVE local-LLM integration test (A6).
 *
 * Simulates the data-analyzer orchestrator path that drives every
 * /data-analyze task post-P13 cutover:
 *
 *   DataAnalysisTask + connections[]
 *     -> runAnswerQuestionTask
 *         -> runL2Skill('data.answer-question', ...)
 *             -> callL1('data.meta.classify-question', ...)
 *             -> callL1('data.meta.select-scope', ...)
 *             -> callL1(<scoped skill>, ...)
 *             -> deps.llm.complete(...) (draft)
 *             -> groundSections(...)
 *     <- DataAnalyzerResult { answer, findings, citations, confidence, ... }
 *
 * What this test catches that the unit tests don't:
 *   - Input-shape passthrough between the adapter and the L2 skill.
 *   - The L2 skill's tool-call protocol working end-to-end against a
 *     real cloud provider (mirror of the code-side guard against the
 *     2026-06-02 scopeTier regression).
 *   - Adapter output shape (answer markdown + findings + citations)
 *     is structurally valid even with stub citations.
 *
 * Structural assertions only (per A6); no exact-prose checks.
 *
 * Prereq: ollama running with the configured `models.providers.local.coreModel`.
 * Skips gracefully when unreachable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeGraphStore, setGraphStorePath } from '../../../../../db/graph/store.js';
import { addRepo } from '../../../../../db/repos.js';

import { _resetSkillRegistryForTests } from '../../../../../daemon/skills/registry.js';
import { _resetRegistryForTests as _resetToolRegistryForTests } from '../../../../../daemon/tools/registry.js';
import { _resetL2RegistryForTests } from '../../../../../daemon/skills/l2/registry.js';
import { registerAllSkills } from '../../../../../daemon/skills/index.js';
import { registerSkillTools } from '../../../../../daemon/tools/builtins/skills/invoke-skill.js';
import { DefaultSkillAuditLog } from '../../../../../daemon/skills/audit.js';
import { DefaultAccessStore, DefaultAccessAuditLog } from '../../../../../shared/access.js';

import { OllamaProvider } from '../../../../providers/ollama.js';
import { loadConfig } from '../../../../config.js';

import { runAnswerQuestionTask } from '../../answer-question-section.js';

import type { Session } from '../../../../session.js';
import type { ConnectionSummary, DataAnalysisTask } from '../../types.js';

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
	: { skip: `Ollama not reachable at ${LOCAL_HOST}; live data-side integration test skipped` };

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const REPO = '/repo/data-aq-live-test';

interface Fixture {
	readonly graphDir: string;
	dispose(): Promise<void>;
}

async function setupFixture(): Promise<Fixture> {
	await closeGraphStore();
	_resetSkillRegistryForTests();
	_resetToolRegistryForTests();
	_resetL2RegistryForTests();

	const graphDir = mkdtempSync(join(tmpdir(), 'insrc-data-aq-live-'));
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

function fakeSession(provider: OllamaProvider): Session {
	// The data-analyzer's `resolveDataAnalyzerProvider` reads from the
	// session's:
	//   - `config.analyzer.useLocal`            (opt-in flag)
	//   - `ollamaProvider`                      (local)
	//   - `claudeProvider`                      (cloud)
	// The live test routes every site to Ollama by setting useLocal
	// + populating ollamaProvider.
	const stub: Record<string, unknown> = {
		id: 'data-aq-live-test', repoPath: REPO, closureRepos: [REPO], startedAt: Date.now(),
		skillAudit:  new DefaultSkillAuditLog(),
		access:      new DefaultAccessStore(),
		accessAudit: new DefaultAccessAuditLog(),
		config: { analyzer: { useLocal: true } },
		ollamaProvider: provider,
		claudeProvider: provider,
	};
	return stub as unknown as Session;
}

function fileConnection(): ConnectionSummary {
	return {
		id:     'csv-1',
		family: 'file',
		kind:   'csv',
		label:  'fixture-csv',
	};
}

function task(): DataAnalysisTask {
	return {
		itemId:   'aq-live-1',
		kind:     'inspect-schema',
		question: 'What columns does the csv-1 connection expose?',
		origin:   'plan',
	};
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test('LIVE: runAnswerQuestionTask drives the data-analyzer pipeline end-to-end', skipIfNoOllama ?? { timeout: 300_000 }, async () => {
	const fx = await setupFixture();
	try {
		const provider = new OllamaProvider(LOCAL_MODEL, LOCAL_HOST);

		// resolveDataAnalyzerProvider walks the session config; the
		// stub here gives it a fallback path. For an integration test
		// we want the L2 runtime + adapter to actually run against
		// Ollama -- patch the provider lookup if needed by swapping
		// the resolve-provider module via dependency injection. For
		// this iteration we accept that the adapter falls back to its
		// own resolution chain; what we structurally assert is shape.
		const session = fakeSession(provider);

		const outcome = await runAnswerQuestionTask({
			session,
			task:        task(),
			connections: [fileConnection()],
		});

		// 1. Outcome shape sanity.
		assert.ok(outcome.result, 'adapter must return a result');

		// 2. itemId is preserved (orchestrator invariant).
		assert.equal(outcome.result.itemId, 'aq-live-1');

		// 3. Confidence is one of the expected enum values.
		assert.ok(['high', 'medium', 'low'].includes(outcome.result.confidence),
			`confidence must be high|medium|low; got ${outcome.result.confidence}`);

		// 4. answer is non-trivial markdown.
		assert.ok(typeof outcome.result.answer === 'string' && outcome.result.answer.length > 10,
			`answer must be a non-trivial string; got ${outcome.result.answer.slice(0, 80)}`);

		// 5. findings is an array (may be the fallback single-item
		//    array when sections=0; either way structurally valid).
		assert.ok(Array.isArray(outcome.result.findings),
			'findings must be an array');

		// 6. Every finding has non-empty citations (the DataFinding
		//    invariant -- adapter must respect it even when L2
		//    produces no grounded sections).
		for (const f of outcome.result.findings) {
			assert.ok(f.citations.length >= 1,
				`finding "${f.issue.slice(0, 40)}" must have non-empty citations`);
		}

		// 7. blockedReason absent for a non-blocked path.
		assert.equal(outcome.blockedReason, undefined);
	} finally { await fx.dispose(); }
});
