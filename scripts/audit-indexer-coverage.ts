/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 1 of plans/code-analyzer-output-quality-followup.md -- diagnostic
 * audit of indexer coverage. For each registered workspace repo, compare:
 *
 *   - on-disk file universe (matches `git ls-files` per repo, filtered
 *     to file kinds the parser registry handles -- code + artifact +
 *     basename-special)
 *
 *   - indexed file universe (LMDB rows with kind='file' for that repo)
 *
 * Report:
 *
 *   1. ON-DISK-BUT-NO-ROW   -- supposed to be indexed; isn't.
 *   2. INDEXED-BUT-EMPTY    -- LMDB row exists, body.length === 0
 *                              (typical for some artifact kinds like
 *                              Dockerfile/YAML where tree-sitter has
 *                              no grammar, but flag anyway for review).
 *
 * Grouped by extension / basename family. Specific hot-targets called out:
 *
 *   - `mapping_generation_agent.py` (cited as "not indexed" in the
 *     2026-05-25 live run)
 *   - `docker/k3s/**` YAML / shell manifests (cited "validation errors")
 *
 * Read-only IPC-free. Opens LMDB directly via getGraphStore. Daemon
 * can be running; LMDB supports multi-reader.
 *
 *   npx tsx scripts/audit-indexer-coverage.ts
 */

import { execFileSync } from 'node:child_process';
import { existsSync, statSync }                          from 'node:fs';
import { extname, basename, resolve, relative, join }    from 'node:path';

import { listRepos }            from '../src/insrc/db/repos.js';
import { listEntitiesForRepo }  from '../src/insrc/db/entities.js';
import {
	BASENAME_LANGUAGE,
	SKIP_BASENAMES,
	artifactParser,
}                               from '../src/insrc/indexer/parser/artifact.js';
import { pythonParser }         from '../src/insrc/indexer/parser/python.js';
import { typescriptParser }     from '../src/insrc/indexer/parser/typescript.js';
import { javaParser }           from '../src/insrc/indexer/parser/java.js';
import { goParser }             from '../src/insrc/indexer/parser/go.js';
import { scalaParser }          from '../src/insrc/indexer/parser/scala.js';

interface BucketCounts {
	readonly extension: string;
	readonly count:     number;
	readonly examples:  string[];
}

interface RepoAudit {
	readonly repo:                   string;
	readonly filesOnDisk:            number;
	readonly filesInGraph:           number;
	readonly onDiskCoveredByParser:  number;
	readonly onDiskNotIndexed:       BucketCounts[];
	readonly indexedButEmptyBody:    BucketCounts[];
	readonly hotTargets:             { readonly name: string; readonly state: 'on-disk-not-indexed' | 'indexed' | 'not-on-disk' }[];
}

// ---------------------------------------------------------------------------
// Parser-aware extension / basename routing (mirrors registry.ts)
// ---------------------------------------------------------------------------

const codeExtensions: Set<string> = new Set([
	...pythonParser.extensions,
	...typescriptParser.extensions,
	...javaParser.extensions,
	...goParser.extensions,
	...scalaParser.extensions,
]);
const artifactExtensions: Set<string> = new Set(artifactParser.extensions);

function isParserCovered(filePath: string): boolean {
	const name = basename(filePath);
	if (SKIP_BASENAMES.has(name)) {
		return false;
	}
	const ext = extname(filePath).toLowerCase();
	if (codeExtensions.has(ext)) {
		return true;
	}
	if (artifactExtensions.has(ext)) {
		return true;
	}
	if (name in BASENAME_LANGUAGE) {
		return true;
	}
	return false;
}

function familyKey(filePath: string): string {
	const name = basename(filePath);
	if (name in BASENAME_LANGUAGE) {
		return `[basename:${name}]`;
	}
	const ext = extname(filePath).toLowerCase();
	return ext.length > 0 ? ext : '[no-ext]';
}

// ---------------------------------------------------------------------------
// Repo enumeration -- mirrors indexer/index.ts:listRepoFiles
// ---------------------------------------------------------------------------

function listRepoFiles(repoPath: string): string[] {
	if (!existsSync(join(repoPath, '.git'))) {
		return [];
	}
	try {
		const stdout = execFileSync(
			'git',
			['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
			{ cwd: repoPath, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' },
		);
		return stdout.split('\0').filter(Boolean).map(f => resolve(repoPath, f));
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Audit per repo
// ---------------------------------------------------------------------------

const HOT_TARGETS = [
	'mapping_generation_agent.py',
];

const HOT_PATH_PREFIXES = [
	'docker/k3s/',
];

async function auditRepo(repoPath: string): Promise<RepoAudit | null> {
	if (!existsSync(repoPath)) {
		console.log(`  repo missing on disk -- skipping: ${repoPath}`);
		return null;
	}

	const allOnDisk = listRepoFiles(repoPath);
	const coveredOnDisk = allOnDisk.filter(isParserCovered);
	const onDiskSet = new Set(coveredOnDisk);

	const entities = await listEntitiesForRepo(null, repoPath);
	const fileEntities = entities.filter(e => e.kind === 'file');
	const indexedFiles = new Set(fileEntities.map(e => e.file));

	// On-disk but no row.
	const missingByFamily = new Map<string, string[]>();
	for (const f of coveredOnDisk) {
		if (!indexedFiles.has(f)) {
			const key = familyKey(f);
			const arr = missingByFamily.get(key) ?? [];
			arr.push(f);
			missingByFamily.set(key, arr);
		}
	}

	// Indexed but empty body. Worth a look but expected for many
	// artifact kinds (tree-sitter has no grammar for Dockerfile, etc.).
	const emptyByFamily = new Map<string, string[]>();
	for (const e of fileEntities) {
		if (typeof e.body === 'string' && e.body.length === 0 && existsSync(e.file)) {
			const key = familyKey(e.file);
			const arr = emptyByFamily.get(key) ?? [];
			arr.push(e.file);
			emptyByFamily.set(key, arr);
		}
	}

	// Hot targets state.
	const hotTargets: RepoAudit['hotTargets'] = [];
	for (const name of HOT_TARGETS) {
		const matchOnDisk  = coveredOnDisk.find(f => basename(f) === name);
		const matchIndexed = [...indexedFiles].find(f => basename(f) === name);
		if (matchOnDisk === undefined && matchIndexed === undefined) {
			continue;
		}
		hotTargets.push({
			name,
			state: matchOnDisk !== undefined && matchIndexed === undefined
				? 'on-disk-not-indexed'
				: matchIndexed !== undefined
					? 'indexed'
					: 'not-on-disk',
		});
	}
	for (const pfx of HOT_PATH_PREFIXES) {
		const onDiskHits  = coveredOnDisk.filter(f => relative(repoPath, f).startsWith(pfx));
		const indexedHits = [...indexedFiles].filter(f => relative(repoPath, f).startsWith(pfx));
		if (onDiskHits.length === 0 && indexedHits.length === 0) {
			continue;
		}
		const missing = onDiskHits.filter(f => !indexedFiles.has(f));
		hotTargets.push({
			name: `${pfx}** (${onDiskHits.length} on disk, ${indexedHits.length} indexed, ${missing.length} missing)`,
			state: missing.length > 0 ? 'on-disk-not-indexed' : 'indexed',
		});
	}

	const onDiskNotIndexed: BucketCounts[] = [...missingByFamily.entries()]
		.map(([ext, files]) => ({
			extension: ext,
			count:     files.length,
			examples:  files.slice(0, 3).map(f => relative(repoPath, f)),
		}))
		.sort((a, b) => b.count - a.count);

	const indexedButEmptyBody: BucketCounts[] = [...emptyByFamily.entries()]
		.map(([ext, files]) => ({
			extension: ext,
			count:     files.length,
			examples:  files.slice(0, 3).map(f => relative(repoPath, f)),
		}))
		.sort((a, b) => b.count - a.count);

	return {
		repo:                  repoPath,
		filesOnDisk:           allOnDisk.length,
		filesInGraph:          fileEntities.length,
		onDiskCoveredByParser: coveredOnDisk.length,
		onDiskNotIndexed,
		indexedButEmptyBody,
		hotTargets,
	};
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function renderRepo(a: RepoAudit): void {
	console.log(`\n--- ${a.repo} ---`);
	console.log(`  files on disk:            ${a.filesOnDisk}`);
	console.log(`  parser-covered (on disk): ${a.onDiskCoveredByParser}`);
	console.log(`  file entities in graph:   ${a.filesInGraph}`);

	if (a.hotTargets.length > 0) {
		console.log(`\n  --- Hot targets ---`);
		for (const h of a.hotTargets) {
			const marker = h.state === 'on-disk-not-indexed' ? '! ' : '  ';
			console.log(`${marker}${h.name}  [${h.state}]`);
		}
	}

	if (a.onDiskNotIndexed.length > 0) {
		const total = a.onDiskNotIndexed.reduce((s, b) => s + b.count, 0);
		console.log(`\n  --- On-disk-but-no-row (${total} files) ---`);
		for (const b of a.onDiskNotIndexed) {
			console.log(`    ${b.extension.padEnd(20)} ${String(b.count).padStart(5)}   e.g. ${b.examples.join(', ')}`);
		}
	} else {
		console.log(`\n  on-disk-but-no-row: NONE (full coverage)`);
	}

	if (a.indexedButEmptyBody.length > 0) {
		const total = a.indexedButEmptyBody.reduce((s, b) => s + b.count, 0);
		console.log(`\n  --- Indexed-but-empty-body (${total} files; expected for some artifact kinds) ---`);
		for (const b of a.indexedButEmptyBody) {
			console.log(`    ${b.extension.padEnd(20)} ${String(b.count).padStart(5)}   e.g. ${b.examples.join(', ')}`);
		}
	}
}

async function main(): Promise<void> {
	const repos = await listRepos(null);
	console.log(`Workspace registry: ${repos.length} repo(s)`);
	if (repos.length === 0) {
		console.log('  no repos registered; nothing to audit.');
		process.exit(0);
	}

	const audits: RepoAudit[] = [];
	for (const r of repos) {
		try {
			const a = await auditRepo(r.path);
			if (a !== null) {
				audits.push(a);
			}
		} catch (err) {
			console.error(`audit failed for ${r.path}: ${(err as Error).message}`);
		}
	}

	for (const a of audits) {
		renderRepo(a);
	}

	// Summary roll-up across repos.
	console.log(`\n--- Summary ---`);
	let totalMissing = 0;
	let totalEmpty   = 0;
	for (const a of audits) {
		const m = a.onDiskNotIndexed.reduce((s, b) => s + b.count, 0);
		const e = a.indexedButEmptyBody.reduce((s, b) => s + b.count, 0);
		totalMissing += m;
		totalEmpty   += e;
		console.log(`  ${a.repo}: missing=${m}  empty=${e}`);
	}
	console.log(`  workspace total:   missing=${totalMissing}  empty=${totalEmpty}`);

	const stat = statSync('package.json');
	void stat;        // keep node happy when daemon is concurrent

	process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
