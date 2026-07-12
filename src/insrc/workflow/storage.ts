/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Storage helpers for workflow artifacts + run logs.
 *
 * Every write goes through `writeAtomic` — write to `<path>.tmp`
 * then rename — so a mid-write crash leaves the previous version
 * intact. Directories are created on demand.
 *
 * The workflow-runs jsonl log lives OUTSIDE the repo, at
 * `~/.insrc/workflow-runs/<slug>/<workflow>-<runId>.jsonl`, one line
 * per step. The repo only holds the human-facing artifacts under
 * `docs/` (and later `plans/`).
 */

import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { PATHS } from '../shared/paths.js';

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

/** Write `content` to `absPath` atomically. Creates parent dirs as
 *  needed. Uses `renameSync` which is atomic within a single
 *  filesystem — no partial writes visible to a concurrent reader.
 *
 *  Refuses when `absPath` looks suspicious (relative, or empty).
 *  Callers should validate paths themselves for the gitignore + is-
 *  under-repo checks; this function is a low-level primitive.
 */
export function writeAtomic(absPath: string, content: string): void {
	if (typeof absPath !== 'string' || absPath.length === 0) {
		throw new Error(`writeAtomic: empty path`);
	}
	if (!absPath.startsWith('/')) {
		throw new Error(`writeAtomic: path must be absolute (got '${absPath}')`);
	}
	mkdirSync(dirname(absPath), { recursive: true });
	const tmp = `${absPath}.tmp`;
	writeFileSync(tmp, content, 'utf8');
	renameSync(tmp, absPath);
}

// ---------------------------------------------------------------------------
// Workflow-runs jsonl
// ---------------------------------------------------------------------------

/** Directory holding this run's jsonl trace. */
export function runsDirFor(slug: string): string {
	return join(PATHS.insrc, 'workflow-runs', slug);
}

/** Path to the jsonl trace for a single (workflow, runId). */
export function runLogPathFor(
	slug:     string,
	workflow: string,
	runId:    string,
): string {
	return join(runsDirFor(slug), `${workflow}-${runId}.jsonl`);
}

/** Append one line to the run's jsonl. Records are best-effort: a
 *  failing append never aborts the run (logging failure is worse
 *  than losing a trace line). */
export function appendRunLog(
	slug:     string,
	workflow: string,
	runId:    string,
	record:   Record<string, unknown>,
): void {
	const path = runLogPathFor(slug, workflow, runId);
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, JSON.stringify(record) + '\n', 'utf8');
	} catch { /* trace is best-effort */ }
}

// ---------------------------------------------------------------------------
// Artifact paths — per workflow shape
// ---------------------------------------------------------------------------

/** Canonical artifact paths per workflow. Callers pass the repo
 *  root and the slug; helpers return the full absolute path for
 *  writing.
 *
 *  `stub` writes to `docs/stub/<slug>.{md,json}` so Phase A can
 *  see end-to-end I/O without polluting the real `docs/` tree the
 *  real workflows will use later. */
export function stubArtifactPaths(repoPath: string, slug: string): {
	readonly md:   string;
	readonly json: string;
} {
	return {
		md:   join(repoPath, 'docs/stub', `${slug}.md`),
		json: join(repoPath, 'docs/stub', `${slug}.json`),
	};
}

export function defineArtifactPaths(repoPath: string, slug: string): {
	readonly md:   string;
	readonly json: string;
} {
	return {
		md:   join(repoPath, 'docs/defines', `${slug}.md`),
		json: join(repoPath, 'docs/defines', `${slug}.json`),
	};
}

export function hldArtifactPaths(repoPath: string, epicSlug: string): {
	readonly md:   string;
	readonly json: string;
	readonly dir:  string;
} {
	const dir = join(repoPath, 'docs/designs', epicSlug);
	return {
		dir,
		md:   join(dir, '_hld.md'),
		json: join(dir, '_hld.json'),
	};
}

export function lldArtifactPaths(
	repoPath: string,
	epicSlug: string,
	storyId:  string,
): {
	readonly md:   string;
	readonly json: string;
	readonly dir:  string;
} {
	const dir = join(repoPath, 'docs/designs', epicSlug);
	return {
		dir,
		md:   join(dir, `${storyId}.md`),
		json: join(dir, `${storyId}.json`),
	};
}
