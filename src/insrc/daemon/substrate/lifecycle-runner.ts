/**
 * Sync lifecycle runner -- P1.2 of plans/skills/substrate-implementation-status.md.
 *
 * Substrate-owned glue that calls owner-declared hooks at the right
 * times. P1 dispatches bootstrap synchronously (no async indexer
 * queue, no DAG scheduling); P3 adds the DAG + topo-sort + parallel-
 * within-level execution.
 *
 * What P1 does:
 *   - On `registerContextBuilders(specs)`, the runner remembers them.
 *   - On `fireTrigger(trigger)`, the runner finds every builder whose
 *     `triggers` array matches the trigger kind, executes them
 *     **sequentially in the order they were registered** -- no DAG
 *     yet. Cycles aren't possible because there's no topo-sort to
 *     fail; dependsOn is recorded but inert.
 *   - Each builder run is wrapped in a try/catch; failures are
 *     logged + counted but don't abort the trigger.
 *
 * What's intentionally NOT done in P1 (deferred to P3):
 *   - DAG-based scheduling, topo-sort, cycle detection.
 *   - Parallel-within-level execution.
 *   - Incremental dirty-input tracking.
 *   - Background scheduler / queue.
 */

import { getLogger } from '../../shared/logger.js';

import type {
	BootstrapTrigger,
	ContextBuilderSpec,
	MemoryStore,
} from './types.js';

const log = getLogger('substrate:lifecycle-runner');

// ---------------------------------------------------------------------------

export interface LifecycleRunner {
	/** Register a context builder. Idempotent on `id`. */
	registerContextBuilder(spec: ContextBuilderSpec): void;

	/** Fire a bootstrap trigger -- dispatches every interested builder synchronously. */
	fireTrigger(trigger: BootstrapTrigger, opts?: FireTriggerOpts): Promise<TriggerReport>;

	/** Introspection: list registered builder ids. */
	registeredBuilders(): readonly string[];
}

export interface FireTriggerOpts {
	readonly signal?: AbortSignal;
}

export interface TriggerReport {
	readonly trigger:     BootstrapTrigger;
	readonly dispatched:  number;
	readonly succeeded:   number;
	readonly failed:      number;
	readonly failures:    readonly { readonly builderId: string; readonly error: string }[];
	readonly entriesWritten: number;
}

export interface CreateLifecycleRunnerOpts {
	readonly memory: MemoryStore;
}

export function createLifecycleRunner(opts: CreateLifecycleRunnerOpts): LifecycleRunner {
	const builders = new Map<string, ContextBuilderSpec>();

	return {
		registerContextBuilder(spec: ContextBuilderSpec): void {
			if (builders.has(spec.id)) {
				log.debug({ id: spec.id }, 'lifecycle: builder re-registered (replaced)');
			}
			builders.set(spec.id, spec);
		},

		registeredBuilders(): readonly string[] {
			return Array.from(builders.keys());
		},

		async fireTrigger(trigger, fireOpts): Promise<TriggerReport> {
			const matching: ContextBuilderSpec[] = [];
			for (const spec of builders.values()) {
				if (spec.triggers.includes(trigger.kind)) { matching.push(spec); }
			}

			let succeeded = 0;
			let failed = 0;
			let entriesWritten = 0;
			const failures: { builderId: string; error: string }[] = [];
			const signal = fireOpts?.signal ?? new AbortController().signal;

			for (const spec of matching) {
				if (signal.aborted) { break; }
				try {
					const result = await spec.build(
						{
							trigger,
							triggerKind: trigger.kind,
							workspaceId: trigger.workspaceId,
						},
						{ memory: opts.memory, signal },
					);
					succeeded++;
					entriesWritten += result.entriesWritten;
					log.debug(
						{ builderId: spec.id, entriesWritten: result.entriesWritten },
						'lifecycle:context-builder',
					);
				} catch (err) {
					failed++;
					const msg = (err as Error).message ?? String(err);
					failures.push({ builderId: spec.id, error: msg });
					log.warn({ builderId: spec.id, err: msg }, 'lifecycle: builder failed');
				}
			}

			return {
				trigger,
				dispatched: matching.length,
				succeeded,
				failed,
				failures,
				entriesWritten,
			};
		},
	};
}
