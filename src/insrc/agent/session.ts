import { randomUUID } from 'node:crypto';
import type { AgentConfig } from '../shared/types.js';
import { OllamaProvider } from './providers/ollama.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { buildProvider } from './providers/factory.js';
import { ProviderResolver } from './config.js';
import { ContextManager, initSession } from './context/index.js';
import { embedText } from './context/semantic.js';
import { sessionClose, sessionSeed, sessionForget, sessionHistory } from './tools/mcp-client.js';
import { HealthMonitor, type HealthSnapshot } from './faults/index.js';
import { ContextAwareProvider } from './context/context-aware-provider.js';
import {
  DefaultAccessStore,
  DefaultAccessAuditLog,
  type AccessStore,
  type AccessAuditLog,
} from '../shared/access.js';
import { DefaultSkillAuditLog, type SkillAuditLog } from '../daemon/skills/audit.js';

export interface SessionOpts {
  repoPath: string;
  config: AgentConfig;
  /** Optional session ID for restoring a persisted session. If omitted, a new UUID is generated. */
  id?: string | undefined;
}

/** Cumulative cost tracking for Claude API usage. */
export interface CostTracker {
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

export class Session {
  readonly id: string;
  readonly repoPath: string;
  readonly config: AgentConfig;
  readonly startedAt: number;

  turnIndex = 0;
  closureRepos: string[] = [];

  /** Runtime permission mode — can be toggled with /toggle-permissions */
  permissionMode: 'validate' | 'auto-accept';

  /** Layered context manager (L1–L4). */
  contextManager!: ContextManager;

  /** Cumulative Claude API cost tracking. */
  readonly cost: CostTracker = { inputTokens: 0, outputTokens: 0, turns: 0 };

  /** Entity IDs seen across all turns (for session close). */
  private readonly seenEntities = new Set<string>();

  /** Raw Ollama provider (no context injection). Use for internal calls only. */
  readonly ollamaProvider: OllamaProvider;
  /** Raw Claude provider (no context injection). Use for internal calls only. */
  readonly claudeProvider: AnthropicProvider | null;

  /** Context-aware local provider (auto-injects L1-L5, auto-records turns). */
  localProvider!: ContextAwareProvider;
  /** Context-aware Claude provider (auto-injects L1-L5, auto-records turns). Null if no API key. */
  claudeContextProvider: ContextAwareProvider | null = null;

  /** Per-agent step-level provider resolver. */
  readonly resolver: ProviderResolver;

  /** Health monitor for Ollama and daemon (Phase 12). */
  readonly health: HealthMonitor;

  /**
   * Universal Access Gate -- session-scoped approval store
   * (plans/access-gate.md). Tools that declare an `access` policy
   * route through this on every call: the executor's gate
   * dispatcher reads `isApproved(kind, key)`; on miss it fires a
   * gate UI and writes the user's reply back via `approve(...)`.
   *
   * Controllers can pre-seed approvals (e.g. data-analyzer's
   * ephemeral file connections, code-analyzer's active-repo
   * scope) so the user isn't prompted for resources they
   * implicitly consented to by typing the prompt.
   *
   * Per design §14, approvals are session-scoped only -- the
   * store dies with the session; resume re-prompts on first
   * access.
   */
  readonly access: AccessStore = new DefaultAccessStore();

  /**
   * Chronological audit trail of access-gate decisions
   * (plans/access-gate.md Phase 5.2). Every dispatch -- auto-pass,
   * approve, approve-prefix, deny, auto-deny -- writes one event.
   * The approvals pane (Phase 5.3) reads `access.list()` for current
   * approvals and `accessAudit.list()` for history.
   *
   * Capped at 1000 entries; oldest events roll off. Session-scoped:
   * dies with the session.
   */
  readonly accessAudit: AccessAuditLog = new DefaultAccessAuditLog();

  /**
   * Chronological audit trail of skill invocations
   * (plans/analyzers/skills-core.md Phase 7.2). Every runSkill emit
   * -- skill-start / feasibility / tool-call / sub-skill / end /
   * error / over-budget -- writes one event. Powers the
   * `skill.audit` RPC and the workbench skill-trace panel.
   *
   * Capped at 1000 entries; oldest roll off. Session-scoped: dies
   * with the session.
   */
  readonly skillAudit: SkillAuditLog = new DefaultSkillAuditLog();

  constructor(opts: SessionOpts) {
    this.id = opts.id ?? randomUUID();
    this.repoPath = opts.repoPath;
    this.config = opts.config;
    this.startedAt = Date.now();

    this.permissionMode = opts.config.permissions.mode;

    this.ollamaProvider = buildProvider({ provider: 'local' }, opts.config) as OllamaProvider;

    this.claudeProvider = opts.config.keys.anthropic
      ? buildProvider({ provider: 'anthropic' }, opts.config) as AnthropicProvider
      : null;

    this.resolver = new ProviderResolver(opts.config, this.ollamaProvider, this.claudeProvider);

    // Health monitor -- ping functions injected to avoid circular deps
    this.health = new HealthMonitor({
      pingOllama: () => this.ollamaProvider.ping(),
      pingDaemon: async () => {
        const { ping } = await import('./tools/mcp-client.js');
        return ping();
      },
    });
  }

  async init(): Promise<void> {
    this.closureRepos = await initSession(this.repoPath);
    const localCtx = localMaxInput(this.config);
    this.contextManager = new ContextManager({
      repoPath: this.repoPath,
      closureRepos: this.closureRepos,
      provider: this.ollamaProvider,
      contextWindowSize: localCtx,
    });

    // Create context-aware provider wrappers (shared context manager)
    this.localProvider = new ContextAwareProvider(
      this.ollamaProvider,
      this.contextManager,
      localCtx,
      { label: 'local', autoRecord: true },
    );

    if (this.claudeProvider) {
      this.claudeContextProvider = new ContextAwareProvider(
        this.claudeProvider,
        this.contextManager,
        anthropicMaxInput(this.config),
        { label: 'anthropic', autoRecord: true },
      );
    }

    // Start periodic health checks (30s interval, unref'd)
    this.health.start();
  }

  /**
   * Hot-reload config -- rebuilds providers and resolver without destroying
   * session state (context manager, turn history, etc.).
   */
  reloadConfig(newConfig: AgentConfig): void {
    // Mutate readonly fields via cast -- intentional for hot reload
    (this as { config: AgentConfig }).config = newConfig;

    // Rebuild providers
    (this as { ollamaProvider: OllamaProvider }).ollamaProvider =
      buildProvider({ provider: 'local' }, newConfig) as OllamaProvider;

    (this as { claudeProvider: AnthropicProvider | null }).claudeProvider = newConfig.keys.anthropic
      ? buildProvider({ provider: 'anthropic' }, newConfig) as AnthropicProvider
      : null;

    // Rebuild resolver with new providers
    (this as { resolver: ProviderResolver }).resolver = new ProviderResolver(
      newConfig, this.ollamaProvider, this.claudeProvider,
    );

    this.permissionMode = newConfig.permissions.mode;
  }

  /** Get the active resolver. Kept for API compatibility with existing callers. */
  get activeResolver(): ProviderResolver {
    return this.resolver;
  }

  /** Track entity IDs referenced in a turn. */
  trackEntities(entityIds: string[]): void {
    for (const id of entityIds) this.seenEntities.add(id);
  }

  /**
   * Seed L2 summary from prior sessions for the same repo.
   * Called once after the first user message is received.
   */
  async seedFromPriorSessions(openingMessage: string): Promise<string | null> {
    const queryVector = await embedText(this.ollamaProvider, openingMessage);
    if (queryVector.length === 0) return null;

    const priors = await sessionSeed(this.repoPath, queryVector);

    // Hydrate L3b semantic history from persisted turns
    const history = await sessionHistory(this.repoPath, queryVector, 20);
    if (history.length > 0 && this.contextManager) {
      this.contextManager.hydrateFromHistory(history);
    }

    if (priors.length === 0) return null;

    const seed = priors.map(s => s.summary).filter(Boolean).join('\n\n');
    return seed || null;
  }

  /**
   * Persist the session's L2 summary + seen-entities snapshot to the
   * conversations LMDB row + the session_vec Lance row. Idempotent;
   * safe to call repeatedly. Does NOT close the session -- the
   * in-memory Session, health checks, channels etc. all keep going.
   *
   * Called by:
   *   - `close()` as part of teardown.
   *   - The chat-pool's idle reaper, periodically, for the protected
   *     "active" session (so a crash doesn't lose the running summary).
   *
   * No-op when no summary exists yet (a fresh session with no
   * compaction-worthy turns produces no summary -- nothing to write).
   */
  async persistSummary(): Promise<void> {
    const summary = this.contextManager.getSummary();
    if (!summary) return;

    const summaryVector = await embedText(this.ollamaProvider, summary);

    await sessionClose({
      id: this.id,
      repo: this.repoPath,
      summary,
      seenEntities: [...this.seenEntities],
      summaryVector,
    });
  }

  /**
   * Close the session: persist L2 summary, stop periodic health checks.
   * Called on /exit, SIGINT, or by the workbench's chat.close RPC
   * (see daemon/chat-sessions.ts:close).
   *
   * IMPORTANT: this method MUST NOT purge per-session artifact spills
   * (~/.insrc/tmp/<session_id>/ or `artifact_vec` Lance rows). Sessions
   * stored under ~/.insrc are persistent by user contract -- closing
   * just stops the in-memory session; the LMDB conversations table +
   * Lance vec tables (turn_vec, artifact_vec, future
   * response_segment_vec) all stay so cross-session retrieval and
   * resume keep working. Only an explicit `/forget` (or the
   * `repo.remove` cascade) may wipe a session's persisted data.
   * The pre-existing `purgeSession` helper still exists in the
   * spill-writer for that explicit-delete path -- it is just NOT
   * wired here.
   */
  async close(): Promise<void> {
    // Stop periodic health checks
    this.health.stop();

    // Persist the L2 summary + seen-entities snapshot.
    await this.persistSummary();
  }

  /** Delete all session summaries for the current repo (/forget). */
  async forget(): Promise<void> {
    await sessionForget(this.repoPath);
  }

  /** Whether Ollama is usable (healthy or degraded). Falls back to live ping. */
  get ollamaAvailable(): Promise<boolean> {
    // If health monitor has data, use cached state for fast path
    if (this.health.snapshot().ollama.lastOk > 0 || this.health.snapshot().ollama.lastFail > 0) {
      return Promise.resolve(this.health.ollamaUsable);
    }
    // First call before any health check — do a live ping
    return this.ollamaProvider.ping();
  }

  /** Get current health snapshot. */
  healthSnapshot(): HealthSnapshot {
    return this.health.snapshot();
  }

  get hasClaudeKey(): boolean {
    return this.claudeProvider !== null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function localMaxInput(cfg: AgentConfig): number {
  const local = cfg.models.providers.local;
  return local.params[local.coreModel]?.maxInputTokens ?? 16_384;
}

function anthropicMaxInput(cfg: AgentConfig): number {
  const a = cfg.models.providers.anthropic;
  const def = a.default ?? '';
  return a.params[def]?.maxInputTokens ?? 200_000;
}
