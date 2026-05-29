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
import { createContextAssembler, type ContextAssembler } from './context-assembler.js';
import { createDistillEngine, type DistillEngine, schemaKeyFor } from './distill.js';
import { createLifecycleRunner, type LifecycleRunner, type TriggerReport } from './lifecycle-runner.js';
import { createWorkingStateLedger } from './working-state.js';
import type {
	AssembleRequest,
	AssembledContext,
	BootstrapTrigger,
	ContextBudget,
	MemoryStore,
	NamespaceSpec,
	SubstrateSkillExtension,
	WorkingStateLedger,
} from './types.js';

const log = getLogger('substrate:runtime');

// ---------------------------------------------------------------------------

export interface SubstrateRuntime {
	readonly memory:     MemoryStore;
	readonly assembler:  ContextAssembler;
	readonly lifecycle:  LifecycleRunner;
	readonly distill:    DistillEngine;

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
	readonly memory: MemoryStore;
}

export function createSubstrateRuntime(opts: CreateSubstrateRuntimeOpts): SubstrateRuntime {
	const assembler = createContextAssembler({ memory: opts.memory });
	const lifecycle = createLifecycleRunner({ memory: opts.memory });
	const distill   = createDistillEngine({ memory: opts.memory });

	// (owner, namespace) -> NamespaceSpec, used by the distill engine.
	const schemas = new Map<string, NamespaceSpec>();
	// skillId -> [(owner, namespace)] declared by that skill (for deregister).
	const ownedSchemas = new Map<string, string[]>();

	return {
		memory: opts.memory,
		assembler,
		lifecycle,
		distill,

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

			ownedSchemas.set(skill.id, own);
			log.debug(
				{ skillId: skill.id, ownerId, namespaces: own.length, builders: ext.contextBuilders?.length ?? 0 },
				'substrate: skill registered',
			);

			return {
				skillId: skill.id,
				deregister(): void {
					for (const k of own) { schemas.delete(k); }
					ownedSchemas.delete(skill.id);
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
			const context = await assembler.assemble(req);

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
	};
}
