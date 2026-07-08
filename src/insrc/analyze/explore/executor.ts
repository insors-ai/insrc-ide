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

import { runCapabilityReuseCheck } from './capability-reuse-check.js';
import { runClassHierarchy } from './class-hierarchy.js';
import { runConceptResolve } from './concept-resolve.js';
import { runDocConstraintEnumerate } from './doc-constraint-enumerate.js';
import { runDocDecisionTrace } from './doc-decision-trace.js';
import { runDocMention } from './doc-mention.js';
import { runImportGraph } from './import-graph.js';
import { runModuleProfile } from './module-profile.js';
import { runSymbolLocate } from './symbol-locate.js';
import { runUsageExample } from './usage-example.js';
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
	'concept.resolve':          runConceptResolve,
	'module.profile':           runModuleProfile,
	'symbol.locate':            runSymbolLocate,
	'import.graph':             runImportGraph,
	'doc.mention':              runDocMention,
	'doc.decision.trace':       runDocDecisionTrace,
	'doc.constraint.enumerate': runDocConstraintEnumerate,
	'usage.example':            runUsageExample,
	'class.hierarchy':          runClassHierarchy,
	'capability.reuse-check':   runCapabilityReuseCheck,
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

	for (const originalExp of args.plan.explorations) {
		const runnerStart = Date.now();

		// Substitute placeholders like `$e1.hits[0].path` in params
		// against prior outputs BEFORE dispatch. Placeholders that
		// can't be resolved leave the param as `undefined` and the
		// runner surfaces its own "required" error -- the executor
		// treats that as a failed exploration + moves on.
		const exp: Exploration = substitutePlaceholders(originalExp, outputsById);

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
// Placeholder substitution
// ---------------------------------------------------------------------------

/**
 * Replace `$eN.<accessor>` placeholders in an exploration's params
 * with concrete values from prior explorations' outputs. The
 * decomposer emits placeholders as strings; the executor resolves
 * them here before dispatching to the runner.
 *
 * Accessor grammar:
 *   $e1.hits[0].path             -- pick index 0's `path` field
 *   $e1.hits[0..2].name          -- pick indices [0, 1, 2]'s `name` fields; returns an array
 *   $e2.profile.exports[0..2]    -- pick indices [0, 1, 2] from an array field
 *   $e1.hits                     -- return the whole `hits` array
 *
 * When a placeholder can't be resolved (missing dep, index out of
 * range, unknown field), the substituted value is `undefined` and
 * the runner surfaces its own "required" error. That gets caught +
 * turned into a `failed` output by the outer loop.
 *
 * The substitution is applied recursively to string values in
 * params. String values NOT starting with `$e` are passed through
 * verbatim.
 */
function substitutePlaceholders(
	exp:            Exploration,
	outputsById:    ReadonlyMap<string, ExplorationOutput>,
): Exploration {
	const params = substituteValue(exp.params, outputsById) as Record<string, unknown>;
	// If nothing changed, keep the original object so cache hashing
	// stays stable.
	if (params === exp.params) return exp;
	return { ...exp, params };
}

function substituteValue(
	value:       unknown,
	outputsById: ReadonlyMap<string, ExplorationOutput>,
): unknown {
	if (typeof value === 'string') {
		if (!value.startsWith('$e')) return value;
		return resolvePlaceholder(value, outputsById);
	}
	if (Array.isArray(value)) {
		let mutated = false;
		const out: unknown[] = [];
		for (const item of value) {
			const sub = substituteValue(item, outputsById);
			if (sub !== item) mutated = true;
			out.push(sub);
		}
		return mutated ? out : value;
	}
	if (typeof value === 'object' && value !== null) {
		const obj = value as Record<string, unknown>;
		let mutated = false;
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(obj)) {
			const sub = substituteValue(obj[k], outputsById);
			if (sub !== obj[k]) mutated = true;
			out[k] = sub;
		}
		return mutated ? out : value;
	}
	return value;
}

/**
 * Parse + resolve a single placeholder string against outputs.
 * Grammar (informal):
 *   $ID(.FIELD | [INT] | [INT..INT])+
 * where ID is a decomposer-emitted exploration id (`e1`, `e2`, ...)
 * and FIELD is a JS identifier. Ranges select multiple array
 * elements + return an array.
 *
 * Returns `undefined` on any resolution failure. The caller decides
 * how to render undefined (runner throws "required" -> failed
 * exploration; string param becomes undefined + runner surfaces
 * "required").
 */
function resolvePlaceholder(
	expr:        string,
	outputsById: ReadonlyMap<string, ExplorationOutput>,
): unknown {
	// Strip leading `$`. Split the head off before the first `.` or
	// `[` -- that's the exploration id.
	const raw = expr.startsWith('$') ? expr.slice(1) : expr;
	const idEnd = firstIndexOfAny(raw, ['.', '[']);
	const id = idEnd === -1 ? raw : raw.slice(0, idEnd);
	const rest = idEnd === -1 ? '' : raw.slice(idEnd);
	const dep = outputsById.get(id);
	if (dep === undefined) return undefined;

	// Tokenise `rest` into a sequence of accessor steps.
	const steps: AccessorStep[] = [];
	let i = 0;
	while (i < rest.length) {
		const ch = rest[i];
		if (ch === '.') {
			i += 1;
			const end = firstIndexOfAny(rest.slice(i), ['.', '[']);
			const field = end === -1 ? rest.slice(i) : rest.slice(i, i + end);
			if (field.length === 0) return undefined;
			steps.push({ kind: 'field', name: field });
			i = end === -1 ? rest.length : i + end;
		} else if (ch === '[') {
			const close = rest.indexOf(']', i);
			if (close === -1) return undefined;
			const inside = rest.slice(i + 1, close);
			if (inside.includes('..')) {
				const [aRaw, bRaw] = inside.split('..');
				const a = Number.parseInt(aRaw!, 10);
				const b = Number.parseInt(bRaw!, 10);
				if (Number.isNaN(a) || Number.isNaN(b) || b < a) return undefined;
				steps.push({ kind: 'range', from: a, to: b });
			} else {
				const idx = Number.parseInt(inside, 10);
				if (Number.isNaN(idx)) return undefined;
				steps.push({ kind: 'index', index: idx });
			}
			i = close + 1;
		} else {
			return undefined;
		}
	}

	let cur: unknown = dep;
	for (const step of steps) {
		if (cur === null || cur === undefined) return undefined;
		if (step.kind === 'field') {
			if (typeof cur !== 'object' || Array.isArray(cur)) return undefined;
			cur = (cur as Record<string, unknown>)[step.name];
		} else if (step.kind === 'index') {
			if (!Array.isArray(cur)) return undefined;
			cur = cur[step.index];
		} else {
			if (!Array.isArray(cur)) return undefined;
			const slice: unknown[] = [];
			for (let j = step.from; j <= step.to; j++) {
				if (j < 0 || j >= cur.length) continue;
				slice.push(cur[j]);
			}
			cur = slice;
		}
	}
	return cur;
}

interface FieldStep  { kind: 'field'; name: string }
interface IndexStep  { kind: 'index'; index: number }
interface RangeStep  { kind: 'range'; from: number; to: number }
type AccessorStep = FieldStep | IndexStep | RangeStep;

function firstIndexOfAny(s: string, needles: readonly string[]): number {
	let best = -1;
	for (const n of needles) {
		const idx = s.indexOf(n);
		if (idx === -1) continue;
		if (best === -1 || idx < best) best = idx;
	}
	return best;
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
