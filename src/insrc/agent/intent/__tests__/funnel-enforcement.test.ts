/**
 * Phase 7 / 9 enforcement: classifyPrimaryIntent is internal to
 * `agent/intent/resolver.ts`. The grep-based assert below pins
 * the rule so a future PR can't quietly add a second caller.
 *
 * Allow-list:
 *   - agent/intent/resolver.ts          -- the canonical funnel
 *   - agent/classify/intent.ts          -- the implementation
 *   - any file under a `__tests__`      -- tests exercise the
 *     directory                            implementation directly
 *
 * Any other production file under src/insrc that imports
 * `classifyPrimaryIntent` fails this test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT = join(__dirname, '..', '..', '..');   // -> src/insrc
const FORBIDDEN_PATTERN = /\bclassifyPrimaryIntent\b/;

const ALLOWLIST: ReadonlySet<string> = new Set([
	'agent/intent/resolver.ts',
	'agent/classify/intent.ts',
]);

function isAllowed(relPath: string): boolean {
	if (ALLOWLIST.has(relPath)) return true;
	if (relPath.includes('__tests__/'))   return true;
	if (relPath.includes('node_modules/')) return true;
	return false;
}

function* walk(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const st   = statSync(full);
		if (st.isDirectory()) {
			if (entry === 'node_modules' || entry === 'dist') continue;
			yield* walk(full);
		} else if (entry.endsWith('.ts')) {
			yield full;
		}
	}
}

test('funnel rule: classifyPrimaryIntent has only its canonical caller (resolver) outside tests', () => {
	const violations: string[] = [];
	for (const path of walk(ROOT)) {
		const rel = relative(ROOT, path).replace(/\\/g, '/');
		if (isAllowed(rel)) continue;
		const body = readFileSync(path, 'utf8');
		// Strip line + block comments so a comment mentioning the
		// function's name (which we want to allow for documentation
		// purposes) doesn't trip the grep.
		const stripped = body
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/\/\/.*$/gm, '');
		if (FORBIDDEN_PATTERN.test(stripped)) {
			violations.push(rel);
		}
	}
	assert.deepEqual(
		violations,
		[],
		`classifyPrimaryIntent must only be called via resolveIntent.\nNew callers detected:\n  ${violations.join('\n  ')}\n\nUse \`resolveIntent\` from \`agent/intent/resolver.ts\` instead.`,
	);
});

test('funnel rule: no production module other than the resolver writes [intent:current]', () => {
	// Resolver writes via `ctx.setTag(INTENT_TAG_CURRENT, ...)`;
	// every other production write would drift. The Phase 6 audit
	// found exactly two strays (chat-handler runCodeAnalyzerSlash
	// and code-analyzer-orchestrator.buildInitialTasks); both are
	// now gone. Pin them gone here so they can't come back.
	const PATTERN = /setTag\(\s*INTENT_TAG_CURRENT\b/;
	const violations: string[] = [];
	for (const path of walk(ROOT)) {
		const rel = relative(ROOT, path).replace(/\\/g, '/');
		if (rel.includes('__tests__/'))                  continue;
		if (rel === 'agent/intent/resolver.ts')          continue;
		const body = readFileSync(path, 'utf8');
		const stripped = body
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/\/\/.*$/gm, '');
		if (PATTERN.test(stripped)) violations.push(rel);
	}
	assert.deepEqual(violations, [],
		`[intent:current] is written EXCLUSIVELY by resolver.ts. Strays:\n  ${violations.join('\n  ')}`,
	);
});
