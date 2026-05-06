/**
 * CLI entry point for the LMDB + Lance benchmark suite.
 *
 * Phase 7.3 of plans/storage-migration-lmdb-lance.md.
 *
 * Usage:
 *   npm run bench:smoke              -- 100k edges + 50k vectors, ~30 s,
 *                                       run on every PR; fails on >30%
 *                                       p99-latency or file-size
 *                                       regression vs baselines/smoke.json.
 *   npm run bench:full               -- 1M+ edges + 1M vectors, multi-min,
 *                                       manual / nightly only.
 *   npm run bench:smoke -- --update-baselines
 *                                    -- record current run as the new
 *                                       baseline. Manual decision.
 *
 * Exit codes:
 *   0   pass (no regression vs baseline, or baseline absent on first
 *       run)
 *   1   regression detected
 *   2   harness error (substrate failed to open, etc.)
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import {
	Bench,
	loadBaseline,
	saveBaseline,
	diffAgainstBaseline,
	renderRunResult,
	renderDiff,
	type Tier,
} from './harness.js';
import { benchGraph } from './ops/graph.js';
import { benchVectors } from './ops/vectors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

function baselinePath(tier: Tier): string {
	return join(__dirname, 'baselines', `${tier}.json`);
}

async function main(): Promise<number> {
	const args = process.argv.slice(2);

	const tier: Tier = args.includes('--full') ? 'full' : 'smoke';
	const update      = args.includes('--update-baselines');

	console.log(`# Running ${tier} bench...`);
	const bench = new Bench(tier);
	try {
		await benchGraph(bench, tier);
		await benchVectors(bench, tier);
	} catch (err) {
		console.error(`Bench harness failed: ${err instanceof Error ? err.stack : err}`);
		return 2;
	}

	const result = bench.finalize();
	console.log('\n' + renderRunResult(result));

	const path = baselinePath(tier);
	if (update) {
		saveBaseline(path, result);
		console.log(`\n# Baselines updated at ${path}`);
		return 0;
	}

	const baseline = loadBaseline(path);
	if (baseline === null) {
		console.log(`\n# No baseline at ${path}.`);
		console.log('# Re-run with --update-baselines to record this run as the new baseline.');
		return 0;
	}

	const diff = diffAgainstBaseline(result, baseline);
	console.log('\n' + renderDiff(diff));
	return diff.regressed ? 1 : 0;
}

main().then(code => process.exit(code)).catch(err => {
	console.error(err);
	process.exit(2);
});
