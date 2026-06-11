/**
 * Tier-split memory layout -- Phase 2 of
 * plans/section-flow-architecture-redesign.md.
 *
 * Today's `MemoryShapeBundle` (system / summary / recent / semantic /
 * code) ships byte-for-byte to every prompt regardless of tier.
 * Cloud has the headroom for it; local doesn't, so the heavier
 * sections get truncated or dropped silently and the local LLM
 * works against a partial picture.
 *
 * The redesign emits TWO views from one shaping call:
 *
 *   - `LocalMemoryView`  -- what the local LLM (Phase 3
 *                            build-context, shape-resolver) needs:
 *                            system + a focused currentTodo + the
 *                            artifact TOC + the last two steps'
 *                            summaries. No semantic / code block --
 *                            too expensive for context, low signal
 *                            for the local model's job (decide which
 *                            artifacts to fetch, then resolve args).
 *
 *   - `CloudMemoryView`  -- what the cloud LLM (cycle-review,
 *                            section-synth, planner) needs: today's
 *                            full bundle PLUS the artifact TOC and
 *                            the current retained fact-gap ledger.
 *                            Cloud has the window to read all of it.
 *
 * Both views share the system block and the TOC; only the heavier
 * sections differ. The builder takes a single `MemoryShapeBundle`
 * (the output of `shapeMemory`) plus the auxiliary blocks (TOC text,
 * fact-ledger text, recent-step summaries) and returns both views in
 * one pass. No extra LLM call.
 *
 * Phase 3 wires the local view into the new build-context sub-step.
 * Phase 4 onward switches the cloud-tier prompts to read from
 * `cloud` instead of the bare `MemoryShapeBundle`.
 */

import type { MemoryShapeBundle } from './shaper.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Memory shape for the LOCAL tier.
 *
 *  - `system`       Fixed evergreen context: project / subject / file
 *                   kinds. Cheap, stable across iterations. Carried
 *                   from `MemoryShapeBundle.system` verbatim.
 *  - `currentTodo`  One-paragraph statement of the active TODO's
 *                   objective + current cycle state. The caller
 *                   provides this -- it's not from the shaping
 *                   bundle (the shaping bundle's `summary` covers
 *                   the whole investigation; we want the active
 *                   slice).
 *  - `toc`          Rendered artifact TOC (`agent/artifacts/toc-builder.ts`
 *                   output). Bounded by the composer; defaults to
 *                   ~2K tokens for the local tier.
 *  - `recentSteps`  Last 2 steps' goal-aware summaries inline (from
 *                   `artifact_vec.summary` via the orchestrator's
 *                   `resolveStepSummaries`). Empty when no steps
 *                   have run yet.
 */
export interface LocalMemoryView {
	readonly system:      string;
	readonly currentTodo: string;
	readonly toc:         string;
	readonly recentSteps: string;
}

/**
 * Memory shape for the CLOUD tier. Superset of today's
 * `MemoryShapeBundle` plus the artifact TOC and a rendering of the
 * current fact-gap ledger. Fields carry over byte-for-byte from
 * `MemoryShapeBundle` so existing cloud-tier prompts can switch to
 * reading from `bundle.cloud` without touching their input shapes.
 */
export interface CloudMemoryView {
	readonly system:     string;
	readonly summary:    string;
	readonly recent:     string;
	readonly semantic:   string;
	readonly code:       string;
	readonly toc:        string;
	readonly factLedger: string;
}

/**
 * Both views, emitted by `buildMemoryBundle`. The orchestrator
 * threads this through stages that need either view; each prompt
 * reads only what it needs.
 */
export interface MemoryBundle {
	readonly local: LocalMemoryView;
	readonly cloud: CloudMemoryView;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Inputs for `buildMemoryBundle`.
 *
 *  - `shape`        : output of `shapeMemory` (system / summary /
 *                     recent / semantic / code).
 *  - `toc`          : rendered TOC text (`renderToc` output). Both
 *                     views share this verbatim; the composer is
 *                     responsible for any tier-specific budget
 *                     trimming before we get here.
 *  - `factLedger`   : rendered fact-gap ledger. Cloud only -- the
 *                     local LLM doesn't need the gap analysis to
 *                     do its job (decide artifacts + resolve args).
 *  - `currentTodo`  : caller-rendered one-paragraph snapshot of the
 *                     active TODO (objective + cycle + status).
 *                     LocalView only.
 *  - `recentSteps`  : caller-rendered last-2-steps summary block.
 *                     LocalView only. Empty when no steps have run.
 */
export interface BuildMemoryBundleInput {
	readonly shape:       MemoryShapeBundle;
	readonly toc:         string;
	readonly factLedger:  string;
	readonly currentTodo: string;
	readonly recentSteps: string;
}

/**
 * Deterministic, no-LLM builder. The expensive shaping has already
 * happened in `shapeMemory`; this just packs the result + auxiliary
 * blocks into the two views.
 */
export function buildMemoryBundle(input: BuildMemoryBundleInput): MemoryBundle {
	return {
		local: {
			system:      input.shape.system,
			currentTodo: input.currentTodo,
			toc:         input.toc,
			recentSteps: input.recentSteps,
		},
		cloud: {
			system:     input.shape.system,
			summary:    input.shape.summary,
			recent:     input.shape.recent,
			semantic:   input.shape.semantic,
			code:       input.shape.code,
			toc:        input.toc,
			factLedger: input.factLedger,
		},
	};
}

// ---------------------------------------------------------------------------
// Compatibility adapter
// ---------------------------------------------------------------------------

/**
 * Adapter for callers still consuming the legacy `MemoryShapeBundle`
 * shape. Strips the new tier-only fields (`toc`, `factLedger`) and
 * returns the 5-field bundle. Phase 2 ships the adapter so the
 * orchestrator can keep feeding existing prompts unchanged while
 * Phase 3+ migrates them to read directly from `bundle.cloud`.
 */
export function cloudViewToLegacyBundle(view: CloudMemoryView): MemoryShapeBundle {
	return {
		system:   view.system,
		summary:  view.summary,
		recent:   view.recent,
		semantic: view.semantic,
		code:     view.code,
	};
}

/**
 * Lift a legacy `MemoryShapeBundle` into a `CloudMemoryView` with
 * empty `toc` / `factLedger`. Used by callers that don't yet have
 * an artifact store wired (tests, legacy script paths).
 */
export function legacyBundleToCloudView(bundle: MemoryShapeBundle): CloudMemoryView {
	return {
		system:     bundle.system,
		summary:    bundle.summary,
		recent:     bundle.recent,
		semantic:   bundle.semantic,
		code:       bundle.code,
		toc:        '',
		factLedger: '',
	};
}

// ---------------------------------------------------------------------------
// Local-view token budget enforcement (Phase 2 follow-up)
// ---------------------------------------------------------------------------

/**
 * Default soft token budget for the local-tier view (Phase 2 plan
 * line: "Local view bounded under a configurable token budget
 * (default 6k); truncation kicks in oldest-first on `recentSteps`,
 * not on `system` or `currentTodo`").
 *
 * The estimate uses the same `chars/3` ratio the rest of the
 * codebase relies on for token counts.
 */
export const DEFAULT_LOCAL_VIEW_TOKEN_BUDGET = 6_000;

const CHARS_PER_TOKEN = 3;
function estimateTokens(s: string): number {
	return Math.ceil(s.length / CHARS_PER_TOKEN);
}

/**
 * Apply the local-view token budget. `system` and `currentTodo` are
 * PROTECTED -- they're tiny, stable, and load-bearing for build-
 * context's framing. `toc` is built externally with its own budget
 * and isn't truncated here. `recentSteps` is the only field that
 * grows unboundedly, so when the total exceeds the budget we drop
 * OLDEST lines (top of `recentSteps`) until the view fits.
 *
 * Returns the SAME view object when no truncation is needed
 * (reference equality short-circuit). Otherwise returns a new view
 * with a truncated `recentSteps`.
 *
 * Phase 2 of plans/section-flow-architecture-redesign.md.
 */
export function enforceLocalViewBudget(
	view:   LocalMemoryView,
	budget: number = DEFAULT_LOCAL_VIEW_TOKEN_BUDGET,
): LocalMemoryView {
	const total = estimateTokens(view.system)
		+ estimateTokens(view.currentTodo)
		+ estimateTokens(view.toc)
		+ estimateTokens(view.recentSteps);
	if (total <= budget) {
		return view;
	}
	const protectedTokens = estimateTokens(view.system)
		+ estimateTokens(view.currentTodo)
		+ estimateTokens(view.toc);
	const recentBudget = Math.max(0, budget - protectedTokens);
	const recentBudgetChars = recentBudget * CHARS_PER_TOKEN;
	if (recentBudgetChars === 0) {
		return { ...view, recentSteps: '' };
	}

	// recentSteps is a `\n`-separated list of lines, OLDEST FIRST
	// (the orchestrator appends new steps to the end). Drop from
	// the TOP until the joined block fits.
	const lines = view.recentSteps.split('\n');
	let kept = lines.slice();
	while (kept.length > 0 && kept.join('\n').length > recentBudgetChars) {
		kept.shift();
	}
	return { ...view, recentSteps: kept.join('\n') };
}
