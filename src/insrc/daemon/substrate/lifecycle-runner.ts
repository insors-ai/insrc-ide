/**
 * Lifecycle runner -- P1.2 + P3 of plans/skills/substrate-implementation-status.md.
 *
 * Substrate-owned glue that calls owner-declared hooks at the right
 * times. P1 dispatched bootstrap synchronously in registration order
 * with `dependsOn` recorded but inert. P3 (this file) lands D15:
 * substrate-managed DAG, topo-sort, cycle detection, level-by-level
 * execution, and queue-serialized concurrent triggers.
 *
 * What P3 adds on top of P1:
 *   - validateDag(): builds the DAG from registered builders and reports
 *     cycles. Called on every registration so a bad spec fails fast --
 *     and exposed publicly for callers that want to assert pre-fire.
 *   - fireTrigger: matches builders against the trigger, topo-sorts the
 *     matched subset, executes level-by-level. Within one level builders
 *     run SERIALLY -- D15 documents parallel-within-level as the eventual
 *     design but CLAUDE.md's "no parallel LLM calls" rule disqualifies a
 *     blind Promise.all here; a per-builder `parallelSafe` flag is the
 *     planned opt-in (deferred).
 *   - Failure propagation: a failed builder's transitive dependents are
 *     SKIPPED (their inputs are missing; running them would just thrash).
 *     Skipped + failed builders are both reported.
 *   - Trigger queue: concurrent `fireTrigger` calls are serialized so two
 *     simultaneous triggers don't interleave reads/writes against the
 *     same memory namespaces. Each caller still gets a Promise that
 *     resolves when their trigger finishes.
 *
 * What's still NOT done in P3 (deferred to P6+):
 *   - Parallel-within-level execution (gated on the `parallelSafe` flag).
 *   - Incremental dirty-input tracking.
 *   - Background scheduler / periodic refresh.
 */

import { getLogger } from '../../shared/logger.js';

import type {
	BootstrapTrigger,
	ContextBuilderSpec,
	MemoryStore,
} from './types.js';
import { SubstrateError } from './types.js';

const log = getLogger('substrate:lifecycle-runner');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LifecycleRunner {
	/**
	 * Register a context builder. Re-registering the same `id` replaces
	 * the prior spec. Throws `DagCycleError` if the addition would
	 * introduce a cycle.
	 */
	registerContextBuilder(spec: ContextBuilderSpec): void;

	/**
	 * Fire a bootstrap trigger. Returns a Promise that resolves with
	 * the trigger's report after every matched builder has either
	 * completed, failed, or been skipped. Concurrent fireTrigger calls
	 * are serialized -- two triggers never interleave.
	 */
	fireTrigger(trigger: BootstrapTrigger, opts?: FireTriggerOpts): Promise<TriggerReport>;

	/**
	 * Wait until the trigger queue is empty. Useful for tests + clean
	 * shutdown.
	 */
	drain(): Promise<void>;

	/** Introspection: list registered builder ids. */
	registeredBuilders(): readonly string[];

	/**
	 * Validate the current registered DAG. Returns `{ ok: true }` when
	 * there's no cycle; `{ ok: false, cycles }` when one or more
	 * cycles are present. Each cycle is reported as a list of ids in
	 * the cycle order.
	 */
	validateDag(): DagValidation;
}

export type DagValidation =
	| { readonly ok: true }
	| { readonly ok: false; readonly cycles: readonly (readonly string[])[] };

export interface FireTriggerOpts {
	readonly signal?: AbortSignal;
}

export type BuilderRunStatus = 'succeeded' | 'failed' | 'skipped';

export interface BuilderRunResult {
	readonly builderId:      string;
	readonly status:         BuilderRunStatus;
	readonly entriesWritten: number;
	readonly error?:         string;
	/** The id whose failure caused this builder to be skipped, if any. */
	readonly skippedBecause?: string;
}

export interface TriggerReport {
	readonly trigger:        BootstrapTrigger;
	readonly dispatched:     number;
	readonly succeeded:      number;
	readonly failed:         number;
	readonly skipped:        number;
	readonly entriesWritten: number;
	readonly results:        readonly BuilderRunResult[];
	/**
	 * Builder-level failures only (back-compat with the P1 shape).
	 * `results` is the full per-builder picture.
	 */
	readonly failures:       readonly { readonly builderId: string; readonly error: string }[];
}

export interface CreateLifecycleRunnerOpts {
	readonly memory: MemoryStore;
}

/**
 * Thrown by registerContextBuilder when a registration would
 * introduce a DAG cycle. Reports the offending cycle(s) so callers
 * can fix the dependsOn declarations.
 */
export class DagCycleError extends SubstrateError {
	constructor(public readonly cycles: readonly (readonly string[])[]) {
		super(
			`context-builder DAG has cycle(s): ${cycles.map(c => c.join(' -> ')).join('; ')}`,
			'DAG_CYCLE',
		);
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLifecycleRunner(opts: CreateLifecycleRunnerOpts): LifecycleRunner {
	const builders = new Map<string, ContextBuilderSpec>();

	// Trigger queue: one outstanding tail Promise that successive fires
	// chain off. Each call adds its own awaiter to the chain and returns
	// it; the chain itself is replaced atomically. Tail is shared, so
	// the first awaiter to fire runs immediately.
	let tail: Promise<void> = Promise.resolve();

	function enqueue<T>(run: () => Promise<T>): Promise<T> {
		const next = tail.then(run, run);
		// Swallow rejection from the tail so a failed run doesn't poison
		// downstream enqueues. Each caller still gets the real error.
		tail = next.then(() => undefined, () => undefined);
		return next;
	}

	function runValidate(): DagValidation {
		const cycles = detectCycles(builders);
		return cycles.length === 0 ? { ok: true } : { ok: false, cycles };
	}

	return {
		registerContextBuilder(spec: ContextBuilderSpec): void {
			const prior = builders.get(spec.id);
			builders.set(spec.id, spec);
			const v = runValidate();
			if (!v.ok) {
				// Roll back the registration so the runner stays in a
				// consistent state.
				if (prior === undefined) {
					builders.delete(spec.id);
				} else {
					builders.set(spec.id, prior);
				}
				throw new DagCycleError(v.cycles);
			}
			log.debug({ id: spec.id, dependsOn: spec.dependsOn.length }, 'lifecycle:builder-registered');
		},

		registeredBuilders(): readonly string[] {
			return Array.from(builders.keys());
		},

		validateDag(): DagValidation {
			return runValidate();
		},

		async fireTrigger(trigger, fireOpts): Promise<TriggerReport> {
			return enqueue(() => runTrigger(builders, trigger, fireOpts, opts.memory));
		},

		async drain(): Promise<void> {
			await tail;
		},
	};
}

// ---------------------------------------------------------------------------
// Trigger execution
// ---------------------------------------------------------------------------

async function runTrigger(
	allBuilders: ReadonlyMap<string, ContextBuilderSpec>,
	trigger: BootstrapTrigger,
	fireOpts: FireTriggerOpts | undefined,
	memory: MemoryStore,
): Promise<TriggerReport> {
	// Select the matched subset.
	const matched = new Map<string, ContextBuilderSpec>();
	for (const spec of allBuilders.values()) {
		if (spec.triggers.includes(trigger.kind)) {
			matched.set(spec.id, spec);
		}
	}

	const signal = fireOpts?.signal ?? new AbortController().signal;

	// Topo-sort INSIDE the matched subset. Dependencies that point
	// outside the matched subset are treated as already satisfied --
	// they either don't apply to this trigger or weren't registered.
	const order = topoLevels(matched);

	const results: BuilderRunResult[] = [];
	const failedOrSkipped = new Set<string>();
	let succeeded = 0;
	let failed = 0;
	let skipped = 0;
	let entriesWritten = 0;

	for (const level of order) {
		// Serial within level. P3 deliberately doesn't run a level
		// concurrently -- CLAUDE.md's "no parallel LLM calls" rule
		// applies anywhere a builder might reach an LLM, and the
		// substrate has no way to know which builders are safe.
		for (const spec of level) {
			if (signal.aborted) {
				results.push({ builderId: spec.id, status: 'skipped', entriesWritten: 0, skippedBecause: 'aborted' });
				skipped++;
				continue;
			}

			// Skip if any dep failed or was skipped (in the matched subset).
			const blockedBy = firstUnmetDep(spec, matched, failedOrSkipped);
			if (blockedBy !== undefined) {
				results.push({
					builderId:      spec.id,
					status:         'skipped',
					entriesWritten: 0,
					skippedBecause: blockedBy,
				});
				failedOrSkipped.add(spec.id);
				skipped++;
				continue;
			}

			try {
				const result = await spec.build(
					{
						trigger,
						triggerKind: trigger.kind,
						workspaceId: trigger.workspaceId,
					},
					{ memory, signal },
				);
				results.push({
					builderId:      spec.id,
					status:         'succeeded',
					entriesWritten: result.entriesWritten,
				});
				succeeded++;
				entriesWritten += result.entriesWritten;
				log.debug({ builderId: spec.id, entriesWritten: result.entriesWritten }, 'lifecycle:context-builder');
			} catch (err) {
				const msg = (err as Error).message ?? String(err);
				results.push({ builderId: spec.id, status: 'failed', entriesWritten: 0, error: msg });
				failedOrSkipped.add(spec.id);
				failed++;
				log.warn({ builderId: spec.id, err: msg }, 'lifecycle:builder-failed');
			}
		}
	}

	const failures = results
		.filter((r): r is BuilderRunResult & { error: string } => r.status === 'failed' && r.error !== undefined)
		.map(r => ({ builderId: r.builderId, error: r.error }));

	return {
		trigger,
		dispatched: matched.size,
		succeeded,
		failed,
		skipped,
		entriesWritten,
		results,
		failures,
	};
}

function firstUnmetDep(
	spec: ContextBuilderSpec,
	matched: ReadonlyMap<string, ContextBuilderSpec>,
	failedOrSkipped: ReadonlySet<string>,
): string | undefined {
	for (const dep of spec.dependsOn) {
		// Deps outside the matched subset are treated as already
		// satisfied -- they may not be relevant to this trigger.
		if (!matched.has(dep)) { continue; }
		if (failedOrSkipped.has(dep)) { return dep; }
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// DAG primitives
// ---------------------------------------------------------------------------

/**
 * Kahn's algorithm: emit builders in dependency order, grouped by
 * level (a level is the set of builders whose dependencies are all
 * satisfied by previous levels). Cycles are reported separately via
 * `detectCycles` so callers can choose to ignore them; topoLevels
 * itself omits cycle members.
 */
function topoLevels(specs: ReadonlyMap<string, ContextBuilderSpec>): ContextBuilderSpec[][] {
	// inDegree counts only deps that exist within `specs`.
	const inDegree = new Map<string, number>();
	const dependents = new Map<string, string[]>();
	for (const id of specs.keys()) {
		inDegree.set(id, 0);
		dependents.set(id, []);
	}
	for (const spec of specs.values()) {
		for (const dep of spec.dependsOn) {
			if (!specs.has(dep)) { continue; }
			inDegree.set(spec.id, (inDegree.get(spec.id) ?? 0) + 1);
			const list = dependents.get(dep);
			if (list !== undefined) { list.push(spec.id); }
		}
	}

	const levels: ContextBuilderSpec[][] = [];
	let frontier: string[] = [];
	for (const [id, deg] of inDegree) {
		if (deg === 0) { frontier.push(id); }
	}

	while (frontier.length > 0) {
		// Stable order within a level: by id, so test assertions can
		// pin the sequence.
		frontier.sort();
		const level: ContextBuilderSpec[] = [];
		const next: string[] = [];
		for (const id of frontier) {
			const spec = specs.get(id);
			if (spec !== undefined) { level.push(spec); }
			for (const dep of dependents.get(id) ?? []) {
				const remaining = (inDegree.get(dep) ?? 0) - 1;
				inDegree.set(dep, remaining);
				if (remaining === 0) { next.push(dep); }
			}
		}
		levels.push(level);
		frontier = next;
	}

	return levels;
}

/**
 * Find every cycle in the dependency graph. Uses Tarjan's SCC
 * algorithm; any SCC with more than one node is a cycle, and a
 * single-node SCC is a cycle only if the node depends on itself.
 *
 * Returns an empty array when the DAG is cycle-free.
 */
function detectCycles(specs: ReadonlyMap<string, ContextBuilderSpec>): (readonly string[])[] {
	const adj = new Map<string, string[]>();
	for (const [id, spec] of specs) {
		// Direction: a -> b means a depends on b. For cycle detection,
		// direction doesn't matter, but using the dependsOn direction
		// keeps the reported cycle in "what depends on what" order.
		const out: string[] = [];
		for (const dep of spec.dependsOn) {
			if (specs.has(dep)) { out.push(dep); }
		}
		adj.set(id, out);
	}

	let index = 0;
	const indices = new Map<string, number>();
	const lowlinks = new Map<string, number>();
	const onStack = new Set<string>();
	const stack: string[] = [];
	const cycles: string[][] = [];

	function strongconnect(v: string): void {
		indices.set(v, index);
		lowlinks.set(v, index);
		index++;
		stack.push(v);
		onStack.add(v);

		for (const w of adj.get(v) ?? []) {
			if (!indices.has(w)) {
				strongconnect(w);
				lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
			} else if (onStack.has(w)) {
				lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
			}
		}

		if (lowlinks.get(v) === indices.get(v)) {
			const component: string[] = [];
			while (true) {
				const w = stack.pop()!;
				onStack.delete(w);
				component.push(w);
				if (w === v) { break; }
			}
			// SCC is a cycle if it has >1 nodes, OR a single-node SCC
			// whose node has a self-edge.
			if (component.length > 1) {
				cycles.push(component.reverse());
			} else if (adj.get(component[0]!)?.includes(component[0]!) === true) {
				cycles.push([component[0]!, component[0]!]);
			}
		}
	}

	for (const id of specs.keys()) {
		if (!indices.has(id)) { strongconnect(id); }
	}

	return cycles;
}
