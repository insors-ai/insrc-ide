/**
 * shared.fs.list-files -- list directory entries with rich filtering and
 * formatting.
 *
 * Phase 1 of plans/shared-fs-skills-and-namespace-cleanup.md.
 *
 * The catalog had no skill that enumerates files under a directory --
 * `code.source.module.describe` returns indexed source-file entities
 * (data fixtures like JSON aren't indexed), `code.source.grep` searches
 * content not filenames, and the `data.source.file.*` family takes a
 * specific connection and returns shapes / rows / schema but never a
 * file list. Every TODO of the form "what JSON files exist in this
 * test fixture directory" hit L2 fallback because there was nothing to
 * call.
 *
 * Flags-over-skills: rather than separate `list-files` + `tree` + `recent`
 * + `stat` skills, one verb (list) with flags covers the full surface:
 *
 *   - `recursive: true` + `format: 'tree'`  -> tree view
 *   - `sortBy: 'mtime'` + `limit: N`        -> N most-recent files
 *   - `pattern: "<exact-filename>"`         -> single-path stat
 *
 * Output kinds: 'file' | 'dir' | 'symlink'. Symlinks are reported by
 * their link kind (not followed) so the caller can decide what to do.
 *
 * NOT via the data-driver tool layer. Filesystem walking is general
 * infrastructure -- no connection registry required.
 */

import { readdir, stat, lstat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FsKind = 'file' | 'dir' | 'symlink';

interface ListFilesInput {
	readonly path:        string;
	readonly pattern?:    string;
	readonly recursive?:  boolean;
	readonly sortBy?:     'name' | 'mtime' | 'size';
	readonly limit?:      number;
	readonly format?:     'flat' | 'tree';
}

interface ListedEntry {
	readonly path:       string;
	readonly kind:       FsKind;
	readonly size:       number;
	readonly modifiedAt: number;
}

interface ListFilesOutput {
	readonly files:      readonly ListedEntry[];
	readonly truncated:  boolean;
	readonly rendered?:  string;
}

// ---------------------------------------------------------------------------
// Bounds + defaults
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 200;
const MAX_LIMIT     = 2000;
// Hard cap on filesystem entries scanned even when limit is large -- defends
// against pathological recursive walks (e.g. into node_modules).
const MAX_SCANNED   = 50_000;
const EXCLUDED_DIRS = new Set<string>([
	'node_modules', '.git', '.svn', 'dist', 'build', 'out', 'target',
	'__pycache__', '.venv', 'venv', '.pytest_cache', '.cache',
]);

// ---------------------------------------------------------------------------
// Skill definition
// ---------------------------------------------------------------------------

const sharedFsListFilesSkill: Skill<ListFilesInput, ListFilesOutput> = {
	id: 'shared.fs.list-files',
	name: 'Filesystem: list files / dirs under a path',
	description:
		'List filesystem entries under `path` (file / dir / symlink kinds). ' +
		'Optional glob `pattern` filters the filename component. `recursive` ' +
		'walks subdirs; `sortBy` controls order ("name" default, "mtime" for ' +
		'most-recent, "size"); `limit` caps results (default 200, max 2000); ' +
		'`format: "tree"` adds an ASCII tree render. Excludes node_modules / ' +
		'.git / build dirs by default. Use this when the question is ' +
		'"what files exist in directory X" -- e.g. enumerating JSON test fixtures.',
	family: 'source-introspection',
	owner: 'shared',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			path:      { type: 'string',  description: 'Absolute directory path to list.' },
			pattern:   { type: 'string',  description: 'Optional glob against the filename component (e.g. "*.json").' },
			recursive: { type: 'boolean', description: 'Walk subdirs. Default false.' },
			sortBy:    { type: 'string',  enum: ['name', 'mtime', 'size'], description: 'Order of returned entries. Default "name".' },
			limit:     { type: 'number',  description: `Cap on returned entries. Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`, minimum: 1, maximum: MAX_LIMIT },
			format:    { type: 'string',  enum: ['flat', 'tree'], description: 'Output format. Default "flat".' },
		},
		required: ['path'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			files:     { type: 'array' },
			truncated: { type: 'boolean' },
			rendered:  { type: 'string' },
		},
		required: ['files', 'truncated'],
	},
	toolDeps: [],
	providerAffinity: 'auto',

	async execute(input: ListFilesInput, _deps: SkillDeps): Promise<SkillResult<ListFilesOutput>> {
		if (!input.path.startsWith('/')) {
			return rejectInvalid('path must be an absolute filesystem path');
		}
		try {
			const s = await stat(input.path);
			if (!s.isDirectory()) {
				return rejectInvalid(`path is not a directory: ${input.path}`);
			}
		} catch (err) {
			return rejectInvalid(`path stat failed: ${(err as Error).message}`);
		}

		const limit = clampLimit(input.limit);
		const matcher = input.pattern !== undefined && input.pattern.length > 0
			? compileGlob(input.pattern)
			: null;

		// Walk -- depth-first when recursive, single-level otherwise.
		const collected: ListedEntry[] = [];
		let scanned = 0;
		const stack: string[] = [input.path];

		while (stack.length > 0) {
			if (scanned >= MAX_SCANNED) { break; }
			const dir = stack.pop()!;
			let entries: Dirent[];
			try {
				entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' }) as Dirent[];
			} catch {
				continue;
			}
			for (const ent of entries) {
				if (scanned >= MAX_SCANNED) { break; }
				scanned++;
				if (input.recursive === true && ent.isDirectory() && EXCLUDED_DIRS.has(ent.name)) {
					continue;
				}
				const full = join(dir, ent.name);
				const kind: FsKind = ent.isSymbolicLink() ? 'symlink' : (ent.isDirectory() ? 'dir' : 'file');

				// Pattern check is on the filename component, not the full path.
				const matches = matcher === null || matcher(ent.name);

				if (matches) {
					try {
						// Use lstat so symlinks report the link's metadata, not the target.
						const s = await lstat(full);
						collected.push({
							path:       full,
							kind,
							size:       s.size,
							modifiedAt: s.mtimeMs,
						});
					} catch {
						// Race: entry vanished between readdir and lstat.
						continue;
					}
				}

				if (input.recursive === true && kind === 'dir') {
					stack.push(full);
				}
			}
		}

		// Sort.
		const sortBy = input.sortBy ?? 'name';
		const sorted = sortEntries(collected, sortBy);

		// Limit.
		const truncated = sorted.length > limit;
		const files = truncated ? sorted.slice(0, limit) : sorted;

		// Tree render (optional).
		const rendered = input.format === 'tree'
			? renderTree(input.path, files)
			: undefined;

		const value: ListFilesOutput = rendered !== undefined
			? { files, truncated, rendered }
			: { files, truncated };

		return {
			value,
			confidence: files.length > 0 ? 'high' : 'medium',
			notes: files.length === 0 ? ['no entries matched'] : [],
			toolCalls: [],
		};
	},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampLimit(requested: number | undefined): number {
	if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
		return DEFAULT_LIMIT;
	}
	return Math.min(Math.floor(requested), MAX_LIMIT);
}

/**
 * Compile a shell-style glob into a regex matcher on the filename component.
 * Supports: `*` (any chars except `/`), `?` (single char), `[abc]` (charset).
 * Anchored at both ends so `*.json` matches `foo.json` but not `foo.json.bak`.
 */
export function compileGlob(pattern: string): (name: string) => boolean {
	let regex = '^';
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i]!;
		switch (c) {
			case '*': regex += '[^/]*'; break;
			case '?': regex += '[^/]';  break;
			case '[': {
				const close = pattern.indexOf(']', i);
				if (close === -1) {
					regex += '\\[';
					break;
				}
				regex += pattern.slice(i, close + 1);
				i = close;
				break;
			}
			default:
				if (/[.+^${}()|\\]/.test(c)) { regex += '\\' + c; }
				else                          { regex += c; }
		}
	}
	regex += '$';
	const re = new RegExp(regex);
	return (name: string) => re.test(name);
}

function sortEntries(entries: ListedEntry[], by: 'name' | 'mtime' | 'size'): ListedEntry[] {
	const sorted = [...entries];
	switch (by) {
		case 'name':  sorted.sort((a, b) => a.path.localeCompare(b.path)); break;
		case 'mtime': sorted.sort((a, b) => b.modifiedAt - a.modifiedAt); break;
		case 'size':  sorted.sort((a, b) => b.size - a.size); break;
	}
	return sorted;
}

/**
 * Render a flat entry list as an ASCII tree rooted at `root`. Each entry's
 * relative path becomes its position in the tree; nesting infers from path
 * separators. Produces output like:
 *
 *   src/
 *   ├── insrc/
 *   │   ├── agent/
 *   │   └── shared/
 *   └── README.md
 */
export function renderTree(root: string, entries: readonly ListedEntry[]): string {
	if (entries.length === 0) { return `${basename(root)}/  (empty)`; }
	// Build a nested tree keyed by relative-path segments.
	interface TreeNode { readonly children: Map<string, TreeNode>; kind?: FsKind; }
	const rootNode: TreeNode = { children: new Map() };
	for (const ent of entries) {
		const rel = relative(root, ent.path);
		if (rel === '' || rel.startsWith('..')) { continue; }
		const parts = rel.split('/').filter(p => p.length > 0);
		let cur = rootNode;
		for (let i = 0; i < parts.length; i++) {
			const seg = parts[i]!;
			let next = cur.children.get(seg);
			if (next === undefined) {
				next = { children: new Map() };
				cur.children.set(seg, next);
			}
			if (i === parts.length - 1) {
				(next as { kind?: FsKind }).kind = ent.kind;
			}
			cur = next;
		}
	}
	const lines: string[] = [`${basename(root)}/`];
	walkTree(rootNode, '', lines);
	return lines.join('\n');
}

function walkTree(node: { children: Map<string, { children: Map<string, unknown>; kind?: FsKind }>; kind?: FsKind }, prefix: string, out: string[]): void {
	const entries = [...node.children.entries()].sort((a, b) => a[0].localeCompare(b[0]));
	for (let i = 0; i < entries.length; i++) {
		const [name, child] = entries[i]!;
		const isLast   = i === entries.length - 1;
		const connector = isLast ? '└── ' : '├── ';
		const suffix    = child.kind === 'dir' || child.children.size > 0 ? '/' : '';
		out.push(`${prefix}${connector}${name}${suffix}`);
		const childPrefix = prefix + (isLast ? '    ' : '│   ');
		walkTree(child as { children: Map<string, { children: Map<string, unknown>; kind?: FsKind }>; kind?: FsKind }, childPrefix, out);
	}
}

function rejectInvalid(reason: string): SkillResult<ListFilesOutput> {
	return {
		value:      { files: [], truncated: false },
		confidence: 'low',
		notes:      [reason],
		toolCalls:  [],
	};
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSharedFsListFilesSkill(): void {
	registerSkill(sharedFsListFilesSkill as unknown as Skill);
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

export const _clampLimitForTest    = clampLimit;
export const _sortEntriesForTest   = sortEntries;
export const _renderTreeForTest    = renderTree;
export const _compileGlobForTest   = compileGlob;
