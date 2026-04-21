/**
 * Task execution module — clean pipeline for multi-step requests.
 *
 * A Task describes a single unit of work (shell command, LLM call, agent run).
 * Tasks can have nested sub-tasks for complex operations (e.g., a shell task
 * that needs error analysis → retry as a sub-pipeline).
 *
 * The TaskOrchestrator executes tasks in DAG order, piping output from N to N+1,
 * gating where required, and only sending the final formatted output to the user.
 */

import type { IpcStreamMessage, LLMMessage } from '../shared/types.js'; // LLMProvider, AgentConfig used by executeAgentTask (future)
import type { ReplyPayload } from '../agent/framework/types.js';
import type { DaemonChannel } from './channel.js';
import type { Session } from '../agent/session.js';
import { marked } from 'marked';
import { getLogger } from '../shared/logger.js';

/** Convert markdown to pre-rendered HTML for webview display. */
export function renderMarkdown(text: string): { text: string; format: TaskFormat } {
  const html = marked.parse(text, { async: false }) as string;
  return { text: html, format: 'html-inline' as TaskFormat };
}

const log = getLogger('task');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskFormat = 'text' | 'markdown' | 'code' | 'table' | 'html' | 'html-inline' | 'diff';

/** Task kind determines how the task is executed.
 *
 */
export type TaskKind = 'shell' | 'rpc' | 'llm' | 'agent' | 'transform' | 'gate' | 'tool';

export interface Task {
  /** Unique index within the pipeline. */
  index: number;
  /** Human-readable description (shown in progress). */
  description: string;
  /** Execution kind. */
  kind: TaskKind;
  /** Intent that originated this task (infra, document, implement, etc.). */
  intent: string;

  // -- Input --
  /** Shell command to execute (kind=shell). Populated by resolveCommand at exec time. */
  command?: string | undefined;
  /** Decomposer's best-guess command (hint). Refined by resolveCommand using runtime context. */
  commandHint?: string | undefined;
  /** RPC method to call (kind=rpc). */
  rpcMethod?: string | undefined;
  /** RPC params (kind=rpc). */
  rpcParams?: Record<string, unknown> | undefined;
  /** LLM system prompt (kind=llm/transform). */
  systemPrompt?: string | undefined;
  /** LLM user message (kind=llm). If omitted, uses the original user message. */
  userMessage?: string | undefined;
  /** Agent definition ID (kind=agent). */
  agentId?: string | undefined;

  // -- Output --
  /** Expected output format. */
  outputFormat?: TaskFormat | undefined;

  // -- Dependencies --
  /** Index of parent task this depends on. Undefined = no dependency. */
  dependsOn?: number | undefined;

  // -- Sub-tasks --
  /** Nested sub-tasks. Executed as a sub-pipeline within this task's scope.
   *  Sub-task outputs are internal — only this task's final result is exposed. */
  subTasks?: Task[] | undefined;

  // -- Permissions --
  /** Risk level for gating (low=read-only, medium=modify, high=destructive). */
  risk?: 'low' | 'medium' | 'high' | undefined;
  /** Whether to require explicit user approval before executing. */
  requiresGate?: boolean | undefined;

  // -- Traits --
  /** Cyclic task — supports retry/edit loops with approval gates. */
  cyclic?: CyclicConfig | undefined;
  /** Stateful task — carries typed state across executions. */
  stateKey?: string | undefined;
  /** Persisted task — checkpoint after execution for crash recovery. */
  persisted?: boolean | undefined;
  /** Pass-through task — return userMessage as output without calling the LLM. */
  passThrough?: boolean | undefined;
  /** Enable tool loop for LLM tasks — LLM can call tools (Read, Grep, etc.). */
  useToolLoop?: boolean | undefined;
  /** Tool id to invoke (kind=tool). */
  toolId?: string | undefined;
  /** Input for the tool (kind=tool). */
  toolInput?: Record<string, unknown> | undefined;

  // -- Gate customisation --
  /** Custom gate actions. Overrides default approve/reject/edit. */
  gateActions?: GateActionDef[] | undefined;
  /** Custom gate title. Overrides task.description as gate title. */
  gateTitle?: string | undefined;
  /** Tabbed gate content. When set, webview renders tabs instead of plain content. */
  gateTabs?: GateTab[] | undefined;

  // -- Provider --
  /** Which LLM provider to use. Defaults to local (Ollama). */
  providerHint?: 'local' | 'claude' | undefined;

  // -- LLM tuning --
  /** LLM temperature override. Creative tasks use higher values, structured tasks lower. */
  temperature?: number | undefined;
  /** LLM max output tokens override. Defaults to 4096 if unset. */
  maxTokens?: number | undefined;
  /** Focused query for L3b semantic search. When set, executeLlmTask embeds this
   *  instead of the full userMessage for context retrieval. Useful when userMessage
   *  is a large composite but the search should target the user's specific input. */
  searchHint?: string | undefined;

  /** Structured data for editor pane rendering (brainstorm, plan, etc.).
   *  Sent alongside gate content so native UI can render rich cards. */
  structured?: Record<string, unknown> | undefined;
}

/** Action definition for custom gate buttons. */
export interface GateActionDef {
  name: string;
  label: string;
  hint?: string | undefined;
  needsInput?: boolean | undefined;
}

/** A tab in a tabbed gate card. */
export interface GateTab {
  label: string;
  /** Text/markdown content (for Summary/Preview tabs). */
  content?: string | undefined;
  /** How to render content. Default: 'markdown'. */
  format?: 'markdown' | 'html' | undefined;
  /** Structured items with per-item toggles (for Ideas/Themes tabs). */
  items?: GateTabItem[] | undefined;
  /** If true, items are clickable rows (selectable list mode). Default: false. */
  selectable?: boolean | undefined;
  /** Save options form (for Save Options tab). */
  saveOptions?: {
    formats: string[];
    defaultFormat: string;
    defaultPath: string;
  } | undefined;
}

/** A structured item in a tabbed gate card. */
export interface GateTabItem {
  id: string | number;
  title: string;
  body?: string | undefined;
  verdict?: 'strong' | 'moderate' | 'weak' | 'user' | undefined;
  status?: 'approved' | 'rejected' | 'pending' | 'discussed' | undefined;
  tags?: string[] | undefined;
  /** Whether to show a comment input for this item. */
  commentable?: boolean | undefined;
  /** Pre-populated comment text (restored from previous cycle). */
  comment?: string | undefined;
  /** Whether to show a priority selector (Low/Medium/High) for this item. */
  prioritySelector?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Task traits
// ---------------------------------------------------------------------------

/** Configuration for cyclic (retry/edit loop) tasks. */
export interface CyclicConfig {
  /** Maximum number of retry/edit rounds before forcing completion. */
  maxRounds: number;
  /** Gate actions that trigger a retry (e.g., 'edit', 'reject'). */
  retryActions: string[];
  /** Gate actions that skip this task entirely (e.g., 'skip'). */
  skipActions?: string[] | undefined;
  /** Current round (managed by orchestrator, not set by builder). */
  currentRound?: number | undefined;
}

/**
 * Typed state store for stateful tasks.
 * Controllers use this to pass structured state between tasks
 * instead of plain string outputs.
 */
export interface TaskStateStore {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  has(key: string): boolean;
  snapshot(): Record<string, unknown>;
}

/** In-memory implementation of TaskStateStore. */
export function createTaskStateStore(
  initial?: Record<string, unknown>,
): TaskStateStore {
  const store = new Map<string, unknown>(
    initial ? Object.entries(initial) : [],
  );
  return {
    get<T>(key: string): T | undefined { return store.get(key) as T | undefined; },
    set<T>(key: string, value: T): void { store.set(key, value); },
    has(key: string): boolean { return store.has(key); },
    snapshot(): Record<string, unknown> {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of store) obj[k] = v;
      return obj;
    },
  };
}

// ---------------------------------------------------------------------------
// Task Controller — flow control for agent-specific pipelines
// ---------------------------------------------------------------------------

/**
 * A TaskController owns the execution flow for a specific agent type.
 * It decides which task to run next based on the current pipeline state,
 * handles gate responses for cyclic tasks, and manages typed state.
 *
 * The orchestrator calls the controller after each task completes to
 * determine the next action.
 */
export interface TaskController {
  /** Controller ID (e.g., 'designer', 'planner', 'tester'). */
  readonly id: string;

  /** Optional sub-category (e.g., 'requirements' for brainstorm). */
  readonly category?: string | undefined;

  /** Build the initial task list from input. Called once at pipeline start. */
  buildInitialTasks(input: ControllerInput): Task[];

  /**
   * Called after a task completes. Returns the next task(s) to execute,
   * or null if the pipeline is done.
   *
   * For cyclic tasks: receives the gate reply and decides whether to
   * retry (return same task with updated state), skip, or advance.
   */
  next(
    completed: TaskResult,
    gateReply: GateReply | undefined,
    state: TaskStateStore,
  ): Task[] | null;

  /**
   * Called when the pipeline finishes. Produces the final output
   * from accumulated state.
   */
  finalize(state: TaskStateStore): FinalizeResult;
}

export interface ControllerInput {
  message: string;
  codeContext: string;
  fileContext?: string | undefined;
  configContext?: string | undefined;
  /** Classification result from intent classifier (passed through to controllers). */
  classification?: { intent: string; confidence: number; keywords?: string[] | undefined } | undefined;
}

export interface GateReply {
  action: string;
  feedback?: string | undefined;
}

export interface FinalizeResult {
  output: string;
  format: TaskFormat;
  artifacts?: Array<{ name: string; content: string }> | undefined;
}

// ---------------------------------------------------------------------------
// Task results
// ---------------------------------------------------------------------------

export interface TaskResult {
  index: number;
  description: string;
  output: string;
  format: TaskFormat;
  success: boolean;
  error?: string | undefined;
  /** Results from sub-tasks (if any). */
  subResults?: TaskResult[] | undefined;
  /** Gate reply if this task was gated. */
  gateReply?: GateReply | undefined;
}

export interface TaskPipelineResult {
  tasks: TaskResult[];
  /** Final output (from last task). */
  finalOutput: string;
  /** Final format. */
  finalFormat: TaskFormat;
  /** Whether all tasks succeeded. */
  success: boolean;
}

// ---------------------------------------------------------------------------
// Task Orchestrator
// ---------------------------------------------------------------------------

export interface TaskOrchestratorDeps {
  session: Session;
  channel: DaemonChannel;
  send: (msg: IpcStreamMessage) => void;
  requestId: number;
  /** Conversation history messages for LLM context. */
  historyMessages?: LLMMessage[] | undefined;
  /** Typed state store shared across all tasks in the pipeline. */
  stateStore?: TaskStateStore | undefined;
  /** Drain injected user messages (from chat.inject RPC). */
  getInjectedMessages?: (() => string[]) | undefined;
  /** Drain injected user-contributed ideas (from brainstorm.addIdea RPC). */
  getInjectedIdeas?: (() => Array<{ title: string; body: string }>) | undefined;
}

interface ShellResult {
  success: boolean;
  output: string;
  exitCode: number;
}

/**
 * Execute a pipeline of tasks in dependency order.
 *
 * - Builds context for each task from prior outputs.
 * - Gates tasks that require permission (unless auto-accept + low risk).
 * - Only sends the final task's output to the user.
 * - Intermediate progress shown as pills.
 * - Sub-tasks are executed recursively as sub-pipelines.
 */
export async function runTaskPipeline(
  tasks: Task[],
  deps: TaskOrchestratorDeps,
  options?: { suppressDelta?: boolean; depth?: number },
): Promise<TaskPipelineResult> {
  const { send, requestId, historyMessages } = deps;
  const results: TaskResult[] = new Array(tasks.length);
  const completed = new Set<number>();
  const pending = new Set(tasks.map((_, i) => i));
  const totalTasks = tasks.length;
  const depth = options?.depth ?? 0;
  const suppressDelta = options?.suppressDelta ?? false;

  if (totalTasks === 0) {
    return { tasks: [], finalOutput: '', finalFormat: 'text', success: true };
  }

  if (totalTasks > 1 && depth === 0) {
    const intents = tasks.map(t => t.intent);
    send({ id: requestId, stream: 'progress', data: {
      message: `Executing ${totalTasks} tasks: ${intents.join(' → ')}`,
    } });
  }

  let aborted = false;

  // DAG execution loop
  while (pending.size > 0 && !aborted) {
    // Find tasks whose dependencies are satisfied
    const ready: number[] = [];
    for (const idx of pending) {
      const task = tasks[idx]!;
      if (task.dependsOn === undefined || completed.has(task.dependsOn)) {
        ready.push(idx);
      }
    }

    if (ready.length === 0) {
      log.error({ pending: [...pending], depth }, 'deadlock: no ready tasks');
      for (const idx of pending) {
        results[idx] = {
          index: idx,
          description: tasks[idx]!.description,
          output: 'Skipped: unresolvable dependency',
          format: 'text',
          success: false,
          error: 'deadlock',
        };
      }
      break;
    }

    // Execute ready tasks (parallel if independent)
    const execResults = await Promise.all(ready.map(async (idx) => {
      const task = tasks[idx]!;
      const isLast = idx === totalTasks - 1;

      // Build context from prior task outputs
      const priorOutputs: string[] = [];
      if (task.dependsOn !== undefined) {
        const dep = results[task.dependsOn];
        if (dep?.output) priorOutputs.push(dep.output);
      }

      // Progress
      if (totalTasks > 1 || depth > 0) {
        const prefix = depth > 0 ? '  '.repeat(depth) : '';
        send({ id: requestId, stream: 'progress', data: {
          message: `${prefix}Task ${idx + 1}/${totalTasks}: ${task.description}`,
        } });
      }

      try {
        const result = await executeTask(task, priorOutputs, deps, historyMessages, depth);
        results[idx] = result;

        // Record task result into ContextManager memory so subsequent tasks
        // and future turns have access via L3a (recent) and L3b (semantic).
        if (result.success && result.output && depth === 0) {
          const ctx = deps.session.contextManager;
          const turnDesc = task.description;
          const embedding = await ctx.embedQuery(turnDesc).catch(() => []);
          if (embedding.length > 0) {
            await ctx.recordTurn({
              userMessage: `[task:${task.kind}] ${turnDesc}`,
              assistantResponse: result.output,
              entityIds: [],
            }, embedding);
          }

          // Tag named pipeline outputs (agent, transform) for cross-pipeline
          // reference via ctx.getTag() — e.g., a design step feeding implement.
          if (task.intent && task.persisted) {
            ctx.setTag(`[${task.intent}]`, result.output);
          }
        }

        // Only send delta for the final task at depth 0
        if (isLast && !suppressDelta && depth === 0) {
          // Transform tasks replace the accumulated raw output with formatted text
          const replace = task.kind === 'transform';
          // Convert markdown to pre-rendered HTML for the webview
          const rendered = result.format === 'markdown'
            ? renderMarkdown(result.output)
            : { text: result.output, format: result.format };
          send({ id: requestId, stream: 'delta', data: {
            text: rendered.text,
            format: rendered.format,
            replace,
          } });
        }

        log.info({ idx, kind: task.kind, intent: task.intent, format: result.format, success: result.success, depth }, 'task completed');
        return { idx, success: result.success };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        results[idx] = {
          index: idx,
          description: task.description,
          output: errMsg,
          format: 'text',
          success: false,
          error: errMsg,
        };
        log.error({ idx, kind: task.kind, error: errMsg, depth }, 'task failed');

        if (depth === 0) {
          send({ id: requestId, stream: 'delta', data: { text: `Task failed: ${errMsg}` } });
        }
        return { idx, success: false };
      }
    }));

    // Process results — mark completed or abort on failure
    for (const { idx, success } of execResults) {
      completed.add(idx);
      pending.delete(idx);

      if (!success) {
        // Abort remaining: mark all pending as skipped
        const failedResult = results[idx];
        const wasCancelled = failedResult?.error === 'cancelled';
        const skipReason = wasCancelled
          ? 'Skipped: task cancelled by user'
          : `Skipped: prior task failed`;
        for (const pendingIdx of pending) {
          results[pendingIdx] = {
            index: pendingIdx,
            description: tasks[pendingIdx]!.description,
            output: skipReason,
            format: 'text',
            success: false,
            error: wasCancelled ? 'cancelled' : 'skipped',
          };
        }
        pending.clear();
        aborted = true;

        if (depth === 0) {
          const msg = wasCancelled
            ? 'Task cancelled — remaining tasks skipped.'
            : `Task ${idx + 1} failed — remaining tasks skipped.`;
          send({ id: requestId, stream: 'delta', data: { text: msg } });
        }
        break;
      }
    }
  }

  const validResults = results.filter(Boolean);
  const lastResult = validResults[validResults.length - 1];

  // Convert markdown to pre-rendered HTML for persistence and downstream display
  const finalFormat = lastResult?.format ?? 'text';
  const finalRendered = finalFormat === 'markdown'
    ? renderMarkdown(lastResult?.output ?? '')
    : { text: lastResult?.output ?? '', format: finalFormat };

  return {
    tasks: validResults,
    finalOutput: finalRendered.text,
    finalFormat: finalRendered.format,
    success: validResults.every(r => r.success),
  };
}

// ---------------------------------------------------------------------------
// Controller-driven pipeline
// ---------------------------------------------------------------------------

/**
 * Execute a pipeline driven by a TaskController.
 *
 * Unlike runTaskPipeline (static DAG), this runner calls controller.next()
 * after each task to determine what to run next. Supports:
 * - Cyclic tasks (edit/retry loops with maxRounds)
 * - Typed state passed between tasks via TaskStateStore
 * - Dynamic flow based on gate replies
 * - Checkpointing for crash recovery (persisted tasks)
 */
export async function runControlledPipeline(
  controller: TaskController,
  input: ControllerInput,
  deps: TaskOrchestratorDeps,
): Promise<TaskPipelineResult> {
  const { send, requestId } = deps;
  const stateStore = deps.stateStore ?? createTaskStateStore();
  const allResults: TaskResult[] = [];

  // Emit category-qualified intent (e.g., "Intent: brainstorm/requirements")
  if (controller.category) {
    send({ id: requestId, stream: 'progress', data: {
      message: `Intent: ${controller.id}/${controller.category}`,
    } });
  }

  // 1. Build initial tasks
  let pendingTasks = controller.buildInitialTasks(input);
  log.info({ controller: controller.id, initialTasks: pendingTasks.length }, 'controlled pipeline starting');

  // 2. Execute tasks sequentially (controller decides next)
  while (pendingTasks.length > 0) {
    const task = pendingTasks.shift()!;

    send({ id: requestId, stream: 'progress', data: {
      message: task.description,
    } });

    // Handle cyclic tasks
    const cyclic = task.cyclic;
    if (cyclic) {
      cyclic.currentRound = (cyclic.currentRound ?? 0);
    }

    // Execute the task
    const result = await executeTask(
      task,
      buildContextFromState(task, stateStore, allResults),
      deps,
      deps.historyMessages,
      0,
    );

    // Store result in state if task has a stateKey
    if (task.stateKey) {
      stateStore.set(task.stateKey, result.output);
      stateStore.set(`${task.stateKey}:result`, result);
    }

    // Gate the result if task requires approval
    let gateReply: GateReply | undefined;
    if (task.requiresGate && result.success) {
      gateReply = await gateTaskResult(task, result, deps);
      result.gateReply = gateReply;

      // Handle cyclic retry
      if (cyclic && gateReply) {
        const round = cyclic.currentRound ?? 0;
        if (cyclic.retryActions.includes(gateReply.action) && round < cyclic.maxRounds) {
          // Retry: re-add this task with incremented round and feedback
          const retryTask: Task = {
            ...task,
            cyclic: { ...cyclic, currentRound: round + 1 },
            userMessage: gateReply.feedback
              ? `${task.userMessage ?? task.description}\n\nUser feedback: ${gateReply.feedback}`
              : task.userMessage,
          };
          pendingTasks.unshift(retryTask);
          log.info({ task: task.description, round: round + 1 }, 'cyclic retry');
          continue;
        }
        if (cyclic.skipActions?.includes(gateReply.action)) {
          result.output = 'Skipped by user.';
          result.success = true;
          allResults.push(result);
          log.info({ task: task.description }, 'cyclic task skipped');
          // Still ask controller for next
          const nextTasks = controller.next(result, gateReply, stateStore);
          if (nextTasks) pendingTasks.unshift(...nextTasks);
          continue;
        }
      }
    }

    allResults.push(result);

    // Checkpoint for persisted tasks
    if (task.persisted) {
      await checkpointState(controller.id, stateStore, allResults, deps.session?.id);
    }

    // If task failed or was cancelled, abort the entire pipeline
    if (!result.success) {
      const wasCancelled = result.error === 'cancelled';
      if (wasCancelled) {
        log.info({ task: task.description }, 'controlled pipeline: task cancelled by user');
        send({ id: requestId, stream: 'delta', data: { text: 'Task cancelled — pipeline aborted.' } });
      } else {
        log.error({ task: task.description, error: result.error }, 'controlled pipeline: task failed');
        send({ id: requestId, stream: 'delta', data: { text: `Task failed: ${result.error}` } });
      }
      break;
    }

    // Drain injected user messages into the store for controller consumption
    if (deps.getInjectedMessages) {
      const injected = deps.getInjectedMessages();
      if (injected.length > 0) {
        const existing = stateStore.get<string[]>('injectedMessages') ?? [];
        stateStore.set('injectedMessages', [...existing, ...injected]);
      }
    }

    // Drain injected user ideas (from brainstorm.addIdea RPC) so the
    // controller can splice them into the ideation queue on its next tick.
    if (deps.getInjectedIdeas) {
      const ideas = deps.getInjectedIdeas();
      if (ideas.length > 0) {
        const existing = stateStore.get<Array<{ title: string; body: string }>>('injectedIdeas') ?? [];
        stateStore.set('injectedIdeas', [...existing, ...ideas]);
      }
    }

    // Ask controller what's next
    const nextTasks = controller.next(result, gateReply, stateStore);

    // Emit QnA updates if controller stored them
    const qna = stateStore.get<unknown[]>('brainstormQnA');
    if (qna && qna.length > 0) {
      send({ id: requestId, stream: 'qna.update', data: { entries: qna } });
    }

    if (nextTasks === null) {
      log.info({ controller: controller.id }, 'controlled pipeline: controller signalled done');
      break;
    }
    pendingTasks.unshift(...nextTasks);
  }

  // 3. Finalize
  const finalized = controller.finalize(stateStore);

  // Send final output
  send({ id: requestId, stream: 'delta', data: {
    text: finalized.output,
    format: finalized.format,
  } });

  // Write artifacts
  if (finalized.artifacts) {
    for (const artifact of finalized.artifacts) {
      log.info({ name: artifact.name }, 'writing artifact');
      // Artifact persistence handled by caller or checkpoint system
      stateStore.set(`artifact:${artifact.name}`, artifact.content);
    }
  }

  return {
    tasks: allResults,
    finalOutput: finalized.output,
    finalFormat: finalized.format,
    success: allResults.every(r => r.success),
  };
}

function buildContextFromState(
  task: Task,
  stateStore: TaskStateStore,
  priorResults: TaskResult[],
): string[] {
  const context: string[] = [];

  // If task depends on another, use that task's output
  if (task.dependsOn !== undefined) {
    const dep = priorResults.find(r => r.index === task.dependsOn);
    if (dep?.output) context.push(dep.output);
  }

  // If task references a state key, include it
  if (task.stateKey) {
    const prior = stateStore.get<string>(task.stateKey);
    if (prior) context.push(prior);
  }

  return context;
}

async function gateTaskResult(
  task: Task,
  result: TaskResult,
  deps: TaskOrchestratorDeps,
): Promise<GateReply> {
  const { send, requestId, channel } = deps;
  const gateId = `ctrl-${task.index}-${Date.now()}`;

  // Use custom gate actions if provided, otherwise build defaults
  const actions: Array<{ name: string; label: string; hint?: string; needsInput?: boolean }> = task.gateActions
    ? task.gateActions.map(a => ({ name: a.name, label: a.label, ...(a.hint ? { hint: a.hint } : {}), ...(a.needsInput ? { needsInput: true } : {}) }))
    : [
        { name: 'approve', label: 'Approve' },
        { name: 'reject', label: 'Reject' },
        ...(task.cyclic ? [{ name: 'edit', label: 'Edit', needsInput: true as const }] : []),
        ...(task.cyclic?.skipActions?.length ? [{ name: 'skip', label: 'Skip' }] : []),
      ];

  // Convert gate content through the same renderMarkdown pipeline as deltas
  const rendered = renderMarkdown(result.output);

  send({ id: requestId, stream: 'gate', data: {
    gateId,
    title: task.gateTitle ?? task.description,
    content: rendered.text,
    format: rendered.format,
    actions,
    ...(task.gateTabs ? { tabs: task.gateTabs } : {}),
    ...(task.structured ? { structured: task.structured } : {}),
  } });

  const reply = await new Promise<ReplyPayload>((resolve, reject) => {
    channel.registerExternalGate(gateId, resolve, reject);
  });

  return { action: reply.action, feedback: reply.feedback };
}

async function checkpointState(
  controllerId: string,
  stateStore: TaskStateStore,
  results: TaskResult[],
  sessionId?: string,
): Promise<void> {
  try {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');
    const dir = join(homedir(), '.insrc', 'checkpoints');
    mkdirSync(dir, { recursive: true });
    // One checkpoint file per (controller, session) pair -- subsequent
    // steps overwrite, so disk usage stays bounded. Fall back to
    // timestamp when sessionId is missing so non-session pipelines
    // still get unique files.
    const suffix = sessionId ?? String(Date.now());
    const file = join(dir, `${controllerId}-${suffix}.json`);
    writeFileSync(file, JSON.stringify({
      controller: controllerId,
      sessionId: sessionId ?? null,
      state: stateStore.snapshot(),
      results: results.map(r => ({ index: r.index, description: r.description, success: r.success })),
      timestamp: new Date().toISOString(),
    }, null, 2));
    log.debug({ file }, 'checkpoint saved');
  } catch (err) {
    log.debug({ err }, 'checkpoint save failed (non-fatal)');
  }
}

// ---------------------------------------------------------------------------
// Shell command resolution — refines decomposer hints at execution time
// ---------------------------------------------------------------------------

const RESOLVE_SYSTEM = `You are a command resolver for a coding assistant.
Given a task description, a suggested command hint, and context from prior steps,
generate the exact shell command to execute.

Rules:
- Use the hint as a starting point — it is often correct but may have incomplete
  values (e.g., truncated names, missing flags) that the prior output can fix.
- If the prior output contains the exact value needed (e.g., a full resource name,
  a pod ID, a context name), use it in the command.
- Do NOT add output format flags (-o json, -o yaml) unless the task explicitly asks.
- Do NOT add extra flags or options beyond what the task requires.
- Classify risk: "low" for read-only (get, list, describe, logs, status),
  "medium" for modifications (apply, set, scale, use-context, restart, update),
  "high" for destructive (delete, destroy, drop, rm, force, prune).

Output ONLY valid JSON — no markdown fences, no explanation:
{ "command": "<exact shell command>", "risk": "<low|medium|high>" }`;

async function resolveCommand(
  task: Task,
  priorOutputs: string[],
  deps: TaskOrchestratorDeps,
): Promise<{ command: string; risk: 'low' | 'medium' | 'high' }> {
  const { session } = deps;
  const ctx = session.contextManager;

  // Build context for the resolver
  const contextParts: string[] = [];

  if (priorOutputs.length > 0) {
    contextParts.push(`Prior step output:\n${priorOutputs.join('\n---\n')}`);
  }

  // Include ContextManager assembled code context for richer resolution
  const queryEmbedding = await ctx.embedQuery(task.description).catch(() => []);
  if (queryEmbedding.length > 0) {
    const assembled = await ctx.assemble(task.description, queryEmbedding);
    if (assembled.code.text) {
      contextParts.push(`Code context:\n${assembled.code.text}`);
    }
  }

  const hint = task.commandHint ? `\nSuggested command: ${task.commandHint}` : '';
  const userContent = `Task: ${task.description}${hint}${contextParts.length > 0 ? '\n\n' + contextParts.join('\n\n') : ''}`;

  const messages: LLMMessage[] = [
    { role: 'system', content: RESOLVE_SYSTEM },
    { role: 'user', content: userContent },
  ];

  const response = await session.ollamaProvider.complete(messages, {
    maxTokens: 200,
    temperature: 0,
  });

  // Parse JSON response — extract from possible surrounding text
  const jsonMatch = response.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Command resolver returned non-JSON: ${response.text.slice(0, 200)}`);
  }

  const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  const command = String(parsed['command'] ?? '').trim();
  if (!command) {
    throw new Error('Command resolver returned empty command');
  }

  const riskRaw = String(parsed['risk'] ?? 'medium');
  const risk = (['low', 'medium', 'high'] as const).includes(riskRaw as 'low' | 'medium' | 'high')
    ? riskRaw as 'low' | 'medium' | 'high'
    : 'medium';

  log.info({ task: task.description, hint: task.commandHint, resolved: command, risk }, 'command resolved');
  return { command, risk };
}

// ---------------------------------------------------------------------------
// Single task execution
// ---------------------------------------------------------------------------

async function executeTask(
  task: Task,
  priorOutputs: string[],
  deps: TaskOrchestratorDeps,
  historyMessages: LLMMessage[] | undefined,
  depth: number,
): Promise<TaskResult> {
  const { session } = deps;
  const permMode = session.config.permissions?.mode ?? 'validate';
  const context = priorOutputs.length > 0 ? priorOutputs.join('\n\n---\n\n') : undefined;

  // Execute sub-tasks first if present
  if (task.subTasks && task.subTasks.length > 0) {
    const subResult = await runTaskPipeline(task.subTasks, deps, {
      suppressDelta: true,
      depth: depth + 1,
    });

    if (!subResult.success) {
      return {
        index: task.index,
        description: task.description,
        output: subResult.finalOutput,
        format: subResult.finalFormat,
        success: false,
        error: 'sub-task failed',
        subResults: subResult.tasks,
      };
    }

    // Sub-tasks succeeded — use their final output as this task's output
    // (unless this task has its own execution logic beyond sub-tasks)
    if (task.kind === 'transform' || task.kind === 'llm') {
      // For transform/llm tasks with sub-tasks, the sub-task output becomes
      // the context for this task's LLM call
      const enrichedPrior = [...priorOutputs, subResult.finalOutput];
      return executeLlmTask(task, enrichedPrior.join('\n\n---\n\n'), deps, historyMessages);
    }

    // For other kinds, sub-task output IS this task's output
    return {
      index: task.index,
      description: task.description,
      output: subResult.finalOutput,
      format: subResult.finalFormat,
      success: true,
      subResults: subResult.tasks,
    };
  }

  // Resolve command for shell tasks — the decomposer only provides a hint.
  // The resolver LLM refines it using actual prior-task output and context.
  if (task.kind === 'shell' && !task.command) {
    const { send, requestId } = deps;
    send({ id: requestId, stream: 'progress', data: { message: `Resolving: ${task.description}` } });
    try {
      const resolved = await resolveCommand(task, priorOutputs, deps);
      task = { ...task, command: resolved.command, risk: resolved.risk };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        index: task.index,
        description: task.description,
        output: `Command resolution failed: ${errMsg}`,
        format: 'text',
        success: false,
        error: errMsg,
      };
    }
  }

  // Gate if required — shows the resolved command, not the hint.
  // Skip pre-execution gate for tasks with custom gateActions (those use post-execution gateTaskResult).
  const needsPreGate = !task.gateActions
    && (task.requiresGate || (permMode !== 'auto-accept' && task.kind === 'shell'));
  if (needsPreGate) {
    const approved = await gateTask(task, context, deps);
    if (!approved.ok) {
      return {
        index: task.index,
        description: task.description,
        output: 'Cancelled by user.',
        format: 'text',
        success: false,
        error: 'cancelled',
      };
    }
    if (approved.editedCommand) {
      task = { ...task, command: approved.editedCommand };
    }
  }

  // Pass-through tasks return their userMessage directly — no LLM call.
  if (task.passThrough) {
    return {
      index: task.index,
      description: task.description,
      output: task.userMessage ?? '',
      format: task.outputFormat ?? 'text',
      success: true,
    };
  }

  switch (task.kind) {
    case 'shell':
      return executeShellTask(task, context, deps);

    case 'rpc':
      return executeRpcTask(task);

    case 'llm':
    case 'transform':
      return executeLlmTask(task, context, deps, historyMessages);

    case 'agent':
      return executeAgentTask(task, context, deps);

    case 'tool': {
      const toolId = task.toolId ?? '';
      const toolInput = task.toolInput ?? {};
      const { executeTool } = await import('./tools/executor.js');
      const result = await executeTool(toolId, toolInput, {
        session: deps.session,
        channel: deps.channel,
        send: deps.send,
        requestId: deps.requestId,
      });
      return {
        index: task.index,
        description: task.description,
        output: result.output,
        format: result.format as TaskFormat,
        success: result.success,
        ...(result.error ? { error: result.error } : {}),
      };
    }

    default:
      return {
        index: task.index,
        description: task.description,
        output: `Unknown task kind: ${task.kind}`,
        format: 'text',
        success: false,
      };
  }
}

// ---------------------------------------------------------------------------
// Gate (permission check)
// ---------------------------------------------------------------------------

interface GateResult {
  ok: boolean;
  editedCommand?: string | undefined;
}

async function gateTask(
  task: Task,
  _context: string | undefined,
  deps: TaskOrchestratorDeps,
): Promise<GateResult> {
  const { send, requestId, channel } = deps;
  const risk = task.risk ?? 'low';
  const riskLabel = risk === 'high' ? '⚠️ HIGH RISK' : risk === 'medium' ? '⚡ Medium risk' : '✓ Low risk';
  const gateId = `task-${task.index}-${Date.now()}`;

  // Show prior task output in gate so user has context for approval
  const priorBlock = _context ? `Prior output:\n\`\`\`\n${_context}\n\`\`\`\n\n` : '';
  const content = task.kind === 'shell'
    ? `${priorBlock}$ ${task.command}\n\n${task.description}`
    : `${priorBlock}${task.description}`;

  send({ id: requestId, stream: 'gate', data: {
    gateId,
    title: `Execute command? (${riskLabel})`,
    content,
    actions: [
      { name: 'execute', label: 'Execute' },
      { name: 'reject', label: 'Cancel' },
      ...(task.kind === 'shell' ? [{ name: 'edit', label: 'Edit', needsInput: true }] : []),
    ],
  } });

  const reply = await new Promise<ReplyPayload>((resolve, reject) => {
    channel.registerExternalGate(gateId, resolve, reject);
  });

  if (reply.action === 'execute') {
    return { ok: true };
  }
  if (reply.action === 'edit' && reply.feedback) {
    return { ok: true, editedCommand: reply.feedback.trim() };
  }
  return { ok: false };
}

// ---------------------------------------------------------------------------
// Shell task executor
// ---------------------------------------------------------------------------

async function executeShellTask(
  task: Task,
  _context: string | undefined,
  deps: TaskOrchestratorDeps,
): Promise<TaskResult> {
  const command = task.command;
  if (!command) {
    return {
      index: task.index,
      description: task.description,
      output: 'No command specified',
      format: 'text',
      success: false,
    };
  }

  const { send, requestId } = deps;
  send({ id: requestId, stream: 'progress', data: { message: `Running: ${command}` } });

  const result = await runShellCommand(command);

  const isDebug = log.isLevelEnabled('debug');

  if (result.success) {
    const output = `$ ${command}\n${result.output}`;
    // Only send intermediate shell output in debug mode — the final
    // transform task (or last-task delta) will deliver the formatted result.
    if (isDebug) {
      const shellRendered = renderMarkdown(`\`\`\`\n${output}\n\`\`\`\n`);
      send({ id: requestId, stream: 'delta', data: {
        text: shellRendered.text,
        format: shellRendered.format,
      } });
    }
    return {
      index: task.index,
      description: task.description,
      output,
      format: task.outputFormat ?? 'code',
      success: true,
    };
  }

  const output = `$ ${command}\n${result.output}\n(exit code: ${result.exitCode})`;
  // Always show failed command output so the user knows what went wrong
  const failRendered = renderMarkdown(`\`\`\`\n${output}\n\`\`\`\n`);
  send({ id: requestId, stream: 'delta', data: {
    text: failRendered.text,
    format: failRendered.format,
  } });
  return {
    index: task.index,
    description: task.description,
    output,
    format: 'code',
    success: false,
    error: `exit code ${result.exitCode}`,
  };
}

async function runShellCommand(command: string): Promise<ShellResult> {
  const { exec } = await import('node:child_process');
  return new Promise((resolve) => {
    exec(command, { timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const parts: string[] = [];
      if (stdout) parts.push(stdout.toString().trim());
      if (stderr) parts.push(stderr.toString().trim());
      if (error && !stdout && !stderr) parts.push(error.message);
      const output = parts.join('\n') || '(no output)';
      const exitCode = error ? (error as { code?: number }).code ?? 1 : 0;
      resolve({ success: exitCode === 0, output, exitCode });
    });
  });
}

// ---------------------------------------------------------------------------
// RPC task executor
// ---------------------------------------------------------------------------

async function executeRpcTask(
  task: Task,
): Promise<TaskResult> {
  if (!task.rpcMethod) {
    return {
      index: task.index,
      description: task.description,
      output: 'No RPC method specified',
      format: 'text',
      success: false,
    };
  }

  try {
    const { rpc: cliRpc } = await import('../cli/client.js');
    const result = await cliRpc(task.rpcMethod, task.rpcParams ?? {});
    const formatted = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return {
      index: task.index,
      description: task.description,
      output: formatted,
      format: task.outputFormat ?? 'code',
      success: true,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      index: task.index,
      description: task.description,
      output: `RPC failed: ${errMsg}`,
      format: 'text',
      success: false,
      error: errMsg,
    };
  }
}

// ---------------------------------------------------------------------------
// LLM / Transform task executor
// ---------------------------------------------------------------------------

async function executeLlmTask(
  task: Task,
  context: string | undefined,
  deps: TaskOrchestratorDeps,
  _historyMessages?: LLMMessage[] | undefined,
): Promise<TaskResult> {
  const { session } = deps;
  const ctx = session.contextManager;

  let messages: LLMMessage[];

  if (task.kind === 'transform') {
    // Transform tasks use a dedicated system prompt + prior step output.
    // No need for full context assembly — they're pure formatting.
    messages = [];
    if (task.systemPrompt) {
      messages.push({ role: 'system', content: task.systemPrompt });
    }
    let userContent = task.userMessage ?? task.description;
    if (context) {
      userContent = `${userContent}\n\`\`\`\n${context}\n\`\`\``;
    }
    messages.push({ role: 'user', content: userContent });
  } else {
    // Regular LLM tasks use the full ContextManager (L1-L5 layers).
    // This gives them session summary, semantic history, code context,
    // and recent turn memory — not just raw prior outputs.
    let userContent = task.userMessage ?? task.description;
    if (context) {
      userContent = `${userContent}\n\nOutput from prior step:\n\`\`\`\n${context}\n\`\`\``;
    }
    const searchQuery = task.searchHint ?? userContent;
    const queryEmbedding = await ctx.embedQuery(searchQuery);
    const assembled = await ctx.assemble(userContent, queryEmbedding);
    messages = ctx.buildMessages(assembled, userContent);

    // Override system prompt if the task specifies one
    if (task.systemPrompt && messages.length > 0 && messages[0]!.role === 'system') {
      messages[0] = { role: 'system', content: task.systemPrompt };
    }
  }

  try {
    const provider = task.providerHint === 'claude' && session.claudeProvider
      ? session.claudeProvider
      : session.ollamaProvider;
    const completeOpts: Record<string, unknown> = { maxTokens: task.maxTokens ?? 4096 };
    if (task.temperature !== undefined) {
      completeOpts.temperature = task.temperature;
    }

    let outputText: string;

    if (task.useToolLoop) {
      // Use tool loop — LLM can call Read, Grep, Glob, etc.
      const { runToolLoop } = await import('../agent/tools/loop.js');
      const { getToolDefinitions } = await import('../agent/tools/registry.js');
      const tools = getToolDefinitions({ mcpAvailable: false }); // builtin tools only
      const result = await runToolLoop(messages, {
        provider,
        tools,
        intent: task.intent,
        permissionMode: 'auto-accept',
        maxTokens: task.maxTokens ?? 4096,
        userPrompt: task.userMessage ?? task.description,
        onToolCall: (call) => {
          deps.send({ id: deps.requestId, stream: 'progress', data: {
            message: `Using ${call.name}${call.input?.['file_path'] ? ': ' + String(call.input['file_path']).split('/').pop() : ''}`,
          }});
        },
        onProgress: (msg) => {
          deps.send({ id: deps.requestId, stream: 'progress', data: { message: msg } });
        },
      });
      outputText = result.response;
    } else {
      const response = await provider.complete(messages, completeOpts);
      outputText = response.text;
    }

    return {
      index: task.index,
      description: task.description,
      output: outputText,
      format: task.outputFormat ?? 'markdown',
      success: true,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      index: task.index,
      description: task.description,
      output: `LLM call failed: ${errMsg}`,
      format: 'text',
      success: false,
      error: errMsg,
    };
  }
}

// ---------------------------------------------------------------------------
// Agent task executor (stub — delegates to existing runAgent)
// ---------------------------------------------------------------------------

async function executeAgentTask(
  task: Task,
  context: string | undefined,
  deps: TaskOrchestratorDeps,
): Promise<TaskResult> {
  const agentId = task.agentId ?? task.intent;
  const controller = await resolveController(agentId, task, deps);

  if (!controller) {
    // No controller found — agent tasks without controllers are not yet supported
    return {
      index: task.index,
      description: task.description,
      output: `No controller found for agent: ${agentId}`,
      format: 'text',
      success: false,
      error: `unknown agent: ${agentId}`,
    };
  }

  log.info({ agent: agentId, controller: controller.id }, 'running controlled agent pipeline');

  const stateStore = createTaskStateStore();
  // Seed state with prior task output if available
  if (context) {
    stateStore.set('priorContext', context);
  }

  // Use ContextManager for rich code context (graph entities, semantic history)
  // instead of raw prior task output strings.
  const ctx = deps.session.contextManager;
  const userMsg = task.userMessage ?? task.description;
  const queryEmbedding = await ctx.embedQuery(userMsg).catch(() => []);
  let codeContext = context ?? '';
  if (queryEmbedding.length > 0) {
    const assembled = await ctx.assemble(userMsg, queryEmbedding);
    codeContext = assembled.code.text || codeContext;
  }

  const controllerInput: ControllerInput = {
    message: userMsg,
    codeContext,
  };

  const subDeps: TaskOrchestratorDeps = {
    ...deps,
    stateStore,
  };

  const result = await runControlledPipeline(controller, controllerInput, subDeps);

  return {
    index: task.index,
    description: task.description,
    output: result.finalOutput,
    format: result.finalFormat,
    success: result.success,
    subResults: result.tasks,
  };
}

// ---------------------------------------------------------------------------
// Controller registry
// ---------------------------------------------------------------------------

const controllerCache = new Map<string, TaskController>();

async function resolveController(
  agentId: string,
  task?: Task,
  deps?: TaskOrchestratorDeps,
): Promise<TaskController | null> {
  // Brainstorm picks a sub-controller per category; cache key includes it.
  let cacheKey = agentId;
  if (agentId === 'brainstorm' && task) {
    const { classifyBrainstormCategoryHybrid } = await import('../agent/classifier/brainstorm-category.js');
    const msg = task.userMessage ?? task.description ?? '';
    const classifierProvider = deps?.session.resolver.resolve('classifier', 'classify');
    const result = await classifyBrainstormCategoryHybrid(msg, classifierProvider);
    log.info(
      { category: result.category, confidence: result.confidence, reasoning: result.reasoning },
      'brainstorm sub-classification',
    );
    if (deps) {
      deps.send({
        id: deps.requestId,
        stream: 'progress',
        data: { message: `Intent: brainstorm/${result.category} (${result.reasoning})` },
      });
    }
    cacheKey = `brainstorm:${result.category}`;
  }

  if (controllerCache.has(cacheKey)) return controllerCache.get(cacheKey)!;

  let controller: TaskController | null = null;

  switch (agentId) {
    case 'design':
    case 'requirements': {
      const mod = await import('./controllers/designer.js');
      controller = new mod.DesignerController();
      break;
    }
    case 'plan': {
      const mod = await import('./controllers/planner.js');
      controller = new mod.PlannerController();
      break;
    }
    case 'test': {
      const mod = await import('./controllers/tester.js');
      controller = new mod.TesterController();
      break;
    }
    case 'brainstorm': {
      const mod = await import('./controllers/brainstorm/index.js');
      const category = cacheKey.slice('brainstorm:'.length);
      switch (category) {
        case 'requirements':
          controller = new mod.RequirementsBrainstormController();
          break;
        case 'general':
          controller = new mod.GeneralBrainstormController();
          break;
        case 'design':
          controller = new mod.DesignBrainstormController();
          break;
        case 'implementation':
          controller = new mod.ImplementationBrainstormController();
          break;
        case 'testing':
          controller = new mod.TestingBrainstormController();
          break;
        default:
          controller = new mod.RequirementsBrainstormController();
          break;
      }
      break;
    }
    case 'implement':
    case 'refactor':
    case 'debug': {
      const mod = await import('./controllers/coding.js');
      controller = new mod.CodingController();
      break;
    }
    case 'research': {
      const mod = await import('./controllers/research.js');
      controller = new mod.ResearchController();
      break;
    }
    case 'code-analysis': {
      const mod = await import('./controllers/code-analysis.js');
      controller = new mod.CodeAnalysisController();
      break;
    }
    default:
      return null;
  }

  if (controller) controllerCache.set(cacheKey, controller);
  return controller;
}
