/**
 * Substrate runtime facade -- ties together memory + context assembler
 * + working-state ledger + lifecycle runner + distillation engine into
 * one object that the skill-runner (`daemon/skills/invoke.ts`) consults.
 *
 * Part of P1.4 of plans/skills/substrate-implementation-status.md.
 *
 * One SubstrateRuntime instance per workspace. Tests create their own
 * (per-temp-dir); production wires the daemon-wide singleton off the
 * active session's workspaceId.
 *
 * The runtime exposes a narrow per-skill helper `prepareForSkill()`
 * that:
 *   - Inspects the skill for substrate-facing fields (cast via
 *     `SubstrateSkillExtension`); skills without any return a no-op
 *     prep so existing skill behavior is unchanged.
 *   - Builds the per-execution context (assembled from declared slots)
 *     + the working-state ledger.
 *   - Returns a `complete(success)` callback that distills pinned
 *     entries on success and discards them on failure.
 *
 * The runtime also exposes `registerContextBuilders(skill)` -- called
 * once at registration time per skill -- and `fireTrigger(trigger)`
 * for indexer events.
 */

import { getLogger } from '../../shared/logger.js';

import type { Skill } from '../skills/types.js';
import { createAssertionIndex, type AssertionIndex } from './assertion-index.js';
import {
	createDefaultClassifier,
	type ClassifyInput,
	type ClassifyResult,
	type CreateClassifierOpts,
	type UserAssertionClassifier,
	type UserAssertionPayload,
} from './classifier/user-assertion.js';
import { createContextAssembler, type ContextAssembler } from './context-assembler.js';
import { createDistillEngine, type DistillEngine, schemaKeyFor } from './distill.js';
import { createFeedbackBus, type FeedbackBus, type FeedbackSubscription } from './feedback-bus.js';
import { createSubstrateIndexer } from './indexer.js';
import { createLifecycleRunner, type LifecycleRunner, type TriggerReport } from './lifecycle-runner.js';
import { withIndexer } from './memory-store-indexed.js';
import { createProviderRegistry, type ProviderRegistry } from './provider-registry.js';
import { createWorkingStateLedger } from './working-state.js';
import type {
	AssembleRequest,
	AssembledContext,
	BootstrapTrigger,
	ContextBudget,
	ContextProvider,
	Embedder,
	FeedbackEvent,
	MemoryStore,
	NamespaceSpec,
	OwnerId,
	SubstrateSkillExtension,
	WorkingStateLedger,
} from './types.js';

const log = getLogger('substrate:runtime');

// ---------------------------------------------------------------------------

export interface SubstrateRuntime {
	readonly memory:          MemoryStore;
	readonly assembler:       ContextAssembler;
	readonly lifecycle:       LifecycleRunner;
	readonly distill:         DistillEngine;
	readonly providers:       ProviderRegistry;
	readonly feedbackBus:     FeedbackBus;
	readonly assertionIndex:  AssertionIndex;
	readonly classifier:      UserAssertionClassifier;

	/**
	 * Register a skill's substrate-facing declarations. Idempotent on
	 * the skill id. Calls the lifecycle runner to register context
	 * builders; remembers the memory schema for distillation.
	 *
	 * Returns a `RegistrationToken` that can be used to deregister.
	 */
	registerSkill(skill: Skill): RegistrationToken;

	/**
	 * Build the per-execution substrate prep for a skill. Returns a
	 * triple of (context, workingState, complete).
	 *
	 * - context: AssembledContext per the skill's declared contextSlots.
	 * - workingState: a fresh WorkingStateLedger for this execution.
	 * - complete(success): on `true`, distills pinned entries to memory;
	 *   on `false`, discards them.
	 *
	 * If the skill has no substrate-facing fields, returns a no-op prep
	 * (undefined context, undefined ledger, no-op complete).
	 */
	prepareForSkill(skill: Skill, opts?: PrepareOpts): Promise<PreparedSkillExecution>;

	/** Fire a bootstrap trigger; dispatches every interested context builder. */
	fireTrigger(trigger: BootstrapTrigger): Promise<TriggerReport>;

	/**
	 * Classify a user-turn text for assertions, persist accepted ones
	 * as constraints in each target's `user-assertions` namespace, and
	 * dispatch `applyFeedback` events on the feedback bus.
	 *
	 * Returns the classification result for caller-side audit + UI.
	 * Owners with no `applyFeedback` subscription still get their
	 * memory writes; the bus just no-ops the dispatch.
	 */
	classifyAssertion(input: ClassifyInput): Promise<ClassifyAssertionResult>;
}

export interface ClassifyAssertionResult {
	readonly classification: ClassifyResult;
	readonly persisted:      readonly { readonly owner: OwnerId; readonly key: string }[];
	readonly dispatched:     readonly { readonly owner: OwnerId; readonly eventId: string }[];
}

export interface RegistrationToken {
	readonly skillId: string;
	/** Remove the substrate-facing registration for this skill. */
	deregister(): void;
}

export interface PrepareOpts {
	/** Caller-provided context budget (D2). Defaults to no cap. */
	readonly budget?: ContextBudget;
	/** Cancellation. */
	readonly signal?: AbortSignal;
	/** Task payload to expose on AssembleRequest. */
	readonly task?:    unknown;
	/** Session payload to expose on AssembleRequest. */
	readonly session?: unknown;
}

export interface PreparedSkillExecution {
	readonly context:      AssembledContext | undefined;
	readonly workingState: WorkingStateLedger | undefined;
	/**
	 * Settlement callback. Call after the skill body returns / throws.
	 * Distills on success; no-op on failure.
	 */
	complete(success: boolean): Promise<DistillSummary | undefined>;
}

export interface DistillSummary {
	readonly considered: number;
	readonly written:    number;
	readonly skipped:    readonly { readonly ref: string; readonly reason: string }[];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateSubstrateRuntimeOpts {
	readonly memory:       MemoryStore;
	/**
	 * If provided, every put / delete on the substrate's memory store
	 * is mirrored to the Lance index (substrate_vec), and
	 * searchByEmbedding routes through Lance. Without an embedder the
	 * indexer is inactive and searchByEmbedding falls back to the base
	 * store's empty-list stub.
	 */
	readonly embedder?:    Embedder;
	/**
	 * Required when `embedder` is provided -- the Lance row's scoping
	 * column. Tests pass the same id used to construct the memory
	 * store; production wires the active session's workspaceId.
	 */
	readonly workspaceId?: string;
	/**
	 * Context providers (D5a) to seed the registry with. Additional
	 * providers can be registered post-creation via
	 * `runtime.providers.register(...)`. Slots whose `fromOwner` starts
	 * with `provider:` route through the registry; without any
	 * providers registered they resolve empty (legacy P1-P3 behavior).
	 */
	readonly providers?:   readonly ContextProvider[];
	/**
	 * User-assertion classifier options (D6). The default classifier
	 * ships Layer 1 heuristic only; daemon wires the LLM-backed
	 * Layer 2 + UI-backed Layer 3 hooks via these opts. Caller may
	 * also pass a fully-replaced classifier via `customClassifier`.
	 */
	readonly classifier?:  CreateClassifierOpts;
	/** Replace the default classifier wholesale (test injection). */
	readonly customClassifier?: UserAssertionClassifier;
}

export function createSubstrateRuntime(opts: CreateSubstrateRuntimeOpts): SubstrateRuntime {
	// (owner, namespace) -> NamespaceSpec, used by the distill engine
	// AND (when present) the indexer. Single source of truth -- the
	// indexer reads at write-time so newly-registered skills become
	// indexable without rebuilding.
	const schemas = new Map<string, NamespaceSpec>();
	// skillId -> [(owner, namespace)] declared by that skill (for deregister).
	const ownedSchemas = new Map<string, string[]>();

	// Wrap the base memory store with the indexer when the caller
	// provides an embedder + workspaceId. The wrapped store is what
	// everything downstream sees (assembler, distill, the runtime's
	// public `memory`), so writes via any path go through the index.
	const memory: MemoryStore = (opts.embedder !== undefined && opts.workspaceId !== undefined)
		? withIndexer(opts.memory, createSubstrateIndexer({
			workspaceId: opts.workspaceId,
			embedder:    opts.embedder,
			schemas,
			memory:      opts.memory,
		}))
		: opts.memory;

	const providers = createProviderRegistry();
	for (const p of opts.providers ?? []) {
		providers.register(p);
	}

	const assembler      = createContextAssembler({ memory, providers });
	const lifecycle      = createLifecycleRunner({ memory });
	const distill        = createDistillEngine({ memory });
	const feedbackBus    = createFeedbackBus({ memory });
	const assertionIndex = createAssertionIndex();
	const classifier     = opts.customClassifier ?? createDefaultClassifier(opts.classifier);

	// skillId -> active feedback subscription handle (for deregister).
	const ownedSubscriptions = new Map<string, FeedbackSubscription>();
	// skillId -> assertion-index owner key (for deregister).
	const ownedAssertionOwners = new Map<string, OwnerId>();

	return {
		memory,
		assembler,
		lifecycle,
		distill,
		providers,
		feedbackBus,
		assertionIndex,
		classifier,

		registerSkill(skill: Skill): RegistrationToken {
			const ext = (skill as unknown as SubstrateSkillExtension);
			const ownerId = ext.ownerId ?? `skill:${skill.id}`;
			const own: string[] = [];

			if (ext.memorySchema !== undefined) {
				for (const ns of ext.memorySchema) {
					const key = schemaKeyFor(ownerId, ns.namespace);
					schemas.set(key, ns);
					own.push(key);
				}
			}
			if (ext.contextBuilders !== undefined) {
				for (const b of ext.contextBuilders) {
					lifecycle.registerContextBuilder(b);
				}
			}
			// D14: assertion-interest routing index.
			if (ext.assertionInterests !== undefined && ext.assertionInterests.length > 0) {
				assertionIndex.register(ownerId, ext.assertionInterests);
				ownedAssertionOwners.set(skill.id, ownerId);
			}
			// D8: feedback-bus subscription. Skill's applyFeedback receives
			// every event whose `targetOwner` matches this skill's ownerId.
			if (ext.applyFeedback !== undefined) {
				const handler = ext.applyFeedback.bind(ext);
				const sub = feedbackBus.subscribe(
					ownerId,
					async (event, deps) => { await handler([event], deps); },
				);
				ownedSubscriptions.set(skill.id, sub);
			}

			ownedSchemas.set(skill.id, own);
			log.debug(
				{
					skillId:    skill.id,
					ownerId,
					namespaces: own.length,
					builders:   ext.contextBuilders?.length    ?? 0,
					interests:  ext.assertionInterests?.length ?? 0,
					feedback:   ext.applyFeedback !== undefined,
				},
				'substrate: skill registered',
			);

			return {
				skillId: skill.id,
				deregister(): void {
					for (const k of own) { schemas.delete(k); }
					ownedSchemas.delete(skill.id);
					const sub = ownedSubscriptions.get(skill.id);
					if (sub !== undefined) {
						sub.unsubscribe();
						ownedSubscriptions.delete(skill.id);
					}
					const assertOwner = ownedAssertionOwners.get(skill.id);
					if (assertOwner !== undefined) {
						assertionIndex.deregister(assertOwner);
						ownedAssertionOwners.delete(skill.id);
					}
				},
			};
		},

		async prepareForSkill(skill: Skill, prepOpts: PrepareOpts = {}): Promise<PreparedSkillExecution> {
			const ext = (skill as unknown as SubstrateSkillExtension);

			// Skill opted out of the substrate -- no-op prep keeps legacy behavior.
			if (ext.contextSlots === undefined && ext.memorySchema === undefined) {
				return {
					context:      undefined,
					workingState: undefined,
					async complete() { return undefined; },
				};
			}

			const ownerId = ext.ownerId ?? `skill:${skill.id}`;

			// Build context from declared slots. Skill with empty contextSlots
			// (declared but no slots) gets an empty context with notes:[].
			const req: AssembleRequest = {
				owner:   ownerId,
				task:    prepOpts.task,
				session: prepOpts.session,
				budget:  prepOpts.budget ?? {},
				slots:   ext.contextSlots ?? [],
			};
			// Hand the session through to providers (D5a: provider:active-session
			// reads it). Provider slots without registered providers still
			// resolve empty.
			const context = await assembler.assemble(req, {
				...(prepOpts.signal !== undefined  ? { signal:  prepOpts.signal  } : {}),
				...(prepOpts.session !== undefined ? { session: prepOpts.session } : {}),
			});

			// Fresh ledger per execution.
			const workingState = createWorkingStateLedger();

			return {
				context,
				workingState,
				async complete(success: boolean): Promise<DistillSummary | undefined> {
					if (!success) { return undefined; }
					if (ext.memorySchema === undefined) { return undefined; }
					const report = await distill.distill({
						workingState,
						schemas,
						...(prepOpts.signal !== undefined ? { signal: prepOpts.signal } : {}),
					});
					log.debug(
						{ skillId: skill.id, considered: report.considered, written: report.written, skipped: report.skipped.length },
						'substrate: distill complete',
					);
					return report;
				},
			};
		},

		async fireTrigger(trigger: BootstrapTrigger): Promise<TriggerReport> {
			return lifecycle.fireTrigger(trigger);
		},

		async classifyAssertion(input: ClassifyInput): Promise<ClassifyAssertionResult> {
			const classification = await classifier.classify(input);

			const persisted:  { owner: OwnerId; key: string }[]     = [];
			const dispatched: { owner: OwnerId; eventId: string }[] = [];

			// For each accepted assertion: resolve targetOwners (from the
			// payload if non-empty, otherwise via index lookup), then for
			// each target -> persist + emit feedback.
			for (const payload of classification.accepted) {
				const targets = resolveTargets(payload, assertionIndex);
				if (targets.length === 0) {
					log.debug({ subject: payload.subject, turnId: input.turnId }, 'classifyAssertion: no targets matched');
					continue;
				}

				for (const owner of targets) {
					try {
						const key = `${input.turnId}::${payload.subject}`;
						const ref = await memory.scope(owner, 'user-assertions').put(key, payload, {
							kind:       'constraint',
							source:     { kind: 'user-asserted', turnId: input.turnId },
							confidence: payload.confidence,
						});
						persisted.push({ owner, key });

						// Best-effort feedback dispatch (D8). The bus serializes;
						// failures are logged and swallowed by the bus itself.
						const event: FeedbackEvent = {
							id:          `assert-${input.turnId}-${owner}-${payload.subject}`,
							kind:        'user-correction',
							targetOwner: owner,
							memoryRefs:  [ref],
							payload,
							source:      'classifier:user-assertion',
							at:          Date.now(),
						};
						await feedbackBus.emit(event);
						dispatched.push({ owner, eventId: event.id });
					} catch (err) {
						log.warn({ owner, err: (err as Error).message }, 'classifyAssertion: persist/dispatch failed');
					}
				}
			}

			return { classification, persisted, dispatched };
		},
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find target owners for an assertion. The classifier (Layer 2 LLM)
 * may name `targetOwners` directly; otherwise the substrate consults
 * the D14 assertion-interest index.
 */
function resolveTargets(payload: UserAssertionPayload, index: AssertionIndex): readonly OwnerId[] {
	if (payload.targetOwners.length > 0) {
		return payload.targetOwners;
	}
	const matches = index.lookup(payload.subject);
	return matches.map(m => m.owner);
}
