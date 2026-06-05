/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Incremental working-memory update (planner-section-task-separation
 * P1.d / Q1.1 hot path).
 *
 * Per-layer update strategy from Q1.1's resolution. Each layer has a
 * different cost profile and stability profile; treat them differently
 * instead of re-running the full shape pipeline on every TODO transition.
 *
 *   system    Evergreen. Reuse the prior bundle's `system` slot.
 *             Recomputed only on cold rebuild (or when prior is empty).
 *
 *   summary   Append-mostly. Take the prior summary + the newly-
 *             completed entry's detail+findings and LLM-rewrite into
 *             an updated 1-2 paragraph TL;DR.
 *
 *   recent    Tail-only. Deterministic slice of the last 3 entries'
 *             findings; light LLM polish to convert the raw findings
 *             into a coherent bullet list relevant to the NEW
 *             objective.
 *
 *   semantic  Prompt-keyed -- the most expensive layer to keep fresh
 *             because relevance is conditioned on the objective. v1
 *             without the bullet cache (P1.e): cheap incremental
 *             LLM update -- prior semantic + new entry + new
 *             objective -> updated semantic. Quality degrades as
 *             iterations compound without a cold rebuild; the 50%
 *             growth trigger below catches this.
 *
 *   code      Append-only. Extract code blocks from the new entry's
 *             detail; concatenate with prior `code` and cap-truncate
 *             if the result exceeds the per-layer budget.
 *
 * Cold-rebuild trigger (`shouldColdRebuild`): when accumulated memory
 * tokens exceed `1.5x` the count captured at the last cold rebuild,
 * or when the orchestrator's review pass flags an inconsistency
 * between layers, or when the user requested a rebuild explicitly,
 * the caller should switch to `shapeMemory()` instead of the
 * incremental path.
 *
 * Cost target (typical, no growth-triggered rebuild):
 *   ~10-20s per TODO transition (4 cheap LLM calls + deterministic
 *   slice + concat). Compares to ~30s-5min for a full re-shape.
 */

import type { TokenBudget } from '../context/budget.js';
import { countTokens } from '../context/budget.js';
import type { LLMMessage, LLMProvider } from '../../shared/types.js';
import type { MemoryShapeBundle } from './shaper.js';
import type { WorkingMemoryEntry } from './types.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('working-memory-updater');

// ---------------------------------------------------------------------------
// Per-layer constants
// ---------------------------------------------------------------------------

/**
 * How many of the most-recent entries' findings get distilled into the
 * `recent` layer. Q1.1 calls for "the last 2-3 sections/turns"; 3 is
 * the upper end and also matches the section-review cap (Q5) so all
 * three latest TODOs survive a single review window.
 */
const RECENT_ENTRY_WINDOW = 3;

/**
 * Memory growth multiplier that triggers a cold rebuild. Q1.1 says
 * "memory growth > 50% since last cold rebuild"; 1.5x of the baseline
 * is exactly that rule.
 */
const COLD_REBUILD_GROWTH_MULTIPLIER = 1.5;

/**
 * Max output tokens for each incremental-update LLM call. Each call
 * regenerates a single layer; layer caps are small (1000-8000 tokens
 * each) so 2k is plenty even at the largest cap.
 */
const MAX_UPDATE_TOKENS = 2048;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IncrementalUpdateInput {
	/** The bundle produced for the previous TODO (or by the initial cold rebuild). */
	readonly priorBundle: MemoryShapeBundle;
	/**
	 * All entries completed BEFORE the new entry. Ordered oldest first.
	 * Used by the `recent` layer's deterministic slice (the last
	 * RECENT_ENTRY_WINDOW - 1 entries, plus the newly-completed one,
	 * become the window).
	 */
	readonly priorEntries: readonly WorkingMemoryEntry[];
	/** The just-completed entry being folded into the bundle. */
	readonly newEntry: WorkingMemoryEntry;
	/**
	 * Objective of the NEXT TODO (the one the caller will plan against).
	 * Drives the `semantic` and `recent` polish so they're scoped to the
	 * upcoming work.
	 */
	readonly nextObjective: string;
	readonly budget: TokenBudget;
}

export interface IncrementalUpdateOpts {
	/**
	 * Skip the LLM polish on the `recent` layer and emit a deterministic
	 * bullet list instead. Marginal quality loss; useful when the polish
	 * call is the bottleneck on small reports.
	 */
	readonly skipRecentPolish?: boolean;
	/**
	 * If set, the `semantic` layer is filled from the bullet cache
	 * (P1.e) instead of the LLM-based incremental call. The updater
	 * embeds `nextObjective` via `provider.embed()` and queries the
	 * cache for top-K relevant bullets. If `provider.embed()` returns
	 * an empty vector (cloud provider; embeddings are local-only --
	 * see CLAUDE.md), the updater falls back to the LLM path silently.
	 *
	 * `topK` defaults to 10 (matching the per-TODO bullet ceiling).
	 */
	readonly bulletCache?: {
		readonly cache: BulletCache;
		readonly topK?: number | undefined;
	} | undefined;
}

/**
 * Minimal cache interface the updater needs. The Lance-backed
 * implementation lives in `db/lance/working-memory-bullets.ts`; tests
 * can inject a hand-rolled mock without spinning up LanceDB.
 */
export interface BulletCache {
	query(queryEmbedding: number[], topK: number): Promise<readonly BulletCacheHit[]>;
}

export interface BulletCacheHit {
	readonly todoId:    string;
	readonly todoIndex: number;
	readonly bullet:    string;
	/** ANN distance (lower = more relevant). Caller may use for tie-breaking. */
	readonly score:     number;
}

export type LayerName = 'system' | 'summary' | 'recent' | 'semantic' | 'code';

export interface IncrementalUpdateTrace {
	readonly layersUpdated: readonly LayerName[];
	readonly llmCallsCount: number;
	readonly durationMs:    number;
}

export interface IncrementalUpdateResult {
	readonly bundle: MemoryShapeBundle;
	readonly trace:  IncrementalUpdateTrace;
}

export interface ColdRebuildInput {
	/**
	 * Accumulated memory tokens at the last cold rebuild. The caller
	 * tracks this; the working-memory store currently does not. Pass 0
	 * when this is the first TODO of a report run.
	 */
	readonly lastColdRebuildMemoryTokens: number;
	readonly currentMemoryTokens: number;
	readonly userRequestedRebuild?: boolean;
	/**
	 * Set when the section or report review step (Q5 / Q7) detects
	 * incoherence between the recent and summary layers -- a signal that
	 * incremental drift has corrupted the bundle.
	 */
	readonly orchestratorFlaggedInconsistency?: boolean;
}

// ---------------------------------------------------------------------------
// Cold-rebuild trigger
// ---------------------------------------------------------------------------

/**
 * Decide whether to abandon the incremental update path and re-run the
 * full `shapeMemory()` pipeline. Cold rebuilds are expensive (especially
 * for Hadoop-sized memories) but they reset the drift that builds up
 * across many incremental updates.
 *
 * Returns true on ANY of:
 *   - user-requested rebuild
 *   - orchestrator flagged a layer inconsistency
 *   - first TODO of the run (lastColdRebuildMemoryTokens === 0)
 *   - memory has grown >= COLD_REBUILD_GROWTH_MULTIPLIER since the
 *     last cold rebuild
 */
export function shouldColdRebuild(input: ColdRebuildInput): boolean {
	if (input.userRequestedRebuild === true) {
		return true;
	}
	if (input.orchestratorFlaggedInconsistency === true) {
		return true;
	}
	if (input.lastColdRebuildMemoryTokens <= 0) {
		return true;
	}
	const ratio = input.currentMemoryTokens / input.lastColdRebuildMemoryTokens;
	return ratio >= COLD_REBUILD_GROWTH_MULTIPLIER;
}

// ---------------------------------------------------------------------------
// Per-layer updaters
// ---------------------------------------------------------------------------

const COMMON_SYSTEM_HEADER = [
	'You are the LOCAL CONTEXT-ASSEMBLY model performing a SINGLE-LAYER',
	'incremental update on an existing working-memory bundle. Emit a JSON',
	'object with EXACTLY ONE string field. No prose, no markdown fences.',
].join('\n');

const SUMMARY_ROLE = [
	COMMON_SYSTEM_HEADER,
	'',
	'You update the `summary` layer. Read the prior summary + the newly-',
	'completed TODO\'s detail+findings. Emit an updated 1-2 paragraph',
	'TL;DR that captures the essentials of the accumulated memory so far.',
	'Do NOT cite section titles. Do NOT duplicate the recent or semantic',
	'layers (those are filled separately).',
].join('\n');

const RECENT_ROLE = [
	COMMON_SYSTEM_HEADER,
	'',
	'You update the `recent` layer. Read the deterministic slice of the',
	'last 2-3 entries\' findings + the NEXT TODO\'s objective. Emit a',
	'bullet list of the salient findings from those entries, biased toward',
	'items the next TODO will need. Cite section/finding sources by name.',
].join('\n');

const SEMANTIC_ROLE = [
	COMMON_SYSTEM_HEADER,
	'',
	'You update the `semantic` layer. Read the prior semantic content +',
	'the newly-completed entry\'s findings + the NEXT TODO\'s objective.',
	'Emit a bullet list of items from across the accumulated memory that',
	'bear specifically on the NEXT objective. Cite section/finding sources.',
	'Keep prior items only if they are still relevant; add items from the',
	'new entry if they bear on the next objective.',
].join('\n');

function buildLayerSchema(layerName: LayerName, budgetTokens: number): string {
	return [
		'## OUTPUT SHAPE (emit EXACTLY this object)',
		'',
		'{',
		`  "${layerName}": <string, max ${budgetTokens} tokens>`,
		'}',
		'',
		'## RULES',
		'  - Token cap is HARD. ~3 chars ~= 1 token.',
		'  - Empty string "" is fine when there is genuinely nothing to add.',
		'  - Do not invent content.',
	].join('\n');
}

interface SingleLayerCallInput {
	readonly system: string;
	readonly user:   string;
	readonly layerName: LayerName;
	readonly budgetTokens: number;
}

async function callSingleLayerUpdate(
	provider: LLMProvider,
	call: SingleLayerCallInput,
): Promise<string> {
	const messages: LLMMessage[] = [
		{ role: 'system', content: call.system },
		{ role: 'user',   content: call.user   },
	];
	const response = await provider.complete(messages, {
		maxTokens:       MAX_UPDATE_TOKENS,
		temperature:     0,
		responseFormat:  'json',
		disableThinking: true,
	});
	const parsed = tryParseSingleField(response.text, call.layerName);
	if (parsed === undefined) {
		log.warn({ layer: call.layerName, preview: response.text.slice(0, 200) }, 'incremental layer update: parse failure -- returning empty');
		return '';
	}
	return enforceBudget(parsed, call.budgetTokens);
}

function tryParseSingleField(raw: string, key: LayerName): string | undefined {
	let text = raw.trim();
	if (text.startsWith('```')) {
		text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
	}
	try {
		const obj = JSON.parse(text) as Record<string, unknown>;
		if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
			return undefined;
		}
		const value = obj[key];
		return typeof value === 'string' ? value : undefined;
	} catch {
		return undefined;
	}
}

function enforceBudget(value: string, budgetTokens: number): string {
	const maxChars = budgetTokens * 3;
	return value.length <= maxChars ? value : value.slice(0, maxChars);
}

// ---------------------------------------------------------------------------
// Layer update implementations
// ---------------------------------------------------------------------------

function updateSystem(prior: string, _newEntry: WorkingMemoryEntry): string {
	// Evergreen layer: reuse the prior value verbatim. Only a cold
	// rebuild changes `system` (or its initial computation when prior
	// is empty -- but bootstrap is the caller's responsibility, not
	// the updater's).
	return prior;
}

async function updateSummary(
	provider: LLMProvider,
	prior: string,
	newEntry: WorkingMemoryEntry,
	budgetTokens: number,
): Promise<string> {
	const system = SUMMARY_ROLE;
	const findingsText = renderFindings(newEntry);
	const user = [
		'## PRIOR SUMMARY',
		prior.length > 0 ? prior : '(empty)',
		'',
		'## NEW ENTRY',
		`Objective: ${newEntry.objective}`,
		'',
		'Findings:',
		findingsText,
		'',
		'Section detail:',
		newEntry.detail,
		'',
		buildLayerSchema('summary', budgetTokens),
		'',
		'## TASK',
		'Emit the JSON object with the updated `summary` field now.',
	].join('\n');
	return callSingleLayerUpdate(provider, { system, user, layerName: 'summary', budgetTokens });
}

async function updateRecent(
	provider: LLMProvider,
	window: readonly WorkingMemoryEntry[],
	nextObjective: string,
	budgetTokens: number,
	skipPolish: boolean,
): Promise<{ value: string; llmCalled: boolean }> {
	const deterministicBullets = window.map(e => {
		const findings = e.findings.perRoot
			.map(r => `  - ${r.rootId}: ${truncate(r.content, 200)}`)
			.join('\n');
		return `- ${e.todoId} (objective: ${truncate(e.objective, 120)}):\n${findings}`;
	}).join('\n');

	if (skipPolish) {
		return { value: enforceBudget(deterministicBullets, budgetTokens), llmCalled: false };
	}

	const system = RECENT_ROLE;
	const user = [
		'## NEXT OBJECTIVE',
		nextObjective,
		'',
		`## LAST ${window.length} ENTRY FINDINGS (oldest first)`,
		deterministicBullets,
		'',
		buildLayerSchema('recent', budgetTokens),
		'',
		'## TASK',
		'Emit the JSON object with the polished `recent` bullet list now.',
	].join('\n');
	const polished = await callSingleLayerUpdate(provider, { system, user, layerName: 'recent', budgetTokens });
	return { value: polished, llmCalled: true };
}

async function updateSemanticViaLLM(
	provider: LLMProvider,
	prior: string,
	newEntry: WorkingMemoryEntry,
	nextObjective: string,
	budgetTokens: number,
): Promise<string> {
	const system = SEMANTIC_ROLE;
	const findingsText = renderFindings(newEntry);
	const user = [
		'## NEXT OBJECTIVE',
		nextObjective,
		'',
		'## PRIOR SEMANTIC LAYER',
		prior.length > 0 ? prior : '(empty)',
		'',
		'## NEW ENTRY',
		`Objective: ${newEntry.objective}`,
		'',
		'Findings:',
		findingsText,
		'',
		buildLayerSchema('semantic', budgetTokens),
		'',
		'## TASK',
		'Emit the JSON object with the updated `semantic` bullet list now.',
	].join('\n');
	return callSingleLayerUpdate(provider, { system, user, layerName: 'semantic', budgetTokens });
}

/**
 * Resolve the `semantic` layer: prefer the bullet cache (cheap ANN
 * lookup) when available, fall back to the LLM-based incremental
 * update otherwise. Returns the resolved string + whether an LLM call
 * was used (for the trace's llmCallsCount accounting).
 */
async function updateSemantic(
	provider: LLMProvider,
	prior: string,
	newEntry: WorkingMemoryEntry,
	nextObjective: string,
	budgetTokens: number,
	cacheOpts: IncrementalUpdateOpts['bulletCache'],
): Promise<{ value: string; usedCache: boolean; llmCalled: boolean }> {
	if (cacheOpts !== undefined) {
		const queryVec = await provider.embed(nextObjective);
		if (queryVec.length > 0) {
			const topK = Math.max(1, cacheOpts.topK ?? 10);
			const hits = await cacheOpts.cache.query(queryVec, topK);
			const formatted = formatBulletsAsSemantic(hits, budgetTokens);
			return { value: formatted, usedCache: true, llmCalled: false };
		}
		log.warn('updateSemantic: provider.embed returned empty vector; falling back to LLM-based semantic update');
	}
	const llmValue = await updateSemanticViaLLM(provider, prior, newEntry, nextObjective, budgetTokens);
	return { value: llmValue, usedCache: false, llmCalled: true };
}

/**
 * Render a deterministic semantic layer from the bullet-cache hits.
 * Dedupes by exact bullet text (the model occasionally emits
 * near-duplicates across TODOs), preserves order by ANN distance,
 * tags each bullet with its source TODO so the downstream planner can
 * see when the same fact appeared in multiple investigations.
 */
function formatBulletsAsSemantic(
	hits: readonly BulletCacheHit[],
	budgetTokens: number,
): string {
	if (hits.length === 0) {
		return '';
	}
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const hit of hits) {
		const key = hit.bullet.trim();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		lines.push(`- [${hit.todoId}] ${key}`);
	}
	return enforceBudget(lines.join('\n'), budgetTokens);
}

function updateCode(prior: string, newEntry: WorkingMemoryEntry, budgetTokens: number): string {
	const newBlocks = extractCodeBlocks(newEntry.detail);
	if (newBlocks.length === 0) {
		return prior;
	}
	const additions = newBlocks.join('\n\n');
	const merged = prior.length > 0 ? `${prior}\n\n${additions}` : additions;
	return enforceBudget(merged, budgetTokens);
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Fold the newly-completed entry into the prior bundle without
 * re-shaping from scratch. Caller should check `shouldColdRebuild()`
 * before invoking this; on a true result, run `shapeMemory()` instead.
 *
 * Three LLM calls fire by default (summary, recent polish, semantic);
 * `skipRecentPolish` drops the second. system + code are deterministic.
 */
export async function incrementalUpdate(
	provider: LLMProvider,
	input: IncrementalUpdateInput,
	opts: IncrementalUpdateOpts = {},
): Promise<IncrementalUpdateResult> {
	const started = Date.now();
	const layersUpdated: LayerName[] = [];
	let llmCallsCount = 0;

	const systemValue = updateSystem(input.priorBundle.system, input.newEntry);
	// `system` is unchanged structurally; don't mark "updated".

	const summaryValue = await updateSummary(
		provider,
		input.priorBundle.summary,
		input.newEntry,
		input.budget.summary,
	);
	llmCallsCount += 1;
	layersUpdated.push('summary');

	const window = buildRecentWindow(input.priorEntries, input.newEntry);
	const recentResult = await updateRecent(
		provider,
		window,
		input.nextObjective,
		input.budget.recent,
		opts.skipRecentPolish === true,
	);
	if (recentResult.llmCalled) {
		llmCallsCount += 1;
	}
	layersUpdated.push('recent');

	const semanticResult = await updateSemantic(
		provider,
		input.priorBundle.semantic,
		input.newEntry,
		input.nextObjective,
		input.budget.semantic,
		opts.bulletCache,
	);
	if (semanticResult.llmCalled) {
		llmCallsCount += 1;
	}
	layersUpdated.push('semantic');

	const codeValue = updateCode(
		input.priorBundle.code,
		input.newEntry,
		input.budget.code,
	);
	if (codeValue !== input.priorBundle.code) {
		layersUpdated.push('code');
	}

	const bundle: MemoryShapeBundle = {
		system:   systemValue,
		summary:  summaryValue,
		recent:   recentResult.value,
		semantic: semanticResult.value,
		code:     codeValue,
	};

	const durationMs = Date.now() - started;
	log.info({ layersUpdated, llmCallsCount, durationMs }, 'incrementalUpdate complete');

	return {
		bundle,
		trace: {
			layersUpdated,
			llmCallsCount,
			durationMs,
		},
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRecentWindow(
	priorEntries: readonly WorkingMemoryEntry[],
	newEntry: WorkingMemoryEntry,
): readonly WorkingMemoryEntry[] {
	const oldest = Math.max(0, priorEntries.length - (RECENT_ENTRY_WINDOW - 1));
	return [...priorEntries.slice(oldest), newEntry];
}

function renderFindings(entry: WorkingMemoryEntry): string {
	if (entry.findings.perRoot.length === 0) {
		return '(no findings)';
	}
	const parts: string[] = [];
	for (const root of entry.findings.perRoot) {
		parts.push(`- ${root.rootId} (verdict: ${root.verdict}, cycles: ${root.cyclesConsumed}${root.exhausted ? ', exhausted' : ''}):`);
		parts.push(`  ${truncate(root.content, 600)}`);
	}
	if (entry.findings.fallback === 'L2') {
		parts.push('- fallback: L2 single-skill invocation took over');
	}
	return parts.join('\n');
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : text.slice(0, max) + '...';
}

const CODE_FENCE_RE = /```[\s\S]*?```/g;

function extractCodeBlocks(markdown: string): string[] {
	const matches = markdown.match(CODE_FENCE_RE);
	return matches !== null ? matches.map(m => m.trim()) : [];
}

// ---------------------------------------------------------------------------
// Test-only exports (underscore-prefixed)
// ---------------------------------------------------------------------------

export const _updateSystemForTest        = updateSystem;
export const _updateCodeForTest          = updateCode;
export const _buildRecentWindowForTest   = buildRecentWindow;
export const _extractCodeBlocksForTest   = extractCodeBlocks;
export const _renderFindingsForTest      = renderFindings;
export const _enforceBudgetForTest       = enforceBudget;
export const _tryParseSingleFieldForTest = tryParseSingleField;
export const RECENT_ENTRY_WINDOW_VALUE   = RECENT_ENTRY_WINDOW;
export const COLD_REBUILD_GROWTH_MULTIPLIER_VALUE = COLD_REBUILD_GROWTH_MULTIPLIER;

export const _countTokensForTest = countTokens;

// Surfaces the bullet-formatter so tests can pin its dedupe + budget
// behavior without going through the full incrementalUpdate path.
export const _formatBulletsAsSemanticForTest = formatBulletsAsSemantic;
