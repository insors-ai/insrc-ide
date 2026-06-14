/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Permission policy evaluation.
 *
 * Each handoff spec carries a `PermissionsBlock` (allow/prompt/deny
 * lists of `PermissionRule`s). At Mode B gate time -- when the
 * external coding agent attempts a tool call inside the worktree --
 * the PreToolUse hook (Phase 3 Day 3) asks the daemon to evaluate
 * the call against this policy. The verdict drives whether the
 * agent's tool call proceeds, is denied, or pauses for the user.
 *
 * Precedence (design §9.1): `deny` > `prompt` > `allow`, default
 * `prompt` if no rule matches. Default to prompt is the fail-safe:
 * an oversight in the spec asks the user instead of silently
 * approving.
 *
 * Path matching: glob via the `minimatch`-style algorithm
 * implemented inline here -- no extra dependency. Supports `*`
 * (any non-slash segment chars), `**` (any segments including
 * slashes), and literal characters. Patterns are anchored to the
 * full path; callers normalize (absolute path, no trailing slash)
 * before evaluating.
 *
 * Command matching (for Bash): substring or glob. A rule whose
 * `commands` includes "git push" matches `git push origin main`.
 * Glob `*` is supported for tokens like `git push *`.
 */

import type { PermissionRule, PermissionsBlock } from '../handoff/types.js';

export type PermissionVerdict = 'allow' | 'prompt' | 'deny';

export interface ToolRequest {
	readonly tool: string;
	/**
	 * Tool input -- specific shape depends on the tool. We extract
	 * known fields below; unknown shapes fall through to the
	 * `commands` / `paths` matchers via `String(input)`.
	 */
	readonly input: ToolInput;
}

export type ToolInput =
	| { readonly path?: string;        readonly file_path?: string; readonly command?: undefined }
	| { readonly command?: string;     readonly path?: undefined;  readonly file_path?: undefined }
	| Record<string, unknown>;

/**
 * Evaluate the request against the policy. Pure -- no I/O, no
 * side effects. Drives both the daemon gate-handler and any
 * inline policy debugging the CLI might offer.
 */
export function evaluatePermission(policy: PermissionsBlock, request: ToolRequest): PermissionVerdict {
	// Deny is absolute. A matching deny rule short-circuits regardless
	// of what's in allow/prompt.
	for (const rule of policy.deny) {
		if (matchRule(rule, request)) return 'deny';
	}
	for (const rule of policy.prompt) {
		if (matchRule(rule, request)) return 'prompt';
	}
	for (const rule of policy.allow) {
		if (matchRule(rule, request)) return 'allow';
	}
	// Default: prompt. Better to bother the user than to silently
	// approve a tool call the spec didn't anticipate.
	return 'prompt';
}

/**
 * A rule matches when:
 *   1. The tool name matches (case-sensitive exact OR `*` wildcard).
 *   2. AT LEAST ONE of the rule's matchers matches:
 *        - `paths` against the request's path/file_path field
 *        - `commands` against the request's command string
 *      If the rule has NO matchers (just `tool`), the tool match
 *      alone is enough.
 */
export function matchRule(rule: PermissionRule, request: ToolRequest): boolean {
	if (!matchTool(rule.tool, request.tool)) return false;

	const hasPaths    = rule.paths    !== undefined && rule.paths.length > 0;
	const hasCommands = rule.commands !== undefined && rule.commands.length > 0;
	if (!hasPaths && !hasCommands) return true;

	if (hasPaths) {
		const path = extractPath(request.input);
		if (path !== undefined) {
			for (const pattern of rule.paths!) {
				if (matchGlob(pattern, path)) return true;
			}
		}
	}
	if (hasCommands) {
		const command = extractCommand(request.input);
		if (command !== undefined) {
			for (const pattern of rule.commands!) {
				if (matchCommand(pattern, command)) return true;
			}
		}
	}
	return false;
}

function matchTool(rulePattern: string, toolName: string): boolean {
	if (rulePattern === '*' || rulePattern === toolName) return true;
	return false;
}

// ---------------------------------------------------------------------------
// Path glob (minimatch-lite)
// ---------------------------------------------------------------------------

/**
 * Translate a glob pattern to an anchored RegExp.
 *   `*`  -> one path segment (no `/`)
 *   `**` -> any number of segments (including `/`)
 *   `?`  -> a single character (no `/`)
 *   other characters are escaped literally.
 *
 * Pattern is anchored start-to-end.
 */
export function matchGlob(pattern: string, target: string): boolean {
	const regex = globToRegex(pattern);
	return regex.test(target);
}

function globToRegex(pattern: string): RegExp {
	let regex = '^';
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i]!;
		if (c === '*') {
			if (pattern[i + 1] === '*') {
				// `**`  -> .*
				regex += '.*';
				i++;
				// Skip a trailing `/` so `**/x` matches `x` too.
				if (pattern[i + 1] === '/') i++;
			} else {
				// `*`   -> [^/]*
				regex += '[^/]*';
			}
		} else if (c === '?') {
			regex += '[^/]';
		} else if ('.+()[]{}^$|\\'.includes(c)) {
			regex += `\\${c}`;
		} else {
			regex += c;
		}
	}
	regex += '$';
	return new RegExp(regex);
}

function extractPath(input: ToolInput): string | undefined {
	const obj = input as { path?: unknown; file_path?: unknown };
	if (typeof obj.file_path === 'string') return obj.file_path;
	if (typeof obj.path === 'string')      return obj.path;
	return undefined;
}

// ---------------------------------------------------------------------------
// Command match
// ---------------------------------------------------------------------------

/**
 * Match a pattern against a command string. A pattern is either:
 *   - a plain substring (e.g. "git push" matches "git push origin main")
 *   - a glob with `*` for variable tokens (e.g. "git push *")
 */
export function matchCommand(pattern: string, command: string): boolean {
	if (pattern.includes('*')) {
		return matchGlob(pattern, command);
	}
	return command.includes(pattern);
}

function extractCommand(input: ToolInput): string | undefined {
	const obj = input as { command?: unknown };
	if (typeof obj.command === 'string') return obj.command;
	return undefined;
}
