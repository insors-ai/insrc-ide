/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Live-LLM smoke for the /plan meta-task template (M4.a Phase 5).
 *
 * Runs the full 6-step pipeline against a real cloud LLM and verifies
 * the result satisfies the deliverable contract: a markdown plan that
 * round-trips through `fromMarkdown`. Gated by `INSRC_LIVE_LLM=1`
 * because it makes ~5 cloud calls per run and depends on a configured
 * provider in `~/.insrc/config.json`.
 *
 * Plan ref: plans/meta-task-plan.md Phase 5.
 *
 * The test is intentionally tolerant of LLM variance:
 *   - Step count >= 2 (the cloud may emit more or fewer than the
 *     scripted test's 4; we just want a non-degenerate plan).
 *   - No cycle assertions (P4 validate catches them; if the cloud
 *     emits one, the test surfaces the abort rather than failing the
 *     deliverable check).
 *   - Plan title + description are LLM-driven; we only check that
 *     the markdown body parses, not its content.
 *
 * Run with:
 *   source ~/.insors && INSRC_LIVE_LLM=1 npx tsx --test \
 *     meta-task/templates/__tests__/plan-template.live.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runMetaTask } from '../../orchestrator.js';
import { MetaTaskEmitter, type OutboundMessage } from '../../event-emitter.js';
import { PATHS } from '../../../shared/paths.js';
import { buildProvider } from '../../../agent/providers/factory.js';
import { loadConfigWithKeys } from '../../../agent/config.js';
import { fromMarkdown } from '../../../agent/planner/markdown.js';
import type { Plan } from '../plan-types.js';

// Bootstrap the registry so /plan is discoverable.
import '../../templates/index.js';


class FakeTodosApi {
	async createList(_opts: { title: string }):           Promise<{ id: string }> { return { id: 'l1' }; }
	async addItem(_listId: string, _opts: { title: string }): Promise<{ id: string }> { return { id: 'i1' }; }
	async markInProgress(_id: string): Promise<unknown> { return {}; }
	async markComplete(_id: string):   Promise<unknown> { return {}; }
	async markBlocked(_id: string, _reason: string): Promise<unknown> { return {}; }
	async updateListBody(_id: string, _body: string): Promise<unknown> { return {}; }
}

function setupEnv(): { home: string; restore: () => void } {
	const home = mkdtempSync(join(tmpdir(), 'mt-plan-live-'));
	const restoreHome = process.env.HOME;
	process.env.HOME = home;
	const originalMeta = PATHS.meta;
	(PATHS as { meta: string }).meta = join(home, '.insrc', 'meta');
	return {
		home,
		restore: () => {
			(PATHS as { meta: string }).meta = originalMeta;
			if (restoreHome !== undefined) { process.env.HOME = restoreHome; }
			try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
		},
	};
}


test('M4.a Phase 5: /plan live-LLM end-to-end + fromMarkdown round-trip',
	{ timeout: 300_000 },                                     // 5 minutes for a full 6-step cloud run
	async (t) => {
		if (process.env['INSRC_LIVE_LLM'] !== '1') {
			t.skip('INSRC_LIVE_LLM unset; skipping live cloud-LLM smoke');
			return;
		}

		// Use the daemon's existing config to resolve the active provider.
		// If none is configured we skip rather than fail -- the live test
		// requires a real workspace setup.
		const cfg = await loadConfigWithKeys();
		if (!existsSync(PATHS.config) || cfg.models.activeProvider === null) {
			t.skip('no active cloud provider configured; skipping live smoke');
			return;
		}

		const active = cfg.models.activeProvider;
		const providerCfg = cfg.models.providers[active];
		if (providerCfg.default === null) {
			t.skip(`active provider '${active}' has no default model configured; skipping`);
			return;
		}

		const apiKey = cfg.keys[active];
		if (apiKey === undefined || apiKey.length === 0) {
			t.skip(`API key for '${active}' missing from keychain; skipping`);
			return;
		}

		const cloud = buildProvider(
			{ provider: active, model: providerCfg.default },
			cfg,
		);

		const env = setupEnv();
		try {
			const events: OutboundMessage[] = [];
			const todos = new FakeTodosApi();
			const emit  = new MetaTaskEmitter({
				send: m => events.push(m),
				todos: todos as unknown as MetaTaskEmitter['todos'],
			});

			const result = await runMetaTask({
				templateId: 'plan',
				intent:     'implement a token-bucket rate limiter for /v1/sessions: 60s window, default 100 req/min, burst of 20',
				scope: {
					intent:          'token-bucket rate limiter',
					repoPath:        env.home,
					inScopeGlobs:    ['**'],
					outOfScopePaths: [],
				},
				sessionId: 'sess-plan-live',
				emit, cloud,
				embed:    async () => [],
				allocId:  () => 'mt-plan-live',
			});

			// The cloud LLM MAY emit a plan with a dependency cycle the
			// validator catches; that's a valid outcome (P4 aborts
			// plan-revisable). Treat it as a soft skip with a log.
			if (result.outcome === 'aborted') {
				t.diagnostic(`live cloud produced an aborted plan: ${result.abortReason}`);
				assert.match(result.abortReason ?? '', /plan-revisable|user-required/);
				return;
			}

			assert.equal(result.outcome, 'completed', 'live plan should complete end-to-end');
			assert.equal(result.deliverables.size, 6, 'all 6 step deliverables present');

			const synth = result.deliverables.get(6)!;
			assert.ok(synth.length > 0, 'synthesis body non-empty');
			assert.match(synth, /^---/m, 'YAML frontmatter present');

			// Round-trip the synthesis body through fromMarkdown. The
			// design's load-bearing claim: this MUST work for every plan
			// the template emits.
			const reconstructed = fromMarkdown<unknown>(synth) as Plan;
			assert.ok(reconstructed.steps.length >= 2,
				`expected >= 2 steps in reconstructed plan, got ${reconstructed.steps.length}`);
			for (const s of reconstructed.steps) {
				assert.ok(s.id.length > 0, `step id non-empty`);
				assert.ok(s.title.length > 0, `step title non-empty`);
			}

			// Sanity logging for human review when the test passes.
			t.diagnostic(`live plan: ${reconstructed.steps.length} steps, ${synth.length} bytes`);
			for (let i = 0; i < reconstructed.steps.length; i++) {
				t.diagnostic(`  ${i + 1}. ${reconstructed.steps[i]!.title}`);
			}
		} finally { env.restore(); }
	},
);
