/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Top-level section-flow orchestrator (planner-section-task-separation
 * P5.a). One async function that wires P1 (working memory) + P2
 * (Scope + Investigation Plan) + P3 (per-TODO body) + P4 (report
 * assembler + review) into a single entrypoint the daemon controller
 * invokes.
 *
 * Lifecycle:
 *
 *   1. Step 1 -- Scope.
 *      `runScopeStep` produces { scope, subtype, contextRefs[],
 *      isTrivial }. Repo signals threaded through when provided.
 *
 *   2. Step 2 -- Investigation Plan.
 *      `runInvestigationPlan` produces the flat TODO list. Fast-path
 *      (scope.isTrivial -> single-TODO plan) handled inside.
 *
 *   3. Working-memory init.
 *      A WorkingMemoryStore is opened at the per-report-run
 *      directory. Bullet cache (P1.e) is bound to the same runId.
 *
 *   4. Per-TODO loop.
 *      For each TODO:
 *        a. Decide cold-rebuild vs incremental memory shape
 *           (shouldColdRebuild on the running memory-tokens count).
 *        b. Run shape (single-call/chunked) OR incremental update.
 *        c. Run the TODO orchestrator (P3.d): planner + per-root
 *           execution + assembly + section review + L2 fallback.
 *        d. Write the resulting WorkingMemoryEntry to the store.
 *        e. Extract bullets and persist to the LanceDB cache.
 *
 *   5. Step 4 -- Final report.
 *      `runReportReview` runs the assemble + review loop (Q7).
 *      Resolvers for structural-revise (section-contradiction +
 *      scope-gap) are bound here -- scope-gap delegates to a fresh
 *      `runTodoOrchestrator` per appended TODO.
 *
 *   6. Cleanup.
 *      Bullet cache entries for the run are dropped via
 *      `deleteBulletsForRun(runId)`. The working-memory directory is
 *      kept by default (Q1 lifetime; caller decides whether to wipe).
 */

import type { LLMProvider } from '../../shared/types.js';
import {
	openWorkingMemoryStore,
	shapeMemory,
	incrementalUpdate,
	shouldColdRebuild,
	extractBullets,
	type MemoryShapeBundle,
	type WorkingMemoryStore,
	type BulletCache,
	type BulletCacheHit,
} from '../working-memory/index.js';
import {
	writeBullets,
	searchBullets,
	deleteBulletsForRun,
} from '../../db/lance/working-memory-bullets.js';
import type { WorkingMemoryEntry } from '../working-memory/types.js';
import { createBudget, countTokens, type TokenBudget } from '../context/budget.js';
import { runScopeStep } from './step-scope.js';
import { runInvestigationPlan } from './step-investigation-plan.js';
import {
	runTodoOrchestrator,
	type L2Fallback,
	type TodoOrchestratorTrace,
} from './todo-orchestrator.js';
import type { ExecuteLeaf } from './leaf-executor.js';
import type { CatalogSkill } from '../content-gen/plan-tree-runner.js';
import type { ScopeStepResult, InvestigationPlanResult } from './types.js';
import { reviewSection } from './step-section-review.js';
import {
	runReportReview,
	type ReportReviewResult,
	type SectionContradictionResolver,
	type ScopeGapResolver,
} from './step-report-review.js';
import type { TodoSpec } from './types.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('section-flow:run');

// ---------------------------------------------------------------------------
// Public input / output
// ---------------------------------------------------------------------------

export interface RunSectionFlowInput {
	readonly question: string;
	/**
	 * Cloud-tier provider used for planner / reviewer / synthesis /
	 * report-assembler calls. Production callers pass the active cloud
	 * provider (Anthropic / OpenAI / etc.) with Ollama as fallback.
	 */
	readonly provider: LLMProvider;
	/**
	 * LOCAL-tier provider used for:
	 *   - working-memory operations (`shapeMemory` cold rebuild,
	 *     `incrementalUpdate` layer deltas, `extractBullets` per-TODO
	 *     fact extraction) -- these prompts declare themselves
	 *     "LOCAL CONTEXT-ASSEMBLY model" and were always intended to
	 *     run on Ollama;
	 *   - embeddings (bullet-cache writes + semantic-layer ANN), which
	 *     are local-only per CLAUDE.md (cloud providers return [] for
	 *     `embed()`).
	 *
	 * When omitted, falls back to `provider`. The fallback is correct
	 * only for unit tests with scripted providers; production callers
	 * MUST pass `session.ollamaProvider`.
	 */
	readonly localProvider?: LLMProvider | undefined;
	readonly executeLeaf: ExecuteLeaf;
	readonly l2Fallback:  L2Fallback;
	/** Per-report-run identifier. Used for the bullet-cache scope and the working-memory dir. */
	readonly runId:       string;
	/** Absolute path to the per-run working-memory directory (PATHS.workingMemoryRun). */
	readonly workingMemoryDir: string;
	/** Repo signals threaded into Step 1's scope classifier (optional). */
	readonly repoSignals?: {
		readonly fileCount?:        number;
		readonly primaryLanguages?: readonly string[];
		readonly topModules?:       readonly string[];
	} | undefined;
	/** Override the token budget; default 32k matches the offline-validated baseline. */
	readonly budget?: TokenBudget | undefined;
	/** numCtx threaded into shape decisions; default matches `budget.total`. */
	readonly numCtx?:  number | undefined;
	/**
	 * Skill catalog surfaced into the section planner. The planner renders
	 * it trailing in its prompt and rejects emitted plans whose `leaf.skill`
	 * is not in the catalog. Pass via `buildCatalogFromRegistry({...})` from
	 * `agent/content-gen/plan-tree-helpers`. Omit for unit tests using
	 * scripted providers; production callers MUST pass a real catalog.
	 */
	readonly catalog?: readonly CatalogSkill[] | undefined;
	/**
	 * Optional session id for the Phase 3 build-context sub-step
	 * (plans/section-flow-architecture-redesign.md). When supplied,
	 * `runTodoOrchestrator` builds a per-step artifact TOC from the
	 * session's `artifact_vec` rows so the leaf-executor's local
	 * build-context turn can decide which artifacts to fetch into
	 * the shape-resolver's priorOutputs. Omit to skip build-context
	 * entirely (legacy path; still exercised by every existing unit
	 * test). Production callers pass `session.id`.
	 */
	readonly sessionId?: string | undefined;
	/**
	 * Optional progress callback the daemon controller wires to chat-
	 * stream events AND the TodoList workbench API (Q8). Awaited
	 * serially so the controller can persist TodoItems before the next
	 * phase starts; failures are logged and swallowed.
	 */
	readonly onProgress?: (event: ProgressEvent) => void | Promise<void>;
}

export interface ProgressEvent {
	readonly phase:
		| 'scope'
		| 'plan'
		| 'todo-start'
		| 'todo-complete'
		| 'scope-gap-todo-added'
		| 'report-assemble'
		| 'report-review'
		| 'cleanup';
	readonly message: string;
	readonly meta?:   Record<string, unknown>;
}

export interface RunSectionFlowResult {
	readonly finalReport: string;
	readonly entries:     readonly WorkingMemoryEntry[];
	readonly trace:       RunSectionFlowTrace;
}

export interface RunSectionFlowTrace {
	readonly scope:             ScopeStepResult;
	readonly investigationPlan: InvestigationPlanResult;
	readonly perTodo:           readonly TodoOrchestratorTrace[];
	readonly reportReview: {
		readonly cyclesConsumed:       number;
		readonly exhausted:            boolean;
		readonly structuralReviseUsed: boolean;
		readonly addedScopeGapTodos:   readonly TodoSpec[];
	};
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runSectionFlow(input: RunSectionFlowInput): Promise<RunSectionFlowResult> {
	const budget = input.budget ?? createBudget(32_768);
	const numCtx = input.numCtx ?? budget.total;
	const store  = openWorkingMemoryStore(input.workingMemoryDir);
	const cache  = makeBulletCache(input.runId);
	// Local-tier provider: working-memory ops (shape / incremental /
	// bullets) + embeddings (bullet cache + semantic ANN). Falls back
	// to `provider` for legacy callers (tests with a scripted
	// provider). Production callers wire `session.ollamaProvider`.
	const localProvider = input.localProvider ?? input.provider;

	const progress = async (event: ProgressEvent): Promise<void> => {
		if (input.onProgress === undefined) { return; }
		try {
			await input.onProgress(event);
		} catch (err) {
			log.warn({ err: (err as Error).message, phase: event.phase }, 'onProgress callback threw; swallowing');
		}
	};

	// 1. Step 1 -- Scope.
	await progress({ phase: 'scope', message: 'classifying scope' });
	const scopeArgs: Parameters<typeof runScopeStep>[0] = {
		question: input.question,
		provider: input.provider,
	};
	if (input.repoSignals !== undefined) {
		(scopeArgs as { repoSignals?: NonNullable<RunSectionFlowInput['repoSignals']> }).repoSignals = input.repoSignals;
	}
	const scope = await runScopeStep(scopeArgs);
	log.info({ scope: scope.scope, subtype: scope.subtype, isTrivial: scope.isTrivial }, 'scope step complete');

	// 2. Step 2 -- Investigation plan.
	const investigationPlan = await runInvestigationPlan({
		question: input.question,
		scope,
		provider: input.provider,
	});
	log.info({ todoCount: investigationPlan.todos.length, fastPath: investigationPlan.isFastPath }, 'investigation plan landed');
	// Emit plan AFTER the call so meta.todos is populated; the
	// controller wires this to addItem-per-TODO on the workbench
	// list (Q8). `todos` carries the full investigation plan in
	// execution order; `isFastPath` lets the workbench skip
	// per-TODO progress polish on single-shot runs.
	await progress({
		phase:   'plan',
		message: `investigation plan: ${investigationPlan.todos.length} TODO(s)`,
		meta: {
			todos: investigationPlan.todos.map(t => ({ id: t.id, objective: t.objective, origin: t.origin })),
			isFastPath: investigationPlan.isFastPath,
		},
	});

	// 3. Per-TODO loop.
	let priorBundle: MemoryShapeBundle | undefined;
	let lastColdRebuildMemoryTokens = 0;
	const perTodoTraces: TodoOrchestratorTrace[] = [];

	// Caller passed `runId` via `input.runId`; carry to per-TODO loop.
	for (let i = 0; i < investigationPlan.todos.length; i++) {
		const todo = investigationPlan.todos[i]!;
		await progress({
			phase:   'todo-start',
			message: `TODO ${i + 1}/${investigationPlan.todos.length}: ${todo.objective}`,
			meta: {
				todoId:    todo.id,
				index:     i,
				objective: todo.objective,
				origin:    todo.origin,
			},
		});

		const memory = await prepareMemoryFor(todo, {
			store,
			cache,
			priorBundle,
			priorEntriesForRecent: await store.listEntries(),
			lastColdRebuildMemoryTokens,
			budget,
			numCtx,
			localProvider,
		});

		const todoResult = await runTodoOrchestrator({
			todo,
			memory:      memory.bundle,
			provider:    input.provider,
			executeLeaf: input.executeLeaf,
			l2Fallback:  input.l2Fallback,
			catalog:     input.catalog ?? [],
			...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
		});
		perTodoTraces.push(todoResult.trace);
		priorBundle = memory.bundle;

		await store.write(i, todoResult.entry);

		// Refresh the cold-rebuild baseline AFTER the new entry is on
		// disk so the next iteration's growth comparison sees the
		// post-write token count, not the pre-write 0.
		if (memory.wasColdRebuild) {
			const accumulatedText = await store.accumulatedMemoryText();
			lastColdRebuildMemoryTokens = countTokens(accumulatedText);
		}

		// Bullets for the cache (best-effort; extraction failures are
		// non-fatal -- the next TODO's semantic update falls back to the
		// LLM path).
		await persistBullets(todoResult.entry, input.runId, i, localProvider);

		await progress({
			phase:   'todo-complete',
			message: `TODO ${i + 1}/${investigationPlan.todos.length} complete${todoResult.trace.l2FallbackUsed ? ' (L2 fallback)' : ''}`,
			meta: {
				todoId:    todo.id,
				index:     i,
				l2:        todoResult.trace.l2FallbackUsed,
				cyclesRun: todoResult.trace.cyclesRun,
				recycles:  todoResult.trace.recyclesConsumed,
				fallback:  todoResult.entry.findings.fallback,
				// Reviewable-root sub-items rendered post-hoc (Q8). One
				// entry per perRoot finding; sub-item status text
				// surfaces followup cycles and exhausted bits so the
				// workbench renderer can show "followup cycle 2/3" etc.
				subItems: todoResult.entry.findings.perRoot.map(r => ({
					id:        r.rootId,
					title:     r.rootId,
					status:    'complete' as const,
					statusText: r.cyclesConsumed > 0
						? `${r.verdict}; ${r.cyclesConsumed} followup cycle${r.cyclesConsumed === 1 ? '' : 's'}${r.exhausted ? ' (exhausted)' : ''}`
						: r.verdict,
				})),
			},
		});
	}

	// 4. Step 4 -- Final report assembly + review.
	await progress({ phase: 'report-assemble', message: 'assembling final report' });
	const entriesForReport = (await store.listEntries()).map(e => e.entry);

	const sectionResolver: SectionContradictionResolver = async ({ sectionIds, entries }) => {
		// For each named section, re-run the section review against
		// the entry's existing detail markdown. If the reviewer accepts
		// (which is the common case after the report-level reviewer's
		// clarification), the entry stays; otherwise we record the new
		// markdown. The new fact-gap loop produces the entry.detail
		// directly via synthesis (no separate per-tree assembly stage),
		// so the candidate is just e.detail.
		const updated: WorkingMemoryEntry[] = [...entries];
		for (let i = 0; i < updated.length; i++) {
			const e = updated[i]!;
			if (!sectionIds.includes(e.todoId)) { continue; }
			const sectionReview = await reviewSection({
				todo:      { id: e.todoId, objective: e.objective, origin: e.origin },
				memory:    priorBundle ?? { system: '', summary: '', recent: '', semantic: '', code: '' },
				candidate: e.detail,
				findings:  e.findings,
				provider:  input.provider,
			});
			if (sectionReview.finalMarkdown.length > 0 && sectionReview.finalMarkdown !== e.detail) {
				updated[i] = { ...e, detail: sectionReview.finalMarkdown };
				// Replace the on-disk entry too so resume sees the corrected version.
				const idx = entries.findIndex(x => x.todoId === e.todoId);
				if (idx >= 0) {
					await store.write(idx, updated[i]!);
				}
			}
		}
		return updated;
	};

	const scopeGapResolver: ScopeGapResolver = async ({ proposedTodos }) => {
		const newEntries: WorkingMemoryEntry[] = [];
		for (let j = 0; j < proposedTodos.length; j++) {
			const todo = proposedTodos[j]!;
			// Q8: emit a TodoList event so the workbench creates a new
			// item flagged with origin='report-review-escalation'
			// BEFORE the per-TODO orchestrator runs. The renderer can
			// then show the item appearing mid-run.
			await progress({
				phase:   'scope-gap-todo-added',
				message: `scope-gap TODO appended: ${todo.objective}`,
				meta: {
					todoId:    todo.id,
					objective: todo.objective,
					origin:    todo.origin,
				},
			});

			const memory = await prepareMemoryFor(todo, {
				store,
				cache,
				priorBundle,
				priorEntriesForRecent: await store.listEntries(),
				lastColdRebuildMemoryTokens,
				budget,
				numCtx,
				localProvider,
			});
			const todoResult = await runTodoOrchestrator({
				todo,
				memory:      memory.bundle,
				provider:    input.provider,
				executeLeaf: input.executeLeaf,
				l2Fallback:  input.l2Fallback,
				catalog:     input.catalog ?? [],
				...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
			});
			const newIndex = (await store.listEntries()).length;
			await store.write(newIndex, todoResult.entry);
			await persistBullets(todoResult.entry, input.runId, newIndex, localProvider);
			newEntries.push(todoResult.entry);

			await progress({
				phase:   'todo-complete',
				message: `scope-gap TODO complete${todoResult.trace.l2FallbackUsed ? ' (L2 fallback)' : ''}: ${todo.objective}`,
				meta: {
					todoId:    todo.id,
					index:     newIndex,
					l2:        todoResult.trace.l2FallbackUsed,
					cyclesRun: todoResult.trace.cyclesRun,
				recycles:  todoResult.trace.recyclesConsumed,
					fallback:  todoResult.entry.findings.fallback,
					subItems: todoResult.entry.findings.perRoot.map(r => ({
						id:        r.rootId,
						title:     r.rootId,
						status:    'complete' as const,
						statusText: r.cyclesConsumed > 0
							? `${r.verdict}; ${r.cyclesConsumed} followup cycle${r.cyclesConsumed === 1 ? '' : 's'}${r.exhausted ? ' (exhausted)' : ''}`
							: r.verdict,
					})),
				},
			});
		}
		return newEntries;
	};

	await progress({ phase: 'report-review', message: 'reviewing final report' });
	const reportResult: ReportReviewResult = await runReportReview({
		question: input.question,
		entries:  entriesForReport,
		provider: input.provider,
		resolveSectionContradiction: sectionResolver,
		resolveScopeGap:             scopeGapResolver,
	});

	// 5. Cleanup. The bullet cache is per-report-run; drop it now that
	// the report has shipped.
	await progress({ phase: 'cleanup', message: 'cleaning up bullet cache' });
	try {
		await deleteBulletsForRun(input.runId);
	} catch (err) {
		log.warn({ err: (err as Error).message, runId: input.runId }, 'bullet-cache cleanup failed; ignoring');
	}

	return {
		finalReport: reportResult.finalReport,
		entries:     reportResult.entries,
		trace: {
			scope,
			investigationPlan,
			perTodo: perTodoTraces,
			reportReview: {
				cyclesConsumed:       reportResult.cyclesConsumed,
				exhausted:            reportResult.exhausted,
				structuralReviseUsed: reportResult.structuralReviseUsed,
				addedScopeGapTodos:   reportResult.addedScopeGapTodos,
			},
		},
	};
}

// ---------------------------------------------------------------------------
// Memory preparation: cold rebuild vs incremental update
// ---------------------------------------------------------------------------

interface PrepareMemoryInput {
	readonly store:                 WorkingMemoryStore;
	readonly cache:                 BulletCache;
	readonly priorBundle:           MemoryShapeBundle | undefined;
	readonly priorEntriesForRecent: ReadonlyArray<{ readonly index: number; readonly entry: WorkingMemoryEntry }>;
	readonly lastColdRebuildMemoryTokens: number;
	readonly budget:                TokenBudget;
	readonly numCtx:                number;
	/**
	 * LOCAL-tier provider used for working-memory shape + incremental
	 * update + the semantic-layer ANN embedding. The prompts in
	 * `working-memory/{shaper,updater,bullet-extractor}.ts` declare
	 * themselves "LOCAL CONTEXT-ASSEMBLY model"; this is the wiring
	 * that makes that real.
	 */
	readonly localProvider:         LLMProvider;
}

interface PrepareMemoryResult {
	readonly bundle:           MemoryShapeBundle;
	readonly wasColdRebuild:   boolean;
}

/**
 * Decide cold rebuild vs incremental update, then return the L1-L5
 * bundle for this TODO iteration. First TODO of the run always
 * cold-rebuilds (Q1.1: `lastColdRebuildMemoryTokens === 0` triggers).
 */
async function prepareMemoryFor(
	todo: TodoSpec,
	input: PrepareMemoryInput,
): Promise<PrepareMemoryResult> {
	const accumulatedText = await input.store.accumulatedMemoryText();
	const currentMemoryTokens = countTokens(accumulatedText);

	const coldRebuild = shouldColdRebuild({
		lastColdRebuildMemoryTokens: input.lastColdRebuildMemoryTokens,
		currentMemoryTokens,
	});

	if (coldRebuild || input.priorBundle === undefined) {
		const turns = input.priorEntriesForRecent.map(({ entry }) => ({
			name:    entry.todoId,
			content: entry.detail,
		}));
		const shapeArgs: Parameters<typeof shapeMemory>[1] = {
			memoryText: accumulatedText,
			objective:  todo.objective,
			budget:     input.budget,
			numCtx:     input.numCtx,
		};
		if (turns.length > 0) {
			(shapeArgs as { entries?: ReadonlyArray<{ name: string; content: string }> }).entries = turns;
		}
		const shaped = await shapeMemory(input.localProvider, shapeArgs);
		return { bundle: shaped.bundle, wasColdRebuild: true };
	}

	// Incremental: prior bundle + the most-recently-completed entry.
	const last = input.priorEntriesForRecent[input.priorEntriesForRecent.length - 1];
	if (last === undefined) {
		// No entries yet but priorBundle isn't undefined? Defensive: cold rebuild.
		const shaped = await shapeMemory(input.localProvider, {
			memoryText: '',
			objective:  todo.objective,
			budget:     input.budget,
			numCtx:     input.numCtx,
		});
		return { bundle: shaped.bundle, wasColdRebuild: true };
	}
	const updated = await incrementalUpdate(input.localProvider, {
		priorBundle:   input.priorBundle,
		priorEntries:  input.priorEntriesForRecent.slice(0, -1).map(e => e.entry),
		newEntry:      last.entry,
		nextObjective: todo.objective,
		budget:        input.budget,
	}, {
		bulletCache: { cache: input.cache, topK: 10, embedProvider: input.localProvider },
	});
	return { bundle: updated.bundle, wasColdRebuild: false };
}

// ---------------------------------------------------------------------------
// Bullet cache integration
// ---------------------------------------------------------------------------

function makeBulletCache(runId: string): BulletCache {
	return {
		async query(queryEmbedding: number[], topK: number): Promise<readonly BulletCacheHit[]> {
			if (queryEmbedding.length === 0) { return []; }
			const hits = await searchBullets(queryEmbedding, { runId, limit: topK });
			return hits.map(h => ({
				todoId:    h.todoId,
				todoIndex: h.todoIndex,
				bullet:    h.bullet,
				score:     h.distance,
			}));
		},
	};
}

async function persistBullets(
	entry: WorkingMemoryEntry,
	runId: string,
	todoIndex: number,
	localProvider: LLMProvider,
): Promise<void> {
	// L2-fallback entries are excluded from the bullet cache. The L2
	// path produces either (a) a real `data.answer-question` markdown
	// answer or (b) a `_(L2 fallback failed: ...)_` sentinel wrapper.
	// Case (a) is already represented in the next-TODO context via
	// `entry.detail`; re-extracting bullets would duplicate it without
	// the citation lineage downstream consumers expect. Case (b)
	// contains framework-flavor verbiage that, when extracted as
	// "facts", leaks into subsequent TODOs' semantic-layer and biases
	// the model away from the user's actual question -- exactly the
	// regression captured in the post-Phase-epsilon run.
	if (entry.findings.fallback === 'L2') {
		log.info({ todoId: entry.todoId }, 'persistBullets: skipping cache write for L2-fallback entry');
		return;
	}
	let bullets: string[];
	try {
		// Bullet extraction is a "LOCAL CONTEXT-ASSEMBLY" role per
		// `bullet-extractor.ts`: small prompt, prompt-agnostic facts,
		// fired once per TODO. Routes to Ollama, not the cloud
		// section-flow provider.
		bullets = await extractBullets(localProvider, entry);
	} catch (err) {
		log.warn({ err: (err as Error).message, todoId: entry.todoId }, 'bullet extraction failed; skipping cache write');
		return;
	}
	if (bullets.length === 0) { return; }

	// Embed each bullet sequentially (no parallel LLM calls rule).
	type BulletRowParam = Parameters<typeof writeBullets>[0] extends ReadonlyArray<infer R> ? R : never;
	const rows: BulletRowParam[] = [];
	for (let i = 0; i < bullets.length; i++) {
		const bullet = bullets[i]!;
		const embedding = await localProvider.embed(bullet);
		if (embedding.length === 0) {
			// Embedder returned no vector. With a properly wired local
			// Ollama provider this only happens on an outage; with the
			// legacy fallback (when this was the active cloud provider)
			// it happened every time. Log + stop.
			log.warn({ todoId: entry.todoId }, 'localProvider.embed returned empty vector; bullet cache write skipped');
			return;
		}
		rows.push({
			id:        `${runId}:${entry.todoId}:${i}`,
			embedding,
			runId,
			todoId:    entry.todoId,
			todoIndex,
			bullet,
			createdAt: Date.now(),
		});
	}
	try {
		await writeBullets(rows);
	} catch (err) {
		log.warn({ err: (err as Error).message, runId, todoId: entry.todoId }, 'bullet cache write failed; ignoring');
	}
}
