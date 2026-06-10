/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Production leaf executor for `runSectionFlow`. Builds an
 * `ExecuteLeaf` closure that:
 *
 *   1. Resolves each `leaf.inputs[<arg>]` binding (4 source kinds:
 *      `node` | `literal` | `question` | `context`) against the
 *      prior-output map + caller-supplied context bag + user question.
 *   2. Invokes `runSkill(leaf.skill, resolvedInput, runnerDeps)`.
 *   3. Stringifies the typed `SkillResult.value` so the next leaf's
 *      `priorOutputs[<nodeId>]` is a string suitable for downstream
 *      `node`-binding resolution (re-parsed on read).
 *
 * The closure encapsulates `runnerDeps`, `userQuestion`, and the
 * `contextBag` so the section-flow stays oblivious to skill
 * execution details. Tests inject a `runSkillOverride` to short-
 * circuit the daemon's skill registry.
 */

import type { PlannedNode } from '../content-gen/plan-tree.js';
import { runSkill, type SkillRunnerDeps } from '../../daemon/skills/invoke.js';
import type { SkillResult } from '../../daemon/skills/types.js';
import type { LLMProvider } from '../../shared/types.js';
import { resolveSkillShape } from './shape-resolve.js';
import { getLogger } from '../../shared/logger.js';

// ---------------------------------------------------------------------------
// ExecuteLeaf contract (relocated here from the now-deleted
// `step-root-execution.ts` during the Phase epsilon cutover of
// plans/section-flow-fact-gap-loop.md; the new task-flow has no
// reviewable-roots concept, so the types live with their last
// surviving consumer.)
// ---------------------------------------------------------------------------

export interface LeafExecutionInput {
	readonly leaf: PlannedNode;
	/**
	 * Outputs of nodes the leaf's inputs reference. Keys match
	 * `leaf.inputs[<argName>].nodeId`. Values are whatever the prior
	 * leaf execution produced. The orchestrator resolves these per
	 * the visibility rules; this module doesn't.
	 */
	readonly priorOutputs: Readonly<Record<string, string>>;
}

/**
 * Result of one leaf invocation. `text` is the stringified SkillResult
 * value (the contract every existing caller already relies on).
 * `spillId` is the `<sessionId>:<timestamp>:<skillId>` key under which
 * the spill-writer persisted the full structured payload + the
 * `artifact_vec` Lance row. `undefined` when:
 *   - the skill didn't spill (e.g. test override that doesn't populate
 *     `result.spillRecord`)
 *   - the spill-writer failed (logged + swallowed by the runner)
 *   - the leaf threw before the runner returned
 *
 * Phase 1 of plans/section-flow-architecture-redesign.md: the
 * orchestrator threads this id through cycle-review so the reviewer-
 * emitted goal-aware summary can be written back to the artifact row
 * via `updateArtifactSummary`.
 */
export interface LeafExecutionResult {
	readonly text:    string;
	readonly spillId: string | undefined;
}

export type ExecuteLeaf = (input: LeafExecutionInput) => Promise<LeafExecutionResult>;

const log = getLogger('section-flow:leaf-executor');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LeafExecutorDeps {
	readonly runnerDeps:   SkillRunnerDeps;
	/** The user's original question; binds the `'question'` source AND fed to shape-resolve. */
	readonly userQuestion: string;
	/** Caller-supplied context bag; binds the `'context'` source AND fed to shape-resolve. Keys per plan-tree.ts. */
	readonly contextBag:   Readonly<Record<string, unknown>>;
	/**
	 * LLM provider for the 2-step executor's first stage (per-leaf shape
	 * resolution -- see `shape-resolve.ts`). When set, the executor calls
	 * the resolver to map the leaf's free-text objective + skill schema
	 * + prior outputs into a validated args dict, then invokes the skill.
	 * When undefined, the executor falls back to the legacy deterministic
	 * path that resolves `leaf.inputs` bindings directly -- intended only
	 * for unit tests using scripted runSkill overrides. Production wiring
	 * MUST pass a provider.
	 */
	readonly provider?:    LLMProvider | undefined;
	/**
	 * Test-only override of `runSkill`. When provided, the executor
	 * routes every leaf invocation through this function instead of
	 * the daemon's skill registry. Production callers leave unset.
	 */
	readonly runSkillOverride?: ((skillId: string, input: unknown) => Promise<SkillResult<unknown>>) | undefined;
}

export function buildSkillExecutor(deps: LeafExecutorDeps): ExecuteLeaf {
	return async (call: LeafExecutionInput): Promise<LeafExecutionResult> => {
		const leaf = call.leaf;
		if (leaf.kind !== 'leaf') {
			log.warn({ leafId: leaf.id, kind: leaf.kind }, 'buildSkillExecutor invoked for non-leaf node; returning empty');
			return { text: '', spillId: undefined };
		}
		if (leaf.skill === undefined || leaf.skill.length === 0) {
			log.warn({ leafId: leaf.id }, 'leaf has no skill id; returning empty');
			return { text: '', spillId: undefined };
		}

		// Stage 1: resolve the skill's args.
		//   - When a provider is wired, defer to the LLM-driven shape
		//     resolver (the 2-step executor's first stage -- restored
		//     from the deleted execute-step.ts pattern). The planner's
		//     `leaf.inputs` bindings are not load-bearing here; the
		//     resolver works from skill schema + prior outputs + the
		//     leaf objective directly.
		//   - When no provider is supplied (legacy unit-test path),
		//     fall back to deterministic binding resolution against
		//     `leaf.inputs`. Production wiring MUST pass a provider.
		let resolvedInput: Record<string, unknown>;
		if (deps.provider !== undefined) {
			const shape = await resolveSkillShape({
				skillId:      leaf.skill,
				objective:    leaf.objective ?? leaf.title ?? leaf.id,
				priorOutputs: call.priorOutputs,
				userQuestion: deps.userQuestion,
				contextBag:   deps.contextBag,
				provider:     deps.provider,
			});
			if (shape.kind === 'failed') {
				log.warn({ leafId: leaf.id, skill: leaf.skill, reason: shape.reason, retried: shape.retried }, 'shape-resolve failed; returning empty leaf output');
				return { text: '', spillId: undefined };
			}
			resolvedInput = shape.args;
		} else {
			resolvedInput = resolveLeafInputs(leaf, call.priorOutputs, deps.userQuestion, deps.contextBag);
		}

		// Stage 2: invoke the skill.
		let result: SkillResult<unknown>;
		try {
			if (deps.runSkillOverride !== undefined) {
				result = await deps.runSkillOverride(leaf.skill, resolvedInput);
			} else {
				result = await runSkill(leaf.skill, resolvedInput, deps.runnerDeps);
			}
		} catch (err) {
			log.warn({ leafId: leaf.id, skill: leaf.skill, err: (err as Error).message }, 'runSkill threw; returning empty leaf output');
			return { text: '', spillId: undefined };
		}

		// Stringify the SkillResult.value so downstream node-bindings
		// can JSON.parse + path-resolve. Skill values are typed
		// (object/array/scalar); we encode uniformly as JSON.
		return {
			text:    stringifySkillValue(result.value),
			spillId: result.spillRecord?.spillId,
		};
	};
}

// ---------------------------------------------------------------------------
// Input resolution
// ---------------------------------------------------------------------------

/**
 * Walk `leaf.inputs` and produce the concrete args object the skill
 * expects. Each binding is resolved per its `source` kind:
 *
 *   - `'literal'`  : the bound value verbatim.
 *   - `'question'` : regex-match against the user question; first
 *                    capturing group wins, else whole match. Empty
 *                    match leaves the arg `undefined`.
 *   - `'context'`  : lookup against the caller-supplied context bag.
 *   - `'node'`     : look up `priorOutputs[nodeId]`, try-parse as JSON,
 *                    apply the dotted path. Path `'$'` returns the
 *                    whole value. Missing/unresolvable path leaves the
 *                    arg `undefined`.
 */
export function resolveLeafInputs(
	leaf: PlannedNode,
	priorOutputs: Readonly<Record<string, string>>,
	userQuestion: string,
	contextBag: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [argName, binding] of Object.entries(leaf.inputs)) {
		const value = resolveOne(binding, priorOutputs, userQuestion, contextBag);
		if (value !== undefined) {
			out[argName] = value;
		}
	}
	return out;
}

function resolveOne(
	binding: PlannedNode['inputs'][string],
	priorOutputs: Readonly<Record<string, string>>,
	userQuestion: string,
	contextBag: Readonly<Record<string, unknown>>,
): unknown {
	switch (binding.source) {
		case 'literal':
			return binding.value;

		case 'question': {
			let re: RegExp;
			try {
				re = new RegExp(binding.extract);
			} catch {
				log.warn({ extract: binding.extract }, 'question binding has malformed regex; skipping');
				return undefined;
			}
			const m = userQuestion.match(re);
			if (m === null) {
				return undefined;
			}
			return m[1] ?? m[0];
		}

		case 'context': {
			const v = contextBag[binding.key];
			return v;
		}

		case 'node': {
			const raw = priorOutputs[binding.nodeId];
			if (raw === undefined) {
				return undefined;
			}
			const parsed = tryParseJson(raw);
			return applyPath(parsed, binding.path);
		}
	}
}

// ---------------------------------------------------------------------------
// Path application + JSON helpers
// ---------------------------------------------------------------------------

function tryParseJson(raw: string): unknown {
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return raw;
	}
	// JSON-shaped prefixes only; treat plain strings/markdown as
	// scalar.
	const first = trimmed.charAt(0);
	if (first !== '{' && first !== '[' && first !== '"') {
		// Numbers / booleans / nulls would parse but section-flow
		// outputs are aggregate markdown strings -- the common case.
		return raw;
	}
	try {
		return JSON.parse(trimmed);
	} catch {
		return raw;
	}
}

/**
 * Apply a dotted path to a value. Supports:
 *   - `'$'` or `''` -> whole value
 *   - dotted property names: `'foo.bar.baz'`
 *   - array index: `'foo[0].bar'` or `'foo.0.bar'`
 *   - wildcard array map: `'foo[*].name'` -> array of `foo[i].name`
 *
 * Returns `undefined` when any step misses.
 */
export function applyPath(value: unknown, path: string): unknown {
	const cleaned = path.trim();
	if (cleaned === '' || cleaned === '$') {
		return value;
	}
	// Strip a leading $. if present.
	const noRoot = cleaned.startsWith('$.') ? cleaned.slice(2) : (cleaned.startsWith('$') ? cleaned.slice(1) : cleaned);

	// Split into tokens. We accept dot syntax and bracket syntax.
	// Convert `foo[0].bar` -> `foo.0.bar` and `foo[*].bar` -> `foo.*.bar`.
	const normalised = noRoot.replace(/\[(\d+|\*)\]/g, '.$1');
	const tokens = normalised.split('.').filter(t => t.length > 0);

	let cur: unknown = value;
	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i]!;
		if (cur === undefined || cur === null) {
			return undefined;
		}
		if (tok === '*') {
			if (!Array.isArray(cur)) {
				return undefined;
			}
			// Apply the rest of the tokens to each element.
			const rest = tokens.slice(i + 1).join('.');
			return cur.map(el => rest.length === 0 ? el : applyPath(el, rest));
		}
		if (/^\d+$/.test(tok)) {
			const idx = parseInt(tok, 10);
			if (!Array.isArray(cur) || idx < 0 || idx >= cur.length) {
				return undefined;
			}
			cur = cur[idx];
			continue;
		}
		if (typeof cur !== 'object' || Array.isArray(cur)) {
			return undefined;
		}
		cur = (cur as Record<string, unknown>)[tok];
	}
	return cur;
}

// ---------------------------------------------------------------------------
// SkillResult.value -> string
// ---------------------------------------------------------------------------

export function stringifySkillValue(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	if (value === undefined || value === null) {
		return '';
	}
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _resolveOneForTest      = resolveOne;
export const _tryParseJsonForTest    = tryParseJson;
