/**
 * code.repo.git-status -- list files changed vs a git ref.
 *
 * Plan 4 (planner-discovery loop): the planner needs to handle
 * "review the changed files" / "audit recent modifications" type
 * requests. This skill wraps `git diff --name-status <ref>` so the
 * planner can list the touched files + their statuses (modified /
 * added / deleted / renamed) before planning sections.
 *
 * Bounded by file count cap. Default ref is `HEAD` (working tree
 * vs current commit). Other useful refs: `main`, `main..HEAD`,
 * a SHA.
 */

import { spawn } from 'node:child_process';
import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';

interface GitStatusInput {
	readonly repoPath: string;
	readonly ref?:     string;
}

type FileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'unknown';

interface ChangedFile {
	readonly path:    string;
	readonly status:  FileStatus;
	/** Optional rename source (only set when `status === 'renamed'`). */
	readonly from?:   string;
}

interface GitStatusOutput {
	readonly ref:       string;
	readonly files:     readonly ChangedFile[];
	readonly truncated: boolean;
}

const DEFAULT_REF = 'HEAD';
const MAX_FILES   = 500;

const codeRepoGitStatusSkill: Skill<GitStatusInput, GitStatusOutput> = {
	id: 'code.repo.git-status',
	name: 'Code: files changed vs a git ref',
	description:
		'List files changed in the working tree relative to a git ref (default `HEAD`). ' +
		'Returns `{ path, status, from? }` per file. Use for "review changed files" / ' +
		'"diff against main" / "what did I modify?" planner questions. Caps at 500 files.',
	family: 'source-introspection',
	owner: 'code-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			repoPath: { type: 'string', description: 'Absolute path to a git repository root.' },
			ref:      { type: 'string', description: 'Git ref to diff against (default `HEAD`). Examples: `HEAD`, `main`, `main..HEAD`, a SHA.' },
		},
		required: ['repoPath'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: {
			ref:       { type: 'string' },
			files:     { type: 'array' },
			truncated: { type: 'boolean' },
		},
		required: ['ref', 'files', 'truncated'],
	},
	toolDeps: [],
	providerAffinity: 'auto',

	async execute(input: GitStatusInput, _deps: SkillDeps): Promise<SkillResult<GitStatusOutput>> {
		if (!input.repoPath.startsWith('/')) {
			return rejectInvalid('repoPath must be an absolute path', input.ref ?? DEFAULT_REF);
		}
		const ref = (typeof input.ref === 'string' && input.ref.length > 0) ? input.ref : DEFAULT_REF;

		const result = await runGitDiffNameStatus(input.repoPath, ref);
		if (result.kind === 'error') {
			return {
				value:      { ref, files: [], truncated: false },
				confidence: 'low',
				notes:      [`git diff failed: ${result.message}`],
				toolCalls:  [],
			};
		}

		const truncated = result.files.length >= MAX_FILES;
		const files = result.files.slice(0, MAX_FILES);
		return {
			value:      { ref, files, truncated },
			confidence: files.length > 0 ? 'high' : 'medium',
			notes:      files.length === 0 ? [`no changes vs ${ref}`] : [],
			toolCalls:  [],
		};
	},
};

// ---------------------------------------------------------------------------
// git diff invocation
// ---------------------------------------------------------------------------

type GitDiffResult =
	| { readonly kind: 'ok';    readonly files: readonly ChangedFile[] }
	| { readonly kind: 'error'; readonly message: string };

function runGitDiffNameStatus(repoPath: string, ref: string): Promise<GitDiffResult> {
	return new Promise<GitDiffResult>((resolve) => {
		const args = ['-C', repoPath, 'diff', '--name-status', '-M', '-z', ref];
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
			resolve({ kind: 'ok', files: parseNameStatusNullDelimited(stdout) });
		});
	});
}

/**
 * Parse `git diff --name-status -z` output. The `-z` flag uses NUL
 * separators (more robust than newlines for paths with whitespace).
 *
 * Format per entry:
 *   <status-letter>\0<path>\0                                 (most statuses)
 *   R<score>\0<from>\0<to>\0                                  (rename)
 *   C<score>\0<from>\0<to>\0                                  (copy)
 */
function parseNameStatusNullDelimited(raw: string): readonly ChangedFile[] {
	const files: ChangedFile[] = [];
	const tokens = raw.split('\0').filter(t => t.length > 0);
	let i = 0;
	while (i < tokens.length) {
		const head = tokens[i]!;
		i++;
		const statusLetter = head[0]!;
		const isRenameOrCopy = statusLetter === 'R' || statusLetter === 'C';
		if (isRenameOrCopy) {
			const from = tokens[i++] ?? '';
			const to   = tokens[i++] ?? '';
			files.push({
				path:   to,
				status: statusLetter === 'R' ? 'renamed' : 'copied',
				from,
			});
		} else {
			const path = tokens[i++] ?? '';
			files.push({ path, status: mapStatusLetter(statusLetter) });
		}
	}
	return files;
}

function mapStatusLetter(letter: string): FileStatus {
	switch (letter) {
		case 'M': return 'modified';
		case 'A': return 'added';
		case 'D': return 'deleted';
		case 'R': return 'renamed';
		case 'C': return 'copied';
		default:  return 'unknown';
	}
}

function rejectInvalid(reason: string, ref: string): SkillResult<GitStatusOutput> {
	return {
		value:      { ref, files: [], truncated: false },
		confidence: 'low',
		notes:      [reason],
		toolCalls:  [],
	};
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerCodeRepoGitStatusSkill(): void {
	registerSkill(codeRepoGitStatusSkill as unknown as Skill);
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

export const _parseNameStatusForTest = parseNameStatusNullDelimited;
export const _mapStatusLetterForTest = mapStatusLetter;
