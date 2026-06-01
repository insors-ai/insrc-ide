/**
 * code.source.grep -- bounded literal-pattern search under a path.
 *
 * Plan 4 (planner-discovery loop): the planner needs a literal-
 * pattern probe to answer "does this repo use X?" / "where is the
 * @app.route decorator?" / "find @celery.task usage". Semantic
 * search (`code.entity.search-by-vector`) is the wrong shape for
 * these questions -- it matches on meaning, not on exact token.
 *
 * Bounded: caps both `maxHits` (default 30) and snippet length.
 * Uses ripgrep (`rg`) when available; falls back to a node-based
 * walker for environments without it. Skips common dirs
 * (node_modules, .git, dist, build, __pycache__) by default.
 */

import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { Dirent, readdirSync } from 'node:fs';
import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import type {
	BootstrapTriggerKind,
	ContextSlotRequest,
	MemoryEntry,
	NamespaceSpec,
	OwnerId,
	SubstrateSkillExtension,
} from '../../substrate/types.js';

interface GrepInput {
	readonly path:     string;
	readonly pattern:  string;
	readonly maxHits?: number;
}

interface GrepHit {
	readonly file:    string;
	readonly line:    number;
	readonly snippet: string;
}

interface GrepOutput {
	readonly hits:      readonly GrepHit[];
	readonly truncated: boolean;
	readonly searched:  number;
}

const DEFAULT_MAX_HITS = 30;
const MAX_HITS_CEILING = 200;
const SNIPPET_MAX_CHARS = 200;
const EXCLUDED_DIRS = new Set<string>([
	'node_modules', '.git', '.svn', 'dist', 'build', 'out', 'target',
	'__pycache__', '.venv', 'venv', '.pytest_cache', '.cache',
]);

const codeSourceGrepSkill: Skill<GrepInput, GrepOutput> = {
	id: 'code.source.grep',
	name: 'Code: literal pattern search under a path',
	description:
		'Bounded literal-pattern search using ripgrep when available. Returns matching ' +
		'lines as `{ file, line, snippet }`. Caps at `maxHits` (default 30) results. ' +
		'Excludes common build/cache dirs. Use for "does this codebase use X?" / ' +
		'"where is @decorator used?" questions where semantic search is the wrong shape.',
	family: 'source-introspection',
	owner: 'code-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			path:    { type: 'string', description: 'Absolute directory path to search under.' },
			pattern: { type: 'string', description: 'Literal-string pattern (regex syntax supported when ripgrep is available).' },
			maxHits: { type: 'number', description: 'Cap on returned hits (default 30, max 200).', minimum: 1, maximum: MAX_HITS_CEILING },
		},
		required: ['path', 'pattern'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			hits:      { type: 'array' },
			truncated: { type: 'boolean' },
			searched:  { type: 'number' },
		},
		required: ['hits', 'truncated', 'searched'],
	},
	toolDeps: [],
	providerAffinity: 'auto',

	async execute(input: GrepInput, deps: SkillDeps): Promise<SkillResult<GrepOutput>> {
		const maxHits = clampMaxHits(input.maxHits);

		// Refuse non-absolute paths -- the catalog convention.
		if (!input.path.startsWith('/')) {
			return rejectInvalid('path must be an absolute filesystem path');
		}
		// Refuse empty patterns to avoid runaway matches.
		if (typeof input.pattern !== 'string' || input.pattern.length === 0) {
			return rejectInvalid('pattern must be a non-empty string');
		}

		// Substrate: cache hit short-circuits ripgrep / fallback walk.
		const cached = readCachedGrep(input, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: cached.hits.length > 0 ? 'high' : 'medium',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		// Probe the path exists + is a directory.
		try {
			const s = await stat(input.path);
			if (!s.isDirectory()) {
				return rejectInvalid(`path is not a directory: ${input.path}`);
			}
		} catch (err) {
			return rejectInvalid(`path stat failed: ${(err as Error).message}`);
		}

		// Try ripgrep first.
		const rgResult = await tryRipgrep(input.path, input.pattern, maxHits);
		if (rgResult !== null) {
			if (rgResult.hits.length > 0) {
				pinGrep(input, rgResult, deps);
			}
			return {
				value: rgResult,
				confidence: rgResult.hits.length > 0 ? 'high' : 'medium',
				notes: rgResult.hits.length === 0 ? ['no matches found'] : [],
				toolCalls: [],
			};
		}

		// Fallback: node-walker grep.
		const fallback = await nodeFallbackGrep(input.path, input.pattern, maxHits);
		return {
			value: fallback,
			confidence: fallback.hits.length > 0 ? 'medium' : 'low',
			notes: [
				'ripgrep unavailable; used node-walker fallback (slower, less robust)',
				...(fallback.hits.length === 0 ? ['no matches found'] : []),
			],
			toolCalls: [],
		};
	},
};

// ---------------------------------------------------------------------------
// ripgrep path
// ---------------------------------------------------------------------------

function tryRipgrep(searchPath: string, pattern: string, maxHits: number): Promise<GrepOutput | null> {
	return new Promise<GrepOutput | null>((resolve) => {
		const args = [
			'--max-count', String(maxHits),
			'--no-heading',
			'--line-number',
			'--with-filename',
			'--color', 'never',
			'-e', pattern,
			searchPath,
		];
		const proc = spawn('rg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
		proc.on('error', () => resolve(null));   // rg not found / failed to spawn
		proc.on('close', (code) => {
			// rg exit codes: 0 = matches, 1 = no matches, 2 = error.
			if (code === 2) {
				resolve(null);
				return;
			}
			const hits = parseRipgrepOutput(stdout, maxHits);
			resolve({
				hits,
				truncated: hits.length >= maxHits,
				searched:  -1,   // ripgrep doesn't tell us file count cheaply
			});
		});
	});
}

function parseRipgrepOutput(stdout: string, maxHits: number): readonly GrepHit[] {
	const hits: GrepHit[] = [];
	const lines = stdout.split('\n');
	for (const raw of lines) {
		if (raw.length === 0) {
			continue;
		}
		if (hits.length >= maxHits) {
			break;
		}
		// Format: <file>:<line>:<content>
		const firstColon  = raw.indexOf(':');
		if (firstColon < 0) {
			continue;
		}
		const secondColon = raw.indexOf(':', firstColon + 1);
		if (secondColon < 0) {
			continue;
		}
		const file = raw.slice(0, firstColon);
		const lineNum = Number(raw.slice(firstColon + 1, secondColon));
		if (!Number.isFinite(lineNum)) {
			continue;
		}
		const snippet = truncateSnippet(raw.slice(secondColon + 1));
		hits.push({ file, line: lineNum, snippet });
	}
	return hits;
}

// ---------------------------------------------------------------------------
// Node-walker fallback
// ---------------------------------------------------------------------------

async function nodeFallbackGrep(root: string, pattern: string, maxHits: number): Promise<GrepOutput> {
	const hits: GrepHit[] = [];
	let searched = 0;
	let regex: RegExp;
	try {
		// Treat pattern as a regex source; if it parses, use it. Otherwise
		// escape and match literally.
		regex = new RegExp(pattern);
	} catch {
		regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
	}

	const stack: string[] = [root];
	while (stack.length > 0 && hits.length < maxHits) {
		const dir = stack.pop()!;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const ent of entries) {
			if (hits.length >= maxHits) {
				break;
			}
			if (EXCLUDED_DIRS.has(ent.name)) {
				continue;
			}
			const full = join(dir, ent.name);
			if (ent.isDirectory()) {
				stack.push(full);
				continue;
			}
			if (!ent.isFile()) {
				continue;
			}
			searched++;
			try {
				const text = await readFile(full, 'utf8');
				const lines = text.split('\n');
				for (let i = 0; i < lines.length; i++) {
					if (hits.length >= maxHits) {
						break;
					}
					if (regex.test(lines[i]!)) {
						hits.push({
							file:    full,
							line:    i + 1,
							snippet: truncateSnippet(lines[i]!),
						});
					}
				}
			} catch {
				// Binary or unreadable file -- skip.
				continue;
			}
		}
	}
	return { hits, truncated: hits.length >= maxHits, searched };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampMaxHits(requested: number | undefined): number {
	if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
		return DEFAULT_MAX_HITS;
	}
	return Math.min(requested, MAX_HITS_CEILING);
}

function truncateSnippet(s: string): string {
	const trimmed = s.replace(/\s+$/, '');
	return trimmed.length > SNIPPET_MAX_CHARS
		? trimmed.slice(0, SNIPPET_MAX_CHARS) + '...'
		: trimmed;
}

function rejectInvalid(reason: string): SkillResult<GrepOutput> {
	return {
		value:      { hits: [], truncated: false, searched: 0 },
		confidence: 'low',
		notes:      [reason],
		toolCalls:  [],
	};
}

// Silence unused-import warning when running in environments without `relative`
void relative;

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------
//
// File contents change with edits; short TTL bounds staleness. Cache
// key conservatively includes path + pattern + maxHits so callers with
// different bounds don't collide.

const OWNER_ID: OwnerId = 'skill:code.source.grep';
const NAMESPACE = 'grep-results';
const TTL_MS = 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['repo-add', 'reindex', 'manual'];

function cacheKey(input: GrepInput): string {
	const maxHits = clampMaxHits(input.maxHits);
	return `${input.path}::${input.pattern}::${maxHits}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-grep',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as GrepInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'GrepOutput',
		autoDistill: 'always-on-success',
		indexing:    { kind: 'never' },
		ttl:         '1h',
	},
];

const substrateExtension: SubstrateSkillExtension = {
	ownerId:            OWNER_ID,
	schemaVersion:      1,
	interestedTriggers: INTERESTED_TRIGGERS,
	contextSlots:       CONTEXT_SLOTS,
	memorySchema:       MEMORY_SCHEMA,
	assertionInterests: [],
};

function readCachedGrep(input: GrepInput, deps: SkillDeps): GrepOutput | undefined {
	const slot = deps.context?.slots.get('cached-grep');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<GrepOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinGrep(input: GrepInput, value: GrepOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'rg' },
		payload: value,
		claims:  [`grep:${cacheKey(input)}`],
		confidence: 0.9,
	});
	deps.workingState.pin(ref, {
		owner:     OWNER_ID,
		namespace: NAMESPACE,
		key:       cacheKey(input),
		kind:      'fact',
		ttlMs:     TTL_MS,
	});
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const skillWithSubstrate = { ...codeSourceGrepSkill, ...substrateExtension };

export function registerCodeSourceGrepSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

export const _parseRipgrepOutputForTest = parseRipgrepOutput;
export const _clampMaxHitsForTest        = clampMaxHits;
export const _truncateSnippetForTest    = truncateSnippet;
