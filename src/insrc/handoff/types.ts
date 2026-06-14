/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Handoff top-level types.
 *
 * The Phase 2a pipeline turns a scope payload + memory excerpts +
 * acceptance criteria into an assembled spec that the external
 * coding agent (Claude Code, Codex) consumes. None of these types
 * carry pre-fetched source code or extracted entity content -- per
 * design §4.0, discovery is the external agent's job and happens
 * AT EXECUTION TIME via the MCP tools (Phase 1 surface). The spec
 * is scope + criteria + memory pointers, not pre-rendered context.
 *
 * Design refs:
 *   - design/external-agent-integration.md §5 "Handoff Templates"
 *   - design/external-agent-integration.md §5.2 "Template structure"
 *   - plans/external-agent-integration.md §2a.2 "Spec assembler"
 */

/**
 * Set of known template ids. Adding a new template means:
 *   1. Append the id here.
 *   2. Add the render module under `handoff/templates/`.
 *   3. Register it in `templates/registry.ts`.
 *   4. Pin its spec + deliverable structure with a test.
 */
export type TemplateId =
	| 'DEBUG-SESSION'
	| 'SPEC'
	| 'DESIGN'
	| 'REQUIREMENTS'
	| 'TEST-PLAN'
	| 'REVIEW'
	| 'MIGRATION'
	| 'AUDIT';

/** Risk tag drives permission ratcheting (Phase 3) + audit mode floor. */
export type RiskTag = 'low' | 'medium' | 'high';

/**
 * Scope payload emitted by section-flow's TODO-decomposition step
 * (under the new role-split rule, design §4.0). The local LLM decides
 * "this objective maps to template T with scope S and risk R" -- no
 * source-code or data-shape extraction here.
 */
export interface ScopePayload {
	/** Repo registry key (path). */
	readonly repoId:                  string;
	/** Absolute path of the repo on disk (same as repoId today). */
	readonly repoPath:                string;
	/** Globs the external agent may read/edit inside the worktree. */
	readonly inScopeGlobs:            readonly string[];
	/** Paths the external agent MUST NOT modify (deny rule at audit). */
	readonly outOfScopePaths:         readonly string[];
	/** Entity ids the agent should START investigation from, when known. */
	readonly entryPointHints?:        readonly EntityRef[] | undefined;
	/** Other repos in this repo's DEPENDS_ON closure the agent may read. */
	readonly dependencyClosureRepos?: readonly string[] | undefined;
	/** Local LLM's risk read; deterministic ratchet may raise it (Phase 3). */
	readonly riskHints:               RiskTag;
}

/** Minimal entity reference; the agent resolves details via MCP. */
export interface EntityRef {
	readonly entityId: string;
	/** Optional one-line note about why this is an entry point. */
	readonly note?:    string | undefined;
}

/**
 * Reference to a prior turn or artifact surfaced by
 * `internal.memory.recall`. The spec includes the ref + a one-line
 * summary so the agent knows it CAN look the rest up via
 * `insrc_memory_recall` or `insrc_artifact_get` -- not a content dump.
 */
export interface MemoryRef {
	readonly kind:            'turn' | 'artifact';
	readonly id:              string;
	readonly oneLineSummary:  string;
}

/**
 * One acceptance criterion. Machine-verifiable criteria run
 * deterministically at audit time; soft criteria require either the
 * cloud-judge shim (optional, §6.6 step 25) or fall through to a
 * user-confirmation gate.
 */
export interface AcceptanceCriterion {
	readonly id:          string;
	readonly description: string;
	readonly kind:        'machine' | 'soft';
	/**
	 * For `kind: 'machine'`, a structured verifier descriptor.
	 * For `kind: 'soft'`, undefined; the judge handles it.
	 */
	readonly verifier?:   MachineVerifier | undefined;
}

/**
 * Machine-verifier shapes the deterministic audit pipeline understands.
 * Phase 4 (audit) adds the dispatch. Phase 2a only emits these into
 * the spec.
 */
export type MachineVerifier =
	| { readonly type: 'file-exists';  readonly path: string }
	| { readonly type: 'regex-match';  readonly path: string; readonly pattern: string }
	| { readonly type: 'shell-exit';   readonly command: string; readonly cwd?: string | undefined; readonly timeoutMs?: number | undefined };

/** Permission policy block emitted into the spec (Phase 3 gating). */
export interface PermissionsBlock {
	readonly allow:  readonly PermissionRule[];
	readonly prompt: readonly PermissionRule[];
	readonly deny:   readonly PermissionRule[];
}

export interface PermissionRule {
	readonly tool:      string;
	readonly paths?:    readonly string[] | undefined;
	readonly commands?: readonly string[] | undefined;
}

/**
 * What `runHandoff` returns to callers (CLI command, future VS Code
 * extension). The spec.md and meta.json are also persisted under
 * `~/.insrc/handoffs/<sessionId>/` per design §7.1.
 */
export interface AssembledSpec {
	readonly specId:      string;
	readonly templateId:  TemplateId;
	readonly specMd:      string;
	readonly meta:        SpecMeta;
}

export interface SpecMeta {
	readonly specId:               string;
	readonly templateId:           TemplateId;
	readonly templateVersion:      number;
	readonly intent:               string;
	readonly scope:                ScopePayload;
	readonly memoryRefs:           readonly MemoryRef[];
	readonly acceptanceCriteria:   readonly AcceptanceCriterion[];
	readonly permissions:          PermissionsBlock;
	readonly riskTag:              RiskTag;
	readonly worktreePath:         string;
	readonly timeBudgetSec:        number;
}

/**
 * Stage-transition events runHandoff emits during execution. Used by
 * the `handoff.run` streaming IPC (daemon/index.ts) to surface
 * progress to subscribers (CLI, VS Code extension, future UIs) so
 * they can render the pipeline without polling.
 *
 * Discriminated union -- subscribers route on `kind`. Each variant
 * is intentionally compact (~1 KB serialised) so the stream stays
 * cheap; the heavy payload (diff, spec markdown) lands on the final
 * `handoff-final` and on dedicated reads.
 */
export type HandoffEvent =
	| { readonly kind: 'spec-assembling'; readonly intent: string; readonly templateId: TemplateId }
	| { readonly kind: 'spec-ready';      readonly specId: string;  readonly templateId: TemplateId;
	    /** First ~200 chars of the spec markdown for a UI preview. */
	    readonly preview: string }
	| { readonly kind: 'worktree-created'; readonly specId: string; readonly worktreePath: string; readonly ref: string }
	| { readonly kind: 'spawned';          readonly specId: string; readonly agent: 'claude-code' | 'codex' | 'scripted-agent' }
	/**
	 * Live stdout chunk from the running agent subprocess. Emitted
	 * verbatim as Node's child-process data events arrive (one
	 * `agent-stdout-chunk` per `child.stdout.on('data')` callback).
	 * Subscribers in terminal-UX mode (Phase 2c) pipe these into a
	 * Pseudoterminal; headless-UX subscribers drop them.
	 */
	| { readonly kind: 'agent-stdout-chunk'; readonly specId: string; readonly chunk: string }
	/** Live stderr chunk; see `agent-stdout-chunk` for shape. */
	| { readonly kind: 'agent-stderr-chunk'; readonly specId: string; readonly chunk: string }
	| { readonly kind: 'agent-completed';  readonly specId: string; readonly exitCode: number; readonly durationMs: number;
	    /** Length of the raw stdout deliverable; useful for size telemetry. */
	    readonly stdoutLen: number }
	| { readonly kind: 'auditing';         readonly specId: string }
	| { readonly kind: 'audit-ready';      readonly specId: string;
	    readonly verdict: 'accept' | 'revise-edits' | 'revise-major';
	    readonly reason:  string;
	    readonly editHintCount: number;
	    readonly machineCheckCount: number;
	    /** Diff size in bytes; the diff itself lands on `handoff-final`. */
	    readonly diffBytes: number }
	| { readonly kind: 'handoff-final';    readonly specId: string;
	    readonly verdict: 'accept' | 'revise-edits' | 'revise-major';
	    readonly diff:   string;
	    readonly worktreePath: string }
	| { readonly kind: 'handoff-error';    readonly stage: 'spec-assemble' | 'worktree' | 'spawn' | 'audit' | 'diff';
	    readonly message: string };
