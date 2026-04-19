import { randomUUID } from 'node:crypto';
import type { AgentConfig } from '../shared/types.js';
import { OllamaProvider } from './providers/ollama.js';
import { ClaudeProvider } from './providers/claude.js';
import { buildProvider } from './providers/factory.js';
import { ProviderResolver } from './config.js';
import { SmartRouter, SmartProviderResolver } from './smart-router.js';
import { ContextManager, initSession } from './context/index.js';
import { embedText } from './context/semantic.js';
import { sessionClose, sessionSeed, sessionForget, sessionHistory } from './tools/mcp-client.js';
import { HealthMonitor, type HealthSnapshot } from './faults/index.js';
import { ContextAwareProvider } from './context/context-aware-provider.js';

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
  readonly claudeProvider: ClaudeProvider | null;

  /** Context-aware local provider (auto-injects L1-L5, auto-records turns). */
  localProvider!: ContextAwareProvider;
  /** Context-aware Claude provider (auto-injects L1-L5, auto-records turns). Null if no API key. */
  claudeContextProvider: ContextAwareProvider | null = null;

  /** Per-agent step-level provider resolver. */
  readonly resolver: ProviderResolver;

  /** Smart LLM router (null when auto mode disabled or Ollama unavailable). */
  smartRouter: SmartRouter | null = null;
  /** Smart provider resolver wrapping the base resolver (null when auto mode disabled). */
  smartResolver: SmartProviderResolver | null = null;
  /** Current routing mode — toggleable at runtime via /auto. */
  routingMode: 'static' | 'auto';

  /** Health monitor for Ollama and daemon (Phase 12). */
  readonly health: HealthMonitor;

  constructor(opts: SessionOpts) {
    this.id = opts.id ?? randomUUID();
    this.repoPath = opts.repoPath;
    this.config = opts.config;
    this.startedAt = Date.now();

    this.permissionMode = opts.config.permissions.mode;

    this.ollamaProvider = buildProvider({ provider: 'local' }, opts.config) as OllamaProvider;

    this.claudeProvider = opts.config.keys.anthropic
      ? buildProvider({ provider: 'claude', tier: 'standard' }, opts.config) as ClaudeProvider
      : null;

    this.resolver = new ProviderResolver(opts.config, this.ollamaProvider, this.claudeProvider);
    this.routingMode = opts.config.routing?.mode ?? 'static';

    // Health monitor — ping functions injected to avoid circular deps
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
    this.contextManager = new ContextManager({
      repoPath: this.repoPath,
      closureRepos: this.closureRepos,
      provider: this.ollamaProvider,
      contextWindowSize: this.config.models.context.local,
    });

    // Create context-aware provider wrappers (shared context manager)
    this.localProvider = new ContextAwareProvider(
      this.ollamaProvider,
      this.contextManager,
      this.config.models.context.local,
      { label: 'local', autoRecord: true },
    );

    if (this.claudeProvider) {
      this.claudeContextProvider = new ContextAwareProvider(
        this.claudeProvider,
        this.contextManager,
        this.config.models.context.claude,
        { label: 'claude', autoRecord: true },
      );
    }

    // Initialize smart router if auto mode and Ollama available
    if (this.routingMode === 'auto' && await this.ollamaProvider.ping()) {
      this.enableSmartRouting();
    }

    // Start periodic health checks (30s interval, unref'd)
    this.health.start();
  }

  /** Enable smart routing (creates SmartRouter + SmartProviderResolver). */
  enableSmartRouting(): void {
    this.smartRouter = new SmartRouter(this.ollamaProvider, this.config);
    this.smartResolver = new SmartProviderResolver(
      this.resolver, this.config, this.ollamaProvider, this.claudeProvider,
    );
    this.routingMode = 'auto';
  }

  /** Disable smart routing (reverts to static). */
  disableSmartRouting(): void {
    this.smartRouter = null;
    this.smartResolver = null;
    this.routingMode = 'static';
  }

  /**
   * Hot-reload config — rebuilds providers, resolver, and routing mode
   * without destroying session state (context manager, turn history, etc.).
   */
  reloadConfig(newConfig: AgentConfig): void {
    // Mutate readonly fields via cast — intentional for hot reload
    (this as { config: AgentConfig }).config = newConfig;

    // Rebuild providers
    (this as { ollamaProvider: OllamaProvider }).ollamaProvider =
      buildProvider({ provider: 'local' }, newConfig) as OllamaProvider;

    (this as { claudeProvider: ClaudeProvider | null }).claudeProvider = newConfig.keys.anthropic
      ? buildProvider({ provider: 'claude', tier: 'standard' }, newConfig) as ClaudeProvider
      : null;

    // Rebuild resolver with new providers
    (this as { resolver: ProviderResolver }).resolver = new ProviderResolver(
      newConfig, this.ollamaProvider, this.claudeProvider,
    );

    // Update permission and routing mode
    this.permissionMode = newConfig.permissions.mode;
    const newRoutingMode = newConfig.routing?.mode ?? 'static';
    if (newRoutingMode === 'auto' && this.routingMode !== 'auto') {
      this.enableSmartRouting();
    } else if (newRoutingMode === 'static' && this.routingMode !== 'static') {
      this.disableSmartRouting();
    }

  }

  /** Toggle routing mode. Returns the new mode. */
  toggleRouting(): 'static' | 'auto' {
    if (this.routingMode === 'auto') {
      this.disableSmartRouting();
    } else {
      this.enableSmartRouting();
    }
    return this.routingMode;
  }

  /** Get the active resolver (smart or base depending on mode). */
  get activeResolver(): ProviderResolver | SmartProviderResolver {
    return this.smartResolver ?? this.resolver;
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
   * Close the session: promote L2 summary to persistent store, delete raw turns.
   * Called on /exit or SIGINT.
   */
  async close(): Promise<void> {
    // Stop periodic health checks
    this.health.stop();

    const summary = this.contextManager.getSummary();
    if (!summary) return; // Nothing to persist if no summary was generated

    const summaryVector = await embedText(this.ollamaProvider, summary);

    await sessionClose({
      id: this.id,
      repo: this.repoPath,
      summary,
      seenEntities: [...this.seenEntities],
      summaryVector,
    });
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
