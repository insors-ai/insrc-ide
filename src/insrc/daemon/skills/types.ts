/**
 * Skill type contract.
 *
 * Skills sit between raw tools (one daemon function call) and end-to-
 * end agents (multi-turn pipelines). A skill is a typed, composable,
 * registered unit of capability that any agent or analyzer in the
 * daemon can invoke through a uniform `runSkill()` API. See
 * plans/analyzers/skills-core.md for the full architectural rationale.
 *
 * Three invocation paths land on the same Skill:
 *
 *   - typed agent-to-agent          via `runSkill('id', input, deps)`
 *   - LLM-exposed (closed-list)     via the `invoke_skill` meta-tool
 *   - workbench / CLI               via the `skill.invoke` RPC
 *
 * Skills do not host their own state machine, gate UI, or session.
 * Those concerns belong to agents. A skill's `execute()` body must be
 * idempotent in the sense that re-running it with the same inputs and
 * deps yields equivalent outputs (within sampling variance for live
 * data); the registry's confidence calibration relies on this.
 */

import type { Session } from '../../agent/session.js';
import type { LLMProvider, ToolCall } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Family / owner enums
// ---------------------------------------------------------------------------

/**
 * Categorical bucket for settings gating + telemetry. The set is
 * deliberately finite -- adding a new family requires a code change in
 * this file plus a matching default-enabled entry in tool config (see
 * plans/analyzers/skills-core.md, "Lessons baked in" §1).
 */
export type SkillFamily =
  | 'source-introspection'
  | 'source-sampling'
  | 'comparison-diff'
  | 'code-binding'
  | 'lineage'
  | 'quality-profile'
  | 'distribution'
  | 'dependency'
  | 'sensitivity'
  | 'drift'
  | 'timeseries'
  | 'synthesis'
  | 'meta';

/**
 * Analyzer family that owns a skill. Drives cross-owner depth
 * accounting in `runSkill`. `shared` denotes a skill not owned by any
 * single analyzer (generic synthesis renderers, json-schema
 * validators, etc.); calls into `shared` skills do not add a depth
 * increment regardless of caller.
 */
export type SkillOwner =
  | 'data-analyzer'
  | 'code-analyzer'
  | 'deploy-analyzer'
  | 'test-agent'
  | 'shared';

export type SkillConfidence = 'high' | 'medium' | 'low';

export type ProviderAffinity = 'local' | 'cloud' | 'auto';

// ---------------------------------------------------------------------------
// Preconditions + feasibility
// ---------------------------------------------------------------------------

/**
 * Preconditions are checked before `execute()` runs. Failing a
 * precondition does not throw -- it short-circuits the skill with
 * `confidence: 'low'` and the reasons attached as notes. Skills that
 * genuinely cannot produce useful output below a precondition should
 * still emit a sane shape (typically a null / empty value).
 */
export type Precondition =
  | {
      readonly kind: 'min-sample-size';
      readonly n: number;
      readonly reason: string;
    }
  | {
      readonly kind: 'required-tools';
      readonly tools: readonly string[];
      readonly reason: string;
    }
  | {
      readonly kind: 'connection-family';
      readonly families: readonly string[];
      readonly reason: string;
    }
  | {
      readonly kind: 'connection-property';
      readonly property: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'cross-owner-allowed';
      readonly reason: string;
    };

export interface PreconditionFailure {
  readonly precondition: Precondition;
  readonly detail: string;
}

export type Feasibility =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasons: readonly PreconditionFailure[] };

// ---------------------------------------------------------------------------
// Skill execution context + deps
// ---------------------------------------------------------------------------

/**
 * Runtime context for feasibility checks. The registry hands this in
 * before `execute()` runs; preconditions consume the relevant subset
 * (sample-size precondition reads `availableSampleSize`, etc.).
 *
 * `availableSampleSize: null` means "unknown" -- the precondition
 * passes by default. Skills that genuinely require a known sample
 * size should declare a tighter `connection-property` precondition
 * (e.g. requiring the connection to expose a row count).
 */
export interface SkillContext {
  readonly session: Session;
  readonly availableSampleSize?: number | null;
  /** Owner of the agent / skill that issued this invocation. */
  readonly callerOwner?: SkillOwner;
  /** Current depth in the skill-call chain. */
  readonly skillDepth?: number;
}

export interface RunSkillOpts {
  /** Owner of the skill / agent making the call -- drives depth accounting. */
  readonly callerOwner?: SkillOwner;
  /** Current depth. Defaults to 0 (top-level invocation). */
  readonly skillDepth?: number;
  /** Effective sample size available to the callee. */
  readonly availableSampleSize?: number | null;
  /** Emit `liveStep` stream events for each tool call inside the skill. */
  readonly streamProgress?: boolean;
  /** Pin a specific version. Defaults to the highest registered. */
  readonly version?: number;
}

/**
 * The wrapped tool-call result a skill consumes via `deps.runTool`.
 * Mirrors the unified tool result shape but flattens the format /
 * data fields so skills don't have to import the tool types.
 */
export interface SkillToolResult {
  readonly content: string;
  readonly isError: boolean;
  readonly data?: unknown;
}

/**
 * The bundle of capabilities a skill's `execute()` body has access
 * to. Keep this surface small: skills should never reach past these
 * fields into the daemon's internals (no direct DB, no direct
 * keychain, no direct fs). Helper functions inside the skill module
 * are fine; reaching out of the file isn't.
 */
export interface SkillDeps {
  readonly session: Session;
  /** Invoke another registered skill with depth + cross-owner accounting. */
  readonly runSkill: <I, O>(
    id: string,
    input: I,
    opts?: RunSkillOpts,
  ) => Promise<SkillResult<O>>;
  /** Invoke a registered tool. Wraps `executeTool` + the access gate. */
  readonly runTool: (call: ToolCall) => Promise<SkillToolResult>;
  /** Resolve the LLM provider for this skill's affinity. */
  readonly resolveProvider: () => LLMProvider;
  /** Telemetry hook. */
  readonly emit: (event: SkillEvent) => void;
  /** Cancellation. */
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface SkillToolCallSummary {
  readonly toolId: string;
  readonly durationMs: number;
  readonly error?: string;
}

export interface SkillSubSkillSummary {
  readonly skillId: string;
  readonly version: number;
  readonly confidence: SkillConfidence;
  readonly durationMs: number;
}

/**
 * Unified result envelope. The registry CLAMPS confidence based on
 * preconditions + tool-call error trace + sub-skill confidences --
 * the body's claimed confidence is an upper bound, never raised.
 *
 * `notes` is a structured channel for caller-relevant diagnostics
 * that aren't part of the typed value: feasibility rejections,
 * tool-call errors, sub-skill warnings. Surface them via the
 * synthesise pass when relevant; the meta-tool path forwards them
 * verbatim to the LLM as part of the rendered skill output.
 */
export interface SkillResult<O = unknown> {
  readonly value: O;
  readonly confidence: SkillConfidence;
  readonly notes?: readonly string[];
  readonly toolCalls: readonly SkillToolCallSummary[];
  readonly subSkillCalls?: readonly SkillSubSkillSummary[];
  readonly truncated?: boolean;
  /**
   * Set ONLY on rejection paths -- categorises *why* the runner short-
   * circuited (input failed validation, feasibility failed, the skill
   * body threw, output failed validation, ...). Downstream consumers
   * branch on this without substring-matching notes. Always absent
   * when the skill executed cleanly.
   */
  readonly rejectionReason?: SkillRejectReason;
  /**
   * Reference to the on-disk spill of the full structured payload --
   * populated by the runner's `onSkillEnd` hook (the spill-writer).
   * Surfaces in the rendered tool_result so the LLM can page through
   * large results via the `skill_load_page` meta-tool. Phase B of
   * plans/code-analyzer-interleaved-investigation.md.
   */
  readonly spillRecord?: SkillSpillRecord;
}

/**
 * On-disk spill location for a SkillResult. Produced by
 * `makeSpillHandler` (agent/artifacts/spill-writer.ts) and threaded
 * through `runSkill` into `SkillResult.spillRecord`.
 */
export interface SkillSpillRecord {
  /** Globally-unique id: `<sessionId>:<timestamp>:<skillId>`. */
  readonly spillId: string;
  /** Absolute path to the JSON file holding the full payload. */
  readonly path:    string;
  /** Size of the on-disk file in bytes. */
  readonly bytes:   number;
}

// ---------------------------------------------------------------------------
// The Skill itself
// ---------------------------------------------------------------------------

export interface Skill<I = unknown, O = unknown> {
  /** Canonical id. Dotted, lowercase, validated at registration. */
  readonly id: string;
  /** Human-readable name; used in palettes / pickers. */
  readonly name: string;
  /** One-line description; surfaced in the LLM closed-list. */
  readonly description: string;
  readonly family: SkillFamily;
  readonly owner: SkillOwner;
  /** Schema version. Hard-coded to 1 in v1. */
  readonly version: number;
  /** JSON Schema for the input. Validated before execute(). */
  readonly inputs: Record<string, unknown>;
  /** JSON Schema for the value field of SkillResult. Validated after execute(). */
  readonly outputs: Record<string, unknown>;
  /** Tool ids called directly by execute(). Drives required-tools feasibility. */
  readonly toolDeps: readonly string[];
  /** Sub-skill ids invoked via runSkill(). Composite skills only. */
  readonly skillDeps?: readonly string[];
  readonly providerAffinity: ProviderAffinity;
  readonly preconditions?: readonly Precondition[];
  /** Telemetry-only soft budget. Hard timeouts live at the agent level. */
  readonly softBudgetMs?: number;
  /** The skill body. */
  execute(input: I, deps: SkillDeps): Promise<SkillResult<O>>;
}

// ---------------------------------------------------------------------------
// Telemetry events
// ---------------------------------------------------------------------------

export type SkillEvent =
  | {
      readonly kind: 'skill-start';
      readonly skillId: string;
      readonly version: number;
      readonly inputDigest: string;
      readonly depth: number;
    }
  | {
      readonly kind: 'skill-feasibility';
      readonly skillId: string;
      readonly ok: boolean;
      readonly reasons?: readonly string[];
    }
  | {
      readonly kind: 'skill-tool-call';
      readonly skillId: string;
      readonly toolId: string;
      readonly durationMs: number;
      readonly error?: string;
    }
  | {
      readonly kind: 'skill-sub-skill';
      readonly parentId: string;
      readonly childId: string;
      readonly depth: number;
    }
  | {
      readonly kind: 'skill-end';
      readonly skillId: string;
      readonly confidence: SkillConfidence;
      readonly durationMs: number;
    }
  /**
   * Telemetry-only over-budget signal -- the skill ran past its
   * declared `softBudgetMs`. NOT a timeout: emit + note, never abort.
   * Plans/analyzers/skills-core.md "Lessons baked in" §3 (no wall-
   * clock caps inside skills).
   */
  | {
      readonly kind: 'skill-over-budget';
      readonly skillId: string;
      readonly durationMs: number;
      readonly budgetMs: number;
    }
  | {
      readonly kind: 'skill-error';
      readonly skillId: string;
      readonly error: string;
    };

// ---------------------------------------------------------------------------
// Reasons + error codes shared across the substrate
// ---------------------------------------------------------------------------

/** All known reason codes the registry / runtime emit on rejection. */
export type SkillRejectReason =
  | 'unknown-skill'
  | 'family-disabled'
  | 'invalid-input'
  | 'invalid-output'
  | 'precondition-failed'
  | 'cross-skill-depth-exceeded'
  | 'execute-threw';

export class SkillInvocationError extends Error {
  constructor(
    public readonly reason: SkillRejectReason,
    message: string,
    public readonly skillId?: string,
  ) {
    super(message);
    this.name = 'SkillInvocationError';
  }
}
