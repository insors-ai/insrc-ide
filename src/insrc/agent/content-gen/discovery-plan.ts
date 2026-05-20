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

/** Output of executing one DiscoveryStep. */
export interface StepOutput {
	readonly stepId:               string;
	readonly status:               'ok' | 'partial' | 'failed';   // partial = some skills empty; failed = the step couldn't run
	readonly facts:                readonly string[];
	readonly citations:            readonly Citation[];
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
