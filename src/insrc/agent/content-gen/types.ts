/**
 * Public types for the multi-pass content generator
 * (plans/content-generator.md).
 *
 * Commit 1 ships the outline-pass types; the section-pass +
 * multi-pass-result types arrive in commit 2 alongside
 * `generateMultiPass()`.
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
