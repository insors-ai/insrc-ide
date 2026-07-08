/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Exploration executor.
 *
 * plans/exploration-based-context-build.md Section 3. Takes an
 * `ExplorationPlan`, runs each exploration in order via the
 * type-registered runner, and returns an `ExecutedPlan` with typed
 * outputs.
 *
 * Deterministic explorations get cached via
 * db/exploration-cache.ts. Non-cacheable types (unsupported /
 * failed / freeform.probe) skip the cache. Cache misses run the
 * runner + write the output; cache hits skip the runner.
 *
 * `dependsOn` is enforced structurally: a later exploration reads
 * the outputs of its declared dependencies via
 * `ExplorationRunnerContext.readDep`. The executor guarantees
 * that dependencies are executed BEFORE their dependents by
 * respecting the plan's declared order (the decomposer's
 * responsibility to emit a valid topological ordering).
 */

import { getCachedExploration, putCachedExploration } from '../../db/exploration-cache.js';
import { getLogger } from '../../shared/logger.js';

import { runConceptResolve } from './concept-resolve.js';
import { runImportGraph } from './import-graph.js';
import { runModuleProfile } from './module-profile.js';
import { runSymbolLocate } from './symbol-locate.js';
import type {
	ExecutedExploration,
	ExecutedPlan,
	Exploration,
	ExplorationOutput,
	ExplorationPlan,
	ExplorationRunner,
	ExplorationRunnerContext,
	ExplorationType,
} from './types.js';

const log = getLogger('analyze:explore:executor');

// ---------------------------------------------------------------------------
// Runner registry
// ---------------------------------------------------------------------------

/** Which exploration types the V1 executor knows how to run. Types
 *  not in this map produce an `unsupported` output that the
 *  synthesizer renders as a diagnostic. */
const RUNNERS: Partial<Record<ExplorationType, ExplorationRunner>> = {
	'concept.resolve': runConceptResolve,
	'module.profile':  runModuleProfile,
	'symbol.locate':   runSymbolLocate,
	'import.graph':    runImportGraph,
};

/** Types that should skip the cache. `unsupported` + `failed`
 *  are never cached (would be sticky wrong); `freeform.probe`
 *  reads from a live tool loop so is never deterministic. */
const NON_CACHEABLE: ReadonlySet<ExplorationType> = new Set([
	'freeform.probe',
]);

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export interface ExecutePlanArgs {
	readonly runId:            string;
	readonly repoPath:         string;
	readonly closureRepos:     readonly string[];
	/** Milliseconds since epoch when the repo was last indexed.
	 *  Used as part of the cache key so a re-index invalidates
	 *  every cached exploration for the repo. */
	readonly repoLastIndexedAtMs: bigint;
	readonly plan:             ExplorationPlan;
}

export async function executePlan(args: ExecutePlanArgs): Promise<ExecutedPlan> {
	const start = Date.now();
	const results: ExecutedExploration[] = [];
	const outputsById = new Map<string, ExplorationOutput>();
	let totalCached = 0;

	for (const exp of args.plan.explorations) {
		const runnerStart = Date.now();
		let output: ExplorationOutput = {
			type: 'failed',
			requested: exp.type,
			errorCode: 'not-executed',
			message: 'exploration was not executed (executor bug)',
		};
		let cached = false;

		const runner = RUNNERS[exp.type];
		if (runner === undefined) {
			output = {
				type: 'unsupported',
				requested: exp.type,
				reason: `V1 executor does not implement exploration type '${exp.type}'`,
			};
		} else {
			const cacheable = !NON_CACHEABLE.has(exp.type);
			if (cacheable) {
				const hit = await getCachedExploration(
					args.repoPath, args.repoLastIndexedAtMs, exp,
				);
				if (hit !== null) {
					output = hit;
					cached = true;
					totalCached += 1;
				}
			}
			if (!cached) {
				try {
					const ctx: ExplorationRunnerContext = {
						runId:        args.runId,
						repoPath:     args.repoPath,
						closureRepos: args.closureRepos,
						readDep:      (id: string) => outputsById.get(id),
					};
					output = await runner(exp, ctx);
					if (cacheable) {
						await putCachedExploration(
							args.repoPath, args.repoLastIndexedAtMs, exp, output,
						);
					}
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					log.warn(
						{ runId: args.runId, explorationId: exp.id, type: exp.type, err: msg },
						'exploration failed',
					);
					output = {
						type:      'failed',
						requested: exp.type,
						errorCode: classifyExplorationError(err),
						message:   msg,
					};
				}
			}
		}

		const elapsedMs = Date.now() - runnerStart;
		outputsById.set(exp.id, output);
		results.push({ exploration: exp, output, cached, elapsedMs });
	}

	const totalMs = Date.now() - start;
	log.info(
		{
			runId:       args.runId,
			answerType:  args.plan.answerType,
			total:       results.length,
			cached:      totalCached,
			failed:      results.filter(r => r.output.type === 'failed').length,
			unsupported: results.filter(r => r.output.type === 'unsupported').length,
			totalMs,
		},
		'plan executed',
	);

	return {
		plan:        args.plan,
		results,
		totalMs,
		totalCached,
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function classifyExplorationError(err: unknown): string {
	if (!(err instanceof Error)) return 'unknown';
	const msg = err.message;
	if (msg.includes('ENOENT'))       return 'path-not-found';
	if (msg.includes('required'))     return 'invalid-params';
	if (msg.includes('cannot stat'))  return 'path-not-found';
	if (msg.includes('not registered')) return 'unregistered-repo';
	return 'runtime-error';
}

// ---------------------------------------------------------------------------
// Test hooks -- allows in-test overriding of the runner registry
// ---------------------------------------------------------------------------

export function _overrideRunnerForTest(
	type:   ExplorationType,
	runner: ExplorationRunner | undefined,
): void {
	if (runner === undefined) delete RUNNERS[type];
	else RUNNERS[type] = runner;
}

/** Return the current runner registry. Read-only for tests. */
export function _getRunnersForTest(): Readonly<Partial<Record<ExplorationType, ExplorationRunner>>> {
	return RUNNERS;
}

// Reference the type in the exported surface so it appears in JSDoc.
export type { ExplorationRunner as _ExplorationRunnerRef } from './types.js';
void 0 as unknown as Exploration;
