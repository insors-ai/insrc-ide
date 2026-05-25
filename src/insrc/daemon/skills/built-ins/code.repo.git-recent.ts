/**
 * code.repo.git-recent -- list files from the last N commits.
 *
 * Plan 4 (planner-discovery loop): the planner needs to handle
 * "review my recent commits" / "what changed this week?" type
 * requests. This skill wraps `git log -n <count> --name-only`
 * and aggregates the unique files touched across the recent
 * commits, with the commit history they appear in.
 *
 * Bounded by file count cap. Default count is 5 commits.
 */

import { spawn } from 'node:child_process';
import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';

interface GitRecentInput {
	readonly repoPath: string;
	readonly count?:   number;
}

interface RecentCommit {
	readonly sha:     string;
	readonly subject: string;
	readonly author:  string;
	readonly date:    string;
}

interface RecentFile {
	readonly path:     string;
	/** Commits (by index into `commits[]`) that touched this file. */
	readonly commits:  readonly number[];
}

interface GitRecentOutput {
	readonly count:     number;
	readonly commits:   readonly RecentCommit[];
	readonly files:     readonly RecentFile[];
	readonly truncated: boolean;
}

const DEFAULT_COUNT = 5;
const MAX_COUNT     = 50;
const MAX_FILES     = 300;

const codeRepoGitRecentSkill: Skill<GitRecentInput, GitRecentOutput> = {
	id: 'code.repo.git-recent',
	name: 'Code: files touched by recent git commits',
	description:
		'List files touched by the most recent N commits (default 5). Returns the ' +
		'commit metadata + the unique file set with per-file commit references. Use ' +
		'for "review my recent commits" / "what did I change this week?" planner ' +
		'questions. Caps at 50 commits and 300 files.',
	family: 'source-introspection',
	owner: 'code-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			repoPath: { type: 'string', description: 'Absolute path to a git repository root.' },
			count:    { type: 'number', description: 'Number of recent commits to inspect (default 5, max 50).', minimum: 1, maximum: MAX_COUNT },
		},
		required: ['repoPath'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			count:     { type: 'number' },
			commits:   { type: 'array' },
			files:     { type: 'array' },
			truncated: { type: 'boolean' },
		},
		required: ['count', 'commits', 'files', 'truncated'],
	},
	toolDeps: [],
	providerAffinity: 'auto',

	async execute(input: GitRecentInput, _deps: SkillDeps): Promise<SkillResult<GitRecentOutput>> {
		if (!input.repoPath.startsWith('/')) {
			return rejectInvalid('repoPath must be an absolute path', DEFAULT_COUNT);
		}
		const count = clampCount(input.count);

		const result = await runGitLog(input.repoPath, count);
		if (result.kind === 'error') {
			return {
				value:      { count, commits: [], files: [], truncated: false },
				confidence: 'low',
				notes:      [`git log failed: ${result.message}`],
				toolCalls:  [],
			};
		}

		const truncated = result.files.length >= MAX_FILES;
		const files = result.files.slice(0, MAX_FILES);
		return {
			value:      { count, commits: result.commits, files, truncated },
			confidence: result.commits.length > 0 ? 'high' : 'medium',
			notes:      result.commits.length === 0 ? ['no commits in this repo'] : [],
			toolCalls:  [],
		};
	},
};

// ---------------------------------------------------------------------------
// git log invocation
// ---------------------------------------------------------------------------

type GitLogResult =
	| { readonly kind: 'ok';    readonly commits: readonly RecentCommit[]; readonly files: readonly RecentFile[] }
	| { readonly kind: 'error'; readonly message: string };

function runGitLog(repoPath: string, count: number): Promise<GitLogResult> {
	return new Promise<GitLogResult>((resolve) => {
		// Format: each commit starts with `COMMIT|<sha>|<author>|<date>|<subject>`
		// followed by one path per line, then a blank line separator.
		const args = [
			'-C', repoPath,
			'log',
			`-${count}`,
			'--name-only',
			'--format=COMMIT|%H|%an|%aI|%s',
		];
		const proc = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
		proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
		proc.on('error', (err) => resolve({ kind: 'error', message: err.message }));
		proc.on('close', (code) => {
			if (code !== 0) {
				resolve({ kind: 'error', message: stderr.trim() || `git exit code ${code}` });
				return;
			}
			const parsed = parseGitLogOutput(stdout);
			resolve({ kind: 'ok', ...parsed });
		});
	});
}

function parseGitLogOutput(raw: string): {
	readonly commits: readonly RecentCommit[];
	readonly files:   readonly RecentFile[];
} {
	const commits: RecentCommit[] = [];
	const filesByPath = new Map<string, number[]>();
	const lines = raw.split('\n');

	let currentCommitIdx = -1;
	for (const line of lines) {
		if (line.startsWith('COMMIT|')) {
			const parts = line.split('|');
			if (parts.length >= 5) {
				commits.push({
					sha:     parts[1] ?? '',
					author:  parts[2] ?? '',
					date:    parts[3] ?? '',
					subject: parts.slice(4).join('|'),
				});
				currentCommitIdx = commits.length - 1;
			}
			continue;
		}
		const trimmed = line.trim();
		if (trimmed.length === 0 || currentCommitIdx < 0) {
			continue;
		}
		const existing = filesByPath.get(trimmed);
		if (existing) {
			existing.push(currentCommitIdx);
		} else {
			filesByPath.set(trimmed, [currentCommitIdx]);
		}
	}

	const files: RecentFile[] = Array.from(filesByPath.entries()).map(([path, c]) => ({
		path,
		commits: c,
	}));
	return { commits, files };
}

function clampCount(requested: number | undefined): number {
	if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
		return DEFAULT_COUNT;
	}
	return Math.min(Math.floor(requested), MAX_COUNT);
}

function rejectInvalid(reason: string, count: number): SkillResult<GitRecentOutput> {
	return {
		value:      { count, commits: [], files: [], truncated: false },
		confidence: 'low',
		notes:      [reason],
		toolCalls:  [],
	};
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerCodeRepoGitRecentSkill(): void {
	registerSkill(codeRepoGitRecentSkill as unknown as Skill);
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

export const _parseGitLogOutputForTest = parseGitLogOutput;
export const _clampCountForTest         = clampCount;
