/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * GitHub tracker config — Phase F.
 *
 * Loads `~/.insrc/github.json`. Resolves per-repo entries with a
 * git-remote fallback for repos not explicitly configured. The
 * resolved config is what the tracker prompts embed so the LLM
 * knows which repo to `gh` against.
 *
 * Config file shape:
 * ```json
 * {
 *   "default": {
 *     "owner": "myorg",
 *     "repo":  "myrepo",
 *     "epicLabel":     "insrc:epic",
 *     "storyLabel":    "insrc:story",
 *     "useMilestones": false
 *   },
 *   "repos": {
 *     "/abs/path/to/repo": { "owner": "...", "repo": "..." }
 *   }
 * }
 * ```
 *
 * Missing config is not an error — the loader falls back to the
 * git remote's owner/repo and the built-in defaults for labels.
 *
 * We do NOT own the GitHub connection: `gh` must be installed and
 * authenticated (`gh auth login`). The prompt tells the LLM to
 * preflight with `gh auth status`; if that fails, execute step
 * aborts cleanly.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PATHS } from '../../shared/paths.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GithubEntry {
	readonly owner:         string;
	readonly repo:          string;
	readonly epicLabel?:    string;      // default 'insrc:epic'
	readonly storyLabel?:   string;      // default 'insrc:story'
	readonly useMilestones?: boolean;    // default false
}

export interface GithubConfigFile {
	readonly default?: GithubEntry;
	readonly repos?:   Readonly<Record<string, GithubEntry>>;
}

/** Resolved config for a specific repo. All optional label fields
 *  are filled in with the built-in defaults. */
export interface ResolvedGithubConfig {
	readonly owner:         string;
	readonly repo:          string;
	readonly epicLabel:     string;
	readonly storyLabel:    string;
	readonly useMilestones: boolean;
	/** How the owner/repo were resolved. Surfaced to the user so
	 *  they can trace surprising pushes. */
	readonly source:        'per-repo-config' | 'default-config' | 'git-remote';
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_EPIC_LABEL:  string = 'insrc:epic';
const DEFAULT_STORY_LABEL: string = 'insrc:story';

// ---------------------------------------------------------------------------
// Config path
// ---------------------------------------------------------------------------

export function githubConfigPath(): string {
	return join(PATHS.insrc, 'github.json');
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export function loadGithubConfigFile(): GithubConfigFile {
	const path = githubConfigPath();
	if (!existsSync(path)) return {};
	try {
		const raw = readFileSync(path, 'utf8');
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== 'object' || parsed === null) return {};
		return parsed as GithubConfigFile;
	} catch {
		return {};
	}
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Errors surface when neither the config file nor the git remote
 *  yields a valid owner/repo. The tracker workflows refuse to
 *  proceed without a target. */
export class GithubConfigError extends Error {
	constructor(msg: string) { super(msg); this.name = 'GithubConfigError'; }
}

/** Resolve the effective config for a repo. Precedence:
 *   1. `github.json` `repos.<repoPath>` entry
 *   2. `github.json` `default` entry
 *   3. `git remote get-url origin` parsed to owner/repo
 *
 *  Throws `GithubConfigError` when no path resolves. */
export function resolveGithubConfig(repoPath: string): ResolvedGithubConfig {
	const file = loadGithubConfigFile();
	const perRepo = file.repos?.[repoPath];
	if (perRepo !== undefined && perRepo.owner.length > 0 && perRepo.repo.length > 0) {
		return {
			owner:         perRepo.owner,
			repo:          perRepo.repo,
			epicLabel:     perRepo.epicLabel  ?? file.default?.epicLabel  ?? DEFAULT_EPIC_LABEL,
			storyLabel:    perRepo.storyLabel ?? file.default?.storyLabel ?? DEFAULT_STORY_LABEL,
			useMilestones: perRepo.useMilestones ?? file.default?.useMilestones ?? false,
			source:        'per-repo-config',
		};
	}
	if (file.default !== undefined && file.default.owner.length > 0 && file.default.repo.length > 0) {
		return {
			owner:         file.default.owner,
			repo:          file.default.repo,
			epicLabel:     file.default.epicLabel  ?? DEFAULT_EPIC_LABEL,
			storyLabel:    file.default.storyLabel ?? DEFAULT_STORY_LABEL,
			useMilestones: file.default.useMilestones ?? false,
			source:        'default-config',
		};
	}
	// git remote fallback
	const remote = parseGitRemoteOwnerRepo(repoPath);
	if (remote === null) {
		throw new GithubConfigError(
			`No GitHub config for repo '${repoPath}'. Add an entry to ` +
			`${githubConfigPath()} or ensure the repo has a GitHub origin remote.`,
		);
	}
	return {
		owner:         remote.owner,
		repo:          remote.repo,
		epicLabel:     DEFAULT_EPIC_LABEL,
		storyLabel:    DEFAULT_STORY_LABEL,
		useMilestones: false,
		source:        'git-remote',
	};
}

/** Parse `git remote get-url origin` for a GitHub owner/repo pair.
 *  Supports both SSH (`git@github.com:owner/repo.git`) and HTTPS
 *  (`https://github.com/owner/repo(.git)?`) forms. Returns null
 *  when parsing fails. */
export function parseGitRemoteOwnerRepo(repoPath: string): { readonly owner: string; readonly repo: string } | null {
	let url: string;
	try {
		url = execFileSync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
	} catch {
		return null;
	}
	return parseGithubRemoteUrl(url);
}

/** Pure parser separated from the git call so tests don't need a
 *  real repo. */
export function parseGithubRemoteUrl(url: string): { readonly owner: string; readonly repo: string } | null {
	// SSH: git@github.com:owner/repo(.git)?
	{
		const m = /^git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?$/.exec(url);
		if (m !== null) return { owner: m[1]!, repo: m[2]! };
	}
	// HTTPS: https://github.com/owner/repo(.git)?
	{
		const m = /^https?:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/.exec(url);
		if (m !== null) return { owner: m[1]!, repo: m[2]! };
	}
	return null;
}
