/**
 * Legacy `AnalysisTask` -> skill invocation shim
 * (code-analyzer-skills.md Phase 9.1).
 *
 * Maps each legacy `AnalysisKind` to a default skill invocation
 * (or composite of invocations) so pre-skill-cutover cached plans
 * + the legacy planner output can replay through the new
 * skills-routing runner without touching the legacy analyzer.
 *
 * Mapping (per the plan):
 *
 *     locate     -> code.entity.locate-by-name
 *     describe   -> code.entity.summary  OR  code.source.module.describe
 *                   (depends on scope shape: entityIds vs packages/paths)
 *     trace      -> code.entity.callers + code.entity.callees
 *                   (composite; direction filter scopes the pair)
 *     compare    -> code.compare.signature  OR  code.compare.impl-vs-doc
 *                   (depends on scope.targets: two entityIds vs entity+doc-path)
 *     free-form  -> code.meta.classify-question + per-result skills
 *                   (handled by the upstream pipeline, not this shim)
 *
 * Returns a typed `LegacyShimPlan` whose shape matches what the
 * skills-pipeline already emits for downstream synthesise. Kept for
 * one daemon release per the plan.
 *
 * `free-form` returns `null` to signal "don't shim this; route the
 * task through `runSkillsPipeline` directly" -- the upstream caller
 * (orchestrator's re-run path) handles that branch.
 */

import type {
	AnalysisKind,
	AnalysisScope,
	AnalysisTask,
} from './types.js';

export interface SkillInvocationStep {
	readonly skillId: string;
	readonly args:    Record<string, unknown>;
}

export interface LegacyShimPlan {
	/** One or more skills to run sequentially; results merge into a single AnalyzerResult. */
	readonly steps: readonly SkillInvocationStep[];
	/** Free-text reason explaining why this mapping was chosen (telemetry-friendly). */
	readonly rationale: string;
}

interface ShimContext {
	/**
	 * Active repo path. The shim threads this onto every skill's args
	 * since the skills' inputSchemas all require `repoPath`. Caller
	 * MUST pass the resolved repo or the shim returns null.
	 */
	readonly repoPath: string;
}

/**
 * Map a legacy task to a skill plan. Returns null when the task's
 * kind is `free-form` (caller should route via the meta-skills
 * pipeline) or when required scope fields are missing.
 */
export function analysisTaskToSkillPlan(
	task: AnalysisTask,
	ctx: ShimContext,
): LegacyShimPlan | null {
	if (ctx.repoPath.length === 0) return null;
	switch (task.kind) {
		case 'locate':    return shimLocate(task, ctx);
		case 'describe':  return shimDescribe(task, ctx);
		case 'trace':     return shimTrace(task, ctx);
		case 'compare':   return shimCompare(task, ctx);
		case 'free-form': return null;
	}
}

// ---------------------------------------------------------------------------
// Per-kind shims
// ---------------------------------------------------------------------------

/**
 * `locate` -> `code.entity.locate-by-name`. The legacy task's
 * `question` field carries the free-form name fragment; we treat
 * the LAST whitespace-separated identifier-shaped token as the
 * entity name. When no identifier is present we fall back to the
 * whole question string and let the skill's exact-match logic
 * decline cleanly.
 */
function shimLocate(task: AnalysisTask, ctx: ShimContext): LegacyShimPlan {
	const name = extractEntityName(task.question);
	const args: Record<string, unknown> = {
		name,
		repoPath: ctx.repoPath,
	};
	return {
		steps: [{ skillId: 'code.entity.locate-by-name', args }],
		rationale: `legacy 'locate' task -> code.entity.locate-by-name (name='${name}')`,
	};
}

/**
 * `describe` -> per scope shape:
 *   - scope.entityIds[0]    -> code.entity.summary
 *   - scope.paths[0] (file) -> code.source.file.describe
 *   - scope.packages[0]     -> code.source.module.describe
 *   - default               -> code.source.repo.describe
 */
function shimDescribe(task: AnalysisTask, ctx: ShimContext): LegacyShimPlan {
	const scope = task.scope;
	if (scope?.entityIds !== undefined && scope.entityIds.length > 0) {
		return {
			steps: [{ skillId: 'code.entity.summary', args: { entityId: scope.entityIds[0] } }],
			rationale: `legacy 'describe' task w/ entityIds -> code.entity.summary`,
		};
	}
	if (scope?.paths !== undefined && scope.paths.length > 0) {
		return {
			steps: [{
				skillId: 'code.source.file.describe',
				args:    { file: scope.paths[0], repoPath: ctx.repoPath },
			}],
			rationale: `legacy 'describe' task w/ paths -> code.source.file.describe`,
		};
	}
	if (scope?.packages !== undefined && scope.packages.length > 0) {
		return {
			steps: [{
				skillId: 'code.source.module.describe',
				args:    { modulePath: scope.packages[0], repoPath: ctx.repoPath },
			}],
			rationale: `legacy 'describe' task w/ packages -> code.source.module.describe`,
		};
	}
	return {
		steps: [{
			skillId: 'code.source.repo.describe',
			args:    { repoPath: ctx.repoPath },
		}],
		rationale: `legacy 'describe' task w/ no scope -> code.source.repo.describe`,
	};
}

/**
 * `trace` -> 1-hop callers / callees. Direction selects which arms
 * to invoke; default ('both') runs both. The skills-routing
 * pipeline merges the two PerSkillExecution results when both run.
 */
function shimTrace(task: AnalysisTask, ctx: ShimContext): LegacyShimPlan | null {
	const entityId = pickEntityId(task.scope);
	if (entityId === undefined) return null;
	const direction = task.scope?.direction ?? 'both';
	const steps: SkillInvocationStep[] = [];
	if (direction === 'callers' || direction === 'both') {
		steps.push({ skillId: 'code.entity.callers', args: { entityId } });
	}
	if (direction === 'callees' || direction === 'both') {
		steps.push({ skillId: 'code.entity.callees', args: { entityId } });
	}
	void ctx;
	return {
		steps,
		rationale: `legacy 'trace' task -> code.entity.callers/callees (direction=${direction})`,
	};
}

/**
 * `compare` -> per scope shape:
 *   - exactly two entityIds   -> code.compare.signature
 *   - one entityId + a doc-path token in question -> code.compare.impl-vs-doc
 *   - otherwise               -> null (no shim possible)
 *
 * The legacy task didn't carry a doc-path field; the impl-vs-doc
 * branch is detected heuristically -- present only when the
 * question text contains a path ending in .md or .markdown. Callers
 * that want richer compare flows should use the new skills directly.
 */
function shimCompare(task: AnalysisTask, ctx: ShimContext): LegacyShimPlan | null {
	const targets = task.scope?.targets;
	if (targets !== undefined && targets.length === 2) {
		return {
			steps: [{
				skillId: 'code.compare.signature',
				args: { aEntityId: targets[0], bEntityId: targets[1] },
			}],
			rationale: `legacy 'compare' task w/ two targets -> code.compare.signature`,
		};
	}
	const docPath = extractDocPath(task.question);
	const entityId = pickEntityId(task.scope);
	if (docPath !== undefined && entityId !== undefined) {
		return {
			steps: [{
				skillId: 'code.compare.impl-vs-doc',
				args: {
					className: extractEntityName(task.question),
					repoPath:  ctx.repoPath,
					docPath,
				},
			}],
			rationale: `legacy 'compare' task w/ doc-path -> code.compare.impl-vs-doc`,
		};
	}
	return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a likely entity name from a free-form question. Strategy:
 * pick the last identifier-shaped token in the string. Falls back
 * to the whole question when no identifier is present (the
 * downstream skill's exact-match path will decline cleanly).
 */
export function extractEntityName(question: string): string {
	const idents = question.match(/[A-Za-z_][\w]*/g);
	if (idents === null || idents.length === 0) return question;
	return idents[idents.length - 1]!;
}

/** Detect an absolute / relative path ending in `.md` / `.markdown`. */
export function extractDocPath(question: string): string | undefined {
	const m = /(?:^|\s)(\/?[\w./-]+\.(?:md|markdown))(?:\s|$)/.exec(question);
	return m === null ? undefined : m[1];
}

function pickEntityId(scope: AnalysisScope | undefined): string | undefined {
	if (scope?.entityIds !== undefined && scope.entityIds.length > 0) {
		return scope.entityIds[0];
	}
	if (scope?.targets !== undefined && scope.targets.length > 0) {
		return scope.targets[0];
	}
	return undefined;
}

/**
 * Static manifest of the kind -> skill defaults the shim emits.
 * Used by the renderer in the report's "How was this run?" footer
 * to explain the routing choice. Keeps the doc + the implementation
 * in lockstep -- if a kind's mapping changes, this entry MUST be
 * updated alongside.
 */
export const ANALYSIS_KIND_SKILL_DEFAULTS: Readonly<Record<AnalysisKind, readonly string[]>> = {
	locate:    ['code.entity.locate-by-name'],
	describe:  ['code.entity.summary', 'code.source.file.describe', 'code.source.module.describe', 'code.source.repo.describe'],
	trace:     ['code.entity.callers', 'code.entity.callees'],
	compare:   ['code.compare.signature', 'code.compare.impl-vs-doc'],
	'free-form': [], // empty means "route via meta-skills pipeline"
};
