/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared scaffolding for the section-flow live-Ollama test scripts.
 *
 * Each script under `scripts/live-section-flow/` exercises ONE LLM
 * call site in the section-flow / working-memory / content-gen
 * pipelines against a real local Ollama model and asserts:
 *
 *   - schema-level contract (the existing validator passes), and
 *   - sanity-level content (non-empty, references the seed terms,
 *     no refusal patterns).
 *
 * The bar is "ollama responses should not be completely off the
 * picture" -- not parity with cloud. A degraded-but-passing run is
 * recorded as such (not a hard failure) so we can compare drift
 * across model upgrades.
 *
 * Run via: `source ~/.insors && npx tsx scripts/live-section-flow/<N>.ts`
 *
 * Common CLI args (all scripts support them via `parseArgs`):
 *   --model=<id>     override the model (default: qwen3.6 from config)
 *   --host=<url>     override Ollama host (default: from config)
 *   --trials=N       repeat the LLM call N times for stability (default 1)
 *   --out=<path>     dump full responses to a file for inspection
 *   --verbose        print full prompts + responses
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { OllamaProvider } from '../../src/insrc/agent/providers/ollama.js';
import { loadConfig } from '../../src/insrc/agent/config.js';
import type { LLMProvider } from '../../src/insrc/shared/types.js';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

export interface LiveTestArgs {
	readonly model:   string;
	readonly host:    string;
	readonly trials:  number;
	readonly out?:    string | undefined;
	readonly verbose: boolean;
	/** Any positional or unknown flags the script may want. */
	readonly extras:  Readonly<Record<string, string>>;
}

const DEFAULT_QWEN36_MODEL = 'qwen3.6:35b-a3b';

export function parseArgs(argv: readonly string[]): LiveTestArgs {
	const cfg = loadConfig();
	const local = cfg.models.providers.local;
	// Config-declared qwen3.6 may be a tag that isn't actually pulled
	// locally (e.g. `qwen3.6:35b-a3b-coding-nvfp4` in config vs
	// `qwen3.6:35b-a3b` actually pulled). The script default favours
	// the simpler tag; the user can override with --model.
	let model   = DEFAULT_QWEN36_MODEL;
	let host    = local.host;
	let trials  = 1;
	let out: string | undefined;
	let verbose = false;
	const extras: Record<string, string> = {};

	for (const arg of argv.slice(2)) {
		if (arg.startsWith('--model=')) { model = arg.slice(8); continue; }
		if (arg.startsWith('--host='))  { host  = arg.slice(7); continue; }
		if (arg.startsWith('--trials=')) { trials = Math.max(1, Number(arg.slice(9))); continue; }
		if (arg.startsWith('--out='))   { out   = arg.slice(6); continue; }
		if (arg === '--verbose')        { verbose = true; continue; }
		if (arg.startsWith('--')) {
			const eq = arg.indexOf('=');
			if (eq > 0) { extras[arg.slice(2, eq)] = arg.slice(eq + 1); }
			else        { extras[arg.slice(2)]     = 'true'; }
			continue;
		}
	}

	return { model, host, trials, ...(out !== undefined ? { out } : {}), verbose, extras };
}

// ---------------------------------------------------------------------------
// Provider construction
// ---------------------------------------------------------------------------

export function buildOllama(args: LiveTestArgs): LLMProvider {
	const numCtx = readNumCtx(args.model) ?? 16_384;
	return new OllamaProvider(args.model, args.host, numCtx);
}

function readNumCtx(model: string): number | undefined {
	try {
		const cfg = loadConfig();
		const params = cfg.models.providers.local.params?.[model];
		return params?.maxInputTokens;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Result reporting
// ---------------------------------------------------------------------------

export type TrialOutcome = 'pass' | 'pass-degraded' | 'fail';

export interface TrialResult {
	readonly outcome:  TrialOutcome;
	readonly summary:  string;
	readonly raw?:     string | undefined;
	readonly details?: Readonly<Record<string, unknown>> | undefined;
	readonly durationMs: number;
}

export interface TestSuiteResult {
	readonly name:    string;
	readonly model:   string;
	readonly trials:  readonly TrialResult[];
}

export function printHeader(name: string, args: LiveTestArgs): void {
	const sep = '='.repeat(72);
	console.log(sep);
	console.log(`LIVE TEST: ${name}`);
	console.log(`  model:  ${args.model}`);
	console.log(`  host:   ${args.host}`);
	console.log(`  trials: ${args.trials}`);
	console.log(sep);
}

export function printTrial(trialIdx: number, total: number, result: TrialResult): void {
	const icon = result.outcome === 'pass' ? 'PASS' : result.outcome === 'pass-degraded' ? 'WARN' : 'FAIL';
	const tag  = `[${icon}]`;
	console.log(`${tag} trial ${trialIdx + 1}/${total}  ${result.durationMs}ms  ${result.summary}`);
	if (result.details !== undefined) {
		for (const [k, v] of Object.entries(result.details)) {
			console.log(`         ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
		}
	}
}

export function printSummary(suite: TestSuiteResult): number {
	const passed   = suite.trials.filter(t => t.outcome === 'pass').length;
	const degraded = suite.trials.filter(t => t.outcome === 'pass-degraded').length;
	const failed   = suite.trials.filter(t => t.outcome === 'fail').length;
	const total    = suite.trials.length;
	const sep = '-'.repeat(72);
	console.log(sep);
	console.log(`${suite.name}: ${passed} pass, ${degraded} pass-degraded, ${failed} fail (of ${total})`);
	console.log(sep);
	return failed > 0 ? 1 : 0;
}

export function dumpOut(args: LiveTestArgs, suite: TestSuiteResult): void {
	if (args.out === undefined) { return; }
	const abs = resolve(process.cwd(), args.out);
	const dir = dirname(abs);
	if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); }
	writeFileSync(abs, JSON.stringify(suite, null, 2));
	console.log(`(raw output written to ${abs})`);
}

// ---------------------------------------------------------------------------
// Trial runner
// ---------------------------------------------------------------------------

export interface RunTrialsInput {
	readonly name:   string;
	readonly args:   LiveTestArgs;
	readonly trial:  (idx: number) => Promise<TrialResult>;
}

export async function runTrials(input: RunTrialsInput): Promise<number> {
	printHeader(input.name, input.args);
	const trials: TrialResult[] = [];
	for (let i = 0; i < input.args.trials; i++) {
		const result = await input.trial(i);
		trials.push(result);
		printTrial(i, input.args.trials, result);
	}
	const suite: TestSuiteResult = { name: input.name, model: input.args.model, trials };
	dumpOut(input.args, suite);
	return printSummary(suite);
}

// ---------------------------------------------------------------------------
// Sanity assertions
// ---------------------------------------------------------------------------

/** Returns null on pass, message on failure. */
export function checkNonEmpty(text: string, label: string): string | null {
	const trimmed = (text ?? '').trim();
	if (trimmed.length === 0) { return `${label}: empty`; }
	return null;
}

/** Returns null on pass, message on failure. */
export function checkContainsAny(text: string, seedTerms: readonly string[], label: string): string | null {
	const lower = text.toLowerCase();
	const hit = seedTerms.some(t => lower.includes(t.toLowerCase()));
	if (!hit) { return `${label}: response does not mention any of [${seedTerms.join(', ')}]`; }
	return null;
}

/**
 * Common refusal / non-answer patterns from local models. Catches the
 * "I can't help with that" / "Sorry, as an AI ..." class. Returns null
 * on pass, message on failure.
 */
export function checkNotRefusal(text: string, label: string): string | null {
	const lower = text.toLowerCase();
	const refusalPatterns = [
		'i cannot',
		'i can\'t help',
		'i am unable',
		'as an ai',
		'i\'m sorry, but',
		'sorry, but i',
	];
	for (const p of refusalPatterns) {
		if (lower.includes(p)) { return `${label}: looks like a refusal ("${p}" appeared in output)`; }
	}
	return null;
}

/**
 * Combine multiple checker results into a single message + outcome.
 * - All null -> pass
 * - Some non-null, content otherwise present -> pass-degraded
 * - Hard schema failure (passed via `schemaError`) -> fail
 */
export function combineChecks(checks: readonly (string | null)[], schemaError?: string | undefined): {
	outcome: TrialOutcome;
	summary: string;
} {
	if (schemaError !== undefined) {
		return { outcome: 'fail', summary: schemaError };
	}
	const issues = checks.filter((c): c is string => c !== null);
	if (issues.length === 0) {
		return { outcome: 'pass', summary: 'schema + sanity OK' };
	}
	return { outcome: 'pass-degraded', summary: issues.join('; ') };
}
