/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 0 of plans/skill-closure-scoping.md -- audit what's actually
 * inside each registered repo's transitive DEPENDS_ON closure.
 *
 * Motivation: the live `insors-extraction` run leaked citations from
 * `insors/hadoop` even though they're disconnected codebases. Before
 * we add closure-scoping to the entity-lookup skills, confirm the
 * closure that resolveClosure returns today is correct -- if hadoop
 * already appears in extraction's closure, we have a separate
 * indexer/manifest bug to track.
 *
 *   npx tsx scripts/audit-repo-closure.ts
 *
 * Read-only IPC; daemon must be running.
 */

import { rpc } from '../src/insrc/cli/client.js';
import type { RegisteredRepo } from '../src/insrc/shared/types.js';

async function main(): Promise<void> {
	const repos = await rpc<RegisteredRepo[]>('repo.list');

	console.log(`--- Registered workspace repos (${repos.length}) ---`);
	if (repos.length === 0) {
		console.log('  (none)');
		console.log();
		console.log('Nothing to audit -- add a repo via `insrc repo add` first.');
		process.exit(0);
	}
	for (const r of repos) {
		console.log(`  ${r.path}`);
		console.log(`    name=${r.name} status=${r.status} indexed=${r.lastIndexed ?? '(never)'}`);
	}
	console.log();

	// Pre-scan: classify the registered repos by family root so we can
	// flag suspicious cross-family inclusions later. Anything sharing a
	// /Users/.../<family>/<...> ancestor counts as "same family".
	type Family = { root: string; repos: string[] };
	const families: Family[] = [];
	for (const r of repos) {
		const parts = r.path.split('/');
		// Take the first 6 components of the path as the family root
		// (e.g. /Users/subhagho/work/projects/insors). Empirically the
		// workspace tree is /Users/<user>/work/projects/<family>/<repo>.
		const familyRoot = parts.slice(0, 6).join('/');
		let f = families.find(x => x.root === familyRoot);
		if (f === undefined) {
			f = { root: familyRoot, repos: [] };
			families.push(f);
		}
		f.repos.push(r.path);
	}

	let suspiciousInclusions = 0;
	let totalClosureSize     = 0;

	for (const r of repos) {
		console.log(`--- Closure of: ${r.path} ---`);
		let closure: string[];
		try {
			closure = await rpc<string[]>('search.closure', { repoPath: r.path });
		} catch (e) {
			console.log(`  ERROR: ${(e as Error).message}`);
			console.log();
			continue;
		}

		totalClosureSize += closure.length;
		console.log(`  closure size: ${closure.length}`);
		for (const p of closure) {
			const inFamily = p.startsWith(
				families.find(f => f.repos.includes(r.path))?.root ?? '',
			);
			const marker = p === r.path
				? '  *'      // self
				: inFamily
					? '   '   // same family, OK
					: '  !';  // CROSS-FAMILY, suspicious
			console.log(`${marker} ${p}`);
			if (marker === '  !') {
				suspiciousInclusions++;
			}
		}
		console.log();
	}

	// Spot-check: does extraction's closure include hadoop?
	const extraction = repos.find(r => r.path.includes('insors-extraction'));
	const hadoop     = repos.find(r => r.path.includes('hadoop'));
	if (extraction !== undefined && hadoop !== undefined) {
		console.log('--- Spot check: extraction <-> hadoop ---');
		const extClosure = await rpc<string[]>('search.closure', { repoPath: extraction.path });
		const hadClosure = await rpc<string[]>('search.closure', { repoPath: hadoop.path });
		const extHasHadoop = extClosure.includes(hadoop.path);
		const hadHasExt    = hadClosure.includes(extraction.path);
		console.log(`  extraction.closure includes hadoop?  ${extHasHadoop ? 'YES (BUG)' : 'no'}`);
		console.log(`  hadoop.closure     includes extraction? ${hadHasExt    ? 'YES (BUG)' : 'no'}`);
		console.log();
	}

	console.log('--- Summary ---');
	console.log(`  total registered repos:    ${repos.length}`);
	console.log(`  total closure sum:         ${totalClosureSize}`);
	console.log(`  cross-family inclusions:   ${suspiciousInclusions}`);
	console.log();
	console.log('Legend: "*" = self, " " = same family (expected), "!" = cross-family (audit).');
	if (suspiciousInclusions === 0) {
		console.log('Result: closure is family-clean. Skill-side closure-scoping will correctly');
		console.log('        exclude disconnected repos like hadoop with no indexer changes.');
	} else {
		console.log(`Result: ${suspiciousInclusions} cross-family inclusions detected. Investigate the`);
		console.log('        DEPENDS_ON edges that link these repos -- likely a manifest parser bug.');
	}

	process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
