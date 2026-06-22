/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * P6 stub -- empty-closure detection + auto-reindex trigger.
 *
 * Phase 6 of plans/analyze-context-builder.md owns this module. The
 * driver invokes this before mode='run' Ollama calls:
 *   - if repo.get_closure() returns empty for any target repo in
 *     intent.scopeRef, invoke repo.reindex IPC directly (NOT via the
 *     LLM's tool surface -- repo.reindex is excluded from there)
 *   - after reindex, re-check the closure
 *   - if still empty, throw ScopeNotIndexedError
 *
 * This is a wrapper-level invariant, not an LLM concern. The shaper
 * model never sees this path -- it just gets a non-empty closure
 * when it queries via the read-only tool surface.
 */

import type { ClassifiedIntent } from '../../shared/analyze-types.js';

export class ScopeNotIndexedError extends Error {
	constructor(scopeRefValue: string) {
		super(`Scope target ${scopeRefValue} produced an empty closure after auto-reindex`);
		this.name = 'ScopeNotIndexedError';
	}
}

export async function ensureNonEmptyClosure(_intent: ClassifiedIntent): Promise<void> {
	throw new Error('analyze/context/invariants.ts: ensureNonEmptyClosure is a P6 stub');
}
