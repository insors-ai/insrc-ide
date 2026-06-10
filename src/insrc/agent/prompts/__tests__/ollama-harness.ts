/**
 * Real-Ollama integration test harness (Phase 0 of
 * `plans/section-flow-architecture-redesign.md`).
 *
 * Mocked unit tests verify code paths; they CAN'T detect prompt
 * issues that only manifest when a real LLM reads the rendered
 * prompt. The redesign's correctness story depends on
 * goal-aware summaries, build-context fetch decisions, decide-next-
 * step termination judgments, etc. -- none of which a scripted
 * response can validate.
 *
 * Integration tests use this harness to:
 *
 *   1. Gate execution on a probe to `localhost:11434` confirming the
 *      target model is loaded (otherwise SKIP, no false failures).
 *   2. Drive real Ollama with `temperature: 0` + fixed seed so the
 *      same prompt yields the same tokens across runs.
 *   3. Assert STRUCTURAL properties of the output (valid JSON shape,
 *      valid artifact ids referenced, action discriminator in enum,
 *      closure markers in fixed vocabulary). NOT exact strings.
 *
 * Opt-in: tests guard via `process.env.INSRC_TEST_OLLAMA === '1'`
 * AND the presence probe. The `npm run test:ollama` script (added
 * to package.json) sets the env var and runs only files matching
 * `*.ollama.test.ts`.
 */

import type { LLMMessage, LLMResponse, LLMProvider, CompletionOpts } from '../../../shared/types.js';
import { OllamaProvider } from '../../providers/ollama.js';

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

export const OLLAMA_TEST_MODEL = process.env['INSRC_TEST_OLLAMA_MODEL'] ?? 'qwen3.6:35b-a3b';
export const OLLAMA_TEST_HOST  = process.env['INSRC_TEST_OLLAMA_HOST']  ?? 'http://localhost:11434';

interface OllamaGateResult {
	readonly ok:     boolean;
	readonly reason: string;
}

let _cachedGate: OllamaGateResult | undefined;

/**
 * Returns `{ ok: true }` when integration tests should run. Caches
 * the probe result so a test file with N integration tests pays the
 * probe cost ONCE.
 *
 * Three failure modes (all map to `ok: false` with a reason string):
 *   - INSRC_TEST_OLLAMA is not '1' -> opt-in not enabled.
 *   - HTTP probe to Ollama fails -> daemon not running / wrong host.
 *   - The configured model is not in /api/tags -> model not pulled.
 */
export async function checkOllamaGate(): Promise<OllamaGateResult> {
	if (_cachedGate !== undefined) { return _cachedGate; }
	if (process.env['INSRC_TEST_OLLAMA'] !== '1') {
		_cachedGate = { ok: false, reason: 'INSRC_TEST_OLLAMA not set; skipping' };
		return _cachedGate;
	}
	try {
		const res = await fetch(`${OLLAMA_TEST_HOST}/api/tags`, { signal: AbortSignal.timeout(2000) });
		if (!res.ok) {
			_cachedGate = { ok: false, reason: `Ollama /api/tags returned ${res.status}` };
			return _cachedGate;
		}
		const body = await res.json() as { models?: Array<{ name?: string }> };
		const names = (body.models ?? []).map(m => m.name ?? '');
		const hasModel = names.some(n => n.startsWith(OLLAMA_TEST_MODEL));
		if (!hasModel) {
			_cachedGate = { ok: false, reason: `model "${OLLAMA_TEST_MODEL}" not available (have: ${names.join(', ') || '(none)'})` };
			return _cachedGate;
		}
		_cachedGate = { ok: true, reason: 'Ollama reachable + model present' };
		return _cachedGate;
	} catch (err) {
		_cachedGate = { ok: false, reason: `Ollama probe failed: ${(err as Error).message}` };
		return _cachedGate;
	}
}

/**
 * Returns a wrapper for node:test's `test()` that automatically skips
 * when the Ollama gate is closed. Pattern:
 *
 *   import { test } from 'node:test';
 *   import { ollamaTest } from '../prompts/__tests__/ollama-harness.js';
 *
 *   ollamaTest(test, 'decide-next-step terminates when TOC fully covered', async () => {
 *     const provider = buildOllamaTestProvider();
 *     const writer = getPromptRegistry().get('decide-next-step');
 *     const messages = writer.build({ ... });
 *     const response = await provider.complete(messages, { temperature: 0 });
 *     // STRUCTURAL assertions only:
 *     const parsed = JSON.parse(response.text);
 *     assert.equal(parsed.action, 'terminate');
 *     assert.equal(parsed.verdict, 'covered');
 *   });
 *
 * The wrapped test reports as `skip` when the gate is closed, so CI
 * stays green without Ollama; nightly + on-demand runs activate it.
 */
export function ollamaTest(
	testFn: (name: string, opts: { skip?: string | boolean }, fn: () => Promise<void> | void) => void,
	name:   string,
	body:   () => Promise<void> | void,
): void {
	void (async () => {
		const gate = await checkOllamaGate();
		if (gate.ok) {
			testFn(name, {}, body);
		} else {
			testFn(name, { skip: gate.reason }, body);
		}
	})();
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Build a real OllamaProvider pinned to the test model + host. Reuses
 * the production provider so retry / numCtx / think:false behaviour
 * matches what the daemon actually does.
 *
 * `temperature: 0` is the default; callers shouldn't override unless
 * they're explicitly testing non-determinism. Pass `disableThinking:
 * true` per the standard local-tier production setting.
 */
export function buildOllamaTestProvider(): LLMProvider {
	return new OllamaProvider({
		host:  OLLAMA_TEST_HOST,
		model: OLLAMA_TEST_MODEL,
	});
}

// ---------------------------------------------------------------------------
// Structural assertion helpers
// ---------------------------------------------------------------------------

/**
 * Parse the response text as JSON, stripping ```json fences if
 * present. Returns the parsed object or throws with a useful message
 * for integration-test failures.
 */
export function parseJsonResponse(response: LLMResponse): unknown {
	let text = response.text.trim();
	if (text.startsWith('```')) {
		text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
	}
	try {
		return JSON.parse(text);
	} catch (err) {
		throw new Error(`response is not valid JSON: ${(err as Error).message}; preview: ${response.text.slice(0, 200)}`);
	}
}

/**
 * Assert the parsed object's top-level keys exactly match the
 * expected set. Catches "extra keys" hallucinations as well as
 * missing keys.
 */
export function assertKeysExactly(obj: unknown, expected: readonly string[]): void {
	if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
		throw new Error(`expected object, got ${Array.isArray(obj) ? 'array' : typeof obj}`);
	}
	const got = Object.keys(obj as Record<string, unknown>).sort();
	const want = [...expected].sort();
	const gotStr  = got.join(',');
	const wantStr = want.join(',');
	if (gotStr !== wantStr) {
		throw new Error(`key mismatch: got [${gotStr}], expected [${wantStr}]`);
	}
}

/** Silence unused-param warnings while keeping the type imports live. */
void ({} as CompletionOpts);
void ({} as LLMMessage);
