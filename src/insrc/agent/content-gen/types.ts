/**
 * Public types for the multi-pass content generator
 * (plans/content-generator.md).
 *
 * Commit 1 shipped the outline-pass types (`SectionPlan`,
 * `OutlineResult`); commit 2 adds the section + multi-pass result
 * shapes alongside `generateMultiPass()`. Commit 3 adds the
 * optional caching layer.
 */

/**
 * One outline entry. `id` is a stable slug used for caching + cross-
 * section refs; `title` is the rendered markdown heading; `intent`
 * is a short brief telling the section writer what to produce (NOT
 * the body itself).
 */
export interface SectionPlan {
	readonly id: string;
	readonly title: string;
	readonly intent: string;
	/**
	 * Soft budget for the section body's `maxTokens`. Pass-2's
	 * default budget (from `GenerateMultiPassInput.section
	 * .defaultBudgetTokens`) is used when this is unset.
	 */
	readonly budgetTokens?: number | undefined;
	/**
	 * Section ids whose bodies must be drafted before this one.
	 * Forces serial ordering for the listed sections; everyone else
	 * stays parallel-eligible. Default: independent.
	 */
	readonly dependsOn?: readonly string[] | undefined;
}

/**
 * Pass-1 output. `title` is the doc-level title; `sections` is
 * the ordered outline pass-2 will iterate.
 */
export interface OutlineResult {
	readonly title: string;
	readonly sections: readonly SectionPlan[];
}

/**
 * Pass-2 output for one section. `body` is the rendered markdown
 * (no leading `#`/`##` heading -- the stitcher prepends one).
 * `fallback` is true when the section degraded somehow:
 *
 *   - empty body                         -> note='empty response'
 *   - max_tokens cap mid-draft           -> note='budget exceeded; truncated'
 *   - provider error after the retry     -> note='provider error: ...'
 *   - aborted via signal                 -> note='aborted'
 *   - cache hit (commit 3 onward)        -> note='cache hit'
 *
 * The stitcher surfaces the `note` inline as italic text so the
 * reader can see WHY a section is partial without inspecting state.
 */
export interface SectionResult {
	readonly id: string;
	readonly body: string;
	readonly fallback: boolean;
	readonly note?: string | undefined;
}

/**
 * Caller-supplied pass-2 prompt builder. See `runSections` in
 * `section.ts` for the receiving signature.
 */
export interface SectionBuildArgs {
	readonly section: SectionPlan;
	readonly outline: OutlineResult;
	readonly prior: ReadonlyMap<string, SectionResult>;
}

/**
 * Caller input to `generateMultiPass`. The module is content-
 * agnostic -- callers supply the pass-1 + pass-2 prompts; we own
 * the orchestration, retry, schema enforcement, parallelism,
 * stitching, and streaming.
 */
export interface GenerateMultiPassInput {
	readonly outline: {
		readonly system: string;
		readonly user:   string;
		readonly maxSections?: number;
		readonly maxTokens?:   number;
	};
	readonly section: {
		build: (args: SectionBuildArgs) => { system: string; user: string };
		readonly defaultBudgetTokens?: number;
	};
	/** Fires once per section as it completes. Caller can render live progress. */
	readonly onSectionComplete?: ((r: SectionResult) => void) | undefined;
	/** Cancellation. Checked at section boundaries. */
	readonly signal?: AbortSignal | undefined;
	/**
	 * Run independent (no-deps) sections in parallel. Default true.
	 * Set false when the local provider is GPU-throughput-bound and
	 * N concurrent generations would swamp it.
	 */
	readonly parallel?: boolean;
	/**
	 * Optional section-level cache (commit 3). When provided, each
	 * section's body is keyed on outline.title + section.id +
	 * section.intent + dependsOn-bodies-hash + cacheContext. On
	 * hit the LLM call is skipped; on a successful generation the
	 * body is written back. Caller decides storage shape -- pass
	 * `makeDiskContentCache(...)` for a disk LRU, or implement
	 * the `ContentCache` interface in-memory / sqlite / wherever.
	 */
	readonly cache?: import('./cache.js').ContentCache | undefined;
	/**
	 * Optional cache-key salt -- typically the active repo's git
	 * HEAD SHA so a new commit invalidates every cached entry.
	 * Ignored when `cache` is unset.
	 */
	readonly cacheContext?: string | undefined;
}

export interface GenerateMultiPassResult {
	readonly outline: OutlineResult;
	readonly sections: readonly SectionResult[];
	/** Stitched final markdown. */
	readonly markdown: string;
	/**
	 * True when the outline degraded OR any section degraded. Caller
	 * decides whether to warn the user / silent / hard-fail.
	 */
	readonly degraded: boolean;
}
