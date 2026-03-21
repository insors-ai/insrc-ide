/**
 * Chat RPC handler logic — classify → route → runAgent over streaming IPC.
 *
 * Separated from daemon/index.ts to keep the handler registry clean.
 * Exports standard handlers (chat.start, chat.reply, etc.) and
 * streaming handlers (chat.send, chat.resume).
 */

import { Session } from '../agent/session.js';
import { classify, decompose, type DecomposedAction } from '../agent/classifier/index.js';
import { selectProvider } from '../agent/router.js';
import { detectScope } from '../agent/classifier/scope.js';
import { runAgent } from '../agent/framework/runner.js';
import { buildTasks } from './task-builder.js';
import { runTaskPipeline, renderMarkdown, type TaskOrchestratorDeps } from './task.js';
import { designerAgent } from '../agent/tasks/designer/agent.js';
import { resolveTemplate, parseTemplateFlags } from '../agent/tasks/designer/index.js';
import { plannerAgent } from '../agent/planner/agent.js';
import { brainstormAgent } from '../agent/tasks/brainstorm/agent.js';
import { pairAgent } from '../agent/tasks/pair/agent.js';
import { delegateAgent } from '../agent/tasks/delegate/agent.js';
import { testerAgent } from '../agent/tasks/tester/agent.js';
import { DaemonChannel } from './channel.js';
import { ChatSessionPool } from './chat-sessions.js';
import { resolveFileRefs, formatFileContext, type FileRefResult } from './file-refs.js';
import { getLogger } from '../shared/logger.js';
import type { IpcStreamMessage, LLMMessage, ToolDefinition } from '../shared/types.js';
import type { AgentDefinition, ReplyPayload } from '../agent/framework/types.js';
import type { AssembledContext } from '../agent/context/index.js';
import type { PairMode, PairInput } from '../agent/tasks/pair/types.js';
import type { DelegateInput } from '../agent/tasks/delegate/types.js';
import type { DesignerInput } from '../agent/tasks/designer/types.js';
import type { PlannerInput } from '../agent/planner/agent-state.js';
import type { BrainstormInput } from '../agent/tasks/brainstorm/types.js';
import type { TesterInput } from '../agent/tasks/tester/types.js';
import type { RpcHandler, StreamHandler } from './server.js';

const log = getLogger('chat');

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let sessionPool: ChatSessionPool | null = null;

export function initChatHandlers(): void {
  sessionPool = new ChatSessionPool();
}

export async function reloadChatConfig(): Promise<number> {
  if (!sessionPool) return 0;
  return sessionPool.reloadConfig();
}

export async function disposeChatHandlers(): Promise<void> {
  if (sessionPool) {
    await sessionPool.dispose();
    sessionPool = null;
  }
}

function getPool(): ChatSessionPool {
  if (!sessionPool) throw new Error('chat handlers not initialized');
  return sessionPool;
}

// ---------------------------------------------------------------------------
// Standard handlers
// ---------------------------------------------------------------------------

export const chatStart: RpcHandler = async (params) => {
  const { repo } = params as { repo: string };
  const pool = getPool();
  const sessionId = await pool.create(repo);
  return { sessionId, repo };
};

export const chatReply: RpcHandler = async (params) => {
  const { sessionId, gateId, action, feedback } = params as {
    sessionId: string;
    gateId: string;
    action: string;
    feedback?: string;
  };
  const pool = getPool();
  const session = pool.get(sessionId);
  if (!session) return { error: 'session not found' };
  if (!session.channel) return { error: 'no agent running' };

  const resolved = session.channel.resolveGate(gateId, { gateId, action, feedback });
  if (!resolved) return { error: `gate ${gateId} not found` };
  return { ok: true };
};

export const chatCancel: RpcHandler = async (params) => {
  const { sessionId } = params as { sessionId: string };
  const pool = getPool();
  const session = pool.get(sessionId);
  if (!session) return { error: 'session not found' };
  if (session.abortController) {
    session.abortController.abort();
  }
  return { ok: true };
};

export const chatInject: RpcHandler = async (params) => {
  const { sessionId, message } = params as { sessionId: string; message: string };
  const pool = getPool();
  const session = pool.get(sessionId);
  if (!session) return { error: 'session not found' };
  if (!session.agentRunning) return { error: 'no agent running' };
  pool.pushInjectedMessage(sessionId, message);
  return { ok: true };
};

export const chatClose: RpcHandler = async (params) => {
  const { sessionId } = params as { sessionId: string };
  const pool = getPool();
  const closed = await pool.close(sessionId);
  return { ok: closed };
};

export const chatList: RpcHandler = async () => {
  const pool = getPool();
  return pool.list();
};

export const chatStatus: RpcHandler = async (params) => {
  const { sessionId } = params as { sessionId: string };
  const pool = getPool();
  const status = pool.status(sessionId);
  if (!status) return { error: 'session not found' };
  return status;
};

export const chatRestore: RpcHandler = async (params) => {
  const { sessionId } = params as { sessionId: string };
  const pool = getPool();
  const restored = await pool.restore(sessionId);
  if (!restored) return { error: 'session not found in DB' };
  const active = pool.get(restored)!;
  return { sessionId: restored, repo: active.session.repoPath };
};

// ---------------------------------------------------------------------------
// Streaming handlers
// ---------------------------------------------------------------------------

export const chatSend: StreamHandler = async (params, send, signal) => {
  const { sessionId, message } = params as { sessionId: string; message: string };
  const pool = getPool();
  const active = pool.get(sessionId);
  if (!active) throw new Error('session not found');
  if (active.agentRunning) throw new Error('agent already running on this session');

  const requestId = Date.now(); // used as stream message id

  // Create DaemonChannel + AbortController
  const abortController = new AbortController();
  // Link outer signal (from IPC server socket close) to our abort
  signal.addEventListener('abort', () => abortController.abort(), { once: true });

  const channel = new DaemonChannel(requestId, send, abortController);

  // Attach channel to session pool
  if (!pool.attachChannel(sessionId, channel, abortController)) {
    throw new Error('agent already running on this session');
  }

  try {
    await runChatMessage(active, channel, message, requestId, send);
  } finally {
    pool.detachChannel(sessionId);
  }
};

export const chatResume: StreamHandler = async (params, send, signal) => {
  const { sessionId } = params as { sessionId: string };
  const pool = getPool();
  const active = pool.get(sessionId);
  if (!active) throw new Error('session not found');
  if (active.agentRunning) throw new Error('agent already running on this session');

  const requestId = Date.now();
  const abortController = new AbortController();
  signal.addEventListener('abort', () => abortController.abort(), { once: true });

  const channel = new DaemonChannel(requestId, send, abortController);

  if (!pool.attachChannel(sessionId, channel, abortController)) {
    throw new Error('agent already running on this session');
  }

  try {
    // Resume uses the same runAgent with resumeFrom option
    // The checkpoint is read internally by runAgent from the run directory
    await runChatMessage(active, channel, '', requestId, send);
  } finally {
    pool.detachChannel(sessionId);
  }
};

// ---------------------------------------------------------------------------
// Code context fetching
// ---------------------------------------------------------------------------

/**
 * Fetch code context from the knowledge graph via daemon RPC search.
 * Returns an empty string if the search fails (degrades gracefully).
 */
async function fetchCodeContext(message: string): Promise<string> {
  try {
    const { rpc: cliRpc } = await import('../cli/client.js');
    const entities = await cliRpc<Array<{ kind: string; name: string; file: string; body?: string; signature?: string }>>('search.query', {
      text: message,
      limit: 10,
      filter: 'all',
    });

    if (entities.length > 0) {
      const contextParts: string[] = [];
      for (const e of entities) {
        const sig = e.signature ? ` — ${e.signature}` : '';
        const body = e.body ? `\n${e.body.slice(0, 500)}` : '';
        contextParts.push(`[${e.kind}] ${e.name}${sig} (${e.file})${body}`);
      }
      log.debug({ hits: entities.length }, 'code context loaded');
      return contextParts.join('\n\n');
    }
  } catch (searchErr) {
    log.debug({ err: searchErr }, 'code context search failed (continuing without)');
  }
  return '';
}

// ---------------------------------------------------------------------------
// Core message processing
// ---------------------------------------------------------------------------

async function runChatMessage(
  active: ReturnType<ChatSessionPool['get']> & object,
  channel: DaemonChannel,
  message: string,
  requestId: number,
  send: (msg: IpcStreamMessage) => void,
): Promise<void> {
  const session = active.session;
  if (!session || !session.repoPath) {
    throw new Error(`session not properly initialized: session=${!!session}, repoPath=${session?.repoPath}`);
  }
  const pool = getPool();

  // 0. Resolve file references with per-session cache
  active.fileCache.setTurn(session.turnIndex);
  const fileRefs = await resolveFileRefs(message, {
    cwd: session.repoPath,
    maxTokens: 6000,
    prompt: message,
    multiPass: true,
    chunkTokens: 4000,
  });
  // Update cache and report per-file progress
  if (fileRefs.length > 0) {
    for (let fi = 0; fi < fileRefs.length; fi++) {
      const ref = fileRefs[fi]!;
      try {
        const cached = active.fileCache.getOrRead(ref.path);
        const chunkCount = cached.chunks.length || 1;
        const fileName = ref.path.split('/').pop() ?? ref.ref;
        send({ id: requestId, stream: 'progress', data: {
          message: `Reading ${fi + 1}/${fileRefs.length}: ${fileName} (${chunkCount} chunk${chunkCount > 1 ? 's' : ''})`,
        }});
      } catch { /* skip if file disappeared */ }
    }
  }
  const fileContext = formatFileContext(fileRefs);
  if (fileRefs.length > 0) {
    const totalChunks = fileRefs.reduce((acc, f) => acc + (f.chunks?.length ?? 1), 0);
    const cacheStats = active.fileCache.stats();
    const msg = `${fileRefs.length} file(s), ${totalChunks} chunk(s) (${cacheStats.files} cached)`;
    send({ id: requestId, stream: 'progress', data: { message: msg } });
    log.info({ files: fileRefs.map(f => f.ref), totalChunks, cached: cacheStats.files, truncated: fileRefs.some(f => f.truncated) }, 'file references resolved');
  }

  // Enrich the message with file content for classification and agents
  const enrichedMessage = fileContext ? `${message}\n\n${fileContext}` : message;

  // 0b. Assemble layered context (L1-L4) from ContextManager
  send({ id: requestId, stream: 'progress', data: { message: 'Building context...' } });
  const ctx = session.contextManager;
  // Inject file attachment content into L4 if present
  if (fileContext) {
    ctx.setAttachmentContext(fileContext);
  }
  const queryEmbedding = await ctx.embedQuery(message);
  const assembled = await ctx.assemble(message, queryEmbedding);
  log.debug({
    system: assembled.system.tokens,
    summary: assembled.summary.tokens,
    recent: assembled.recent.tokens,
    semantic: assembled.semantic.tokens,
    code: assembled.code.tokens,
    total: assembled.totalTokens,
    dropped: assembled.dropped.length,
  }, 'context assembled');

  // Send overflow feedback to IDE
  if (assembled.dropped.length > 0) {
    const droppedSummary = assembled.dropped
      .reduce((acc, d) => {
        const key = `${d.layer}`;
        acc[key] = (acc[key] ?? 0) + d.tokensDropped;
        return acc;
      }, {} as Record<string, number>);
    const parts = Object.entries(droppedSummary).map(([layer, tokens]) => `${layer}: ${tokens} tokens`);
    send({ id: requestId, stream: 'progress', data: {
      message: `Context: ${assembled.totalTokens} tokens. Dropped: ${parts.join(', ')}`,
    }});
  }

  // 1. Decompose prompt into structured actions
  send({ id: requestId, stream: 'progress', data: { message: 'Analyzing prompt...' } });

  // Build conversation history from assembled context for the decomposer
  // so it can resolve references to prior turns (e.g., "format that", "use gke...")
  const historyMessages = ctx.buildMessages(assembled, '')
    .filter(m => m.role !== 'system')
    .slice(0, -1) // remove the empty user message placeholder
    .filter(m => typeof m.content === 'string')
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content as string }));
  const decomposeProvider = session.resolver.resolve('classifier', 'decompose');
  const decomposed = await decompose(message, decomposeProvider, historyMessages);

  if (decomposed.usedLLM && decomposed.actions.length > 1) {
    // Multi-action prompt — build tasks and execute via TaskPipeline
    log.info({ actions: decomposed.actions.length }, 'multi-action prompt detected');
    send({ id: requestId, stream: 'progress', data: {
      message: `Decomposed into ${decomposed.actions.length} actions: ${decomposed.actions.map(a => a.intent).join(' → ')}`,
    } });

    // Update file refs with purpose tags from decomposition
    for (const action of decomposed.actions) {
      if (action.refs) {
        for (const ref of action.refs) {
          const matchingFileRef = fileRefs.find(f => f.ref === ref.path || f.path.endsWith(ref.path));
          if (matchingFileRef) {
            Object.assign(matchingFileRef, { purpose: ref.purpose });
          }
        }
      }
    }

    const tasks = buildTasks(decomposed.actions, message);
    const taskDeps: TaskOrchestratorDeps = {
      session, channel, send, requestId,
      historyMessages: historyMessages as LLMMessage[],
    };
    const pipelineResult = await runTaskPipeline(tasks, taskDeps);

    send({ id: requestId, stream: 'done', data: { summary: `${pipelineResult.tasks.length} tasks completed` } });
    await persistTurn(session, message, pipelineResult.finalOutput, pipelineResult.finalFormat);
    return;
  }

  // Single action or decompose failed — fall through to classic single-intent flow
  // Use decomposed intent if available, otherwise classify
  let classifiedIntent: string;
  let classifiedMessage: string;
  let classifiedExplicit: import('../shared/types.js').ExplicitProvider | undefined;

  if (decomposed.usedLLM && decomposed.actions.length === 1) {
    const action = decomposed.actions[0]!;
    const conf = action.confidence ?? 0;
    log.info({ intent: action.intent, confidence: conf }, 'single action from decomposer');

    // Low-confidence classifications fall through to simple completion
    if (conf < 0.6) {
      log.info({ intent: action.intent, confidence: conf }, 'low confidence — using simple completion');
      classifiedIntent = 'research';
      classifiedMessage = message;
      classifiedExplicit = undefined;
    } else {
      // Single shell intent → route through task pipeline (command resolved at exec time)
      if (['infra', 'deploy', 'release'].includes(action.intent)) {
        send({ id: requestId, stream: 'progress', data: { message: `Intent: ${action.intent}` } });
        const tasks = buildTasks([action], message);
        const taskDeps: TaskOrchestratorDeps = {
          session, channel, send, requestId,
          historyMessages: historyMessages as LLMMessage[],
        };
        const pipelineResult = await runTaskPipeline(tasks, taskDeps);
        send({ id: requestId, stream: 'done', data: { summary: action.action } });
        await persistTurn(session, message, pipelineResult.finalOutput, pipelineResult.finalFormat);
        return;
      }

      classifiedIntent = action.intent;
      classifiedMessage = message;
      classifiedExplicit = undefined;
    }
  } else {
    log.info({ message: message.slice(0, 80) }, 'classifying (fallback)');
    const classifyProvider = session.resolver.resolve('classifier', 'classify');
    const classified = await classify(enrichedMessage, {
      llmProvider: classifyProvider,
    });
    classifiedIntent = classified.intent;
    classifiedMessage = classified.message;
    classifiedExplicit = classified.explicit;
    log.info({ intent: classifiedIntent, confidence: classified.confidence }, 'classified');
  }

  send({ id: requestId, stream: 'progress', data: { message: `Intent: ${classifiedIntent}` } });

  // 2. Route to provider
  const route = selectProvider(classifiedIntent as import('../shared/types.js').Intent, classifiedExplicit, {
    ollamaProvider: session.ollamaProvider,
    claudeProvider: session.claudeProvider,
    config: session.config,
  });

  // 3. Check for actionable intents (infra, deploy) — fallback for
  //    static pattern matches (daemon status, repo list, etc.) when decomposer didn't extract a command
  const actionResponse = await tryActionableIntent(classifiedIntent, classifiedMessage, requestId, send, session, channel, assembled);
  if (actionResponse !== null) {
    await persistTurn(session, message, actionResponse);
    return;
  }

  // 4. Use assembled context (already fetched from ContextManager in step 0b)
  const codeContext = assembled.code.text;

  // 5. Route through task pipeline — agent intents become agent tasks,
  //    non-agent intents become LLM tasks (simple completion)
  const isAgentIntent = ['implement', 'refactor', 'debug', 'test', 'design',
    'plan', 'brainstorm', 'requirements'].includes(classifiedIntent);

  if (isAgentIntent) {
    // Build a single agent task and run through the task pipeline
    const agentTask: import('./task.js').Task = {
      index: 0,
      description: `Running ${classifiedIntent} agent...`,
      kind: 'agent',
      intent: classifiedIntent,
      agentId: classifiedIntent,
      userMessage: enrichedMessage,
      persisted: true,
    };

    send({ id: requestId, stream: 'progress', data: { message: `Running ${classifiedIntent} agent...` } });

    const taskDeps: TaskOrchestratorDeps = {
      session, channel, send, requestId,
      historyMessages: historyMessages as LLMMessage[],
      getInjectedMessages: () => pool.popInjectedMessages(active.id),
    };
    const pipelineResult = await runTaskPipeline([agentTask], taskDeps);

    pool.setLastStep(active.id, `done (${classifiedIntent})`);
    send({ id: requestId, stream: 'done', data: { summary: `${classifiedIntent} agent completed` } });

    if (!channel.aborted) {
      log.info({ sessionId: active.id, intent: classifiedIntent }, 'agent completed via task pipeline');
      await persistTurn(session, message, pipelineResult.finalOutput, pipelineResult.finalFormat);
    }
    return;
  }

  // Non-agent intent (research, document, review, code-analysis) — simple completion via LLM task
  await runSimpleCompletion(session, channel, enrichedMessage, route.provider, requestId, send, codeContext, assembled);
}

// ---------------------------------------------------------------------------
// Agent selection
// ---------------------------------------------------------------------------

interface AgentSelection {
  definition: AgentDefinition;
  input: unknown;
}

function selectAgent(
  intent: string,
  message: string,
  session: Session,
  codeContext: string,
  fileRefs?: FileRefResult[],
): AgentSelection | null {
  log.debug({ repoPath: session.repoPath, intent }, 'selectAgent');
  const sessionRef = {
    repoPath: session.repoPath,
    closureRepos: session.closureRepos ?? [],
  };

  switch (intent) {
    case 'design':
    case 'requirements': {
      const parsed = parseTemplateFlags(message);
      const template = resolveTemplate({ ...parsed, repoPath: session.repoPath });
      // Collect doc chunks from all file refs for multi-pass extraction
      const docChunks = fileRefs
        ?.flatMap(f => f.chunks ?? [])
        .map(c => ({ heading: c.heading, content: c.content, index: c.index, total: c.total }));
      const input: DesignerInput = {
        message: parsed.message,
        codeContext,
        template,
        intent: intent as 'requirements' | 'design',
        session: sessionRef,
        ...(docChunks && docChunks.length > 0 ? { docChunks } : {}),
      };
      return {
        definition: designerAgent as unknown as AgentDefinition,
        input,
      };
    }

    case 'plan': {
      const input: PlannerInput = {
        message,
        codeContext,
        session: sessionRef,
      };
      return {
        definition: plannerAgent as unknown as AgentDefinition,
        input,
      };
    }

    case 'brainstorm': {
      const input: BrainstormInput = {
        message,
        codeContext,
        session: sessionRef,
      };
      return {
        definition: brainstormAgent as unknown as AgentDefinition,
        input,
      };
    }

    case 'implement':
    case 'refactor': {
      const scope = detectScope(message);
      if (scope === 'batch') {
        const input: DelegateInput = {
          message,
          codeContext,
          session: sessionRef,
        };
        return {
          definition: delegateAgent as unknown as AgentDefinition,
          input,
        };
      }
      const mode: PairMode = intent === 'refactor' ? 'refactor' : 'implement';
      const input: PairInput = {
        message,
        codeContext,
        mode,
        session: sessionRef,
      };
      return {
        definition: pairAgent as unknown as AgentDefinition,
        input,
      };
    }

    case 'test': {
      const input: TesterInput = {
        message,
        codeContext,
        session: sessionRef,
      };
      return {
        definition: testerAgent as unknown as AgentDefinition,
        input,
      };
    }

    case 'debug': {
      const input: PairInput = {
        message,
        codeContext,
        mode: 'debug',
        session: sessionRef,
      };
      return {
        definition: pairAgent as unknown as AgentDefinition,
        input,
      };
    }

    default:
      // research, document, review, code-analysis, deploy, release, infra
      return null;
  }
}

// ---------------------------------------------------------------------------
// Actionable intents (infra, deploy — execute daemon RPCs)
// ---------------------------------------------------------------------------

const ACTION_PATTERNS: Array<{
  patterns: RegExp[];
  action: string;
  rpcMethod: string;
  rpcParams?: (message: string) => Record<string, unknown>;
  formatResult: (result: unknown) => string;
}> = [
  {
    patterns: [/status.*(?:index|daemon|queue)/i, /(?:index|daemon|queue).*status/i, /check.*(?:index|daemon)/i, /how.*(?:index|daemon).*doing/i],
    action: 'Checking daemon status...',
    rpcMethod: 'daemon.status',
    formatResult: (r) => {
      const s = r as { uptime?: number; queueDepth?: number; repos?: Array<{ path: string; status: string; lastIndexed?: string }> };
      const uptime = s.uptime ? `${Math.floor(s.uptime / 60)}m ${s.uptime % 60}s` : 'unknown';
      const repoLines = (s.repos ?? []).map(repo => {
        const name = repo.path.split('/').pop();
        return `  - **${name}**: ${repo.status}${repo.lastIndexed ? ` (last indexed: ${repo.lastIndexed})` : ''}`;
      }).join('\n');
      return `**Daemon Status**\n- Uptime: ${uptime}\n- Queue: ${s.queueDepth ?? 0} pending\n\n**Repos:**\n${repoLines || '  (none)'}`;
    },
  },
  {
    patterns: [/list.*repo/i, /(?:show|what).*repo/i, /indexed.*repo/i],
    action: 'Listing repos...',
    rpcMethod: 'repo.list',
    formatResult: (r) => {
      const repos = r as Array<{ path: string; name: string; status: string; lastIndexed?: string }>;
      if (repos.length === 0) return 'No repos indexed. Use `insrc repo add <path>` to add one.';
      const lines = repos.map(repo => `- **${repo.name}** — ${repo.status}${repo.lastIndexed ? ` (${repo.lastIndexed})` : ''}\n  \`${repo.path}\``);
      return `**Indexed Repos (${repos.length}):**\n${lines.join('\n')}`;
    },
  },
  {
    patterns: [/reindex/i, /re-index/i, /rebuild.*index/i],
    action: 'Triggering re-index...',
    rpcMethod: 'repo.reindex',
    rpcParams: (msg) => {
      // Try to extract repo path from message, default to first repo
      const pathMatch = msg.match(/(?:\/[\w./-]+)/);
      return pathMatch ? { path: pathMatch[0] } : {};
    },
    formatResult: (r) => {
      const res = r as { ok?: boolean; error?: string };
      if (res.error) return `Re-index failed: ${res.error}`;
      return 'Re-index started. Check status with "check indexer status".';
    },
  },
  {
    patterns: [/conversation.*stats/i, /memory.*stats/i, /how.*many.*turns/i],
    action: 'Getting conversation stats...',
    rpcMethod: 'conversation.stats',
    formatResult: (r) => {
      const s = r as Record<string, unknown>;
      const lines = Object.entries(s).map(([k, v]) => `- **${k}**: ${v}`);
      return `**Conversation Stats:**\n${lines.join('\n')}`;
    },
  },
  {
    patterns: [/compact.*conversation/i, /compact.*history/i, /compact.*memory/i],
    action: 'Compacting conversations...',
    rpcMethod: 'conversation.compact',
    formatResult: (r) => {
      const s = r as Record<string, unknown>;
      return `**Compaction complete:** ${JSON.stringify(s)}`;
    },
  },
];

/**
 * Try to handle as an actionable intent. Returns the response text if handled, null otherwise.
 */
async function tryActionableIntent(
  intent: string,
  message: string,
  requestId: number,
  send: (msg: IpcStreamMessage) => void,
  session?: Session,
  channel?: DaemonChannel,
  assembled?: AssembledContext,
): Promise<string | null> {
  // Only consider infra, deploy, release intents
  if (!['infra', 'deploy', 'release'].includes(intent)) return null;

  // 1. Try static pattern match (fast path — no LLM needed)
  for (const action of ACTION_PATTERNS) {
    if (action.patterns.some(p => p.test(message))) {
      send({ id: requestId, stream: 'progress', data: { message: action.action } });

      try {
        const { rpc: cliRpc } = await import('../cli/client.js');
        const params = action.rpcParams ? action.rpcParams(message) : {};
        const result = await cliRpc(action.rpcMethod, params);
        const formatted = action.formatResult(result);

        const rendered = renderMarkdown(formatted);
        send({ id: requestId, stream: 'delta', data: { text: rendered.text, format: rendered.format } });
        send({ id: requestId, stream: 'done', data: { summary: action.action } });
        return formatted;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const errText = `Failed to execute: ${errMsg}`;
        send({ id: requestId, stream: 'delta', data: { text: errText } });
        send({ id: requestId, stream: 'done', data: { summary: 'action failed' } });
        return errText;
      }
    }
  }

  // 2. No static match — use LLM to extract shell command (if session/channel available)
  if (session && channel) {
    return tryLLMCommandExtraction(message, requestId, send, session, channel, assembled);
  }

  return null;
}

// ---------------------------------------------------------------------------
// LLM-driven shell command extraction + gated execution
// ---------------------------------------------------------------------------

const INSRC_COMMANDS_CONTEXT = `
IMPORTANT: For insrc-specific operations, use these INTERNAL RPC commands (not shell commands):
- For "restart the daemon/indexer" → set command to "RPC:daemon.restart"
- For "reindex a repo" → set command to "RPC:repo.reindex"
- For "list repos" → set command to "RPC:repo.list"
- For "conversation stats" → set command to "RPC:conversation.stats"
- For "compact conversations" → set command to "RPC:conversation.compact"
- For "list keys" → set command to "RPC:keys.list"
Any command starting with "RPC:" is handled internally, not via shell.
Do NOT use "insrc" as a shell command — it is not installed in PATH.
`;

const COMMAND_EXTRACTION_PROMPT = `You are a system administrator assistant. The user wants to perform an infrastructure/deployment action.
Extract the exact shell command they want to run. Consider common tools: kubectl, docker, helm, terraform, ansible, systemctl, journalctl, curl, git, npm, etc.

${INSRC_COMMANDS_CONTEXT}

Rules:
- Output ONLY a JSON object: {"command": "<shell command>", "description": "<1-line description>", "risk": "low"|"medium"|"high"}
- "low" = read-only commands (get, list, status, logs, describe)
- "medium" = modifications (apply, restart, scale)
- "high" = destructive (delete, destroy, drop, rm -rf, force)
- If the request is about insrc operations, use the insrc CLI commands listed above
- If the request is ambiguous or you can't determine a safe command, set command to null
- Do NOT add output format flags (e.g., -o markdown, -o json, -o yaml) unless the user
  explicitly asked for a specific kubectl/CLI output format. Formatting and analysis of
  output is handled separately as a post-processing step.
- No markdown fences, no explanation, just the JSON`;

async function tryLLMCommandExtraction(
  message: string,
  requestId: number,
  send: (msg: IpcStreamMessage) => void,
  session: Session,
  channel: DaemonChannel,
  assembled?: AssembledContext,
): Promise<string | null> {
  try {
    send({ id: requestId, stream: 'progress', data: { message: 'Analyzing command...' } });

    // Include code context and conversation history from assembled layers
    const codeHint = assembled?.code.text
      ? `\n\nRelevant codebase context:\n${assembled.code.text.slice(0, 2000)}`
      : '';

    // Build messages with conversation history so the LLM can resolve
    // references to prior command outputs (e.g., "switch to gke..." from previous kubectl output)
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: COMMAND_EXTRACTION_PROMPT },
    ];
    if (assembled) {
      const ctx = session.contextManager;
      const historyMsgs = ctx.buildMessages(assembled, '')
        .filter(m => m.role !== 'system')
        .slice(0, -1)
        .filter(m => typeof m.content === 'string')
        .map(m => ({ role: m.role as 'system' | 'user' | 'assistant', content: m.content as string }));
      // Include last 4 turns max (to stay within context budget)
      messages.push(...historyMsgs.slice(-8));
    }
    messages.push({ role: 'user', content: `${message}${codeHint}` });

    const commandProvider = session.resolver.resolve('classifier', 'command-extract');
    const response = await commandProvider.complete(
      messages,
      { maxTokens: 256, temperature: 0.1 },
    );

    // Parse command from LLM response
    const text = response.text.trim();
    let parsed: { command: string | null; description: string; risk: string };
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { command: null, description: '', risk: 'high' };
    } catch {
      log.debug({ response: text }, 'failed to parse command extraction response');
      return null;
    }

    if (!parsed.command) {
      const unclearMsg = `I couldn't determine a safe command for: "${message}"\n\nPlease specify the exact command you'd like to run.`;
      send({ id: requestId, stream: 'delta', data: { text: unclearMsg } });
      send({ id: requestId, stream: 'done', data: { summary: 'command unclear' } });
      return unclearMsg;
    }

    const { command, description, risk } = parsed;
    log.info({ command, description, risk }, 'extracted shell command');

    // Handle internal RPC commands (e.g., "RPC:daemon.restart")
    if (command.startsWith('RPC:')) {
      const rpcMethod = command.slice(4);
      send({ id: requestId, stream: 'progress', data: { message: `Executing: ${rpcMethod}...` } });
      try {
        const { rpc: cliRpc } = await import('../cli/client.js');
        const result = await cliRpc(rpcMethod, {});
        const formatted = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        const rpcRendered = renderMarkdown(`**${description}**\n\n\`\`\`\n${formatted}\n\`\`\``);
        send({ id: requestId, stream: 'delta', data: { text: rpcRendered.text, format: rpcRendered.format } });
        send({ id: requestId, stream: 'done', data: { summary: description } });
        return formatted;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        send({ id: requestId, stream: 'delta', data: { text: `Failed: ${errMsg}` } });
        send({ id: requestId, stream: 'done', data: { summary: 'RPC failed' } });
        return `Failed: ${errMsg}`;
      }
    }

    // Check permission mode
    const permMode = session.config.permissions?.mode ?? 'validate';

    if (permMode === 'auto-accept' && risk === 'low') {
      const responseText = await executeWithRetry(command, requestId, send, session, channel);
      send({ id: requestId, stream: 'done', data: { summary: description } });
      return responseText;
    }

    // Gate: ask user for permission
    const riskLabel = risk === 'high' ? '⚠️ HIGH RISK' : risk === 'medium' ? '⚡ Medium risk' : '✓ Low risk';
    const gateId = `cmd-${Date.now()}`;

    send({ id: requestId, stream: 'gate', data: {
      gateId,
      title: `Execute command? (${riskLabel})`,
      content: `$ ${command}\n\n${description}`,
      actions: [
        { name: 'execute', label: 'Execute' },
        { name: 'reject', label: 'Cancel' },
        { name: 'edit', label: 'Edit', needsInput: true },
      ],
    } });

    const reply = await new Promise<ReplyPayload>((resolve, reject) => {
      channel.registerExternalGate(gateId, resolve, reject);
    });

    if (reply.action === 'execute') {
      const responseText = await executeWithRetry(command, requestId, send, session, channel);
      send({ id: requestId, stream: 'done', data: { summary: description } });
      return responseText;
    }

    if (reply.action === 'edit' && reply.feedback) {
      const editedCmd = reply.feedback.trim();
      const responseText = await executeWithRetry(editedCmd, requestId, send, session, channel);
      send({ id: requestId, stream: 'done', data: { summary: `Executed: ${editedCmd.slice(0, 50)}` } });
      return responseText;
    }

    // Cancelled
    send({ id: requestId, stream: 'delta', data: { text: 'Command cancelled.' } });
    send({ id: requestId, stream: 'done', data: { summary: 'cancelled' } });
    return 'Command cancelled.';

  } catch (err) {
    log.debug({ err }, 'LLM command extraction failed');
    return null;
  }
}

interface ShellResult {
  success: boolean;
  output: string;
  exitCode: number | null;
}

async function executeShellCommand(command: string): Promise<ShellResult> {
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

const ERROR_FIX_PROMPT = `You are a system administrator. A shell command failed. Analyze the error and suggest a fixed command.

Rules:
- Output ONLY a JSON object: {"analysis": "<1-2 sentence explanation of what went wrong>", "fixedCommand": "<corrected command>", "canFix": true|false}
- If the error is unfixable (e.g., service doesn't exist, permission denied that needs sudo), set canFix to false and fixedCommand to null
- Common fixes: wrong flags, missing namespace, typo in resource name, wrong path, missing package
- Do NOT suggest dangerous commands (rm -rf, DROP TABLE, etc.)
- No markdown fences, no explanation, just the JSON`;

const DEFAULT_MAX_RETRIES = 3;
const ABSOLUTE_MAX_RETRIES = 8;

async function executeWithRetry(
  command: string,
  requestId: number,
  send: (msg: IpcStreamMessage) => void,
  session: Session,
  channel: DaemonChannel,
): Promise<string> {
  const configuredRetries = (session.config as unknown as Record<string, unknown>)['maxCommandRetries'] as number | undefined;
  const maxRetries = Math.min(configuredRetries ?? DEFAULT_MAX_RETRIES, ABSOLUTE_MAX_RETRIES);
  let currentCmd = command;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    send({ id: requestId, stream: 'progress', data: { message: `Running: ${currentCmd}` } });
    const result = await executeShellCommand(currentCmd);

    if (result.success) {
      const formatted = `$ ${currentCmd}\n${result.output}`;
      send({ id: requestId, stream: 'delta', data: { text: formatted, format: 'code' } });
      return formatted;
    }

    // Command failed — show the error
    const errorBlock = `$ ${currentCmd}\n${result.output}\n(exit code: ${result.exitCode})`;
    send({ id: requestId, stream: 'delta', data: { text: errorBlock, format: 'code' } });

    if (attempt >= maxRetries) {
      send({ id: requestId, stream: 'delta', data: { text: `Failed after ${maxRetries + 1} attempts.` } });
      return errorBlock;
    }

    // Ask LLM to analyze the error and suggest a fix — with system context
    send({ id: requestId, stream: 'progress', data: { message: 'Analyzing error...' } });

    try {
      // Build context-aware system prompt
      let systemPrompt = ERROR_FIX_PROMPT;
      try {
        const ctx = session.contextManager;
        if (ctx) {
          const { embedQuery: embedQ } = await import('../indexer/embedder.js');
          const embedding = await embedQ(`${currentCmd} ${result.output}`);
          const assembled = await ctx.assemble(currentCmd, embedding);
          if (assembled.code.text) {
            systemPrompt += `\n\nRelevant system context:\n${assembled.code.text.slice(0, 2000)}`;
          }
        }
      } catch {
        // Non-fatal — continue without context
      }

      const fixResponse = await session.ollamaProvider.complete(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Command: ${currentCmd}\n\nError output:\n${result.output}\n\nExit code: ${result.exitCode}` },
        ],
        { maxTokens: 256, temperature: 0.1 },
      );

      const fixText = fixResponse.text.trim();
      const fixMatch = fixText.match(/\{[\s\S]*\}/);
      if (!fixMatch) break;

      const fix = JSON.parse(fixMatch[0]) as { analysis: string; fixedCommand: string | null; canFix: boolean };

      const analysisRendered = renderMarkdown(`**Analysis:** ${fix.analysis}\n\n`);
      send({ id: requestId, stream: 'delta', data: { text: analysisRendered.text, format: analysisRendered.format } });

      if (!fix.canFix || !fix.fixedCommand) {
        send({ id: requestId, stream: 'delta', data: { text: 'Cannot auto-fix this error.' } });
        return errorBlock;
      }

      // Gate: ask user to approve the fix
      const gateId = `fix-${Date.now()}`;
      send({ id: requestId, stream: 'gate', data: {
        gateId,
        title: `Retry with fixed command? (attempt ${attempt + 2}/${maxRetries + 1})`,
        content: `$ ${fix.fixedCommand}\n\n${fix.analysis}`,
        actions: [
          { name: 'execute', label: 'Retry' },
          { name: 'reject', label: 'Stop' },
          { name: 'edit', label: 'Edit', needsInput: true },
        ],
      } });

      const reply = await new Promise<ReplyPayload>((resolve, reject) => {
        channel.registerExternalGate(gateId, resolve, reject);
      });

      if (reply.action === 'execute') {
        currentCmd = fix.fixedCommand;
        continue;
      } else if (reply.action === 'edit' && reply.feedback) {
        currentCmd = reply.feedback.trim();
        continue;
      } else {
        send({ id: requestId, stream: 'delta', data: { text: 'Retry cancelled.' } });
        return errorBlock;
      }
    } catch (err) {
      log.debug({ err }, 'error fix analysis failed');
      break;
    }
  }

  return `Command failed: ${currentCmd}`;
}

// ---------------------------------------------------------------------------
// Simple completion (non-agent intents)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Single action runner (used by DAG executor for multi-action prompts)
// ---------------------------------------------------------------------------

export async function _runSingleAction(
  active: ReturnType<ChatSessionPool['get']> & object,
  channel: DaemonChannel,
  action: DecomposedAction,
  _idx: number,
  priorOutput: string | undefined,
  fileRefs: FileRefResult[],
  fileContext: string,
  send: (msg: IpcStreamMessage) => void,
  requestId: number,
): Promise<string> {
  const session = active.session;
  const pool = getPool();

  // Build message from action + prior output context
  const actionMessage = priorOutput
    ? `${action.action}\n\nContext from prior step:\n${priorOutput.slice(0, 2000)}`
    : action.action;

  // If decomposer provided a command hint, use it directly (legacy path — unused)
  if (action.commandHint && ['infra', 'deploy', 'release'].includes(action.intent)) {
    const cmd = action.commandHint;
    const isIntermediate = action.dependsOn !== undefined || priorOutput === undefined;
    log.info({ command: cmd, action: action.action, intermediate: isIntermediate }, 'using pre-extracted command from decomposer');

    // Still gate the command for permission
    const permMode = session.config.permissions?.mode ?? 'validate';
    if (permMode !== 'auto-accept') {
      const gateId = `cmd-${Date.now()}`;
      send({ id: requestId, stream: 'gate', data: {
        gateId,
        title: 'Execute command? (✓ Low risk)',
        content: `$ ${cmd}\n\n${action.action}`,
        actions: [
          { name: 'execute', label: 'Execute' },
          { name: 'reject', label: 'Cancel' },
        ],
      } });
      const reply = await new Promise<ReplyPayload>((resolve, reject) => {
        channel.registerExternalGate(gateId, resolve, reject);
      });
      if (reply.action !== 'execute') {
        send({ id: requestId, stream: 'delta', data: { text: 'Command cancelled.' } });
        return 'cancelled';
      }
    }

    const responseText = await executeWithRetry(cmd, requestId, send, session, channel);
    return responseText;
  }

  // Check for actionable intents first
  const actionResponse = await tryActionableIntent(action.intent, actionMessage, requestId, send, session, channel);
  if (actionResponse !== null) return actionResponse;

  // Fetch code context
  const graphContext = await fetchCodeContext(actionMessage);
  const codeContext = fileContext
    ? `${fileContext}\n\n--- Code Graph Context ---\n${graphContext}`
    : graphContext;

  // Try to route to an agent
  const enrichedMessage = fileContext ? `${actionMessage}\n\n${fileContext}` : actionMessage;
  const agentInfo = selectAgent(action.intent, enrichedMessage, session, codeContext, fileRefs);

  if (!agentInfo) {
    // Simple completion for this action
    let output = '';
    const captureSend = (msg: IpcStreamMessage): void => {
      send(msg);
      if (msg.stream === 'delta') {
        const data = msg.data as Record<string, unknown>;
        output += String(data['text'] ?? '');
      }
    };
    await runSimpleCompletion(session, channel, enrichedMessage, undefined, requestId, captureSend, codeContext);
    return output;
  }

  // Run agent
  const { definition, input } = agentInfo;
  send({ id: requestId, stream: 'progress', data: { message: `Running ${definition.id} agent...` } });

  const { rpc: cliRpc } = await import('../cli/client.js');
  const rpcFn = async <T>(method: string, params?: unknown): Promise<T> => {
    return cliRpc<T>(method, params ?? {});
  };

  await runAgent({
    definition: definition as AgentDefinition,
    channel,
    options: { input, repo: session.repoPath },
    config: session.config,
    providers: {
      local: session.ollamaProvider,
      claude: session.claudeProvider,
      resolve: (agent: string, step: string) => session.resolver.resolve(agent, step),
      resolveOrNull: (agent: string, step: string) => session.resolver.resolveOrNull(agent, step),
    },
    rpcFn,
  });

  pool.setLastStep(active.id, `done (${definition.id})`);
  return channel.responseText || `[${definition.id} agent completed]`;
}

// Read-only tools for simple completion (same as investigate, no write tools)
const SIMPLE_COMPLETION_TOOLS: ToolDefinition[] = [
  {
    name: 'Read',
    description: 'Read a file from disk. Returns the file contents.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to read' },
        offset: { type: 'number', description: 'Line number to start reading from (optional)' },
        limit: { type: 'number', description: 'Number of lines to read (optional)' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'Glob',
    description: 'Search for files by glob pattern. Returns matching file paths.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g. "src/**/*.ts")' },
        path: { type: 'string', description: 'Base directory to search in (optional)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Grep',
    description: 'Search file contents by regex pattern. Returns matching lines.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'File or directory to search in (optional)' },
        glob: { type: 'string', description: 'Glob to filter files (e.g. "*.ts") (optional)' },
        include_context: { type: 'number', description: 'Lines of context around matches (optional)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'graph_search',
    description: 'Vector similarity search over code entity embeddings. Returns ranked entities.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'graph_callers',
    description: 'Return entities that call a given entity.',
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name or ID' },
        hops: { type: 'number', description: 'Max hop depth (default 1)' },
      },
      required: ['entity'],
    },
  },
  {
    name: 'graph_callees',
    description: 'Return entities called by a given entity.',
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name or ID' },
        hops: { type: 'number', description: 'Max hop depth (default 1)' },
      },
      required: ['entity'],
    },
  },
];

async function runSimpleCompletion(
  session: Session,
  _channel: DaemonChannel,
  message: string,
  _provider: unknown,
  requestId: number,
  send: (msg: IpcStreamMessage) => void,
  _existingContext?: string,
  assembled?: AssembledContext,
): Promise<void> {
  try {
    // Build messages from assembled context
    let messages: LLMMessage[];
    if (assembled) {
      messages = session.contextManager.buildMessages(assembled, message);
      log.debug({ layers: assembled.totalTokens }, 'simple completion: using assembled context');
    } else {
      const queryEmbed = await session.contextManager.embedQuery(message);
      const freshAssembled = await session.contextManager.assemble(message, queryEmbed);
      messages = session.contextManager.buildMessages(freshAssembled, message);
      log.debug({ layers: freshAssembled.totalTokens }, 'simple completion: assembled fresh context');
    }

    // Use tool loop so the LLM can read files, search code, query graph
    const { runToolLoop } = await import('../agent/tools/loop.js');

    let accumulatedText = '';

    const result = await runToolLoop(messages, {
      provider: session.ollamaProvider,
      tools: SIMPLE_COMPLETION_TOOLS,
      intent: 'research',
      permissionMode: 'auto-accept',  // read-only tools, no validation needed
      maxTokens: 4096,
      onTextDelta: (delta) => {
        accumulatedText += delta;
      },
      onToolCall: (call) => {
        send({ id: requestId, stream: 'progress', data: {
          message: `Using ${call.name}${call.input?.['file_path'] ? ': ' + (call.input['file_path'] as string).split('/').pop() : call.input?.['pattern'] ? ': ' + call.input['pattern'] : call.input?.['query'] ? ': ' + call.input['query'] : ''}`,
        }});
      },
    });

    const responseText = result.response || accumulatedText;
    const resRendered = renderMarkdown(responseText);
    send({ id: requestId, stream: 'delta', data: { text: resRendered.text, format: resRendered.format } });
    send({ id: requestId, stream: 'done', data: { summary: responseText.slice(0, 100) } });

    if (result.iterations > 0) {
      log.info({ toolIterations: result.iterations, hitLimit: result.hitLimit }, 'simple completion used tools');
    }

    // Persist turn and update context manager
    await persistTurn(session, message, resRendered.text, resRendered.format);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send({ id: requestId, stream: 'error', data: { error: msg, recoverable: true } });
  }
}

// ---------------------------------------------------------------------------
// Turn persistence — fire-and-forget save to conversation_turns via RPC
// ---------------------------------------------------------------------------

/**
 * Generate a human-readable session title from the first user message.
 * Extracts key nouns/verbs, capitalizes, truncates to ~50 chars.
 */
function generateSessionTitle(message: string): string {
  // Remove file paths and special chars for a cleaner title
  let cleaned = message
    .replace(/\/[\w./-]+/g, '')           // remove file paths
    .replace(/```[\s\S]*?```/g, '')       // remove code blocks
    .replace(/[#*`_~\[\]()]/g, '')        // remove markdown chars
    .replace(/\s+/g, ' ')
    .trim();

  // If too short after cleaning, use original
  if (cleaned.length < 5) cleaned = message.replace(/\s+/g, ' ').trim();

  // Capitalize first letter
  cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);

  // Truncate at word boundary
  if (cleaned.length > 50) {
    const cut = cleaned.slice(0, 50);
    const lastSpace = cut.lastIndexOf(' ');
    cleaned = (lastSpace > 20 ? cut.slice(0, lastSpace) : cut) + '...';
  }

  return cleaned;
}

async function persistTurn(
  session: Session,
  userMessage: string,
  assistantResponse: string,
  format?: string,
): Promise<void> {
  try {
    // 1. Update context manager's L3a/L3b so subsequent turns have memory
    const entityIds = session.contextManager.getLastEntityIds();
    const turnRecord = {
      userMessage,
      assistantResponse,
      entityIds,
    };
    const embedding = await session.contextManager.embedQuery(userMessage);
    await session.contextManager.recordTurn(turnRecord, embedding);

    // 2. Persist to DB via RPC (fire-and-forget)
    const { rpc: cliRpc } = await import('../cli/client.js');
    await cliRpc('conversation.saveTurn', {
      sessionId: session.id ?? 'unknown',
      idx: session.turnIndex,
      user: userMessage,
      assistant: assistantResponse,
      entities: entityIds,
      vector: embedding,
      repo: session.repoPath,
      type: 'turn',
      tier: 'hot',
      format: format ?? 'text',
      createdAt: new Date().toISOString(),
    });

    // 3. On first turn, save session with a human-readable title
    if (session.turnIndex === 0) {
      const title = generateSessionTitle(userMessage);
      try {
        await cliRpc('conversation.saveSession', {
          id: session.id ?? 'unknown',
          repo: session.repoPath,
          summary: title,
          seenEntities: entityIds,
          vector: embedding,
        });
        log.info({ sessionId: session.id, title }, 'session title saved');
      } catch (titleErr) {
        log.warn({ err: titleErr }, 'failed to save session title');
      }
    }

    session.turnIndex++;
    log.debug({ sessionId: session.id, idx: session.turnIndex, entities: entityIds.length }, 'turn persisted + context updated');
  } catch (err) {
    // Fire-and-forget — don't fail the chat on persistence errors
    log.debug({ err }, 'failed to persist turn');
  }
}
