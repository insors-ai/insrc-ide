/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Handoff top-level orchestrator: `runHandoff`.
 *
 * One call composes everything Days 1-4 built:
 *
 *   1. assembleSpec  -- scope + memory + intent -> AssembledSpec
 *   2. createWorktree -- git worktree off HEAD of the source repo
 *   3. spawn agent    -- claude-code (Day 3) by default; scripted-agent
 *                        in tests + CLI dry-run
 *   4. auditDeliverable -- parser + machine-checks + judge ->
 *                        AuditResult
 *   5. diffWorktreeAgainstHead -- the actual file changes the agent
 *                        produced, ready for Day 5 CLI to render
 *
 * The orchestrator does NOT decide what to do with the verdict --
 * callers (CLI command, Phase 2b VS Code extension) route on it.
 * `accept`-on-success commits the diff; `revise-*` re-spawns or kicks
 * back to the user.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { assembleSpec, type SpecAssemblerInput } from './spec-assembler.js';
import { createWorktree, diffWorktreeAgainstHead, removeWorktree } from './worktree.js';
import { spawnClaudeCode } from './spawn/claude-code.js';
import type { AgentSpawnResult } from './spawn/base.js';
import { auditDeliverable, type AuditResult } from './audit/judge.js';
import { getTemplate } from './templates/registry.js';
import type { AssembledSpec, HandoffEvent, MemoryRef, ScopePayload, TemplateId } from './types.js';
import { getLogger } from '../shared/logger.js';

export type HandoffEventListener = (event: HandoffEvent) => void;

const log = getLogger('handoff:run');

export type AgentChoice = 'claude-code' | 'codex' | 'scripted-agent';

/**
 * Scripted-agent function for tests + CLI dry-run. Receives the
 * assembled spec markdown and returns a synthetic AgentSpawnResult --
 * useful for exercising the audit pipeline without spawning a real
 * agent.
 */
export type ScriptedAgentFn = (spec: string) => Promise<AgentSpawnResult> | AgentSpawnResult;

export interface RunHandoffOpts {
	readonly templateId:      TemplateId;
	readonly intent:          string;
	readonly scope:           ScopePayload;
	readonly memoryRefs:      readonly MemoryRef[];
	readonly templateExtras?: Record<string, unknown> | undefined;
	readonly agent:           AgentChoice;
	/**
	 * MCP server path written into the worktree's .mcp.json (so the
	 * spawned agent auto-discovers insrc's tools). Same path the user
	 * fed to `insrc mcp-setup`.
	 */
	readonly mcpServerPath?:  string | undefined;
	/** Where to root the per-session handoff dir. Default ~/.insrc/handoffs. */
	readonly persistRoot?:    string | undefined;
	readonly sessionId:       string;
	readonly specIdOverride?: string | undefined;
	readonly timeoutMs?:      number | undefined;
	/** Required when `agent === 'scripted-agent'`. */
	readonly scriptedAgent?:  ScriptedAgentFn | undefined;
	/** Test seam: override the claude binary lookup. */
	readonly claudeBinPath?:  string | undefined;
	/**
	 * Absolute path to insrc-permission-hook binary
	 * (out/insrc/bin/permission-hook.js). When set on claude-code
	 * spawn, Mode B PreToolUse gating activates for this handoff.
	 * Undefined -> no Mode B hook (Mode A allowed-tools + Mode C
	 * audit still apply).
	 */
	readonly hookBinPath?:    string | undefined;
	/** Don't delete the worktree on completion. Default: keep on accept, keep on revise so the user can inspect. */
	readonly keepWorktree?:   boolean | undefined;
	/** Cleanup the worktree even on failure (tests). */
	readonly forceCleanup?:   boolean | undefined;
	/**
	 * Stage-transition event callback. Invoked synchronously at each
	 * pipeline boundary with a typed `HandoffEvent`. The daemon's
	 * `handoff.run` stream IPC forwards these into IpcStreamMessages;
	 * CLI callers can pass an inline listener for live progress;
	 * tests assert call order + payload shapes.
	 *
	 * The callback MUST NOT throw -- errors are swallowed via try/catch
	 * around each invocation to avoid breaking the pipeline.
	 */
	readonly onEvent?:        HandoffEventListener | undefined;
}

export interface RunHandoffResult {
	readonly spec:        AssembledSpec;
	readonly spawnResult: AgentSpawnResult;
	readonly audit:       AuditResult;
	readonly diff:        string;
	readonly worktreePath: string;
}

const DEFAULT_PERSIST_ROOT = join(homedir(), '.insrc', 'handoffs');

export async function runHandoff(opts: RunHandoffOpts): Promise<RunHandoffResult> {
	const persistRoot  = opts.persistRoot ?? DEFAULT_PERSIST_ROOT;
	const worktreePath = join(persistRoot, opts.sessionId, 'worktree');

	const emit = (event: HandoffEvent): void => {
		if (opts.onEvent === undefined) return;
		try { opts.onEvent(event); } catch (err) {
			log.warn({ err: (err as Error).message }, 'handoff onEvent listener threw; swallowing');
		}
	};

	// 1. Assemble the spec.
	emit({ kind: 'spec-assembling', intent: opts.intent, templateId: opts.templateId });
	const template = getTemplate(opts.templateId);
	const assemblerInput: SpecAssemblerInput = {
		templateId:     opts.templateId,
		intent:         opts.intent,
		scope:          opts.scope,
		memoryRefs:     opts.memoryRefs,
		worktreePath,
		timeBudgetSec:  600,
		persistRoot,
		sessionId:      opts.sessionId,
		...(opts.specIdOverride !== undefined ? { specIdOverride: opts.specIdOverride } : {}),
		...(opts.templateExtras !== undefined ? { templateExtras: opts.templateExtras } : {}),
	};
	let spec: AssembledSpec;
	try {
		spec = assembleSpec(assemblerInput);
	} catch (err) {
		emit({ kind: 'handoff-error', stage: 'spec-assemble', message: (err as Error).message });
		throw err;
	}
	log.info({ specId: spec.specId, templateId: opts.templateId }, 'handoff: spec assembled');
	emit({ kind: 'spec-ready', specId: spec.specId, templateId: opts.templateId, preview: spec.specMd.slice(0, 200) });

	// 2. Create the worktree off HEAD of the source repo.
	let createResult: Awaited<ReturnType<typeof createWorktree>>;
	try {
		createResult = await createWorktree({ repoPath: opts.scope.repoPath, worktreePath });
	} catch (err) {
		emit({ kind: 'handoff-error', stage: 'worktree', message: (err as Error).message });
		throw err;
	}
	emit({ kind: 'worktree-created', specId: spec.specId, worktreePath: createResult.worktreePath, ref: createResult.ref });

	let spawnResult: AgentSpawnResult;
	try {
		// 3. Spawn the agent.
		emit({ kind: 'spawned', specId: spec.specId, agent: opts.agent });
		try {
			spawnResult = await dispatchSpawn(opts, spec.specMd, worktreePath, spec.specId);
		} catch (err) {
			emit({ kind: 'handoff-error', stage: 'spawn', message: (err as Error).message });
			throw err;
		}
		log.info({ specId: spec.specId, exitCode: spawnResult.exitCode, durationMs: spawnResult.durationMs },
			'handoff: agent returned');
		emit({
			kind: 'agent-completed', specId: spec.specId,
			exitCode: spawnResult.exitCode, durationMs: spawnResult.durationMs,
			stdoutLen: spawnResult.stdout.length,
		});

		// 4. Audit the deliverable.
		emit({ kind: 'auditing', specId: spec.specId });
		let audit: AuditResult;
		try {
			audit = await auditDeliverable({
				deliverable:        spawnResult.stdout,
				requiredSections:   template.requiredDeliverableSections,
				acceptanceCriteria: spec.meta.acceptanceCriteria,
				cwd:                worktreePath,
			});
		} catch (err) {
			emit({ kind: 'handoff-error', stage: 'audit', message: (err as Error).message });
			throw err;
		}
		log.info({ specId: spec.specId, verdict: audit.verdict }, 'handoff: audit verdict');

		// 5. Compute the diff against HEAD for the caller to display / apply.
		let diff: string;
		try {
			diff = await diffWorktreeAgainstHead({ repoPath: opts.scope.repoPath, worktreePath });
		} catch (err) {
			emit({ kind: 'handoff-error', stage: 'diff', message: (err as Error).message });
			throw err;
		}
		emit({
			kind: 'audit-ready', specId: spec.specId,
			verdict: audit.verdict, reason: audit.reason,
			editHintCount:     audit.editHints.length,
			machineCheckCount: audit.machineResults.length,
			diffBytes:         diff.length,
		});
		emit({ kind: 'handoff-final', specId: spec.specId, verdict: audit.verdict, diff, worktreePath });

		return { spec, spawnResult, audit, diff, worktreePath };
	} finally {
		if (opts.forceCleanup === true) {
			await removeWorktree({ repoPath: opts.scope.repoPath, worktreePath });
		}
	}
}

async function dispatchSpawn(opts: RunHandoffOpts, spec: string, worktreePath: string, specId: string): Promise<AgentSpawnResult> {
	if (opts.agent === 'scripted-agent') {
		if (opts.scriptedAgent === undefined) {
			throw new Error("runHandoff: agent='scripted-agent' requires scriptedAgent fn");
		}
		const start = Date.now();
		const partial = await opts.scriptedAgent(spec);
		return {
			stdout:     partial.stdout,
			stderr:     partial.stderr,
			exitCode:   partial.exitCode,
			durationMs: partial.durationMs > 0 ? partial.durationMs : Date.now() - start,
		};
	}
	if (opts.agent === 'codex') {
		const { spawnCodex } = await import('./spawn/codex.js');
		const codexOpts: Parameters<typeof spawnCodex>[0] = {
			worktreePath,
			spec,
			sessionId:     opts.sessionId,
			specId,
			mcpServerPath: opts.mcpServerPath ?? '/abs/path/insrc-mcp-server.js',
		};
		if (opts.timeoutMs !== undefined) (codexOpts as { timeoutMs?: number }).timeoutMs = opts.timeoutMs;
		return spawnCodex(codexOpts);
	}
	// claude-code path
	const claudeOpts: Parameters<typeof spawnClaudeCode>[0] = {
		worktreePath,
		spec,
		sessionId:     opts.sessionId,
		specId,
		mcpServerPath: opts.mcpServerPath ?? '/abs/path/insrc-mcp-server.js',
	};
	if (opts.timeoutMs !== undefined)    (claudeOpts as { timeoutMs?: number }).timeoutMs    = opts.timeoutMs;
	if (opts.claudeBinPath !== undefined) (claudeOpts as { claudeBinPath?: string }).claudeBinPath = opts.claudeBinPath;
	if (opts.hookBinPath !== undefined)  (claudeOpts as { hookBinPath?: string }).hookBinPath  = opts.hookBinPath;
	return spawnClaudeCode(claudeOpts);
}
