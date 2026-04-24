/**
 * Unified Tool type.
 *
 * A Tool is a single capability invoked via two entry paths:
 *   - LLM tool-call (via the tool-loop)
 *   - Controller task (`kind: 'tool'`)
 *
 * Both paths share this contract, the registry, and the executor so
 * approval gating, schema validation, and progress streaming happen in
 * one place regardless of who invoked the tool.
 */

import type { Session } from '../../agent/session.js';
import type { IpcStreamMessage } from '../../shared/types.js';
import type { DaemonChannel } from '../channel.js';
import type { GateAction } from '../../agent/framework/types.js';
import type { TodosApi } from '../../shared/todos.js';

// ---------------------------------------------------------------------------
// Tool contract
// ---------------------------------------------------------------------------

export type ToolFormat =
  | 'text' | 'markdown' | 'code' | 'json' | 'diff' | 'table';

export interface ToolInput { [key: string]: unknown }

export interface ToolResult {
  /** Rendered output surfaced to the caller and persisted on agent turns. */
  output: string;
  /** Render hint for the UI. */
  format: ToolFormat;
  /** True when execution completed without an error. */
  success: boolean;
  /** Error message when success is false. */
  error?: string | undefined;
  /**
   * Optional structured payload for callers that want more than a string
   * (e.g. web-search exposing its result list to the LLM for further
   * reasoning without re-parsing the rendered text).
   */
  data?: unknown;
}

export interface ToolDeps {
  session: Session;
  /**
   * Channel for approval gate resolution. Optional: when absent, the
   * executor logs and auto-approves (matches the legacy delegate fallback).
   */
  channel?: DaemonChannel | undefined;
  /** Stream-message emitter for progress / gate events. */
  send: (msg: IpcStreamMessage) => void;
  /** IPC request id -- used to correlate stream events. */
  requestId: number;
  /**
   * Cancellation signal. Tools that run long operations should respect this.
   * Defaults to a non-aborting signal when the caller does not supply one.
   */
  signal?: AbortSignal | undefined;
  /**
   * Pre-built TodosApi scoped to the calling agent's family (or
   * `'chat'` for LLM tool-loop turns without an active controller).
   * Tools that persist to TODO-framework storage should read through
   * this rather than constructing their own instance -- the caller
   * owns `caller` attribution, not the tool. Optional for backward
   * compatibility with existing tool call sites that don't know
   * about it; new tools should assume it's present in production.
   */
  todos?: TodosApi | undefined;
}

export interface ToolApprovalGate {
  title: string;
  content: string;
  actions: GateAction[];
}

export interface Tool {
  /** Unique canonical ID. Namespacing convention: 'domain:action'. */
  readonly id: string;

  /** One-sentence description -- surfaced to the LLM and to the gate UI. */
  readonly description: string;

  /**
   * JSON Schema for the input. Used both to advertise the tool to the LLM
   * and to validate controller-supplied input before execute() runs.
   * Schema validation is enforced by the executor (stage 2+).
   */
  readonly inputSchema: Record<string, unknown>;

  /**
   * When truthy, the executor fires an Approve / Skip / Edit gate before
   * calling execute(). A predicate lets a tool opt in per-input (e.g.
   * shell:exec auto-runs low-risk commands, gates higher-risk ones).
   */
  readonly requiresApproval?: boolean | ((input: ToolInput) => boolean);

  /**
   * Optional alias IDs. Lets legacy tool names (Read, Bash, WebSearch, ...)
   * resolve to the canonical entry during migration. Aliases are preferred
   * over duplicate registrations.
   */
  readonly aliases?: readonly string[];

  /**
   * Flags the tool as destructive / irreversible (terminate VM, drop
   * database, recursive rm, force push to protected branch). The
   * executor applies a second "Are you sure?" approval gate after the
   * normal one when `insrc.tools.destructive.requireDoubleConfirm` is
   * on, even if the tool already verified an in-band confirmation
   * token (confirmBucket, confirmCount, confirmService, ...).
   */
  readonly destructive?: boolean;

  /**
   * Build the approval gate shown to the user. The default gate is
   * generic -- tools that care should override to show query / command /
   * diff previews. May be async when the gate needs live repo / cluster
   * state (e.g. git:amend checking if HEAD has already been pushed).
   */
  buildApprovalGate?(input: ToolInput): ToolApprovalGate | Promise<ToolApprovalGate>;

  /**
   * Apply the user's Edit feedback to input before re-gating. Default
   * behavior: replace input.query with the feedback text.
   */
  applyEdit?(input: ToolInput, feedback: string): ToolInput;

  /** Do the work. */
  execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult>;
}
