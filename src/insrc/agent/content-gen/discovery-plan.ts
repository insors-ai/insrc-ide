/**
 * Discovery-plan loop types -- Phase α of
 * plans/code-analyzer-discovery-plan-loop.md.
 *
 * The discovery-plan loop replaces the gather-evidence + patch loop
 * with a cloud-driven, multi-cycle discovery process. Each section
 * goes through:
 *
 *   - Stage 2  expandDiscoveryPlan(section, cycleMemory)
 *              -> DiscoveryPlan { steps: DiscoveryStep[] }
 *   - Stage 3  executeStep(step) per step
 *              -> StepOutput { facts, citations: Citation[] }
 *   - Stage 5  reviewCycle(stepOutputs, cycleMemory)
 *              -> CycleReviewResponse { keep, new_steps, scratchpad? }
 *   - loop until new_steps empty or cycle == 3
 *   - Stage 6  writeSection(retainedLedger) -- existing writer
 *   - Stage 7  reviewProse(prose) -- prose-only check
 *
 * Phase α lands the TYPES only -- no execution, no callers wired.
 * Subsequent phases implement the cloud + local entrypoints and
 * thread these through the orchestrator behind a feature flag.
 */

// ---------------------------------------------------------------------------
// Cloud-driven plan: skill calls + steps
// ---------------------------------------------------------------------------

/**
 * One skill invocation the cloud is directing the local LLM to make.
 * The cloud names the skill + provides semantic context; the
 * orchestrator translates context to args at execute time using the
 * skill's schema (which it pulls from the registry, not the cloud).
 *
 * `dependsOn` lets a cloud-emitted step express skill chaining without
 * forcing the array index to be the execution order: e.g. a step can
 * have [{ id:'s1.a', skillId:'locate-by-name' }, { id:'s1.b',
 * skillId:'summary', dependsOn:'s1.a' }] -- local picks the entityId
 * from s1.a's result and feeds it as the arg context for s1.b.
 */
export interface PlannedSkillCall {
	readonly id:           string;     // stable id within the step (e.g. "s1.a")
	readonly skillId:      string;     // catalog skill id (e.g. "code.entity.summary")
	readonly context:      string;     // plain-language context for arg resolution
	readonly dependsOn?:   string | undefined;
}

/**
 * One discovery step -- a multi-skill investigation with one purpose.
 * The cloud emits an ordered list of these per cycle; the orchestrator
 * iterates and calls the local LLM once per step.
 *
 * `targetsCriteria` is the index list (into the section's
 * `reviewCriteria` array) the step claims to address. Used mechanically
 * by `computeCoverage` to keep `CycleMemory.criteriaCoverage` in sync
 * without an LLM judgment.
 */
export interface DiscoveryStep {
	readonly id:               string;       // "step-1", "step-2", ...
	readonly intent:           string;       // one-sentence purpose
	readonly skills:           readonly PlannedSkillCall[];
	readonly targetsCriteria:  readonly number[];   // indices into section.reviewCriteria
}

export interface DiscoveryPlan {
	readonly steps:  readonly DiscoveryStep[];
	readonly cycle:  1 | 2 | 3;
}

// ---------------------------------------------------------------------------
// Step output: structured facts + structured citations
// ---------------------------------------------------------------------------

/**
 * Structured citation. Replaces the string-keyed citations the legacy
 * gather-evidence path emitted (e.g. "path:foo.ts#L1-L20"). The writer
 * composes the inline markdown link at render time from these fields,
 * so the same Citation can be styled differently across consumers
 * (writer, reviewer, picker).
 */
export interface Citation {
	readonly path:       string;
	readonly startLine?: number | undefined;
	readonly endLine?:   number | undefined;
	readonly entityId?:  string | undefined;   // 32-char hex from locate-by-name/file.describe/etc.
	readonly label?:     string | undefined;   // class/function name; writer composes `label`
	readonly repoPath?:  string | undefined;   // workspace root, for multi-repo runs
}

/**
 * Output of executing one DiscoveryStep.
 *
 * Phase 1 batch 3b of plans/section-flow-architecture-redesign.md
 * replaced the pre-summarised `facts: string[]` + `citations: Citation[]`
 * fields (sourced from the deleted `summarizeResult` cloud call) with
 * two fields that come straight from the leaf executor:
 *
 *   - `rawOutputs`  : stringified `SkillResult.value` per skill call.
 *                     Cycle-review v2 renders these (truncated) so the
 *                     reviewer reasons over what the skill literally
 *                     produced, not a paraphrase.
 *   - `artifactIds` : the spill-writer's `<sessionId>:<ts>:<skillId>`
 *                     id per skill call. Downstream consumers
 *                     (section-synth, ledger-to-findings) read the
 *                     reviewer-emitted goal-aware summary from
 *                     `artifact_vec.summary` via `getArtifactById`
 *                     against these ids.
 *
 * Calls that returned empty are present in `rawOutputs` with value
 * `''`. Calls that didn't spill (typically the same set, plus any
 * runner-side spill-writer failures) are absent from `artifactIds`.
 *
 * `Citation` stays exported -- the working-memory writer reads
 * citations directly from `WorkingMemoryEntry`, which derives them
 * from the artifact summaries downstream.
 */
export interface StepOutput {
	readonly stepId:               string;
	readonly status:               'ok' | 'partial' | 'failed';   // partial = some skills empty; failed = the step couldn't run
	readonly rawOutputs:           Readonly<Record<string, string>>;
	readonly artifactIds:          Readonly<Record<string, string>>;
	readonly extraSkillsCalled?:   readonly string[] | undefined;  // skills the local LLM added beyond the plan
	readonly durationMs:           number;
}

// ---------------------------------------------------------------------------
// Cycle review (cloud's per-cycle verdict)
// ---------------------------------------------------------------------------

export interface CycleReviewResponse {
	/** stepIds of THIS cycle's outputs the cloud judged on-topic + useful.
	 *  Outputs whose stepId is in `keep` are promoted to the retained
	 *  ledger; others are dropped. */
	readonly keep:        readonly string[];
	/** Steps the cloud wants run next cycle. Empty array = terminate. */
	readonly new_steps:   readonly DiscoveryStep[];
	/** Cloud's free-form note carried into the next cycle's CycleMemory.
	 *  ~300 chars; for qualitative judgments the mechanical
	 *  coverage map can't capture. */
	readonly scratchpad?: string | undefined;
}

// ---------------------------------------------------------------------------
// Cycle memory (orchestrator-held, summarised into the cloud's prompt)
// ---------------------------------------------------------------------------

/**
 * Per-section state carried across cycles. Lives on the orchestrator;
 * never persisted, never round-trips the kept ledger raw to the cloud
 * (per the architectural decision: kept items are not relayed back).
 *
 * Renders into prompt text via `summarizeCycleMemory` (defined in
 * `agent/tasks/code-analyzer/cycle-memory.ts`).
 *
 * Three pieces:
 *   - priorAsks       -- what the cloud asked for in each prior cycle
 *                         (steps it emitted in new_steps). Lets the
 *                         cloud reason about gaps it already
 *                         identified.
 *   - criteriaCoverage -- mechanical map criterion → status →
 *                          contributing stepIds. Built by
 *                          `computeCoverage` from the retained ledger
 *                          + each step's `targetsCriteria`.
 *   - scratchpad      -- cloud-emitted free-form note from the last
 *                         review (or empty initially). Overwritten
 *                         each cycle.
 */
export interface CycleMemory {
	readonly priorAsks: readonly {
		readonly cycle:  1 | 2 | 3;
		readonly steps:  readonly { readonly id: string; readonly intent: string }[];
	}[];
	readonly criteriaCoverage: readonly {
		readonly criterion:             string;
		readonly status:                'covered' | 'partial' | 'open';
		readonly contributingStepIds:   readonly string[];
	}[];
	readonly scratchpad: string;
}

/** Initial empty CycleMemory for cycle 1 (before any cloud asks). */
export function emptyCycleMemory(reviewCriteria: readonly string[]): CycleMemory {
	return {
		priorAsks: [],
		criteriaCoverage: reviewCriteria.map(criterion => ({
			criterion,
			status:               'open' as const,
			contributingStepIds:  [],
		})),
		scratchpad: '',
	};
}

// ---------------------------------------------------------------------------
// JSON Schemas (used as `responseFormat.schema` on cloud LLM calls)
// ---------------------------------------------------------------------------

/**
 * Shared sub-schema for a DiscoveryStep. Used inside both
 * DISCOVERY_PLAN_SCHEMA and CYCLE_REVIEW_RESPONSE_SCHEMA (which carries
 * `new_steps: DiscoveryStep[]`).
 *
 * Caps:
 *   - 1-6 skills per step (matches the gather budget; >6 would suggest
 *     the step should be split)
 *   - 5-200 char intent (one-sentence purpose)
 *   - 32-char id (kebab-case typical: "step-1", "step-2", ...)
 *   - targetsCriteria is unique-int-array of indices into the section's
 *     reviewCriteria list (validated downstream against the section)
 */
const DISCOVERY_STEP_SCHEMA: Record<string, unknown> = {
	type: 'object',
	required: ['id', 'intent', 'skills', 'targetsCriteria'],
	additionalProperties: false,
	properties: {
		id:     { type: 'string', minLength: 1, maxLength: 32 },
		intent: { type: 'string', minLength: 5, maxLength: 200 },
		skills: {
			type: 'array',
			minItems: 1,
			maxItems: 6,
			items: {
				type: 'object',
				required: ['id', 'skillId', 'context'],
				additionalProperties: false,
				properties: {
					id:        { type: 'string', minLength: 1, maxLength: 16 },
					skillId:   { type: 'string', minLength: 5, maxLength: 80 },
					context:   { type: 'string', minLength: 1, maxLength: 200 },
					dependsOn: { type: 'string', maxLength: 16 },
				},
			},
		},
		targetsCriteria: {
			type: 'array',
			items: { type: 'integer', minimum: 0 },
			uniqueItems: true,
			maxItems: 12,
		},
	},
};

/**
 * Schema for the cloud's Stage 2 emission (expandDiscoveryPlan).
 * Cycle 1 -> 2-10 steps; cycle 2+ steps come back via the cycle
 * review's new_steps and aren't bounded here. The cycle field is
 * carried for symmetry with the type even though the orchestrator
 * supplies it; cloud just echoes back.
 */
export const DISCOVERY_PLAN_SCHEMA: Record<string, unknown> = {
	type: 'object',
	required: ['steps', 'cycle'],
	additionalProperties: false,
	properties: {
		steps: {
			type: 'array',
			minItems: 1,
			maxItems: 12,
			items: DISCOVERY_STEP_SCHEMA,
		},
		cycle: { type: 'integer', minimum: 1, maximum: 3 },
	},
};

/**
 * Schema for the cloud's Stage 5 emission (reviewCycle).
 *   - keep: ids of step outputs from THIS cycle to promote to ledger
 *   - new_steps: more discovery for next cycle (empty array = done)
 *   - scratchpad: optional free-form note carried forward
 */
export const CYCLE_REVIEW_RESPONSE_SCHEMA: Record<string, unknown> = {
	type: 'object',
	required: ['keep', 'new_steps'],
	additionalProperties: false,
	properties: {
		keep: {
			type: 'array',
			items: { type: 'string', minLength: 1, maxLength: 32 },
			uniqueItems: true,
		},
		new_steps: {
			type: 'array',
			maxItems: 12,
			items: DISCOVERY_STEP_SCHEMA,
		},
		scratchpad: { type: 'string', maxLength: 500 },
	},
};

/** Schema for the cloud's Stage 7 emission (reviewProse). Lighter shape:
 *  verdict + optional notes. No ledger sent; cloud is judging the
 *  rendered markdown directly. */
export const PROSE_REVIEW_RESPONSE_SCHEMA: Record<string, unknown> = {
	type: 'object',
	required: ['verdict'],
	additionalProperties: false,
	properties: {
		verdict: { type: 'string', enum: ['accept', 'redraft'] },
		notes: {
			type: 'array',
			maxItems: 6,
			items: { type: 'string', minLength: 1, maxLength: 200 },
		},
	},
};
