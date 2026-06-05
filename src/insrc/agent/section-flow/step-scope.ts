/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Step 1 -- Scope (planner-section-task-separation P2).
 *
 * Replaces the deleted bootstrap's `select-scope` work (Q4). Runs the
 * existing `classifyScope` LLM call (which produces scope tier +
 * subtype) and augments it with two pieces the bootstrap didn't
 * surface:
 *
 *   - `contextRefs[]`: concrete pointers (file paths, directory
 *     paths, symbol-shaped identifiers) the user mentioned or that
 *     trivially follow from the question. The Step 2 investigation
 *     planner uses these to scope the TODO objectives; the per-TODO
 *     section planner (P3) uses them when constructing the task
 *     tree.
 *
 *   - `isTrivial`: true when the question is single-shot fast-path-
 *     eligible (S scope + one focused contextRef). When set, Step 2
 *     skips the planning LLM call and emits a single-TODO plan
 *     directly.
 *
 * Intent classification is NOT done here -- the single-funnel rule
 * (auto-memory `intent_classification_single_funnel`) means the
 * resolved intent is passed in from upstream via
 * `resolveIntent(session, message)`. This step trusts it.
 *
 * Context-ref extraction is regex-based (no extra LLM call). The
 * patterns target the high-confidence shapes:
 *   - Absolute Unix paths and project-relative paths with separators
 *   - Filename + extension tokens (.ts, .py, .md, ...)
 *   - Backtick-quoted identifiers in the user's prose
 *   - `path/to/dir/` trailing-slash directory hints
 * False negatives are fine: the planner's tools can still discover
 * unmentioned files. False positives are noisy but harmless --
 * downstream uses these as hints, not as binding scope.
 */

import { classifyScope, type AnalysisSubtype } from '../classify/scope.js';
import type { LLMProvider } from '../../shared/types.js';
import type { ContextRef, ScopeStepResult } from './types.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('section-flow:scope');

export interface ScopeStepInput {
	readonly question: string;
	/** Optional repo signals threaded into the scope classifier's context block. */
	readonly repoSignals?: {
		readonly fileCount?:        number;
		readonly primaryLanguages?: readonly string[];
		readonly topModules?:       readonly string[];
	} | undefined;
	readonly provider: LLMProvider;
}

/**
 * Run Step 1. Emits the scope tier + subtype + context-refs +
 * trivial-flag bundle the orchestrator threads through Step 2 and
 * subsequent steps.
 *
 * Failure modes:
 *   - classifyScope returns its own structured fallback on parse /
 *     provider failure. We pass it through with `fallback: true`.
 *   - context-ref extraction is regex-based and can't fail; returns
 *     [] when the question carries no recognisable refs.
 */
export async function runScopeStep(input: ScopeStepInput): Promise<ScopeStepResult> {
	const scopeContext = buildScopeContext(input.repoSignals);
	const classifyOpts = scopeContext === '' ? {} : { context: scopeContext };
	const classified = await classifyScope({ text: input.question, ...classifyOpts }, input.provider);

	const contextRefs = extractContextRefs(input.question);
	const isTrivial = decideTrivial(classified.scope, contextRefs);

	log.info({
		scope:        classified.scope,
		subtype:      classified.subtype,
		contextRefs:  contextRefs.map(r => `${r.kind}:${r.value}`),
		isTrivial,
		fallback:     classified.fallback,
	}, 'scope step complete');

	return {
		scope:        classified.scope,
		subtype:      classified.subtype as AnalysisSubtype,
		contextRefs,
		isTrivial,
		reasoning:    classified.reasoning,
		fallback:     classified.fallback,
	};
}

// ---------------------------------------------------------------------------
// Repo-signals context block
// ---------------------------------------------------------------------------

function buildScopeContext(signals: ScopeStepInput['repoSignals']): string {
	if (signals === undefined) {
		return '';
	}
	const parts: string[] = [];
	if (signals.fileCount !== undefined) {
		parts.push(`File count: ${signals.fileCount}`);
	}
	if (signals.primaryLanguages !== undefined && signals.primaryLanguages.length > 0) {
		parts.push(`Primary languages: ${signals.primaryLanguages.join(', ')}`);
	}
	if (signals.topModules !== undefined && signals.topModules.length > 0) {
		parts.push(`Top modules: ${signals.topModules.slice(0, 10).join(', ')}`);
	}
	return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Context-ref extraction
// ---------------------------------------------------------------------------

const ABS_PATH_RE       = /(?<![A-Za-z0-9_./-])\/(?:[A-Za-z0-9_-]+\/)+[A-Za-z0-9_.-]+(?![A-Za-z0-9_./-])/g;
const REL_PATH_RE       = /(?<![A-Za-z0-9_./-])(?:[A-Za-z0-9_-]+\/)+[A-Za-z0-9_.-]+(?![A-Za-z0-9_./-])/g;
const DIR_RE            = /(?<![A-Za-z0-9_./-])(?:[A-Za-z0-9_-]+\/)+(?![A-Za-z0-9_./-])/g;
const FILENAME_RE       = /(?<![A-Za-z0-9_./-])[A-Za-z0-9_-]+\.(?:ts|tsx|js|jsx|py|go|java|scala|rs|md|json|yaml|yml|toml|sh|sql|xml|html|css|cs|swift|kt|rb|php|c|cpp|h|hpp|proto)(?![A-Za-z0-9_./-])/g;
const BACKTICK_IDENT_RE = /`([A-Za-z_][A-Za-z0-9_.]{2,})`/g;

/**
 * Extract concrete pointer refs from the user question. Best-effort
 * pattern matching; downstream consumers treat the result as hints,
 * not as the binding scope.
 *
 * Dedupes by `${kind}:${value}` so a path that matches both the
 * filename and the path patterns only lands once.
 */
export function extractContextRefs(question: string): ContextRef[] {
	const seen = new Set<string>();
	const out: ContextRef[] = [];

	const push = (kind: ContextRef['kind'], value: string): void => {
		const cleaned = value.trim();
		if (cleaned.length === 0) {
			return;
		}
		const key = `${kind}:${cleaned}`;
		if (seen.has(key)) {
			return;
		}
		seen.add(key);
		out.push({ kind, value: cleaned, origin: 'user-mention' });
	};

	// Absolute paths first (longest match wins).
	for (const m of question.matchAll(ABS_PATH_RE)) {
		push('file', m[0]);
	}
	// Directory hints (`path/to/dir/`).
	for (const m of question.matchAll(DIR_RE)) {
		push('dir', m[0]);
	}
	// Relative paths (multi-segment, with extension).
	for (const m of question.matchAll(REL_PATH_RE)) {
		// Skip if already captured as a directory or absolute.
		if (m[0].endsWith('/')) {
			continue;
		}
		push('file', m[0]);
	}
	// Bare filenames with known extensions.
	for (const m of question.matchAll(FILENAME_RE)) {
		push('file', m[0]);
	}
	// Backticked identifiers ("the `BlockManager` class").
	for (const m of question.matchAll(BACKTICK_IDENT_RE)) {
		const sym = m[1]!;
		// Skip if it's a path-shaped string already captured.
		if (sym.includes('/')) {
			continue;
		}
		push('symbol', sym);
	}

	return out;
}

// ---------------------------------------------------------------------------
// Trivial-fast-path decision
// ---------------------------------------------------------------------------

function decideTrivial(scope: string, contextRefs: readonly ContextRef[]): boolean {
	// Q4's fast-path tradeoff: a trivial query has S scope AND one
	// focused contextRef. Anything broader needs the multi-TODO plan.
	if (scope !== 'S') {
		return false;
	}
	return contextRefs.length === 1;
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _extractContextRefsForTest = extractContextRefs;
export const _decideTrivialForTest      = decideTrivial;
export const _buildScopeContextForTest  = buildScopeContext;
