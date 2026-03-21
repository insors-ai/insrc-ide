/**
 * Chat session pool — manages active daemon-hosted agent sessions.
 *
 * Each session holds a Session object (context manager, providers, turn history),
 * a DaemonChannel, and an AbortController. Sessions idle for >30 minutes are
 * automatically closed.
 */

import { randomUUID } from 'node:crypto';
import { Session } from '../agent/session.js';
import { loadConfigForRepo } from '../agent/config.js';
import { DaemonChannel } from './channel.js';
import { getLogger } from '../shared/logger.js';
import { getSessionById, getTurnsForSession } from '../db/conversations.js';
import { getDb } from '../db/client.js';
import { SessionFileCache } from './file-cache.js';

const log = getLogger('chat-sessions');

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000;  // check every minute

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActiveSession {
  id: string;
  session: Session;
  channel: DaemonChannel | null;       // null when no agent is running
  abortController: AbortController | null;
  agentRunning: boolean;
  lastStep: string | null;
  createdAt: number;
  lastActivityAt: number;
  /** Free-text messages injected by the user mid-pipeline (via chat.inject). */
  injectedMessages: string[];
  /** Per-session file cache for referenced files. */
  fileCache: SessionFileCache;
}

export interface SessionInfo {
  id: string;
  repo: string;
  agentRunning: boolean;
  lastStep: string | null;
  pendingGateId: string | undefined;
  idleSeconds: number;
}

// ---------------------------------------------------------------------------
// Session Pool
// ---------------------------------------------------------------------------

export class ChatSessionPool {
  private readonly sessions = new Map<string, ActiveSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Start periodic idle cleanup
    this.cleanupTimer = setInterval(() => this.cleanupIdle(), CLEANUP_INTERVAL_MS);
  }

  /**
   * Create a new chat session for a repo.
   * Initializes Session object with config, context manager, and providers.
   */
  async create(repoPath: string): Promise<string> {
    const sessionId = randomUUID();
    const config = await loadConfigForRepo(repoPath);

    const session = new Session({ repoPath, config });
    await session.init();

    const active: ActiveSession = {
      id: sessionId,
      session,
      channel: null,
      abortController: null,
      agentRunning: false,
      lastStep: null,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      injectedMessages: [],
      fileCache: new SessionFileCache(),
    };

    this.sessions.set(sessionId, active);
    log.info({ sessionId, repo: repoPath }, 'chat session created');
    return sessionId;
  }

  /**
   * Restore a persisted session from DB into the active pool.
   * Hydrates the ContextManager with L2 summary, L3a recent turns, and L3b semantic history.
   * Returns the sessionId if successful, null if not found in DB.
   */
  async restore(sessionId: string): Promise<string | null> {
    // Already active? Just return it.
    if (this.sessions.has(sessionId)) {
      log.info({ sessionId }, 'session already active');
      return sessionId;
    }

    const db = await getDb();

    // 1. Look up session — try sessions table first, fall back to turns
    const sessionRecord = await getSessionById(db, sessionId);
    const turns = await getTurnsForSession(db, sessionId);

    // Determine repo from session record or from turns
    const repo = sessionRecord?.repo ?? (turns.length > 0 ? turns[0]!.repo : undefined);
    if (!repo) {
      log.warn({ sessionId }, 'session not found in DB for restore');
      return null;
    }

    // 2. Create fresh Session with original repo and session ID
    const config = await loadConfigForRepo(repo);
    const session = new Session({ repoPath: repo, config, id: sessionId });
    await session.init();

    // 3. Hydrate context from DB
    if (sessionRecord?.summary) {
      session.contextManager.seedSummary(sessionRecord.summary);
    }
    if (turns.length > 0) {
      // Restore L3a (recent turns window)
      session.contextManager.restoreRecentTurns(
        turns.map(t => ({ user: t.user, assistant: t.assistant, entities: t.entities })),
      );

      // Restore L3b (semantic history with embeddings)
      session.contextManager.hydrateFromHistory(
        turns.map(t => ({ user: t.user, assistant: t.assistant, entities: t.entities, vector: t.vector })),
      );
    }

    session.turnIndex = turns.length;

    // 4. Add to pool
    const active: ActiveSession = {
      id: sessionId,
      session,
      channel: null,
      abortController: null,
      agentRunning: false,
      lastStep: null,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      injectedMessages: [],
      fileCache: new SessionFileCache(),
    };

    this.sessions.set(sessionId, active);
    log.info({ sessionId, repo, turns: turns.length }, 'chat session restored from DB');
    return sessionId;
  }

  /**
   * Get an active session by ID.
   */
  get(sessionId: string): ActiveSession | undefined {
    const s = this.sessions.get(sessionId);
    if (s) s.lastActivityAt = Date.now();
    return s;
  }

  /**
   * Attach a DaemonChannel to a session (called when chat.send starts).
   * Returns false if an agent is already running on this session.
   */
  attachChannel(sessionId: string, channel: DaemonChannel, abortController: AbortController): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    if (s.agentRunning) return false;

    s.channel = channel;
    s.abortController = abortController;
    s.agentRunning = true;
    s.lastActivityAt = Date.now();
    return true;
  }

  /**
   * Mark agent as finished (called when runAgent completes or errors).
   */
  detachChannel(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.channel = null;
    s.abortController = null;
    s.agentRunning = false;
    s.lastActivityAt = Date.now();
  }

  /**
   * Queue a free-text message injected by the user mid-pipeline.
   */
  pushInjectedMessage(sessionId: string, message: string): void {
    const s = this.sessions.get(sessionId);
    if (s) s.injectedMessages.push(message);
  }

  /**
   * Drain and return all queued injected messages.
   */
  popInjectedMessages(sessionId: string): string[] {
    const s = this.sessions.get(sessionId);
    if (!s || s.injectedMessages.length === 0) return [];
    const msgs = [...s.injectedMessages];
    s.injectedMessages = [];
    return msgs;
  }

  /**
   * Update the last step name (for status reporting).
   */
  setLastStep(sessionId: string, step: string): void {
    const s = this.sessions.get(sessionId);
    if (s) s.lastStep = step;
  }

  /**
   * Close a session — persists summary, releases resources.
   */
  async close(sessionId: string): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;

    // Abort if agent is running
    if (s.agentRunning && s.abortController) {
      s.abortController.abort();
    }

    try {
      await s.session.close();
    } catch (err) {
      log.warn({ sessionId, error: String(err) }, 'error closing session');
    }

    this.sessions.delete(sessionId);
    log.info({ sessionId }, 'chat session closed');
    return true;
  }

  /**
   * List all active sessions with status info.
   */
  list(): SessionInfo[] {
    const now = Date.now();
    const result: SessionInfo[] = [];
    for (const s of this.sessions.values()) {
      result.push({
        id: s.id,
        repo: s.session.repoPath,
        agentRunning: s.agentRunning,
        lastStep: s.lastStep,
        pendingGateId: s.channel?.pendingGateId,
        idleSeconds: Math.floor((now - s.lastActivityAt) / 1000),
      });
    }
    return result;
  }

  /**
   * Get session status (for chat.status RPC).
   */
  status(sessionId: string): SessionInfo | null {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    const now = Date.now();
    return {
      id: s.id,
      repo: s.session.repoPath,
      agentRunning: s.agentRunning,
      lastStep: s.lastStep,
      pendingGateId: s.channel?.pendingGateId,
      idleSeconds: Math.floor((now - s.lastActivityAt) / 1000),
    };
  }

  /**
   * Clean up idle sessions (called periodically).
   */
  private cleanupIdle(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (!s.agentRunning && (now - s.lastActivityAt) > IDLE_TIMEOUT_MS) {
        log.info({ sessionId: id, idleMinutes: Math.floor((now - s.lastActivityAt) / 60000) }, 'closing idle session');
        void this.close(id);
      }
    }
  }

  /**
   * Hot-reload config for all active sessions.
   * Skips sessions with an agent currently running.
   */
  async reloadConfig(): Promise<number> {
    let reloaded = 0;
    for (const [id, s] of this.sessions) {
      if (s.agentRunning) {
        log.info({ sessionId: id }, 'skipping config reload — agent running');
        continue;
      }
      try {
        const newConfig = await loadConfigForRepo(s.session.repoPath);
        s.session.reloadConfig(newConfig);
        reloaded++;
        log.info({ sessionId: id }, 'config reloaded');
      } catch (err) {
        log.warn({ sessionId: id, error: String(err) }, 'config reload failed');
      }
    }
    return reloaded;
  }

  /**
   * Dispose — close all sessions and stop cleanup timer.
   */
  async dispose(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const id of this.sessions.keys()) {
      await this.close(id);
    }
  }
}
