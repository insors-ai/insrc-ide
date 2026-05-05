/**
 * Phase 0.4 spike runner. Executes all 7 substrate-validation tests
 * sequentially and reports pass/fail.
 *
 * Tests are run as separate processes (via tsx --test isn't applicable
 * here -- these are scripts not unit tests). Each test reports its
 * own pass/fail; the runner aggregates exit codes.
 *
 * Usage:
 *   npx tsx scripts/storage-spike/run-all.ts
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TESTS = [
	'01-lmdb-bulk-write.ts',
	'02-lmdb-random-read.ts',
	'03-lmdb-closure.ts',
	'04-lance-bulk-write.ts',
	'05-lance-ann.ts',
	'06-lance-rebuild.ts',
	'07-hadoop-realistic.ts',
];

interface RunResult {
	test: string;
	pass: boolean;
	exitCode: number;
	wallMs: number;
}

function run(test: string): RunResult {
	const t0 = Date.now();
	const result = spawnSync('npx', ['tsx', join(__dirname, test)], {
		stdio: 'inherit',
		cwd: join(__dirname, '..', '..'),
	});
	return {
		test,
		pass:     result.status === 0,
		exitCode: result.status ?? -1,
		wallMs:   Date.now() - t0,
	};
}

function main(): void {
	console.log('=== Phase 0.4 substrate scale-validation spike ===\n');
	const results: RunResult[] = [];
	for (const t of TESTS) {
		console.log(`\n--- running ${t} ---`);
		const r = run(t);
		results.push(r);
		if (!r.pass) {
			console.error(`\n!!! ${t} FAILED (exit ${r.exitCode}) -- halting suite per HARD GATE policy`);
			break;
		}
	}

	console.log('\n=== summary ===');
	let totalMs = 0;
	for (const r of results) {
		const status = r.pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
		console.log(`  [${status}] ${r.test}  (${(r.wallMs / 1000).toFixed(1)}s)`);
		totalMs += r.wallMs;
	}
	const allPass = results.length === TESTS.length && results.every(r => r.pass);
	console.log(`\nTotal wall time: ${(totalMs / 1000).toFixed(1)}s`);
	console.log(`Gate result: ${allPass ? '\x1b[32mPASS\x1b[0m -- substrate validated for migration' : '\x1b[31mFAIL\x1b[0m -- migration BLOCKED per design doc Phase 0.4'}`);

	process.exit(allPass ? 0 : 1);
}

main();
