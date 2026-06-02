/**
 * runAnswerQuestionSection LIVE local-LLM integration test (A6).
 *
 * Simulates the full orchestrator -> adapter -> L2 skill pipeline that
 * the IDE's /code-analyze flow drives. Each section in a real run goes
 * through this exact path:
 *
 *   PlannedAction (from the planner)
 *     -> runAnswerQuestionSection
 *         -> runL2Skill('code.answer-question', { input, ... })
 *             -> callL1('code.meta.classify-question', ...)
 *             -> callL1('code.meta.select-scope', ...)
 *             -> callL1(<scoped skill>, ...)
 *             -> deps.llm.complete(...) (draft)
 *             -> groundSections(...)
 *
 * What this test catches that the unit tests do not:
 *   - Input-schema passthrough bugs between the L2 skill and its L1
 *     sub-skills (e.g. the scopeTier-leak regression from 2026-06-02
 *     that produced 0-section reports across an entire 11-section run).
 *   - Bad orchestrator wiring (wrong types, missing fields in the
 *     adapter, etc.).
 *   - End-to-end ledger / grounding behaviour with a real LLM picking
 *     real refs from the rendered evidence block.
 *
 * Structural assertions only (per A6) -- never exact prose.
 *
 * Prereq: ollama running with the configured `models.providers.local.coreModel`.
 * Skips gracefully when unreachable.
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

import { _resetSkillRegistryForTests } from '../../../../../daemon/skills/registry.js';
import { _resetRegistryForTests as _resetToolRegistryForTests } from '../../../../../daemon/tools/registry.js';
import { _resetL2RegistryForTests } from '../../../../../daemon/skills/l2/registry.js';
import { registerAllSkills } from '../../../../../daemon/skills/index.js';
import { registerSkillTools } from '../../../../../daemon/tools/builtins/skills/invoke-skill.js';
import { DefaultSkillAuditLog } from '../../../../../daemon/skills/audit.js';
import { DefaultAccessStore, DefaultAccessAuditLog } from '../../../../../shared/access.js';

import { OllamaProvider } from '../../../../providers/ollama.js';
import { loadConfig } from '../../../../config.js';

import { runAnswerQuestionSection } from '../../answer-question-section.js';

import type { LLMProvider } from '../../../../../shared/types.js';
import type { Session } from '../../../../session.js';
import type { Entity, EntityKind, Language } from '../../../../../shared/types.js';
import type { PlannedAction } from '../../../../content-gen/plan-actions.js';

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
	: { skip: `Ollama not reachable at ${LOCAL_HOST}; live integration test skipped` };

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const REPO = '/repo/aqs-live-test';
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

	const graphDir = mkdtempSync(join(tmpdir(), 'insrc-aqs-live-'));
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
		indexedAt: '2026-06-02T00:00:00.000Z',
	};
}

function fakeSession(): Session {
	const stub: Record<string, unknown> = {
		id: 'aqs-live-test', repoPath: REPO, closureRepos: [REPO], startedAt: Date.now(),
		skillAudit:  new DefaultSkillAuditLog(),
		access:      new DefaultAccessStore(),
		accessAudit: new DefaultAccessAuditLog(),
	};
	return stub as unknown as Session;
}

function fakeAction(): PlannedAction {
	// Shape matches what the planner emits per `PlannedAction` --
	// title + objective + maxBudgetTokens + reviewCriteria.
	return {
		id:              'widget-file-surface',
		title:           'Widget.ts File Surface',
		objective:       `Enumerate the entities declared in ${FILE} and summarize the imports.`,
		maxBudgetTokens: 1500,
		reviewCriteria:  [
			'Identify every function defined in Widget.ts',
			'Note whether the file has any imports',
		],
	};
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test('LIVE: runAnswerQuestionSection produces a grounded section for a fixture file', skipIfNoOllama ?? { timeout: 300_000 }, async () => {
	const fx = await setupFixture();
	try {
		// Fixture: one file + one function, with the DEFINES edge so
		// `code.source.file.describe` finds the function via the graph
		// walk. (Without the DEFINES edge, file.describe returns 0
		// entities and the L2 draft has nothing to ground against.)
		const fileEnt = ent({ kind: 'file', name: FILE, file: FILE });
		const funcEnt = ent({
			kind: 'function', name: 'render', file: FILE,
			body: 'function render(x: number) { if (x > 0) return x; return -x; }',
		});
		await upsertEntities(null, [fileEnt, funcEnt]);
		await upsertRelations(null, [
			{ kind: 'DEFINES', from: fileEnt.id, to: funcEnt.id, resolved: true },
		]);

		const provider: LLMProvider = new OllamaProvider(LOCAL_MODEL, LOCAL_HOST);

		const result = await runAnswerQuestionSection({
			localProvider: provider,
			cloudProvider: provider,
			session:       fakeSession(),
			action:        fakeAction(),
			request:       'Analyze the Widget file in detail.',
			tier:          'XL',                                  // exercises the scopeTier=XL branch
			repoPath:      REPO,
			analyzerLabel: 'code-analyzer',
		});

		// 1. Adapter returned a result (no throw).
		assert.ok(result, 'adapter returned undefined');

		// 2. Sub-skill dispatch happened at least once. A zero here means
		//    classify or select-scope short-circuited -- the exact
		//    failure mode of the scopeTier-leak regression.
		assert.ok(result.dispatched.length >= 1,
			`expected at least one L1 sub-skill dispatched; got ${result.dispatched.length}. ` +
			'A zero count means classify-question / select-scope returned ' +
			'empty -- usually a sub-skill input-schema mismatch or precondition gate.');

		// 3. The section count + confidence floor.
		assert.ok(result.sectionCount >= 1,
			`expected at least one grounded section; got ${result.sectionCount}`);
		assert.ok(
			result.confidence === 'high' || result.confidence === 'medium',
			`expected confidence high|medium; got ${result.confidence}`,
		);

		// 4. Stitched markdown is non-trivial.
		assert.ok(result.markdown.length > 50,
			`stitched markdown is suspiciously short (${result.markdown.length} chars): ${result.markdown.slice(0, 200)}`);

		// 5. Markdown should NOT be the fallback "no grounded findings"
		//    stub from the adapter. That stub fires when sections=[] --
		//    again, a regression signal.
		assert.doesNotMatch(result.markdown, /^\*No grounded findings for/,
			'adapter emitted the no-grounded-findings fallback -- the pipeline did not produce a section');

		// 6. Property-based: at least one sub-section heading or body
		//    should mention "Widget" (or the function name "render").
		assert.match(result.markdown, /Widget|render/i,
			`expected markdown to mention Widget or render; got: ${result.markdown.slice(0, 200)}`);

		// 7. P11 regression guard: no padding "Repository Context" /
		//    "Codebase Scale" / "Repository Scope" / "Repository Overview"
		//    sub-section. Pre-P11 runs filled the last slot with a
		//    repo-summary recap pulled from the in-prompt repo.describe
		//    ledger entry, producing noisy duplication across every
		//    section. The compact rendering + explicit prompt rule should
		//    keep this stub out of the per-section drafts.
		assert.doesNotMatch(result.markdown,
			/^#{2,4}\s+(Repository\s+(Context|Scope|Overview)|Codebase\s+Scale|Repo(sitory)?\s+Summary)\b/im,
			`P11 regression: stitched markdown contains a padding repo-summary sub-section. ` +
			`First 400 chars: ${result.markdown.slice(0, 400)}`);

		// 8. P11 regression guard: no repo-wide misattribution. The pre-P11
		//    draft prompt let the LLM lift the 4-5 digit repo totals
		//    ("126,327 methods" / "12,848 files") from the in-prompt
		//    repo.describe entry and re-state them as if they were
		//    scoped to a module / package / subsystem. The new compact
		//    rendering + scope-discipline rules should suppress that.
		assert.doesNotMatch(result.markdown,
			/\b\d{4,}\s+(files|entities|methods|classes|interfaces|variables|functions)\s+(across|in|within)\s+(the\s+)?(entire\s+)?(\w[\w-]*\s+){0,3}(package|subsystem|module|layer|component|namespace)\b/i,
			`P11 regression: stitched markdown reframes a repo-wide total as a section-scoped count. ` +
			`First 400 chars: ${result.markdown.slice(0, 400)}`);
	} finally { await fx.dispose(); }
});
