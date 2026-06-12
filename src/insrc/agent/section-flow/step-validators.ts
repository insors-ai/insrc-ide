/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared discovery-step validators -- promoted from
 * `step-discovery-plan-expansion.ts` during Phase 4 batch 4.2 of
 * plans/section-flow-architecture-redesign.md (the plan-expansion
 * module was deleted along with the cycle loop it served).
 *
 * Two callers in the new dynamic loop:
 *
 *   - `step-sketch.ts`           -- validates each of the 3-5 sketch
 *                                    entries the cloud emits up-front.
 *   - `step-decide-next-step.ts` -- validates the single embedded
 *                                    `step` an `execute-step` action
 *                                    carries.
 *
 * Both call `coerceStep` with the same contract: a raw object plus
 * the index-stable parameter set (catalog ids, max gap-fact index,
 * earlier-step skill index for cross-step `dependsOn` resolution),
 * and receive either a typed `DiscoveryStep` or a short error string
 * the caller wraps with a location prefix.
 */

import type { DiscoveryStep, PlannedSkillCall } from '../content-gen/discovery-plan.js';

/**
 * Validate a `PlannedSkillCall.dependsOn` reference against the
 * current step's already-declared skill ids and an earlier-step
 * skill index. Supports two forms:
 *
 *   - intra-step (`"s1.a"`)              -- references a skill
 *                                            earlier in the SAME step.
 *   - cross-step (`"step-1.s1.a"`)       -- references a skill in an
 *                                            EARLIER step (the
 *                                            orchestrator forwards
 *                                            its raw output into the
 *                                            dependent step's
 *                                            priorOutputs).
 *
 * Returns `undefined` when valid, or a short error suffix that the
 * caller wraps with the location prefix.
 */
export function validateDependsOn(
	dependsOn:          string,
	currentSkillId:     string,
	seenSkillIdsInStep: ReadonlySet<string>,
	earlierStepSkills:  ReadonlyMap<string, ReadonlySet<string>>,
): string | undefined {
	if (dependsOn === currentSkillId) {
		return `"${dependsOn}" must not reference itself`;
	}
	// Intra-step match wins. Our intra-step convention uses ids like
	// `"s1.a"` which themselves contain dots, so we MUST try the
	// full-string match against the current step's seen ids before
	// any cross-step parsing.
	if (seenSkillIdsInStep.has(dependsOn)) {
		return undefined;
	}
	// Cross-step form: "<stepId>.<skillId>". Split on the FIRST dot.
	// skillId may itself contain dots (e.g. `"step-1.s1.a"` ->
	// stepId="step-1", skillId="s1.a").
	const dotIdx = dependsOn.indexOf('.');
	if (dotIdx === -1) {
		return `"${dependsOn}" must reference an earlier skill id in the same step OR use the "stepId.skillId" cross-step form`;
	}
	const stepId  = dependsOn.slice(0, dotIdx);
	const skillId = dependsOn.slice(dotIdx + 1);
	if (stepId.length === 0 || skillId.length === 0) {
		return `"${dependsOn}" is not a valid "stepId.skillId" reference`;
	}
	const earlierSkills = earlierStepSkills.get(stepId);
	if (earlierSkills === undefined) {
		return `"${dependsOn}" references step "${stepId}" which is not an earlier step in this plan (or is the current step)`;
	}
	if (!earlierSkills.has(skillId)) {
		return `"${dependsOn}" references skill "${skillId}" which is not in step "${stepId}"`;
	}
	return undefined;
}

/**
 * Validate + coerce one raw step object into a typed `DiscoveryStep`.
 * Permissive: returns either the coerced step OR a short error string
 * the caller logs and drops. Used by both the sketch and the
 * decide-next-step callers.
 *
 * Two shapes accepted (mutually exclusive at the same level):
 *
 *   LEAF -- legacy + new shape:
 *     - `skills` is a 1-6 entry array (skill ids in catalog, contexts
 *       non-empty, `dependsOn` valid).
 *     - `children` absent or empty.
 *     - Executes skills directly + runs one summarize-step pass.
 *
 *   BRANCH -- new in step-nesting:
 *     - `children` is a 2-6 entry array; each child recursively
 *       coerced (children may be leaves or further branches).
 *     - `skills` absent or empty.
 *     - No skill execution at this level. The branch's `intent` is
 *       compound + descriptive; sub-objectives live on the children.
 *
 * Constraints applied to BOTH:
 *
 *   - `id`, `intent` are non-empty strings; `intent` >= 5 chars.
 *   - `targetsCriteria` is a non-empty array of integers in
 *     `[0, maxFactIdx]`; duplicates silently deduped.
 *
 * The `idx` parameter is used for error-message location only
 * (`steps[<idx>].something`). Pass `0` when validating a single step
 * outside a list.
 */
const MAX_CHILDREN_PER_BRANCH = 6;

export function coerceStep(
	raw:                Record<string, unknown>,
	idx:                number,
	catalogIds:         ReadonlySet<string>,
	maxFactIdx:         number,
	earlierStepSkills:  ReadonlyMap<string, ReadonlySet<string>>,
): DiscoveryStep | string {
	const id = typeof raw['id'] === 'string' ? raw['id'].trim() : '';
	if (id.length === 0) {
		return `steps[${idx}].id missing or empty`;
	}
	const intent = typeof raw['intent'] === 'string' ? raw['intent'].trim() : '';
	if (intent.length < 5) {
		return `steps[${idx}].intent must be a concrete sentence (min 5 chars; got ${intent.length})`;
	}

	const skillsRaw   = raw['skills'];
	const childrenRaw = raw['children'];
	const hasSkills   = Array.isArray(skillsRaw)   && skillsRaw.length   > 0;
	const hasChildren = Array.isArray(childrenRaw) && childrenRaw.length > 0;

	if (hasSkills && hasChildren) {
		return `steps[${idx}] has BOTH \`skills\` and \`children\`; a step is either a leaf (skills) OR a branch (children)`;
	}
	if (!hasSkills && !hasChildren) {
		return `steps[${idx}].skills must be a non-empty array (leaf) OR steps[${idx}].children must be a non-empty array (branch)`;
	}

	// Shared: targetsCriteria
	const tcRaw = raw['targetsCriteria'];
	if (!Array.isArray(tcRaw) || tcRaw.length === 0) {
		return `steps[${idx}].targetsCriteria must be a non-empty array of fact indices`;
	}
	const targetsCriteria: number[] = [];
	const seenTC = new Set<number>();
	for (let k = 0; k < tcRaw.length; k++) {
		const v = tcRaw[k];
		if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > maxFactIdx) {
			return `steps[${idx}].targetsCriteria[${k}] = ${String(v)} is not a valid fact index (0..${maxFactIdx})`;
		}
		if (seenTC.has(v)) { continue; }
		seenTC.add(v);
		targetsCriteria.push(v);
	}

	if (hasChildren) {
		// BRANCH path
		const childrenArr = childrenRaw as unknown[];
		if (childrenArr.length < 2) {
			return `steps[${idx}].children must have at least 2 entries (single-child branch is pointless; emit a leaf instead)`;
		}
		if (childrenArr.length > MAX_CHILDREN_PER_BRANCH) {
			return `steps[${idx}].children has ${childrenArr.length} entries; cap is ${MAX_CHILDREN_PER_BRANCH}`;
		}
		const seenChildIds = new Set<string>();
		const children: DiscoveryStep[] = [];
		for (let j = 0; j < childrenArr.length; j++) {
			const childRaw = childrenArr[j];
			if (childRaw === null || typeof childRaw !== 'object' || Array.isArray(childRaw)) {
				return `steps[${idx}].children[${j}] is not an object`;
			}
			// Recurse. Earlier-step-skills passes through unchanged so
			// children can still depend on prior sibling-step skills
			// across the broader plan.
			const coercedChild = coerceStep(
				childRaw as Record<string, unknown>,
				j,
				catalogIds,
				maxFactIdx,
				earlierStepSkills,
			);
			if (typeof coercedChild === 'string') {
				return `steps[${idx}].children[${j}]: ${coercedChild}`;
			}
			if (seenChildIds.has(coercedChild.id)) {
				return `steps[${idx}].children[${j}].id "${coercedChild.id}" duplicates an earlier child in the same branch`;
			}
			seenChildIds.add(coercedChild.id);
			children.push(coercedChild);
		}
		return { id, intent, children, targetsCriteria };
	}

	// LEAF path
	const skillsArr = skillsRaw as unknown[];
	if (skillsArr.length > 6) {
		return `steps[${idx}].skills has ${skillsArr.length} entries; cap is 6`;
	}
	const seenSkillIds = new Set<string>();
	const skills: PlannedSkillCall[] = [];
	for (let j = 0; j < skillsArr.length; j++) {
		const skRaw = skillsArr[j];
		if (skRaw === null || typeof skRaw !== 'object' || Array.isArray(skRaw)) {
			return `steps[${idx}].skills[${j}] is not an object`;
		}
		const sk = skRaw as Record<string, unknown>;
		const skId = typeof sk['id'] === 'string' ? sk['id'].trim() : '';
		if (skId.length === 0) {
			return `steps[${idx}].skills[${j}].id missing or empty`;
		}
		if (seenSkillIds.has(skId)) {
			return `steps[${idx}].skills[${j}].id "${skId}" duplicates an earlier skill in the same step`;
		}
		seenSkillIds.add(skId);
		const skillId = typeof sk['skillId'] === 'string' ? sk['skillId'].trim() : '';
		if (skillId.length === 0) {
			return `steps[${idx}].skills[${j}].skillId missing or empty`;
		}
		if (!catalogIds.has(skillId)) {
			return `steps[${idx}].skills[${j}].skillId "${skillId}" is not in the SKILL CATALOG; pick a real catalog id`;
		}
		const context = typeof sk['context'] === 'string' ? sk['context'].trim() : '';
		if (context.length === 0) {
			return `steps[${idx}].skills[${j}].context missing or empty`;
		}
		const dependsOnRaw = sk['dependsOn'];
		const dependsOn = typeof dependsOnRaw === 'string' && dependsOnRaw.trim().length > 0
			? dependsOnRaw.trim()
			: undefined;
		if (dependsOn !== undefined) {
			const depCheck = validateDependsOn(dependsOn, skId, seenSkillIds, earlierStepSkills);
			if (depCheck !== undefined) {
				return `steps[${idx}].skills[${j}].dependsOn ${depCheck}`;
			}
		}
		skills.push({
			id: skId, skillId, context,
			...(dependsOn !== undefined ? { dependsOn } : {}),
		});
	}

	return { id, intent, skills, targetsCriteria };
}
