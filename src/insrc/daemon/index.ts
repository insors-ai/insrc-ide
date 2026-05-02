/**
 * Daemon entry point.
 *
 * Startup sequence:
 *  1. Check for existing daemon (stale PID cleanup)
 *  2. Ensure ~/.insrc/ directories exist
 *  3. Open Kuzu + LanceDB and run schema migrations
 *  4. Bootstrap embedding model (non-blocking)
 *  5. Load registered repos, start watcher + queue
 *  6. Write PID file
 *  7. Start IPC server
 *  8. Handle SIGTERM / SIGINT for graceful shutdown
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync, rmSync } from 'node:fs';
import { PATHS } from '../shared/paths.js';
import { setLogMode, getLogger } from '../shared/logger.js';

setLogMode('daemon');
const log = getLogger('daemon');

// ---------------------------------------------------------------------------
// Top-level crash handlers
// ---------------------------------------------------------------------------
//
// Node 20+ kills the process by default on an unhandled rejection /
// uncaught exception. The daemon's pino-roll transport runs in a
// worker thread (async) so any pending log line is lost on
// process.exit -- previously a daemon crash left agent.*.log silent
// past the last successful flush, with no trace of WHY we died.
//
// Capture both shapes here. We log THREE places, each as resilient as
// we can manage given the imminent exit:
//
//   1. stderr (sync fd write) -- captured by the IDE's spawn redirect
//      to /tmp/.insrc/daemon.stderr.log (electron-main side).
//   2. /tmp/.insrc/daemon.crash.log (sync appendFileSync) -- always
//      lands even when stderr isn't redirected (manual launches /
//      tests / detached invocations).
//   3. pino fatal -- best-effort. setImmediate before process.exit
//      gives the worker-thread transport a chance to drain.
//
// All three log the kind (uncaughtException | unhandledRejection)
// + the error message + stack, prefixed with an ISO timestamp so
// post-mortem readers can correlate against agent.*.log lines.
function reportFatal(kind: 'uncaughtException' | 'unhandledRejection', reason: unknown): void {
	const err = reason instanceof Error ? reason : new Error(String(reason));
	const traceText = `[insrc-daemon][${new Date().toISOString()}][${kind}] ${err.message}\n${err.stack ?? '(no stack)'}\n`;
	try { process.stderr.write(traceText); } catch { /* stderr closed */ }
	try {
		mkdirSync(PATHS.logDir, { recursive: true });
		appendFileSync(`${PATHS.logDir}/daemon.crash.log`, traceText);
	} catch { /* fs unavailable */ }
	try { log.fatal({ kind, err: err.message, stack: err.stack }, 'daemon fatal'); } catch { /* logger broken */ }
	// Hard exit on next tick so async writes have a chance to flush.
	// Using setTimeout(0) instead of setImmediate so pino's worker has
	// at least one event-loop turn -- empirically reliable on Node 20.
	setTimeout(() => { process.exit(1); }, 50).unref();
}

process.on('uncaughtException',  (err) =>    reportFatal('uncaughtException',  err));
process.on('unhandledRejection', (reason) => reportFatal('unhandledRejection', reason));

import { getDb, initDb, closeDb } from '../db/client.js';
import { closeDuckDB } from './db/duckdb-pool.js';
import { closeDuckDBStorage } from './db/duckdb-storage-pool.js';
import { listRepos, addRepo, removeRepo } from '../db/repos.js';
import { deleteEntitiesForRepo, findEntitiesByFile } from '../db/entities.js';
import { deleteUnresolvedForRepo } from '../db/relations.js';
import { Watcher } from '../indexer/watcher.js';
import { IndexQueue } from './queue.js';
import { IndexerService } from '../indexer/index.js';
import { IpcServer } from './server.js';
import {
	initChatHandlers, disposeChatHandlers, reloadChatConfig,
	chatStart, chatReply, chatCancel, chatInject, chatRedirect, chatClose, chatList, chatStatus, chatRestore, brainstormAddIdea,
	chatSend, chatResume, chatResumeFromCheckpoint, chatResumeCodeAnalysis, chatResumeDataAnalysis,
} from './chat-handler.js';
import { writePid, clearPid, isAlreadyRunning, bootstrapEmbeddingModel, getModelState } from './lifecycle.js';
import { resolveClosure, searchEntities, findCallers, findCallees } from '../db/search.js';
import { embedQuery } from '../indexer/embedder.js';
import {
	saveTurn, closeSession, saveSession, seedFromPrior, deleteSessionsForRepo, deleteTurnsForRepo, pruneConversations,
	searchTurnsByRepo, getConversationStats, listSessions, getAllTurns,
	type TurnRecord,
} from '../db/conversations.js';
import { compactConversations, type CompactionOpts } from '../db/compaction.js';
import {
	savePlan, getPlan, getActivePlan, updateStepState, getNextStep, deletePlan, deletePlansForRepo, resetStaleLocks,
} from '../agent/tasks/plan-store.js';
import type { RegisteredRepo, DaemonStatus, Entity, Plan, PlanStepStatus, ConfigScope, ConfigSearchOpts, TemplateQuery } from '../shared/types.js';
import { basename, dirname } from 'node:path';
import { ConfigStore } from '../config/store.js';
import { searchConfig, resolveTemplate } from '../config/search.js';
import * as todosRpc from './todos-rpc.js';

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	// 1. Check for existing daemon
	if (isAlreadyRunning()) {
		log.error('already running — exiting');
		process.exit(1);
	}

	// 2. Ensure directories
	mkdirSync(dirname(PATHS.duckdb), { recursive: true });

	// One-time cleanup of orphaned legacy on-disk state from before the
	// storage migration. Removes Kuzu (post Phase A.11) and LanceDB
	// (post Phase B.10) directories. Idempotent: silently no-ops once
	// the files are gone.
	for (const stale of [
		PATHS.graph,
		`${PATHS.graph}.wal`,
		`${PATHS.graph}.shadow`,
		PATHS.lance,
		PATHS.configStore,
	]) {
		try {
			if (existsSync(stale)) {
				rmSync(stale, { recursive: true, force: true });
				log.info({ path: stale }, 'removed legacy storage state on post-migration boot');
			}
		} catch (err) {
			log.warn({ path: stale, err: err instanceof Error ? err.message : String(err) },
				'failed to remove legacy storage state -- non-fatal, retry on next boot');
		}
	}

	mkdirSync(PATHS.templates, { recursive: true });
	mkdirSync(PATHS.feedback, { recursive: true });
	mkdirSync(PATHS.conventions, { recursive: true });
	mkdirSync(PATHS.logDir, { recursive: true });

	// 2b. Ensure config.json exists with agent defaults
	if (!existsSync(PATHS.config)) {
		writeFileSync(PATHS.config, JSON.stringify({
			logLevel: 'info',
			ollama: { host: 'http://localhost:11434' },
			models: {
				local: 'qwen3-coder:latest',
				embedding: 'qwen3-embedding:4b',
				embeddingDim: 2560,
				tiers: { fast: 'claude-haiku-4-5', standard: 'claude-sonnet-4-6', powerful: 'claude-opus-4-6' },
				context: { local: 16384, localMaxOutput: 8192, claude: 200000, claudeMaxOutput: 8192, charsPerToken: 3 },
			},
			permissions: { mode: 'validate' },
			routing: { mode: 'static' },
		}, null, 2), 'utf-8');
		log.info('created default config.json');
	} else {
		// Ensure models.agents exists in config
		try {
			const raw = JSON.parse(readFileSync(PATHS.config, 'utf-8')) as Record<string, unknown>;
			const models = (raw['models'] ?? {}) as Record<string, unknown>;
			if (!models['agents']) {
				log.info('config.json missing models.agents, will be populated on first config.agents call');
			}
		} catch { /* ignore parse errors */ }
	}

	// 2c. One-shot Phase 0 agent-family rename migration (idempotent).
	// Rewrites any persisted `agentId: 'pair' | 'delegate'` to the new
	// `{ agentId: 'implementation', agentVariant: <prior> }` shape and
	// moves `~/.insrc/<category>/pair|delegate/` dirs under
	// `.../implementation/`. Runs before DB init so downstream loaders
	// see a consistent view.
	const { migrateAgentFamilyRename } = await import('./agent-family-migration.js');
	migrateAgentFamilyRename();

	// 3. Open DB
	const db = await getDb();
	await initDb(db);
	const { initTodosTables } = await import('../db/todos.js');
	await initTodosTables(db);
	log.info('database ready');

	// 4. Bootstrap embedding model (async, non-blocking)
	void bootstrapEmbeddingModel();

	// 5. Load repos, start indexer
	const configStore = new ConfigStore(db);

	const repos = await listRepos(db);
	const watcher = new Watcher();
	const queue = new IndexQueue();
	const indexer = new IndexerService(db, queue, watcher, configStore);

	await indexer.start(repos);

	// Run queue in background (never awaited until shutdown)
	const queueDone = queue.start(job => indexer.processJob(job));

	// 6. Write PID
	writePid();
	const startedAt = Date.now();

	// 6b. Register the unified tool set (plans/tools.md stage 5). Covers
	//     git:*, gh:*, file:*, shell:*, web:*, cloud:*, ... and registers
	//     legacy LLM-name aliases (Read, Bash, Grep, graph_search, ...)
	//     onto the canonical unified ids in one pass.
	const { registerBuiltinTools } = await import('./tools/builtins/index.js');
	registerBuiltinTools();

	// 6c. Register data-driver kinds (plans/data-driver.md phase 1).
	//     Drivers self-register at import time; pulling the barrel
	//     once is the bootstrap.
	const { registerBuiltinDataDrivers } = await import('./db/drivers/index.js');
	registerBuiltinDataDrivers();

	// 6d. Register cross-agent surface (plans/analyzers/code-analyzer.md
	//     Phase 3). The Code Analyzer exposes `code_locate` / `code_trace`
	//     / `code_describe` for sibling analyzer families to dispatch
	//     into. Phase 4 of plans/analyzers/data-analyzer.md adds the
	//     symmetrical `data_*` registrations alongside.
	const { registerCodeAnalyzerCrossAgentTools, registerDataAnalyzerCrossAgentTools } = await import('./cross-agent/index.js');
	registerCodeAnalyzerCrossAgentTools();
	registerDataAnalyzerCrossAgentTools();

	// 6e. Register the skill registry (plans/analyzers/skills-core.md).
	//     Skills depend on tools (toolDeps) so this runs strictly after
	//     all tool / cross-agent registrations. The bootstrap is
	//     dependency-aware: atomic skills register before composites
	//     so the registry's sub-skill check passes. v1 ships one
	//     migration target -- data.lineage.read-write-callsites -- as
	//     proof of substrate; per-family build-outs land in
	//     plans/analyzers/data-analyzer-skills.md.
	const { registerAllSkills } = await import('./skills/index.js');
	registerAllSkills();

	// 7. Start IPC server
	const server = new IpcServer({
		'repo.add': async (params) => {
			const { path } = params as { path: string };
			const repo: RegisteredRepo = {
				path,
				name: basename(path),
				addedAt: new Date().toISOString(),
				status: 'pending',
			};
			await addRepo(db, repo);
			await indexer.addRepo(path);
			return { ok: true };
		},

		'repo.remove': async (params) => {
			const { path } = params as { path: string };
			// Order matters: stop watching first so no new file events arrive
			// during cleanup; delete entities (cascades the typed REL edges)
			// before the unresolved twins; then plans/sessions; then the
			// Repo registry node last.
			await indexer.removeRepo(path);
			await deleteEntitiesForRepo(db, path);
			await deleteUnresolvedForRepo(db, path);
			await deletePlansForRepo(db, path);
			await deleteSessionsForRepo(db, path);
			await deleteTurnsForRepo(db, path);
			await removeRepo(db, path);
			log.info({ repo: path }, 'repo removed (entities + relations + plans + sessions + turns purged)');
			return { ok: true };
		},

		'repo.list': async () => {
			return listRepos(db);
		},

		'repo.reindex': async (params) => {
			const { path: repoPath } = params as { path: string };
			const repos = await listRepos(db);
			const repo = repos.find(r => r.path === repoPath);
			if (!repo) { return { error: 'repo not found' }; }
			queue.enqueue({ kind: 'full', repoPath });
			return { ok: true };
		},

		'session.list': async (params) => {
			const { repo, limit } = (params ?? {}) as { repo?: string; limit?: number };
			const sessions = await listSessions(db, repo);
			return limit ? sessions.slice(0, limit) : sessions;
		},

		'session.history': async (params) => {
			const { sessionId, repo, limit } = (params ?? {}) as { sessionId?: string; repo?: string; limit?: number };
			const allTurns = await getAllTurns(db);

			let targetSessionId = sessionId;

			// When loading by repo (no sessionId), find the most recent session
			if (!targetSessionId && repo) {
				const repoTurns = allTurns.filter(t => t.repo === repo);
				let latestDate = '';
				for (const t of repoTurns) {
					const date = t.createdAt ?? '';
					if (date > latestDate) {
						latestDate = date;
						targetSessionId = t.sessionId;
					}
				}
			}

			const filtered = allTurns.filter(t => {
				if (targetSessionId) return t.sessionId === targetSessionId;
				return true;
			});

			return filtered
				.sort((a, b) => {
					const dateA = a.createdAt ?? '';
					const dateB = b.createdAt ?? '';
					if (dateA !== dateB) return dateA.localeCompare(dateB);
					return a.idx - b.idx;
				})
				.slice(0, limit ?? 30)
				.map(t => ({
					sessionId: t.sessionId,
					idx: t.idx,
					user: t.user,
					assistant: t.assistant,
					repo: t.repo,
					type: t.type ?? 'turn',
					tier: t.tier ?? 'hot',
					createdAt: t.createdAt,
					format: t.format,
				}));
		},

		'agent.list': async () => {
			// Phase 2 of plans/session-lifecycle.md: the DB is authoritative
			// for session identity + metadata (agent/category/status/repo).
			// Checkpoint presence is a secondary signal used only to peek at
			// the lastStep label for the sidebar. Sessions without a live
			// checkpoint (status='completed') are filtered out -- they're
			// not resumable. Discarded sessions are filtered likewise.
			//
			// agent='chat' rows are excluded -- plain chat sessions belong in
			// the dedicated Sessions sidebar, not Runs. Runs is for agent
			// pipelines (brainstorm, designer, planner, ...). A session only
			// earns an agent stamp after classification picks a controller;
			// everything else stays 'chat' and stays out of this list.
			const { listSessionRecords } = await import('../db/conversations.js');
			const { existsSync, readFileSync: readFs } = await import('node:fs');
			const { join } = await import('node:path');

			const all = await listSessionRecords(db, { statuses: ['active', 'paused'] });
			const sessions = all.filter(s => s.agent && s.agent !== 'chat');
			const checkpointDir = join(PATHS.insrc, 'checkpoints');

			const runs: Array<{
				id: string; agent: string; status: string;
				step?: string; repo?: string; createdAt: string; summary?: string;
			}> = [];

			for (const s of sessions) {
				const file = join(checkpointDir, `${s.agent}-${s.id}.json`);
				const hasCheckpoint = existsSync(file);

				// Peek only the lastStep field; don't pay a full JSON parse
				// cost for the whole checkpoint just to render a label.
				let step: string | undefined;
				if (hasCheckpoint) {
					try {
						const raw = JSON.parse(readFs(file, 'utf-8')) as {
							state?: { brainstormState?: { lastStep?: string } };
						};
						step = raw.state?.brainstormState?.lastStep;
					} catch {
						// Corrupt / in-flight write; no step, still show the row.
					}
				}

				// Status mapping:
				//   'active'  -> DB says session in flight, checkpoint may or
				//                may not exist yet (covers the window between
				//                chat.start and the first persisted task).
				//   'paused'  -> checkpoint present, pipeline exited, awaiting
				//                resume. Resumable.
				// When a checkpoint is missing for a 'paused' session, the
				// checkpoint was manually removed or never flushed -- surface
				// as 'crashed' so the user knows discard is the only option.
				let reportedStatus: string = s.status;
				if (s.status === 'paused' && !hasCheckpoint) reportedStatus = 'crashed';

				const entry: {
					id: string; agent: string; status: string;
					step?: string; repo?: string; createdAt: string; summary?: string;
				} = {
					id: s.id,
					agent: s.agent || 'unknown',
					status: reportedStatus,
					createdAt: s.lastActivityAt || s.createdAt,
				};
				if (step !== undefined) entry.step = step;
				if (s.repo) entry.repo = s.repo;
				if (s.summary) entry.summary = s.summary;
				runs.push(entry);
			}

			return runs;
		},

		'agent.resume': async (params) => {
			const { id } = params as { id: string };
			const { readFileSync: readFs, existsSync: existsFs } = await import('node:fs');
			const { join } = await import('node:path');
			const { CHECKPOINT_SCHEMA_VERSION } = await import('./task.js');
			const { getSessionById } = await import('../db/conversations.js');

			// Phase 3 + Phase 6 (plans/session-lifecycle.md): validate both
			// the DB row and the checkpoint before handing off to
			// chat.resumeFromCheckpoint. Returning a structured reason code
			// here means the Runs sidebar surfaces a clear error before a
			// stream is opened (otherwise the user sees a cancelBrainstormSession
			// bounce that's hard to interpret).
			const row = await getSessionById(db, id);
			if (!row) {
				return {
					ok: false,
					reason: 'no-session-row',
					message: `Session ${id} has no DB row. Discard to clean up any orphan checkpoint.`,
				};
			}
			if (row.status === 'discarded' || row.status === 'completed') {
				return {
					ok: false,
					reason: 'terminal-status',
					message: `Session ${id} is ${row.status}; nothing to resume.`,
					controllerId: row.agent,
				};
			}

			// Checkpoint filename matches `${row.agent}-${id}.json`. Legacy
			// files with a different controller prefix aren't resumable under
			// Phase 3's DB-authoritative rules -- user should Discard.
			const checkpointFile = join(PATHS.insrc, 'checkpoints', `${row.agent}-${id}.json`);
			if (!existsFs(checkpointFile)) {
				return {
					ok: false,
					reason: 'no-checkpoint',
					message: `No checkpoint file for session ${id}. Discard to clean up.`,
					controllerId: row.agent,
				};
			}
			try {
				const raw = JSON.parse(readFs(checkpointFile, 'utf-8')) as Record<string, unknown>;
				const schemaVersion = raw['schemaVersion'] as number | undefined;
				// Decision I2: refuse when the checkpoint's schema doesn't match
				// the daemon's. Client surfaces a Discard-only message; we do
				// NOT best-effort rehydrate.
				if (schemaVersion !== CHECKPOINT_SCHEMA_VERSION) {
					return {
						ok: false,
						reason: 'schema-drift',
						message: `Checkpoint schema ${schemaVersion ?? 'unknown'} cannot be resumed by this daemon (current ${CHECKPOINT_SCHEMA_VERSION}). Discard to continue.`,
						controllerId: row.agent,
					};
				}
				return {
					ok: true,
					sessionId: id,
					controllerId: row.agent,
					// The browser then opens chat.resumeFromCheckpoint to actually
					// stream the rehydrated pipeline.
					message: `Use chat.resumeFromCheckpoint with sessionId=${id}`,
				};
			} catch (err) {
				return { ok: false, reason: 'read-failed', message: `Checkpoint read failed: ${(err as Error).message}` };
			}
		},

		'agent.discard': async (params) => {
			const { id } = params as { id: string };
			// Phase 4 discard (plans/session-lifecycle.md). Purges every
			// trace of the session so the Runs sidebar stops listing it:
			//   1. Checkpoint file(s) under ~/.insrc/checkpoints/
			//   2. Todos framework lists/items/comments for this session
			//      (plans/todo-framework.md Phase 2b).
			//   3. DB sessions row + all associated turns.
			//   4. In-memory pool entry (aborts any in-flight agent).
			// Best-effort per step -- a missing checkpoint / DB row is fine;
			// continue purging the other artifacts.
			const { readdirSync, unlinkSync, existsSync: existsFs } = await import('node:fs');
			const { join } = await import('node:path');
			const { deleteSession } = await import('../db/conversations.js');
			const { dropSessionFromPool } = await import('./chat-handler.js');

			// 1. Checkpoint files (match by session-id suffix -- works
			//    regardless of which controller owned the session).
			let checkpointsDeleted = 0;
			const checkpointDir = join(PATHS.insrc, 'checkpoints');
			if (existsFs(checkpointDir)) {
				const files = readdirSync(checkpointDir).filter(f => f.endsWith(`-${id}.json`));
				for (const f of files) {
					try {
						unlinkSync(join(checkpointDir, f));
						checkpointsDeleted++;
					} catch {
						// Best-effort.
					}
				}
			}

			// 2. Todos framework purge. `caller: 'system'` authorises the
			//    broad cleanup; `sessionIds: [id]` scopes it so the
			//    retention safety rail doesn't reject.
			let todosListsDeleted = 0;
			let todosItemsDeleted = 0;
			try {
				const cleanupResult = await todosRpc.cleanup(db, {
					caller: 'system',
					sessionIds: [id],
				});
				if (!('error' in cleanupResult)) {
					todosListsDeleted = cleanupResult.deletedListCount;
					todosItemsDeleted = cleanupResult.deletedItemCount;
				} else {
					log.warn({ err: cleanupResult, sessionId: id }, 'agent.discard: todos cleanup rejected');
				}
			} catch (err) {
				log.warn({ err, sessionId: id }, 'agent.discard: todos cleanup failed');
			}

			// 3. DB session row + turns.
			let sessionRows = 0;
			let turnRows = 0;
			try {
				const result = await deleteSession(db, id);
				sessionRows = result.sessionRows;
				turnRows = result.turnRows;
			} catch (err) {
				log.warn({ err, sessionId: id }, 'agent.discard: DB delete failed');
			}

			// 4. In-memory pool entry (aborts in-flight agent if any).
			try {
				dropSessionFromPool(id);
			} catch (err) {
				log.warn({ err, sessionId: id }, 'agent.discard: pool.drop failed');
			}

			log.info(
				{ sessionId: id, checkpointsDeleted, todosListsDeleted, todosItemsDeleted, sessionRows, turnRows },
				'agent.discard',
			);
			return { ok: true, checkpointsDeleted, todosListsDeleted, todosItemsDeleted, sessionRows, turnRows };
		},

		'daemon.status': async () => {
			const modelState = getModelState();
			const status: DaemonStatus = {
				uptime: Math.floor((Date.now() - startedAt) / 1000),
				repos: await listRepos(db),
				queueDepth: queue.depth,
				embeddingsPending: queue.depth, // approximate
				modelPullStatus: modelState.status === 'pulling' ? 'pulling' : 'ready',
				...(modelState.pct !== undefined && { modelPullPct: modelState.pct }),
			};
			return status;
		},

		'search.query': async (params) => {
			const { text, limit, filter } = params as { text: string; limit?: number; filter?: string };
			const searchFilter = (filter === 'code' || filter === 'artifact') ? filter : 'all';
			log.debug({ query: text.slice(0, 120), limit: limit ?? 10, filter: searchFilter }, 'search.query request');
			const queryVec = await embedQuery(text);
			// Use all registered repos as the default closure scope
			const repos = (await listRepos(db)).map(r => r.path);
			const results = await searchEntities(db, queryVec, repos, limit ?? 10, searchFilter) as Entity[];
			log.debug({ query: text.slice(0, 60), hits: results.length, names: results.slice(0, 5).map(e => `${e.kind}:${e.name}`) }, 'search.query response');
			return results;
		},

		'search.closure': async (params) => {
			const { repoPath } = params as { repoPath: string };
			return resolveClosure(db, repoPath);
		},

		'search.callers': async (params) => {
			const { entityId } = params as { entityId: string };
			return findCallers(db, entityId) as Promise<Entity[]>;
		},

		'search.callees': async (params) => {
			const { entityId } = params as { entityId: string };
			return findCallees(db, entityId) as Promise<Entity[]>;
		},

		// ----- Graph context helpers (Phase 7) -----

		'search.by_file': async (params) => {
			const { filePath } = params as { filePath: string };
			return findEntitiesByFile(db, filePath);
		},

		'search.callers_nhop': async (params) => {
			const { entityId, hops } = params as { entityId: string; hops?: number };
			const maxHops = Math.min(hops ?? 1, 3); // cap at 3 to prevent explosion
			// For 1-hop, use the existing findCallers
			if (maxHops <= 1) return findCallers(db, entityId) as Promise<Entity[]>;

			// Multi-hop: BFS caller traversal
			const seen = new Set<string>();
			let frontier = [entityId];
			const allCallers: Entity[] = [];

			for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
				const nextFrontier: string[] = [];
				for (const eid of frontier) {
					if (seen.has(eid)) continue;
					seen.add(eid);
					const callers = await findCallers(db, eid);
					for (const c of callers) {
						if (!seen.has(c.id)) {
							allCallers.push(c);
							nextFrontier.push(c.id);
						}
					}
				}
				frontier = nextFrontier;
			}

			return allCallers;
		},

		// ----- Session lifecycle (Phase 5) -----

		'session.save': async (params) => {
			const turn = params as TurnRecord;
			await saveTurn(db, turn);
			return { ok: true };
		},

		'session.close': async (params) => {
			const { id, repo, summary, seenEntities, summaryVector } = params as {
				id: string; repo: string; summary: string; seenEntities: string[]; summaryVector: number[];
			};
			await closeSession(db, { id, repo, summary, seenEntities }, summaryVector);
			return { ok: true };
		},

		'session.seed': async (params) => {
			const { repo, queryVector, limit } = params as {
				repo: string; queryVector: number[]; limit?: number;
			};
			return seedFromPrior(db, repo, queryVector, limit);
		},

		'session.forget': async (params) => {
			const { repo } = params as { repo: string };
			await deleteSessionsForRepo(db, repo);
			return { ok: true };
		},

		'session.prune': async () => {
			return pruneConversations(db);
		},

		'session.search_turns': async (params) => {
			const { repo, queryVector, limit } = params as {
				repo: string; queryVector: number[]; limit?: number;
			};
			return searchTurnsByRepo(db, repo, queryVector, limit ?? 20);
		},

		// ----- Conversation management -----

		'conversation.saveTurn': async (params) => {
			const turn = params as TurnRecord;
			// Generate embedding for the turn (user + assistant text)
			const text = `${turn.user}\n${turn.assistant}`.slice(0, 1000);
			turn.vector = await embedQuery(text);
			await saveTurn(db, turn);
			return { ok: true };
		},

		'conversation.saveSession': async (params) => {
			const { id, repo, summary, seenEntities, vector } = params as {
				id: string; repo: string; summary: string; seenEntities?: string[]; vector?: number[];
			};
			if (seenEntities && vector) {
				// Full close with entities and embedding
				await closeSession(db, { id, repo, summary, seenEntities }, vector);
			} else {
				// Lightweight upsert (create/update title)
				await saveSession(db, { id, repo, summary });
			}
			return { ok: true };
		},

		'conversation.compact': async (params) => {
			const opts = params as CompactionOpts;
			return compactConversations(db, async (text) => embedQuery(text), opts);
		},

		'conversation.stats': async (params) => {
			const { repo } = params as { repo?: string };
			return getConversationStats(db, repo);
		},

		// ----- Plan graph (Phase 6) -----

		'plan.save': async (params) => {
			const plan = params as Plan;
			await savePlan(db, plan);
			return { ok: true };
		},

		'plan.get': async (params) => {
			const { planId, repoPath } = params as { planId?: string; repoPath?: string };
			if (planId) return getPlan(db, planId);
			if (repoPath) return getActivePlan(db, repoPath);
			return null;
		},

		'plan.step_update': async (params) => {
			const { stepId, status, note } = params as {
				stepId: string; status: PlanStepStatus; note?: string;
			};
			return updateStepState(db, stepId, status, note);
		},

		'plan.next_step': async (params) => {
			const { planId } = params as { planId: string };
			return getNextStep(db, planId);
		},

		'plan.delete': async (params) => {
			const { planId } = params as { planId: string };
			await deletePlan(db, planId);
			return { ok: true };
		},

		// Underscore aliases — match tool names from registry (LLM tool calls)
		'plan_get': async (params) => {
			const { repo } = params as { repo?: string };
			if (repo) return getActivePlan(db, repo);
			return null;
		},

		'plan_step_update': async (params) => {
			const { step_id, status, note } = params as {
				step_id: string; status: PlanStepStatus; note?: string;
			};
			return updateStepState(db, step_id, status, note);
		},

		'plan_next_step': async (params) => {
			const { planId } = params as { planId: string };
			return getNextStep(db, planId);
		},

		'plan.reset_stale': async (params) => {
			const { planId } = params as { planId: string };
			const count = await resetStaleLocks(db, planId);
			return { reset: count };
		},

		// ----- File re-index (Phase 7) -----

		'index.file': async (params) => {
			const { filePath, event } = params as { filePath: string; event?: 'create' | 'update' | 'delete' };
			queue.enqueue({ kind: 'file', filePath, event: event ?? 'update' });
			return { ok: true };
		},

		// ----- Config management -----

		'system.info': async () => {
			const { getSystemInfo } = await import('../shared/system-info.js');
			return getSystemInfo();
		},

		'system.recommend': async () => {
			const { getSystemInfo } = await import('../shared/system-info.js');
			const { recommendModels, toConfig } = await import('../shared/model-recommender.js');
			const info = getSystemInfo();
			const recommendation = recommendModels(info);
			const config = toConfig(recommendation);
			return { system: info, recommendation, config };
		},

		// Ollama model management
		'ollama.list': async () => {
			const { Ollama } = await import('ollama');
			const config = JSON.parse(readFileSync(PATHS.config, 'utf-8')) as Record<string, unknown>;
			const ollamaConfig = (config['ollama'] ?? {}) as Record<string, unknown>;
			const host = (ollamaConfig['host'] as string) ?? 'http://localhost:11434';
			const ollama = new Ollama({ host });
			const { models } = await ollama.list();
			return models.map(m => ({
				name: m.name,
				size: m.size,
				parameterSize: m.details?.parameter_size,
				quantization: m.details?.quantization_level,
				family: m.details?.family,
			}));
		},

		'ollama.search': async (params) => {
			const { query } = params as { query: string };
			const { request } = await import('undici');
			const { body } = await request(`https://ollama.com/search?q=${encodeURIComponent(query)}`, {
				headers: { 'Accept': 'application/json' },
			});
			const data = await body.json() as Record<string, unknown>;
			return data['models'] ?? [];
		},

		// Claude model listing
		'claude.models': async () => {
			const { getKey } = await import('../shared/keystore.js');
			const key = await getKey('ANTHROPIC_API_KEY');
			if (key) {
				try {
					const Anthropic = (await import('@anthropic-ai/sdk')).default;
					const client = new Anthropic({ apiKey: key });
					const models = await client.models.list();
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					return models.data.map((m: any) => ({
						id: m.id,
						displayName: m.display_name ?? m.id,
						createdAt: m.created_at ?? '',
					}));
				} catch (err) {
					log.warn({ error: String(err) }, 'failed to list Claude models via API');
				}
			}
			// Fallback: static catalog
			return [
				{ id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', createdAt: '' },
				{ id: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5', createdAt: '' },
				{ id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', createdAt: '' },
				{ id: 'claude-opus-4-6', displayName: 'Claude Opus 4.6', createdAt: '' },
			];
		},

		// Return all agent step bindings (defaults + config overrides)
		'config.agents': async () => {
			const { pairAgent } = await import('../agent/tasks/pair/agent.js');
			const { delegateAgent } = await import('../agent/tasks/delegate/agent.js');
			const { plannerAgent } = await import('../agent/planner/agent.js');
			const { designerAgent } = await import('../agent/tasks/designer/agent.js');
			const { brainstormAgent } = await import('../agent/tasks/brainstorm/agent.js');
			const { testerAgent } = await import('../agent/tasks/tester/agent.js');

			const allAgents = [pairAgent, delegateAgent, plannerAgent, designerAgent, brainstormAgent, testerAgent];

			// Read current config overrides
			let overrides: Record<string, Record<string, string>> = {};
			try {
				const raw = JSON.parse(readFileSync(PATHS.config, 'utf-8')) as Record<string, unknown>;
				const models = raw['models'] as Record<string, unknown> | undefined;
				overrides = (models?.['agents'] ?? {}) as Record<string, Record<string, string>>;
			} catch { /* no config */ }

			// Default bindings: steps using resolveOrNull -> claude, others -> local
			const CLAUDE_STEPS: Record<string, string[]> = {
				pair: ['validate'],
				delegate: ['validate'],
				planner: ['enhance'],
				designer: ['enhance', 'review'],
				brainstorm: ['validate-seed', 'validate-convergence', 'review-spec'],
				tester: ['validate-plan', 'validate-tests', 'review-tests'],
			};

			const result: Record<string, Record<string, string>> = {};
			for (const agent of allAgents) {
				const ns = agent.configNamespace ?? agent.id;
				const displayId = agent.id; // Use agent.id for display (e.g. 'brainstorm' not 'common')
				const steps = Object.keys(agent.steps);
				const agentOverrides = overrides[ns] ?? {};
				const claudeSteps = CLAUDE_STEPS[ns] ?? [];
				const stepBindings: Record<string, string> = {};
				for (const step of steps) {
					if (typeof agentOverrides[step] === 'string') {
						stepBindings[step] = agentOverrides[step];
					} else {
						stepBindings[step] = claudeSteps.includes(step) ? 'anthropic' : 'local';
					}
				}
				result[displayId] = stepBindings;
			}
			return result;
		},

		'config.show': async () => {
			try {
				const raw = readFileSync(PATHS.config, 'utf-8');
				return JSON.parse(raw) as Record<string, unknown>;
			} catch {
				return {};
			}
		},

		'config.write': async (params) => {
			const { path: dotPath, value } = params as { path: string; value: unknown };
			let config: Record<string, unknown> = {};
			try {
				config = JSON.parse(readFileSync(PATHS.config, 'utf-8')) as Record<string, unknown>;
			} catch { /* start fresh */ }

			// Set value at dotted path (e.g. 'models.agents.pair.propose')
			const keys = dotPath.split('.');
			let obj: Record<string, unknown> = config;
			for (let i = 0; i < keys.length - 1; i++) {
				const key = keys[i]!;
				if (typeof obj[key] !== 'object' || obj[key] === null) {
					obj[key] = {};
				}
				obj = obj[key] as Record<string, unknown>;
			}
			obj[keys[keys.length - 1]!] = value;

			writeFileSync(PATHS.config, JSON.stringify(config, null, 2), 'utf-8');
			await reloadChatConfig();
			log.info({ path: dotPath, value }, 'config.write');
			return { ok: true };
		},

		'config.reload': async () => {
			const reloaded = await reloadChatConfig();
			log.info({ reloaded }, 'config reloaded for active sessions');
			return { ok: true, reloaded };
		},

		'config.enqueue': async (params) => {
			const { filePath, scope, event } = params as {
				filePath: string; scope: ConfigScope; event: 'create' | 'update' | 'delete';
			};
			queue.enqueue({ kind: 'config-file', filePath, scope, event });
			return { ok: true };
		},

		'config.reindex': async (params) => {
			const { scope } = params as { scope: ConfigScope };
			queue.enqueue({ kind: 'config-reindex', scope });
			return { ok: true };
		},

		'config.search': async (params) => {
			const opts = params as ConfigSearchOpts;
			const queryVec = await embedQuery(opts.query);
			const results = await searchConfig(configStore, queryVec, opts);
			return results;
		},

		'config.list': async (params) => {
			const { namespace, category, scope } = params as {
				namespace?: string; category?: string; scope?: string;
			};
			return configStore.listEntries({ namespace, category, scope });
		},

		'config.resolveTemplate': async (params) => {
			const opts = params as TemplateQuery;
			const queryVec = await embedQuery(opts.name);
			return resolveTemplate(configStore, queryVec, opts);
		},

		'keys.set': async (params) => {
			const { name, value } = params as { name: string; value: string };
			const { setKey } = await import('../shared/keystore.js');
			await setKey(name, value);
			return { ok: true };
		},

		'keys.get': async (params) => {
			const { name } = params as { name: string };
			const { getKey, maskKey } = await import('../shared/keystore.js');
			const value = await getKey(name);
			return value ? { name, masked: maskKey(value), exists: true } : { name, exists: false };
		},

		'keys.delete': async (params) => {
			const { name } = params as { name: string };
			const { deleteKey } = await import('../shared/keystore.js');
			await deleteKey(name);
			return { ok: true };
		},

		'keys.list': async () => {
			const { listKeys, getKey, maskKey } = await import('../shared/keystore.js');
			const names = await listKeys();
			const entries = await Promise.all(names.map(async (name) => {
				const value = await getKey(name);
				return { name, masked: value ? maskKey(value) : '(empty)' };
			}));
			return entries;
		},

		'daemon.shutdown': async () => {
			log.info('shutdown requested');
			shutdown('daemon.shutdown RPC');
			return { ok: true };
		},

		// Tool settings snapshot -- pushed by the IDE on connect and on
		// settings changes. Daemon holds the snapshot in memory; tools
		// and the tool-loop read via getToolSettings().
		'tools.config.set': async (params) => {
			const { updateToolSettings } = await import('./tools/config.js');
			const next = updateToolSettings((params ?? {}) as Record<string, unknown>);
			return { ok: true, settings: next };
		},

		'tools.config.get': async () => {
			const { getToolSettings } = await import('./tools/config.js');
			return getToolSettings();
		},

		// ---- Providers RPC ----
		'providers.listModels': async (params) => {
			const { listModelsForProvider } = await import('./providers.js');
			const { provider } = (params ?? {}) as { provider: import('../shared/types.js').ProviderName };
			return listModelsForProvider(provider);
		},

		'providers.testKey': async (params) => {
			const { testProviderKey } = await import('./providers.js');
			const { provider } = (params ?? {}) as { provider: import('../shared/types.js').ProviderName };
			return testProviderKey(provider);
		},

		'providers.getConfig': async () => {
			const { getProvidersConfig } = await import('./providers.js');
			return getProvidersConfig();
		},

		'providers.setConfig': async (params) => {
			const { setProvidersConfig } = await import('./providers.js');
			const patch = (params ?? {}) as Partial<import('../shared/types.js').AgentConfig['models']>;
			const result = setProvidersConfig(patch);
			await reloadChatConfig();
			return result;
		},

		'providers.check': async () => {
			const { checkConfigured } = await import('./providers.js');
			const { loadConfigWithKeys } = await import('../agent/config.js');
			const cfg = await loadConfigWithKeys();
			const err = checkConfigured(cfg);
			return err ?? { ok: true };
		},

		// Chat session management (standard handlers)
		'chat.start': chatStart,
		'chat.reply': chatReply,
		'chat.cancel': chatCancel,
		'chat.inject': chatInject,
		'chat.redirect': chatRedirect,
		'brainstorm.addIdea': brainstormAddIdea,
		'chat.close': chatClose,
		'chat.list': chatList,
		'chat.status': chatStatus,
		'chat.restore': chatRestore,

		// Todos framework (plans/todo-framework.md). Standard RPCs --
		// caller authorization happens inside each handler, stream
		// events land on the in-process bus and get flushed via
		// 'todos.subscribe' below.
		'todos.listForSession': (params) => todosRpc.listForSession(db, params),
		'todos.create': (params) => todosRpc.create(db, params),
		'todos.update': (params) => todosRpc.update(db, params),
		'todos.archive': (params) => todosRpc.archive(db, params),
		'todos.unarchive': (params) => todosRpc.unarchive(db, params),
		'todos.deleteList': (params) => todosRpc.deleteList(db, params),
		'todos.transfer': (params) => todosRpc.transfer(db, params),
		'todos.reparent': (params) => todosRpc.reparent(db, params),
		'todos.addItem': (params) => todosRpc.addItem(db, params),
		'todos.updateItem': (params) => todosRpc.updateItem(db, params),
		'todos.reorderItem': (params) => todosRpc.reorderItem(db, params),
		'todos.removeItem': (params) => todosRpc.removeItem(db, params),
		'todos.clearCompleted': (params) => todosRpc.clearCompleted(db, params),
		'todos.cleanup': (params) => todosRpc.cleanup(db, params),
		'todos.addComment': (params) => todosRpc.addComment(db, params),
		'todos.editComment': (params) => todosRpc.editComment(db, params),
		'todos.deleteComment': (params) => todosRpc.deleteCommentRpc(db, params),
		'todos.ackComment': (params) => todosRpc.ackComment(db, params),
		'todos.forwardToAgent': (params) => todosRpc.forwardToAgent(db, params),

		// Artifact template commands (plans/artifact-tasks.md §2.3).
		// Standard RPCs backing the workbench palette commands --
		// listTemplates / edit / reset -- so the workbench doesn't
		// need to know the daemon's install path.
		'artifacts.listTemplates': async (params) => {
			const mod = await import('./artifacts-rpc.js');
			return mod.listTemplatesRpc(params);
		},
		'artifacts.ensureUserTemplate': async (params) => {
			const mod = await import('./artifacts-rpc.js');
			return mod.ensureUserTemplateRpc(params);
		},
		'artifacts.resetUserTemplate': async (params) => {
			const mod = await import('./artifacts-rpc.js');
			return mod.resetUserTemplateRpc(params);
		},
		'db.listConnections': async (params) => {
			const mod = await import('./db-rpc.js');
			return mod.listConnectionsRpc(params as { repoRoot?: unknown });
		},
		'db.listDriverKinds': async () => {
			const mod = await import('./db-rpc.js');
			return mod.listDriverKindsRpc();
		},
		'db.saveConnection': async (params) => {
			const mod = await import('./db-rpc.js');
			return mod.saveConnectionRpc(params as { repoRoot?: unknown; config?: unknown });
		},
		'db.deleteConnection': async (params) => {
			const mod = await import('./db-rpc.js');
			return mod.deleteConnectionRpc(params as { repoRoot?: unknown; id?: unknown });
		},
		'db.testConnection': async (params) => {
			const mod = await import('./db-rpc.js');
			return mod.testConnectionRpc(params as { repoRoot?: unknown; config?: unknown });
		},

		// Access-gate RPCs (plans/access-gate.md Phase 5.3). Read /
		// revoke window into Session.access + Session.accessAudit so
		// the workbench Approvals pane can render the live picture.
		'access.snapshot': async (params) => {
			const mod = await import('./access-rpc.js');
			return mod.snapshotRpc(params as { sessionId?: unknown });
		},
		'access.revoke': async (params) => {
			const mod = await import('./access-rpc.js');
			return mod.revokeRpc(params as { sessionId?: unknown; kind?: unknown; key?: unknown });
		},
		'access.revokePrefix': async (params) => {
			const mod = await import('./access-rpc.js');
			return mod.revokePrefixRpc(params as { sessionId?: unknown; kind?: unknown; prefix?: unknown });
		},

		// Skill registry RPCs (plans/analyzers/skills-core.md Phase 2.3).
		// Workbench / CLI window into the runSkill pipeline -- the same
		// pipeline the skill_invoke meta-tool uses from an LLM tool loop.
		// `skill.audit` ships separately with the per-session ring buffer
		// covered by Phase 7.2.
		'skill.list': async () => {
			const mod = await import('./skills-rpc.js');
			return mod.listRpc();
		},
		'skill.feasibility': async (params) => {
			const mod = await import('./skills-rpc.js');
			return mod.feasibilityRpc(params as Parameters<typeof mod.feasibilityRpc>[0]);
		},
		'skill.invoke': async (params) => {
			const mod = await import('./skills-rpc.js');
			return mod.invokeRpc(params as Parameters<typeof mod.invokeRpc>[0]);
		},
		'skill.audit': async (params) => {
			const mod = await import('./skills-rpc.js');
			return mod.auditRpc(params as Parameters<typeof mod.auditRpc>[0]);
		},
		'artifacts.getOfflineBundleStatus': async () => {
			const mod = await import('./artifacts-rpc.js');
			return mod.getOfflineBundleStatusRpc();
		},
		'artifacts.downloadOfflineBundle': async () => {
			const mod = await import('./artifacts-rpc.js');
			return mod.downloadOfflineBundleRpc();
		},
		'artifacts.removeOfflineBundle': async () => {
			const mod = await import('./artifacts-rpc.js');
			return mod.removeOfflineBundleRpc();
		},

		// Code Analyzer per-task cache (plans/analyzers/code-analyzer.md
		// Phase 2.5). The clearCache RPC backs the
		// `insrc.codeAnalyzer.clearCache` palette command -- workbench
		// doesn't have direct access to the daemon's `~/.insrc/cache/`
		// dir, so the daemon owns the unlink and reports the count.
		'codeAnalyzer.clearCache': async () => {
			const mod = await import('../agent/tasks/code-analyzer/cache.js');
			return mod.clearCache();
		},

		// Data Analyzer per-task cache (plans/analyzers/data-analyzer.md
		// Phase 2.4). Mirror of `codeAnalyzer.clearCache`. Backs the
		// `insrc.dataAnalyzer.clearCache` palette command.
		'dataAnalyzer.clearCache': async () => {
			const mod = await import('../agent/tasks/data-analyzer/cache.js');
			return mod.clearCache();
		},

		// Data Analyzer diff-vs-previous-run (plans/analyzers/data-analyzer.md
		// Phase 5.2). Compares two completed analysis lists and returns a
		// structured diff over their accepted findings plus a rendered
		// markdown summary. Backs `insrc.dataAnalyzer.diffWithPrevious`.
		'dataAnalyzer.diffRuns': async (params) => {
			const mod = await import('./data-analyzer-diff.js');
			return mod.diffRunsRpc(params as { priorListId?: unknown; currentListId?: unknown });
		},

		// Code Analyzer diff-vs-previous-run (plans/analyzers/code-analyzer.md
		// Phase 4.2). Compares two completed analysis lists; returns a
		// structured diff over their accepted findings plus a rendered
		// markdown summary. Backs `insrc.codeAnalyzer.diffWithPrevious`.
		'codeAnalyzer.diffRuns': async (params) => {
			const mod = await import('./code-analyzer-diff.js');
			return mod.diffRunsRpc(params as { priorListId?: unknown; currentListId?: unknown });
		},
	}, {
		// Streaming handlers
		'chat.send': chatSend,
		'chat.resume': chatResume,
		'chat.resumeFromCheckpoint': chatResumeFromCheckpoint,
		'chat.resumeCodeAnalysis':   chatResumeCodeAnalysis,
		'chat.resumeDataAnalysis':   chatResumeDataAnalysis,
		'todos.subscribe': todosRpc.subscribe,
		'ollama.pull': async (params, send, signal) => {
			const { model } = params as { model: string };
			const { Ollama } = await import('ollama');
			const config = JSON.parse(readFileSync(PATHS.config, 'utf-8')) as Record<string, unknown>;
			const ollamaConfig = (config['ollama'] ?? {}) as Record<string, unknown>;
			const host = (ollamaConfig['host'] as string) ?? 'http://localhost:11434';
			const ollama = new Ollama({ host });
			const stream = await ollama.pull({ model, stream: true });
			for await (const progress of stream) {
				if (signal.aborted) break;
				const pct = progress.completed && progress.total
					? Math.round((progress.completed / progress.total) * 100) : 0;
				send({ id: 0, stream: 'progress', data: { model, status: progress.status, pct } });
			}
			send({ id: 0, stream: 'done', data: { model } });
			log.info({ model }, 'ollama.pull complete');
		},
	});

	// Initialize chat session pool
	initChatHandlers();

	await server.listen();
	log.info('ready');

	// 8. Nightly pruning job — runs every 24 hours
	const PRUNE_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
	const pruneTimer = setInterval(async () => {
		try {
			const result = await pruneConversations(db);
			if (result.expired > 0 || result.capped > 0) {
				log.info(`pruned ${result.expired} expired + ${result.capped} capped sessions`);
			}
			// Also run conversation compaction
			const compactResult = await compactConversations(db, async (text) => embedQuery(text));
			const totalCompacted = compactResult.warmCompressed + compactResult.coldMerged + compactResult.archived;
			if (totalCompacted > 0 || compactResult.directives > 0) {
				log.info({ ...compactResult }, 'conversation compaction');
			}
		} catch (err) {
			log.error({ err }, 'pruning/compaction error');
		}
	}, PRUNE_INTERVAL);

	// 8b. Todos retention sweep (plans/todo-framework.md Phase 2).
	// Fires once at boot and every 24 h; drops archived todo lists
	// untouched for 90 days.
	const stopTodosRetention = todosRpc.scheduleTodosRetention(db);

	// 9. Graceful shutdown on signals
	// Shutdown handler. Race between two timelines:
	//
	//   1. `queueDone.finally(...)` cleanly drains the indexer + cross-
	//      file resolver queue, then calls process.exit(0) with pino
	//      having flushed.
	//   2. The hard-exit backstop fires at HARD_EXIT_MS regardless of
	//      queue state. Used to be: queueDone never resolved if a
	//      long-running indexer job was in flight, so SIGTERM left the
	//      process running until the IDE escalated to SIGKILL --
	//      silent death, no flush, no PID cleanup. Live testing
	//      2026-04-29 confirmed every IDE restart that re-pulled the
	//      daemon code produced this signature.
	//
	// HARD_EXIT_MS is intentionally less than the IDE's
	// TERMINATE_GRACE_MS (30 s) so the backstop fires first whenever
	// possible -- the daemon flushes pino + clears its PID before
	// the IDE escalates to SIGKILL.
	const HARD_EXIT_MS = 20_000;
	let shutdownStarted = false;
	function shutdown(signal: string): void {
		// Re-entrant safety: SIGINT followed by SIGTERM (or vice
		// versa) shouldn't restart the timers / double-emit "bye".
		if (shutdownStarted) {
			log.warn({ signal }, 'shutdown signal received again; already in progress');
			return;
		}
		shutdownStarted = true;
		// Log synchronously at the top so even a SIGKILL race leaves
		// at least the receipt line in agent.*.log. pino's worker-
		// thread transport may not flush this in time, but it's the
		// best-effort bookend matching the daemon-crash handler.
		log.info({ signal }, 'shutdown signal received; draining...');
		clearInterval(pruneTimer);
		stopTodosRetention();
		queue.stop();
		void disposeChatHandlers();
		void watcher.close();
		void server.close();
		// Hard-exit backstop -- fires whether or not queueDone resolved.
		// `unref()` so the timer doesn't keep the event loop alive on
		// its own; queue drain finishing first lets us exit early.
		const backstop = setTimeout(() => {
			log.warn({ ms: HARD_EXIT_MS }, 'shutdown: hard-exit backstop fired (queue drain stalled)');
			try { clearPid(); } catch { /* nothing */ }
			process.exit(0);
		}, HARD_EXIT_MS);
		backstop.unref();
		void queueDone.finally(async () => {
			// Order: storage pool last so the WAL flushes after every
			// other writer has closed. closeDb() handles LanceDB +
			// graph-client reset; closeDuckDB() drops the in-memory
			// query engine (no on-disk state); closeDuckDBStorage()
			// flushes + closes ~/.insrc/duckdb.db.
			await closeDb();
			await closeDuckDB();
			await closeDuckDBStorage();
			clearPid();
			log.info('bye');
			clearTimeout(backstop);
			process.exit(0);
		});
	}

	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('SIGINT',  () => shutdown('SIGINT'));
}

main().catch(err => {
	log.fatal({ err }, 'fatal error');
	process.exit(1);
});
