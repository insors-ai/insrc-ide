/**
 * Agent framework types — message protocol, state machines, checkpoints.
 *
 * All agent ↔ transport communication uses typed AgentMessage envelopes.
 * Agents are step-based state machines with serializable checkpoints.
 */

import type {
  AgentConfig, LLMProvider, RecordFeedbackOpts,
  ConfigNamespace, ConfigSearchOpts, ConfigSearchResult,
  TemplateQuery, ConfigEntry,
} from '../../shared/types.js';
import type { TodosApi } from '../../shared/todos.js';

// ---------------------------------------------------------------------------
// Message envelope
// ---------------------------------------------------------------------------

export interface AgentMessage<T = unknown> {
  id:        string;
  agentId:   string;
  /** Variant of the agent family when multiple definitions share `agentId`.
   *  E.g. `'pair'` or `'delegate'` under the `'implementation'` family.
   *  Absent when the family has no variants. */
  agentVariant?: string | undefined;
  runId:     string;
  kind:      string;
  payload:   T;
  timestamp: string;
  replyTo?:  string | undefined;
}

// ---------------------------------------------------------------------------
// Outbound messages (agent → transport)
// ---------------------------------------------------------------------------

export interface EmitPayload {
  text: string;
  stream?: boolean | undefined;
}

export interface GatePayload {
  gateId:   string;
  stage:    string;
  title:    string;
  content:  string;
  actions:  GateAction[];
  context?: Record<string, unknown> | undefined;
}

export interface GateAction {
  name:       string;
  label:      string;
  hint?:      string | undefined;
  needsInput?: boolean | undefined;
  /**
   * Prefix payload carried alongside an `approve-prefix` action
   * (Phase 5 of plans/access-gate.md). When the user clicks an
   * action that has this set, the workbench echoes it back in the
   * reply so the daemon's gate dispatcher can call
   * AccessStore.approvePrefix(kind, prefix) and cascade the grant
   * to every descendant key. The dispatcher (executor.fireAccessGate)
   * pre-populates this for fs-path / cloud-resource gates so the
   * UI doesn't have to do path arithmetic.
   */
  prefix?:    string | undefined;
}

export interface DonePayload {
  result:  unknown;
  summary: string;
}

export interface ErrorPayload {
  error:       string;
  recoverable: boolean;
}

export interface CheckpointPayload {
  stepIndex: number;
  label:     string;
}

export interface ProgressPayload {
  message: string;
  pct?:    number | undefined;
}

// ---------------------------------------------------------------------------
// Inbound messages (transport → agent)
// ---------------------------------------------------------------------------

export interface ReplyPayload {
  gateId:    string;
  action:    string;
  feedback?: string | undefined;
  /**
   * Prefix echoed back from a clicked action that carried one
   * (typically `approve-prefix` for fs-path / cloud-resource scopes;
   * see GateAction.prefix). The daemon's executor.fireAccessGate
   * uses this to call AccessStore.approvePrefix(kind, prefix).
   */
  prefix?:   string | undefined;
}

export interface CancelPayload {
  reason?: string | undefined;
}

// ---------------------------------------------------------------------------
// Message kind constants
// ---------------------------------------------------------------------------

export type OutboundKind = 'emit' | 'gate' | 'done' | 'error' | 'checkpoint' | 'progress';
export type InboundKind  = 'reply' | 'cancel';
export type MessageKind  = OutboundKind | InboundKind;

// ---------------------------------------------------------------------------
// Channel — transport abstraction
// ---------------------------------------------------------------------------

export interface Channel {
  /** Non-blocking send for emit/progress/checkpoint/done/error. */
  send(msg: AgentMessage): void;

  /** Blocking gate: send gate message, wait for reply. Throws on cancel. */
  gate(msg: AgentMessage<GatePayload>): Promise<ReplyPayload>;

  /** Subscribe to inbound messages (cancel, etc.). */
  onMessage(handler: (msg: AgentMessage) => void): void;

  /** Signal that the agent run is complete. */
  close(): void;
}

// ---------------------------------------------------------------------------
// Agent state machine
// ---------------------------------------------------------------------------

/** Serializable agent state — must survive JSON.parse(JSON.stringify(...)). */
export type AgentState = Record<string, unknown>;

/** A single step in the agent workflow. */
export interface AgentStep<S extends AgentState = AgentState> {
  name: string;
  /** Execute the step. Returns updated state and the name of the next step (null = done). */
  run(state: S, ctx: StepContext): Promise<StepResult<S>>;
  /** Artifacts this step produces. Checked on resume — missing artifacts trigger rollback. */
  artifacts?: ((state: S) => string[]) | undefined;
}

export interface StepResult<S extends AgentState = AgentState> {
  state: S;
  next:  string | null;
}

export interface StepContext {
  channel:   Channel;
  runId:     string;
  agentId:   string;
  runDir:    string;
  config:    AgentConfig;
  providers: {
    local:  LLMProvider;
    claude: LLMProvider | null;
    /** Resolve provider for an agent step. Falls back to local if Claude unavailable. */
    resolve: (agent: string, step: string) => LLMProvider;
    /** Like resolve() but returns null when Claude is unavailable for optional slots. */
    resolveOrNull: (agent: string, step: string) => LLMProvider | null;
  };
  /** Emit progress update (non-blocking). */
  progress(msg: string, pct?: number): void;
  /** Request user input at a gate. Blocks until reply. */
  gate(opts: GateOpts): Promise<ReplyPayload>;
  /** Emit text output (non-blocking). */
  emit(text: string, stream?: boolean): void;
  /** RPC to daemon (best-effort — returns null if daemon unavailable). */
  rpc<T = unknown>(method: string, params?: unknown): Promise<T | null>;
  /** Write an artifact to the run's artifacts/ directory. Returns the full path. */
  writeArtifact(name: string, content: string): string;
  /** Read an artifact from a prior step. Returns null if not found. */
  readArtifact(name: string): string | null;
  /** Record feedback to the config management system. */
  recordFeedback?: ((opts: RecordFeedbackOpts) => Promise<void>) | undefined;
  /** Search config entries (templates, feedback, conventions). */
  searchConfig?: ((opts: ConfigSearchOpts) => Promise<ConfigSearchResult[]>) | undefined;
  /** Resolve a specific template by name with semantic fallback. */
  resolveTemplate?: ((opts: TemplateQuery) => Promise<ConfigEntry | null>) | undefined;
  /** AbortSignal — set when a cancel message is received. */
  signal: AbortSignal;
  /**
   * TodosApi bound to the agent's family id (plans/todo-framework.md
   * Phase 3 / 6). Constructed in the daemon-side runAgent call site
   * and threaded through by the runner. Undefined for callers that
   * don't provide one -- agents should treat it as optional and
   * skip gracefully when absent.
   */
  todos?: TodosApi | undefined;
  /**
   * Id of the chat session this run belongs to. Paired with `todos`
   * so agent steps can create session-scoped todo lists without
   * needing an extra parameter on their input. Undefined when the
   * run is not attached to a chat session (CLI dry runs, tests).
   */
  sessionId?: string | undefined;
}

export interface GateOpts {
  stage:    string;
  title:    string;
  content:  string;
  actions:  GateAction[];
  context?: Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// Agent definition
// ---------------------------------------------------------------------------

export interface AgentDefinition<S extends AgentState = AgentState> {
  /** Agent family id (AgentFamily from `shared/agent-registry.ts`). E.g.
   *  `'implementation'`, `'designer'`, `'brainstorm'`. Multiple definitions
   *  may share an `id` when the family has variants (see `variant`). */
  id:      string;
  /** Optional variant discriminator within a family. E.g. `'pair'` or
   *  `'delegate'` under the `'implementation'` family. Undefined for
   *  single-variant families. The pair `(id, variant)` is what uniquely
   *  identifies a definition at runtime; variant is written to
   *  checkpoints / run-index entries / messages so persistence and
   *  filters can distinguish the variant later. */
  variant?: string | undefined;
  /** State schema version. Incremented when state shape changes. */
  version: number;
  /** Config namespace for loading templates/conventions/feedback. */
  configNamespace?: ConfigNamespace | undefined;
  /** Create initial state from user-provided input. */
  initialState: (input: unknown) => S;
  /** All steps keyed by name. */
  steps:   Record<string, AgentStep<S>>;
  /** Entry point step name. */
  firstStep: string;
  /** Migrate state from an older version on resume. */
  migrate?: ((state: AgentState, fromVersion: number) => S) | undefined;
}

// ---------------------------------------------------------------------------
// Checkpoint and run state
// ---------------------------------------------------------------------------

export type RunStatus = 'running' | 'paused' | 'completed' | 'failed' | 'crashed';

export interface CompletedStep {
  name:       string;
  durationMs: number;
  timestamp:  string;
}

export interface Checkpoint {
  runId:          string;
  agentId:        string;
  /** Variant within the family when applicable (see AgentDefinition.variant). */
  agentVariant?:  string | undefined;
  version:        number;
  stepName:       string;
  stepIndex:      number;
  state:          AgentState;
  status:         RunStatus;
  pid:            number;
  heartbeat:      string;
  createdAt:      string;
  completedSteps: CompletedStep[];
}

export interface RunMeta {
  agentId:   string;
  /** Variant within the family when applicable. */
  agentVariant?: string | undefined;
  version:   number;
  repo:      string;
  createdAt: string;
  inputHash: string;
}

export interface RunIndexEntry {
  runId:     string;
  agentId:   string;
  /** Variant within the family when applicable. */
  agentVariant?: string | undefined;
  repo:      string;
  status:    RunStatus;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Runner options and result
// ---------------------------------------------------------------------------

export interface RunOptions {
  /** Resume from this checkpoint instead of starting fresh. */
  resumeFrom?: Checkpoint | undefined;
  /** Agent input (ignored if resuming). */
  input?: unknown;
  /** Repository path for this run. */
  repo?: string | undefined;
}

export interface RunResult {
  runId:   string;
  result:  unknown;
  summary: string;
  steps:   number;
  resumed: boolean;
}
