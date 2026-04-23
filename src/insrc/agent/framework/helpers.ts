/**
 * StepContext builder and message utilities.
 */

import { randomUUID } from 'node:crypto';
import type {
  AgentMessage, Channel, StepContext, GateOpts, GatePayload,
  ReplyPayload, EmitPayload, ProgressPayload,
} from './types.js';
import type {
  AgentConfig, LLMProvider, RecordFeedbackOpts,
  ConfigSearchOpts, ConfigSearchResult, TemplateQuery, ConfigEntry,
} from '../../shared/types.js';
import { recordFeedback as recordFeedbackImpl } from '../../config/feedback.js';
import { writeArtifact as writeArtifactFile, readArtifact as readArtifactFile } from './checkpoint.js';
import type { TodosApi } from '../../shared/todos.js';

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

export function generateRunId(): string {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// Message factory
// ---------------------------------------------------------------------------

export function createMessage<T>(
  agentId: string,
  runId: string,
  kind: string,
  payload: T,
  replyTo?: string,
  agentVariant?: string,
): AgentMessage<T> {
  return {
    id: randomUUID(),
    agentId,
    agentVariant,
    runId,
    kind,
    payload,
    timestamp: new Date().toISOString(),
    replyTo,
  };
}

// ---------------------------------------------------------------------------
// StepContext builder
// ---------------------------------------------------------------------------

export interface StepContextOpts {
  channel:         Channel;
  runId:           string;
  agentId:         string;
  /** Optional family variant (e.g. `'pair'` / `'delegate'` under
   *  `'implementation'`). Passed through from the AgentDefinition. */
  agentVariant?:   string | undefined;
  runDir:          string;
  config:          AgentConfig;
  providers:       { local: LLMProvider; claude: LLMProvider | null; resolve: (agent: string, step: string) => LLMProvider; resolveOrNull: (agent: string, step: string) => LLMProvider | null };
  abortController: AbortController;
  /** Optional RPC function for daemon IPC. */
  rpcFn?:          (<T>(method: string, params?: unknown) => Promise<T>) | undefined;
  /** Optional TodosApi scoped to this agent's family. */
  todos?:          TodosApi | undefined;
  /** Optional chat session id (paired with todos). */
  sessionId?:      string | undefined;
}

export function buildStepContext(opts: StepContextOpts): StepContext {
  const { channel, runId, agentId, agentVariant, runDir, config, providers, abortController, rpcFn, todos, sessionId } = opts;

  return {
    channel,
    runId,
    agentId,
    runDir,
    config,
    providers,
    signal: abortController.signal,
    todos,
    sessionId,

    progress(msg: string, pct?: number): void {
      const payload: ProgressPayload = { message: msg, pct };
      channel.send(createMessage(agentId, runId, 'progress', payload, undefined, agentVariant));
    },

    async gate(gateOpts: GateOpts): Promise<ReplyPayload> {
      const gateId = randomUUID();
      const payload: GatePayload = { gateId, ...gateOpts };
      const msg = createMessage<GatePayload>(agentId, runId, 'gate', payload, undefined, agentVariant);
      return channel.gate(msg);
    },

    emit(text: string, stream?: boolean): void {
      const payload: EmitPayload = { text, stream };
      channel.send(createMessage(agentId, runId, 'emit', payload, undefined, agentVariant));
    },

    async rpc<T = unknown>(method: string, params?: unknown): Promise<T | null> {
      if (!rpcFn) return null;
      try {
        return await rpcFn<T>(method, params);
      } catch {
        return null;
      }
    },

    writeArtifact(name: string, content: string): string {
      return writeArtifactFile(runDir, name, content);
    },

    readArtifact(name: string): string | null {
      return readArtifactFile(runDir, name);
    },

    recordFeedback: rpcFn
      ? async (feedbackOpts: RecordFeedbackOpts): Promise<void> => {
          await recordFeedbackImpl({ ...feedbackOpts, rpcFn });
        }
      : undefined,

    searchConfig: rpcFn
      ? async (searchOpts: ConfigSearchOpts): Promise<ConfigSearchResult[]> => {
          const result = await rpcFn<ConfigSearchResult[]>('config.search', searchOpts);
          return result ?? [];
        }
      : undefined,

    resolveTemplate: rpcFn
      ? async (templateOpts: TemplateQuery): Promise<ConfigEntry | null> => {
          return rpcFn<ConfigEntry | null>('config.resolveTemplate', templateOpts);
        }
      : undefined,
  };
}
