/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Meta-task orchestrator: the two-phase loop, the two retry loops, abort routing.
 *
 * One `runMetaTask()` per user-initiated meta-task invocation. Drives the
 * lifecycle (scope -> plan -> approve -> execute -> synthesize -> done),
 * persists state under `~/.insrc/meta/<id>/`, and emits the chat-panel
 * events through the supplied `MetaTaskEmitter`.
 *
 * Design refs:
 *   - [`design/meta-tasks.html`](../../../design/meta-tasks.html) §3 lifecycle,
 *     §4 two-phase model, §6 retries, §7 plan revision / heartbeats.
 *   - [`plans/meta-tasks.md`](../../../plans/meta-tasks.md) M2.5.
 *
 * What's wired in M2:
 *   - Single-step + auto-accept plan path (used by `/review`).
 *   - Both retry loops (narrowing cap 2, context-needed cap 3) with
 *     verbatim retry prompts.
 *   - Heartbeats via `Heartbeat` reusing the existing progress widget.
 *   - Abort routing: M2 treats every `abort` as terminal; the user-driven
 *     four-action gate lands in M5.
 *   - Persistence: meta.json, plan.json, plan.history.jsonl, per-step
 *     phase1/phase2 JSONLs, deliverables.
 *
 * What lands later:
 *   - M3 sub-meta-task invocation + section-flow leaf integration.
 *   - M4 planner migration (the planner step becomes a sub-meta-task call).
 *   - M5 user-driven plan revision via the abort gate.
 */

import { randomBytes } from 'crypto';

import type { LLMProvider, LLMMessage } from '../shared/types.js';
import { getLogger } from '../shared/logger.js';

import { fulfill } from './context-fetcher.js';
import { MetaTaskStore, stepSlug } from './persist.js';
import { Heartbeat, composeStatus } from './heartbeat.js';
import { MetaTaskEmitter } from './event-emitter.js';
import { Phase1AskSchema, Phase2OutSchema, validatePhase1Ask, validatePhase2Out } from './schema.js';
import type { MetaTaskTemplate } from './templates/index.js';
import { getTemplate } from './templates/index.js';

import type {
	ContextChunk,
	DeliverableCatalog,
	Phase1Ask,
	Phase1Result,
	Phase2Out,
	Plan,
	ScopeManifest,
	StepDescriptor,
} from './types.js';
import { DEFAULT_RETRY_CAPS } from './types.js';

const log = getLogger('meta-task:orchestrator');


// ---------------------------------------------------------------------------
// Run options + result
// ---------------------------------------------------------------------------

export interface RunMetaTaskOpts {
	readonly templateId: string;
	readonly intent:     string;
	readonly scope:      ScopeManifest;
	readonly sessionId:  string;
	readonly emit:       MetaTaskEmitter;
	/** Cloud LLM provider for phase-1 / phase-2 calls. Caller-built so the
	 *  orchestrator stays free of factory plumbing. */
	readonly cloud:      LLMProvider;
	/** Embedder for `semantic` / `memory` slots in the fetcher. */
	readonly embed:      (text: string) => Promise<number[]>;
	/**
	 * memory-context M2.5. Local LLM provider for G5 relevance curation in
	 * the auto-injected `preferences` slot. Optional -- when omitted the
	 * fetcher skips curation and returns the scope-filtered preference list
	 * (matching the inclusion-bias behaviour of `agent/context/preferences.ts`).
	 */
	readonly localProvider?: LLMProvider | undefined;
	readonly signal?:    AbortSignal | undefined;
	/** Override the random-id allocator for tests. */
	readonly allocId?:   (() => string) | undefined;
	/** Override the clock for tests. */
	readonly now?:       (() => number) | undefined;
	/**
	 * Sub-meta-task: when set, the orchestrator persists under this store
	 * (rooted in the parent's persistRoot) and stamps the parent reference
	 * in `meta.json`. The parent's deliverable catalog flows in via
	 * `parentCatalog`. Sub-task TodoList rows + emissions still flow through
	 * the parent's emitter -- they're labelled with the sub's id so the
	 * chat panel can distinguish.
	 */
	readonly store?:           MetaTaskStore | undefined;
	readonly parentMetaTaskId?: string | undefined;
	readonly parentCatalog?:   DeliverableCatalog | undefined;
}

export interface MetaTaskResult {
	readonly metaTaskId: string;
	readonly plan:       Plan;
	readonly outcome:    'completed' | 'aborted';
	readonly synthesis?: string | undefined;
	/** Cumulative per-step deliverables, keyed by step index (1-based). */
	readonly deliverables: ReadonlyMap<number, string>;
	readonly abortReason?: string | undefined;
}


// ---------------------------------------------------------------------------
// runMetaTask -- top-level entrypoint
// ---------------------------------------------------------------------------

export async function runMetaTask(opts: RunMetaTaskOpts): Promise<MetaTaskResult> {
	const template = getTemplate(opts.templateId);
	if (template === undefined) {
		opts.emit.error(`unknown meta-task template: '${opts.templateId}'`, false);
		throw new Error(`unknown meta-task template: '${opts.templateId}'`);
	}

	const metaTaskId = (opts.allocId ?? defaultAllocId)();
	const store      = opts.store ?? new MetaTaskStore(metaTaskId);
	const now        = opts.now ?? (() => Date.now());
	const isSubTask  = opts.parentMetaTaskId !== undefined;

	log.info({ metaTaskId, templateId: opts.templateId, sessionId: opts.sessionId, parent: opts.parentMetaTaskId }, 'meta-task starting');
	opts.emit.progress(`meta-task:${template.id}`, 'scope');

	// 1. Persist meta + plan.
	const plan = template.plan(opts.scope);
	const metaPayload: import('./types.js').MetaTaskMeta = opts.parentMetaTaskId !== undefined
		? {
			metaTaskId,
			templateId:        template.id,
			intent:            opts.intent,
			scope:             opts.scope,
			worktreeMode:      template.worktreeMode,
			startedAt:         new Date(now()).toISOString(),
			parentMetaTaskId:  opts.parentMetaTaskId,
			planRevisionCount: 0,
		}
		: {
			metaTaskId,
			templateId:        template.id,
			intent:            opts.intent,
			scope:             opts.scope,
			worktreeMode:      template.worktreeMode,
			startedAt:         new Date(now()).toISOString(),
			planRevisionCount: 0,
		};
	await store.writeMeta(metaPayload);
	await store.writePlan(plan, 'initial');

	// 2. Create a TodoList mirroring the plan; one item per step.
	//    Owner is bound when TodosApi is constructed (`makeTodosApi(db, 'meta-task')`).
	const list = await opts.emit.todos.createList({
		title:       `${template.displayName}: ${opts.intent}`,
		sessionId:   opts.sessionId,
		description: `${template.id} -- ${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}`,
	});
	const itemByStep = new Map<number, string>();
	for (let i = 0; i < plan.steps.length; i++) {
		const desc = plan.steps[i]!;
		const item = await opts.emit.todos.addItem(list.id, { title: desc.name });
		itemByStep.set(i + 1, item.id);
	}

	// 3. M2: auto-accept the plan. User gate lands in M5.
	opts.emit.progress(`meta-task:${template.id}`, 'plan: auto-accepted (M2)');

	// 4. Execute each step in order.
	const deliverables = new Map<number, string>();
	// Mutable working catalog; the orchestrator-internal copy. Sub-tasks
	// inherit a snapshot of the parent's catalog so phase-1 fetchers can
	// pull upstream deliverables; the child's own deliverables append as
	// it runs.
	const catalog: import('./types.js').DeliverableCatalogEntry[] = [
		...(opts.parentCatalog ?? []),
	];
	let aborted = false;
	let abortReason: string | undefined;

	for (let i = 0; i < plan.steps.length; i++) {
		const stepIndex = i + 1;
		const stepDesc  = plan.steps[i]!;
		const slug      = stepSlug(stepDesc.name);
		const itemId    = itemByStep.get(stepIndex)!;

		await opts.emit.todos.markInProgress(itemId);

		const outcome = await runStep({
			stepIndex,
			stepDesc,
			slug,
			scope:    opts.scope,
			catalog,
			cloud:    opts.cloud,
			embed:    opts.embed,
			localProvider: opts.localProvider,
			emit:     opts.emit,
			store,
			template,
			signal:   opts.signal,
			now,
			deliverables,
		});

		if (outcome.kind === 'deliverable') {
			deliverables.set(stepIndex, outcome.body);
			await store.writeStepDeliverable(stepIndex, slug, outcome.body);
			await opts.emit.todos.markComplete(itemId);
			// Extend the catalog so subsequent steps can pull this deliverable.
			catalog.push({
				id:       `step-${String(stepIndex).padStart(2, '0')}-${slug}`,
				label:    stepDesc.name,
				headings: extractHeadings(outcome.body),
				bytes:    Buffer.byteLength(outcome.body, 'utf8'),
				absPath:  `${store.stepFileBase(stepIndex, slug)}.deliverable.md`,
			});
		} else {
			aborted = true;
			abortReason = outcome.reason;
			await opts.emit.todos.markBlocked(itemId, outcome.reason);
			break;
		}
	}

	// 5. Synthesis -- only when the template declares one + all steps completed.
	let synthesis: string | undefined;
	if (!aborted && template.synthesizeIntent !== undefined) {
		synthesis = await runSynthesis({
			template,
			deliverables,
			catalog,
			scope: opts.scope,
			cloud: opts.cloud,
			emit:  opts.emit,
			store,
			now,
		});
	}

	// 6. Compose the list body. Even single-step templates land their
	//    deliverable here so the report pane has something to show.
	const composedBody = composeListBody({
		template,
		intent: opts.intent,
		plan,
		deliverables,
		synthesis,
		aborted,
		abortReason,
	});
	try { await opts.emit.todos.updateListBody(list.id, composedBody); }
	catch (err) { log.warn({ err: (err as Error).message }, 'updateListBody failed'); }

	if (aborted) {
		opts.emit.progress(`meta-task:${template.id}`, 'aborted');
		// Sub-tasks don't close the IPC stream -- the parent owns the
		// stream terminal signal. Sub-task abort is surfaced via the
		// returned `MetaTaskResult`.
		if (!isSubTask) {
			opts.emit.done({ metaTaskId, outcome: 'aborted', abortReason });
		}
		return { metaTaskId, plan, outcome: 'aborted', deliverables, abortReason };
	}

	opts.emit.progress(`meta-task:${template.id}`, 'done');
	if (!isSubTask) {
		opts.emit.done({ metaTaskId, outcome: 'completed' });
	}
	return synthesis !== undefined
		? { metaTaskId, plan, outcome: 'completed', deliverables, synthesis }
		: { metaTaskId, plan, outcome: 'completed', deliverables };
}


// ---------------------------------------------------------------------------
// runStep -- two-phase loop for a single step. Returns either a deliverable
// or an abort with reason. The two retry loops live inside this function;
// they're stateful enough (catalog of fetched chunks, retry counters) that
// extracting them buys little.
// ---------------------------------------------------------------------------

interface RunStepOpts {
	readonly stepIndex: number;
	readonly stepDesc:  StepDescriptor;
	readonly slug:      string;
	readonly scope:     ScopeManifest;
	readonly catalog:   DeliverableCatalog;
	readonly cloud:     LLMProvider;
	readonly embed:     (text: string) => Promise<number[]>;
	/** memory-context M2.5. Local LLM for the `preferences` slot G5 curation. */
	readonly localProvider: LLMProvider | undefined;
	readonly emit:      MetaTaskEmitter;
	readonly store:     MetaTaskStore;
	readonly template:  MetaTaskTemplate;
	readonly signal:    AbortSignal | undefined;
	readonly now:       () => number;
	/**
	 * /plan template M4.a Phase 1. Snapshot of the running meta-task's
	 * prior-step deliverables. Available to `StepDescriptor.phase2`
	 * runners so deterministic steps can read upstream bodies inline
	 * (e.g. P4 validate reads P3's draft, P6 synth reads P3 + P5).
	 */
	readonly deliverables: ReadonlyMap<number, string>;
}

type StepOutcome =
	| { readonly kind: 'deliverable'; readonly body:   string }
	| { readonly kind: 'abort';       readonly reason: string };

async function runStep(opts: RunStepOpts): Promise<StepOutcome> {
	const startMs = opts.now();
	// The heartbeat's `_status` arg now carries the bare substate; the
	// onTick callback composes the rolling elapsed time so the user sees
	// the counter advance on every tick. Tight 2s cadence so silent LLM
	// calls (cloud Phase 1 ask + Phase 2 task, often 15-45s each) feel
	// alive in the progress widget.
	const label = stepLabel(opts.template, opts.stepDesc);
	const heartbeat = new Heartbeat({
		intervalMs: 2_000,
		onTick: substate => opts.emit.progress(
			label,
			composeStatus({ substate, elapsedMs: opts.now() - startMs }),
		),
		now: opts.now,
	});

	// Cumulative chunks across narrowing + context-needed retries. Each retry
	// preserves earlier `ok` fetches; only the failing requests get retried.
	const cumulativeChunks: ContextChunk[] = [];

	let phase2RetryAttempt = 0;
	let lastPhase2Reason: string | undefined;

	const bubble = `meta-task:${opts.template.id} / ${opts.stepDesc.name}`;
	heartbeat.start('phase-1 ctx');

	try {
		// ─────────────────────────────────────────────────────────────────
		// Phase 2 loop (context-needed retries). Each iteration runs the
		// phase-1 mini-loop, then phase 2. Capped at maxContextNeededRetries.
		// ─────────────────────────────────────────────────────────────────
		// eslint-disable-next-line no-constant-condition
		while (true) {
			// PHASE 1 -- get the cloud LLM's ask, fulfill it.
			opts.emit.liveStep(`${bubble}: phase-1 ctx`, '');
			const askPrompt = buildPhase1Prompt({
				stepDesc:        opts.stepDesc,
				template:        opts.template,
				catalog:         opts.catalog,
				cumulativeChunks,
				priorPhase2Reason: lastPhase2Reason,
				phase2RetryAttempt,
				maxPhase2Retries: DEFAULT_RETRY_CAPS.maxContextNeededRetries,
			});
			const cloudAsk = await callForPhase1Ask({
				cloud:  opts.cloud,
				prompt: askPrompt,
				store:  opts.store,
				stepIndex: opts.stepIndex,
				slug:   opts.slug,
				retryAttempt: phase2RetryAttempt,
			});

			// memory-context M2.5: auto-inject a `preferences` slot regardless
			// of whether the cloud said sufficient or context-needed. Even on
			// 'sufficient' we still fetch preferences -- that's the documented
			// exception per G5. Synthesise an effective ask with the preferences
			// slot pre-pended (or as the only slot when the cloud said sufficient).
			const preferencesReq: Phase1Ask & { kind: 'context-needed' } = {
				kind: 'context-needed',
				requests: [
					{
						kind: 'preferences',
						scope: {
							templateId: opts.template.id,
							repoPath:   opts.scope.repoPath,
						},
						stepIntent: opts.stepDesc.intent,
					},
					...(cloudAsk.kind === 'context-needed' ? cloudAsk.requests : []),
				],
				...(cloudAsk.kind === 'context-needed' && cloudAsk.intent !== undefined ? { intent: cloudAsk.intent } : {}),
			};
			const ask: Phase1Ask = preferencesReq;

			let phase1Result: Phase1Result | null = null;
			if (ask.kind === 'context-needed') {
				phase1Result = await runNarrowingLoop({
					initialAsk: ask,
					opts,
					cumulativeChunks,
				});
			}
			opts.emit.liveStep(`${bubble}: phase-1 ctx`, '', true);
			heartbeat.updateStatus('phase-2 task');

			// PHASE 2 -- run the task with the assembled context.
			opts.emit.liveStep(`${bubble}: phase-2 task`, '');
			// /plan template M4.a Phase 1 (O1 resolution): escape hatch.
			// When the step descriptor supplies a `phase2` runner, the
			// orchestrator delegates to it instead of the default cloud
			// path. The runner may call `ctx.cloud.complete()` 0 / 1 / N
			// times (deterministic helpers + multi-call patterns) and
			// must return a `Phase2Out`. The standard JSONL persistence
			// + Phase2Out routing below stays identical.
			let output: Phase2Out;
			if (opts.stepDesc.phase2 !== undefined) {
				try {
					output = await opts.stepDesc.phase2({
						stepDesc:         opts.stepDesc,
						phase1Result,
						cumulativeChunks: [...cumulativeChunks],
						cloud:            opts.cloud,
						catalog:          opts.catalog,
						deliverables:     opts.deliverables,
						stepIndex:        opts.stepIndex,
						retryAttempt:     phase2RetryAttempt,
						bubble,
						signal:           opts.signal,
					});
				} catch (err) {
					// Mirror the LLM path's failure shape: any throw becomes
					// a user-required abort so the meta-task surfaces a
					// stable error to the consumer rather than crashing
					// runStep mid-iteration.
					output = {
						kind:       'abort',
						resolution: 'user-required',
						reason:     `phase2 runner threw: ${(err as Error).message ?? String(err)}`,
					};
				}
				await opts.store.appendStepPhase2(opts.stepIndex, opts.slug, {
					ts: opts.now(), kind: 'output', output, retryAttempt: phase2RetryAttempt,
				});
			} else {
				const taskPrompt = buildPhase2Prompt({
					stepDesc:    opts.stepDesc,
					template:    opts.template,
					// memory-context M2.5: use the CLOUD's original kind for
					// messaging. The orchestrator may have auto-injected
					// preferences into the effective ask, but the cloud
					// shouldn't see the rewritten kind -- it judges based on
					// what it asked for.
					askKind:     cloudAsk.kind,
					phase1Result,
					phase2RetryAttempt,
					maxPhase2Retries: DEFAULT_RETRY_CAPS.maxContextNeededRetries,
					priorPhase2Reason: lastPhase2Reason,
				});
				output = await callForPhase2({
					cloud:  opts.cloud,
					prompt: taskPrompt,
					emit:   opts.emit,
					bubble,
					store:  opts.store,
					stepIndex: opts.stepIndex,
					slug:   opts.slug,
					retryAttempt: phase2RetryAttempt,
				});
			}
			opts.emit.liveStep(`${bubble}: phase-2 task`, '', true);

			// ROUTE by Phase2Out kind.
			if (output.kind === 'deliverable') {
				return { kind: 'deliverable', body: output.body };
			}
			if (output.kind === 'abort') {
				// M2: every abort terminates. M5 wires the user gate.
				return { kind: 'abort', reason: `${output.resolution}: ${output.reason}` };
			}
			// 'context-needed'
			lastPhase2Reason  = output.reason;
			phase2RetryAttempt += 1;
			if (phase2RetryAttempt > DEFAULT_RETRY_CAPS.maxContextNeededRetries) {
				return {
					kind:   'abort',
					reason: `context-needed retry cap (${DEFAULT_RETRY_CAPS.maxContextNeededRetries}) exceeded; last reason: ${output.reason}`,
				};
			}
			// Loop back into phase 1 with the updated context.
			heartbeat.updateStatus(`phase-1 ctx (retry ${phase2RetryAttempt}/${DEFAULT_RETRY_CAPS.maxContextNeededRetries})`);
		}
	} finally {
		heartbeat.stop();
	}
}


// ---------------------------------------------------------------------------
// runNarrowingLoop -- the phase-1-only retry loop. Triggered when the local
// LLM emits `status: 'needs-narrowing'` on any chunk.
// ---------------------------------------------------------------------------

interface NarrowingLoopOpts {
	readonly initialAsk: Phase1Ask & { kind: 'context-needed' };
	readonly opts: RunStepOpts;
	readonly cumulativeChunks: ContextChunk[];
}

async function runNarrowingLoop(input: NarrowingLoopOpts): Promise<Phase1Result | null> {
	let ask: Phase1Ask & { kind: 'context-needed' } = input.initialAsk;
	let attempt = 0;
	const cap = DEFAULT_RETRY_CAPS.maxNarrowingRetries;

	// eslint-disable-next-line no-constant-condition
	while (true) {
		const result = await fulfill(ask, {
			scope:   input.opts.scope,
			catalog: input.opts.catalog,
			embed:   input.opts.embed,
			...(input.opts.localProvider !== undefined ? { localProvider: input.opts.localProvider } : {}),
		});
		await input.opts.store.appendStepPhase1(input.opts.stepIndex, input.opts.slug, {
			ts: input.opts.now(), kind: 'result', result: result!, retryAttempt: attempt,
		});
		// Accumulate `ok` / `partial` / `empty` / `error` into the cumulative catalog.
		for (const chunk of result!.chunks) {
			if (chunk.status !== 'needs-narrowing') {
				input.cumulativeChunks.push(chunk);
			}
		}
		const narrowing = result!.chunks.filter(c => c.status === 'needs-narrowing');
		if (narrowing.length === 0) {
			return result;
		}
		attempt += 1;
		if (attempt > cap) {
			// Cap reached: take what we have and proceed to phase 2.
			// Convert the remaining `needs-narrowing` chunks into `partial` placeholders
			// so phase 2 sees them as truncated rather than missing.
			for (const c of narrowing) {
				input.cumulativeChunks.push({ ...c, status: 'partial', payload: null,
					note: `narrowing cap ${cap} reached; original hint: ${c.narrowingHint?.note ?? '(none)'}` });
			}
			return result;
		}
		// Build the next ask: only re-request the narrowing-failed requests, with
		// the hints attached as context the cloud LLM sees in its next prompt.
		// The narrowing prompt is built by buildPhase1Prompt; here we only need
		// the cloud's refined ask, so we call it again.
		const refinedAskPrompt = buildPhase1RefinementPrompt({
			priorAsk:        ask,
			narrowingChunks: narrowing,
			attempt,
			cap,
		});
		const refined = await callForPhase1Ask({
			cloud:  input.opts.cloud,
			prompt: refinedAskPrompt,
			store:  input.opts.store,
			stepIndex: input.opts.stepIndex,
			slug:   input.opts.slug,
			retryAttempt: attempt,
		});
		if (refined.kind !== 'context-needed') {
			// Cloud bailed out -- pretend sufficient and proceed.
			return result;
		}
		ask = refined;
	}
}


// ---------------------------------------------------------------------------
// LLM call helpers. Both phase-1 ask and phase-2 output are JSON; we
// constrain via `responseFormat: 'json'` and validate via the schema
// validators. On validation failure we retry once with the error feedback
// appended; deeper retries surface as either narrowing or context-needed.
// ---------------------------------------------------------------------------

interface Phase1CallOpts {
	readonly cloud:        LLMProvider;
	readonly prompt:       string;
	readonly store:        MetaTaskStore;
	readonly stepIndex:    number;
	readonly slug:         string;
	readonly retryAttempt: number;
}

async function callForPhase1Ask(opts: Phase1CallOpts): Promise<Phase1Ask> {
	// plans/structured-output.md Phase C.1. The wire-layer schema is
	// Phase1AskSchema (TypeBox); the provider's completeStructured
	// path enforces it natively (Anthropic forced tool, OpenAI
	// json_schema strict, Gemini responseSchema, Mistral json_schema,
	// Ollama format). ajv re-validates as a defensive backstop and
	// retries with feedback (up to maxAttempts) on schema failure.
	// On schema-level pass the hand-rolled validatePhase1Ask runs
	// next and surfaces business-rule violations (empty `requests`
	// on context-needed, etc.) -- those errors flow into the
	// existing orchestrator-side retry flow above this call.
	const messages: LLMMessage[] = [
		{ role: 'system', content:
			`You are a meta-task orchestrator's context planner. Emit one of these two shapes:\n\n`
			+ `{ "kind": "sufficient" }   -- you genuinely need nothing, the orchestrator skips the local LLM and runs you directly.\n\n`
			+ `OR\n\n`
			+ `{ "kind": "context-needed", "requests": [ <ContextRequest>... ], "intent": "<optional free-text>" }   -- you need context; requests MUST be non-empty.\n\n`
			+ `Each <ContextRequest> is one of:\n`
			+ `  - { "kind": "entities", "names"?: string[], "kinds"?: string[], "repos"?: string[] }  (at least one of names/kinds/repos)\n`
			+ `  - { "kind": "files", "globs": string[], "maxBytes"?: number }\n`
			+ `  - { "kind": "deliverable", "specId": string, "heading"?: string }\n`
			+ `  - { "kind": "semantic", "query": string, "topK"?: number, "over"?: ("entities"|"deliverables")[] }\n`
			+ `  - { "kind": "graph", "op": "callers"|"callees"|"imports"|"importers"|"closure", "targets": string[], "depth"?: number }\n`
			+ `  - { "kind": "git", "paths"?: string[], "since"?: string, "maxCommits"?: number }\n`
			+ `  - { "kind": "trace", "specId": string }\n`
			+ `  - { "kind": "memory", "query"?: string }\n`
			+ `  - { "kind": "preferences", "scope"?: { templateId?, category?, repoPath? }, "stepIntent"?: string }`,
		},
		{ role: 'user', content: opts.prompt },
	];
	const parsed = await opts.cloud.completeStructured<unknown>(messages, Phase1AskSchema);
	const v = validatePhase1Ask(parsed);
	await opts.store.appendStepPhase1(opts.stepIndex, opts.slug, {
		ts: Date.now(), kind: 'ask',
		ask: v.ok ? v.value : ({ kind: 'context-needed', requests: [] } as Phase1Ask),
		retryAttempt: opts.retryAttempt,
	});
	if (!v.ok) {
		throw new Error(`phase-1 ask: business-rule validation failed: ${v.errors.join('; ')}`);
	}
	return v.value;
}


interface Phase2CallOpts {
	readonly cloud:        LLMProvider;
	readonly prompt:       string;
	readonly emit:         MetaTaskEmitter;
	readonly bubble:       string;
	readonly store:        MetaTaskStore;
	readonly stepIndex:    number;
	readonly slug:         string;
	readonly retryAttempt: number;
}

async function callForPhase2(opts: Phase2CallOpts): Promise<Phase2Out> {
	// plans/structured-output.md Phase C.1. Wire-layer schema is
	// Phase2OutSchema (TypeBox). Streaming token feedback (onToken /
	// liveStep) is not currently honoured on the structured-output
	// surface -- it returns the validated value, not a stream. Per
	// design this is fine: phase-2 outputs are short JSON envelopes
	// (deliverable.body is the only large field, and the user sees
	// the final markdown body, not its incremental construction).
	// If streaming becomes important later we can extend the
	// LLMProvider surface; for now the deterministic structured
	// path is the right tradeoff.
	const messages: LLMMessage[] = [
		{ role: 'system', content:
			`You are a meta-task orchestrator's task runner. Emit one of these three shapes:\n\n`
			+ `1. { "kind": "deliverable", "body": "<markdown body>" }  -- success. The user reads body directly.\n`
			+ `2. { "kind": "context-needed", "requests": [...], "reason": "<why prior context was insufficient>", "intent"?: "..." }  -- you need more context; the orchestrator will fetch and re-call you. REASON IS REQUIRED.\n`
			+ `3. { "kind": "abort", "reason": "<why you cannot continue>", "resolution": "user-required" | "plan-revisable", "hint"?: "..." }  -- terminate the step. Resolution and reason are REQUIRED.\n\n`
			+ `For ContextRequest shapes see the orchestrator's phase-1 contract.`,
		},
		{ role: 'user', content: opts.prompt },
	];
	const parsed = await opts.cloud.completeStructured<unknown>(messages, Phase2OutSchema);
	const v = validatePhase2Out(parsed);
	await opts.store.appendStepPhase2(opts.stepIndex, opts.slug, {
		ts: Date.now(), kind: 'output',
		output: v.ok ? v.value : ({ kind: 'abort', reason: `schema validation failed: ${v.errors.join('; ')}`, resolution: 'user-required' } as Phase2Out),
		retryAttempt: opts.retryAttempt,
	});
	if (!v.ok) {
		throw new Error(`phase-2 output: business-rule validation failed: ${v.errors.join('; ')}`);
	}
	// Surface the final body via liveStep so the chat panel transitions
	// from "running" to "done" cleanly, even though no streaming
	// happened in between.
	if (v.value.kind === 'deliverable') {
		opts.emit.liveStep(opts.bubble, v.value.body);
	}
	return v.value;
}


// ---------------------------------------------------------------------------
// Synthesis -- one phase-2 call after the last step in templates that
// declare `synthesizeIntent`. /review is single-step so this is unused in M2.
// ---------------------------------------------------------------------------

interface SynthesisOpts {
	readonly template:     MetaTaskTemplate;
	readonly deliverables: ReadonlyMap<number, string>;
	readonly catalog:      DeliverableCatalog;
	readonly scope:        ScopeManifest;
	readonly cloud:        LLMProvider;
	readonly emit:         MetaTaskEmitter;
	readonly store:        MetaTaskStore;
	readonly now:          () => number;
}

// plans/structured-output.md Phase C.7. Synthesis emits a single
// `{ kind: 'deliverable', body: '<markdown>' }` object via the
// wire-layer-enforced surface. Streaming token-emission is dropped on
// the structured path (the body still surfaces via liveStep once the
// final object arrives).
const SYNTHESIS_SCHEMA: Record<string, unknown> = {
	type: 'object',
	required: ['kind', 'body'],
	additionalProperties: false,
	properties: {
		kind: { type: 'string', enum: ['deliverable'] },
		body: { type: 'string' },
	},
};

async function runSynthesis(opts: SynthesisOpts): Promise<string> {
	const bubble = `meta-task:${opts.template.id} / synthesis`;
	opts.emit.liveStep(bubble, '');

	// 2s heartbeat so the progress widget stays alive during the silent
	// synthesis LLM call (cloud Phase 2 of the meta-task pipeline; can
	// take 15-30s for a multi-step plan).
	const startMs = opts.now();
	const label = `meta-task:${opts.template.id}`;
	const heartbeat = new Heartbeat({
		intervalMs: 2_000,
		onTick: substate => opts.emit.progress(
			label,
			composeStatus({ substate, elapsedMs: opts.now() - startMs }),
		),
		now: opts.now,
	});
	heartbeat.start('synthesis');

	const prompt =
		`You are composing the synthesis artifact for a multi-step meta-task.\n\n`
		+ `Intent: ${opts.scope.intent}\n`
		+ `Synthesis target: ${opts.template.synthesizeIntent}\n\n`
		+ `Step deliverables (markdown, in order):\n\n`
		+ [...opts.deliverables.entries()]
			.sort(([a], [b]) => a - b)
			.map(([idx, body]) => `### Step ${idx}\n\n${body}`)
			.join('\n\n---\n\n')
		+ `\n\nRespond with a JSON object: { "kind": "deliverable", "body": "<composed markdown>" }`;
	const messages: LLMMessage[] = [
		{ role: 'system', content: 'Respond with ONLY a JSON object: { "kind": "deliverable", "body": "<markdown>" }' },
		{ role: 'user',   content: prompt },
	];
	let body = '';
	try {
		const parsed = await opts.cloud.completeStructured<{ kind: string; body: string }>(
			messages,
			SYNTHESIS_SCHEMA,
		);
		body = parsed.body ?? '';
		opts.emit.liveStep(bubble, body);
	} catch (err) {
		log.warn({ err: (err as Error).message }, 'synthesis call failed');
	} finally {
		heartbeat.stop();
	}
	opts.emit.liveStep(bubble, '', true);
	await opts.store.writeSynthesis(body);
	return body;
}


// ---------------------------------------------------------------------------
// Prompt builders. Verbatim concatenation -- no orchestrator paraphrasing.
// The strings here are EXACTLY what the cloud LLM sees, in retry order.
// ---------------------------------------------------------------------------

interface BuildPhase1PromptOpts {
	readonly stepDesc:           StepDescriptor;
	readonly template:           MetaTaskTemplate;
	readonly catalog:            DeliverableCatalog;
	readonly cumulativeChunks:   readonly ContextChunk[];
	readonly priorPhase2Reason:  string | undefined;
	readonly phase2RetryAttempt: number;
	readonly maxPhase2Retries:   number;
}

function buildPhase1Prompt(opts: BuildPhase1PromptOpts): string {
	const lines: string[] = [];
	lines.push(`Template: ${opts.template.id} -- ${opts.template.displayName}`);
	lines.push(`Step: ${opts.stepDesc.name}`);
	lines.push(`Step intent: ${opts.stepDesc.intent}`);
	if (opts.stepDesc.acceptance.length > 0) {
		lines.push('');
		lines.push('Step acceptance:');
		for (const a of opts.stepDesc.acceptance) {
			lines.push(`  - [${a.kind}] ${a.id}: ${a.description}`);
		}
	}
	lines.push('');
	lines.push('Available prior deliverables (catalog -- pull bodies via `deliverable` slot):');
	if (opts.catalog.length === 0) {
		lines.push('  (none yet)');
	} else {
		for (const e of opts.catalog) {
			lines.push(`  - id="${e.id}" label="${e.label}" headings=[${e.headings.map(h => `"${h}"`).join(', ')}] bytes=${e.bytes}`);
		}
	}
	if (opts.cumulativeChunks.length > 0) {
		lines.push('');
		lines.push('Context already fetched for this step (do not re-request unless refining):');
		for (let i = 0; i < opts.cumulativeChunks.length; i++) {
			const c = opts.cumulativeChunks[i]!;
			lines.push(`  chunk[${i}] request.kind=${c.request.kind} status=${c.status}${c.note !== undefined ? ` note="${c.note}"` : ''}`);
		}
	}
	if (opts.priorPhase2Reason !== undefined) {
		lines.push('');
		lines.push('─── Previous phase-2 attempt declared the context insufficient ───');
		lines.push(`Reason: ${opts.priorPhase2Reason}`);
		lines.push(`Phase-2 retries remaining: ${opts.maxPhase2Retries - opts.phase2RetryAttempt + 1} / ${opts.maxPhase2Retries}`);
		lines.push('Refine your request.');
	}
	lines.push('');
	lines.push('Respond with the JSON ask shape.');
	return lines.join('\n');
}


interface BuildPhase1RefinementOpts {
	readonly priorAsk:        Phase1Ask & { kind: 'context-needed' };
	readonly narrowingChunks: readonly ContextChunk[];
	readonly attempt:         number;
	readonly cap:             number;
}

function buildPhase1RefinementPrompt(opts: BuildPhase1RefinementOpts): string {
	const lines: string[] = [];
	lines.push('─── Narrowing required ───');
	lines.push('You requested:');
	lines.push(JSON.stringify(opts.priorAsk.requests, null, 2));
	lines.push('');
	lines.push('Local LLM declined to fulfill the following requests because they were too broad:');
	for (const c of opts.narrowingChunks) {
		lines.push(`  - request.kind=${c.request.kind}`);
		if (c.narrowingHint !== undefined) {
			if (c.narrowingHint.matched !== undefined)             { lines.push(`      matched: ${c.narrowingHint.matched}`); }
			if (c.narrowingHint.suggestedFilters !== undefined)    { lines.push(`      suggested filters: ${c.narrowingHint.suggestedFilters.join('; ')}`); }
			if (c.narrowingHint.suggestedAlternativeKinds !== undefined) { lines.push(`      suggested alternative kinds: ${c.narrowingHint.suggestedAlternativeKinds.join(', ')}`); }
			if (c.narrowingHint.note !== undefined)                { lines.push(`      note: ${c.narrowingHint.note}`); }
		}
	}
	lines.push('');
	lines.push(`Narrowing retries remaining: ${opts.cap - opts.attempt + 1} / ${opts.cap}.`);
	if (opts.attempt >= opts.cap) {
		lines.push('Cap reached. Either accept a `partial` result with an explicit cap, or proceed with what you have.');
	}
	lines.push('');
	lines.push('─── Updated request ───');
	lines.push('Respond with the JSON ask shape.');
	return lines.join('\n');
}


interface BuildPhase2PromptOpts {
	readonly stepDesc:           StepDescriptor;
	readonly template:           MetaTaskTemplate;
	readonly askKind:            Phase1Ask['kind'];
	readonly phase1Result:       Phase1Result | null;
	readonly phase2RetryAttempt: number;
	readonly maxPhase2Retries:   number;
	readonly priorPhase2Reason:  string | undefined;
}

function buildPhase2Prompt(opts: BuildPhase2PromptOpts): string {
	const lines: string[] = [];
	// /plan template M4.a Phase 4: step-level prelude wins over template-level.
	// Templates whose steps each need a distinct system prelude (e.g. /plan's
	// P1/P2/P3/P5) ship one per step; templates with a single shared prelude
	// (e.g. /review) keep using the template-level field.
	const prelude = opts.stepDesc.phase2SystemPrelude ?? opts.template.phase2SystemPrelude;
	if (prelude !== undefined) {
		lines.push(prelude);
		lines.push('');
	}
	lines.push(`Step: ${opts.stepDesc.name}`);
	lines.push(`Step intent: ${opts.stepDesc.intent}`);
	if (opts.stepDesc.acceptance.length > 0) {
		lines.push('');
		lines.push('Acceptance criteria:');
		for (const a of opts.stepDesc.acceptance) {
			lines.push(`  - [${a.kind}] ${a.id}: ${a.description}`);
		}
	}
	lines.push('');
	// memory-context M2.5: the orchestrator may auto-inject a `preferences`
	// chunk into phase-1 even when the cloud declared 'sufficient'. Split
	// the render so the "you declared sufficient" message still appears
	// (the cloud's own judgment is preserved) but any auto-injected
	// preferences chunks are surfaced alongside it.
	const allChunks = opts.phase1Result?.chunks ?? [];
	// Empty preferences chunks carry no signal -- skip them so the prompt
	// doesn't show a meaningless "Auto-injected" section when no preferences
	// are seeded for the owner.
	const prefChunks = allChunks.filter(c => c.request.kind === 'preferences' && c.status !== 'empty');
	const otherChunks = allChunks.filter(c => c.request.kind !== 'preferences');

	if (opts.askKind === 'sufficient' || opts.phase1Result === null) {
		lines.push('You declared sufficiency in phase 1; run the task with what your training has + your tool access.');
		if (prefChunks.length > 0) {
			lines.push('');
			lines.push('Auto-injected: active user preferences (apply when relevant):');
			for (let i = 0; i < prefChunks.length; i++) {
				const c = prefChunks[i]!;
				lines.push(`─── preferences[${i}] -- status=${c.status}${c.note !== undefined ? ` (${c.note})` : ''} ───`);
				lines.push(JSON.stringify(c.payload, null, 2).slice(0, 8000));
			}
		}
	} else {
		lines.push('Context (assembled by local LLM from your phase-1 ask):');
		for (let i = 0; i < otherChunks.length; i++) {
			const c = otherChunks[i]!;
			lines.push('');
			lines.push(`─── chunk[${i}]: ${c.request.kind} -- status=${c.status}${c.note !== undefined ? ` (${c.note})` : ''} ───`);
			lines.push(JSON.stringify(c.payload, null, 2).slice(0, 8000));   // cap per-chunk render
		}
		if (prefChunks.length > 0) {
			lines.push('');
			lines.push('Auto-injected: active user preferences (apply when relevant):');
			for (let i = 0; i < prefChunks.length; i++) {
				const c = prefChunks[i]!;
				lines.push(`─── preferences[${i}] -- status=${c.status}${c.note !== undefined ? ` (${c.note})` : ''} ───`);
				lines.push(JSON.stringify(c.payload, null, 2).slice(0, 8000));
			}
		}
		lines.push('');
		lines.push(`Aggregate: ${opts.phase1Result.meta.totalBytes} bytes, ${opts.phase1Result.meta.elapsedMs} ms, ${opts.phase1Result.meta.droppedRequests} dropped requests.`);
	}
	if (opts.phase2RetryAttempt > 0 && opts.priorPhase2Reason !== undefined) {
		lines.push('');
		lines.push(`─── Retry ${opts.phase2RetryAttempt}/${opts.maxPhase2Retries} ───`);
		lines.push(`Your previous attempt declared the context insufficient with reason: ${opts.priorPhase2Reason}`);
		lines.push(`The local LLM has refetched per your refined request. Try again with the updated context.`);
	}
	if (opts.phase2RetryAttempt >= opts.maxPhase2Retries) {
		lines.push('');
		lines.push('Cap reached. Produce your best-effort deliverable from what you have, or abort with reason.');
	}
	lines.push('');
	lines.push('Respond with the JSON deliverable / context-needed / abort shape.');
	return lines.join('\n');
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stepLabel(template: MetaTaskTemplate, desc: StepDescriptor): string {
	return `meta-task:${template.id} / ${desc.name}`;
}

function extractHeadings(body: string): string[] {
	const out: string[] = [];
	const re = /^(#{1,3})\s+(.+)$/;
	for (const line of body.split('\n')) {
		const m = re.exec(line);
		if (m !== null) { out.push(m[2]!.trim()); }
	}
	return out;
}

function defaultAllocId(): string {
	return `mt-${randomBytes(6).toString('hex')}`;
}


interface ComposeListBodyOpts {
	readonly template:     MetaTaskTemplate;
	readonly intent:       string;
	readonly plan:         Plan;
	readonly deliverables: ReadonlyMap<number, string>;
	readonly synthesis:    string | undefined;
	readonly aborted:      boolean;
	readonly abortReason:  string | undefined;
}

function composeListBody(opts: ComposeListBodyOpts): string {
	const lines: string[] = [];
	lines.push(`# ${opts.template.displayName}: ${opts.intent}`);
	lines.push('');
	if (opts.aborted) {
		lines.push(`**Status:** aborted`);
		lines.push('');
		lines.push('## Abort reason');
		lines.push('');
		lines.push(opts.abortReason ?? '(no reason)');
		lines.push('');
	} else {
		lines.push(`**Status:** completed`);
		lines.push('');
	}
	if (opts.synthesis !== undefined && opts.synthesis.length > 0) {
		lines.push('## Synthesis');
		lines.push('');
		lines.push(opts.synthesis);
		lines.push('');
	}
	if (opts.deliverables.size > 0) {
		lines.push('## Step deliverables');
		lines.push('');
		for (const [idx, body] of [...opts.deliverables.entries()].sort(([a], [b]) => a - b)) {
			const step = opts.plan.steps[idx - 1];
			lines.push(`### ${step?.name ?? `Step ${idx}`}`);
			lines.push('');
			lines.push(body);
			lines.push('');
		}
	}
	return lines.join('\n');
}
