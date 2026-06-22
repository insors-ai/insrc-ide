/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * P4 stub -- run-level + task-level bundle cache.
 *
 * Phase 4 of plans/analyze-context-builder.md owns this module:
 *   readBundle(runId, key)  : Promise<AnalyzeContextBundle | null>
 *   writeBundle(runId, key, bundle): Promise<void>
 *
 * Cache layout:
 *   ~/.insrc/analyze/<run-id>/context/classification.json
 *   ~/.insrc/analyze/<run-id>/context/run-bundle.json
 *   ~/.insrc/analyze/<run-id>/context/<task-id>.bundle.json
 *
 * Invalidation:
 *   - cache key includes prompt-content hash + schemaVersion +
 *     invocation-inputs hash (computed in driver.ts)
 *   - cached bundle records meta.repoLastIndexedAt; on read, if the
 *     registry's current lastIndexedAt > cached value, discard
 *
 * No per-layer cross-run cache -- killed when summarize-down was
 * dropped. No --no-cache flag; ShapeOpts.bypassCache is for tests.
 */

import type { AnalyzeContextBundle, ShapeOpts } from './types.js';

export interface CacheKey {
	readonly mode:       'classification' | 'run' | 'task';
	readonly taskId?:    string;
	readonly hash:       string;
}

export async function readBundle(
	_runId: string,
	_key:   CacheKey,
	_opts:  ShapeOpts,
): Promise<AnalyzeContextBundle | null> {
	throw new Error('analyze/context/cache.ts: readBundle is a P4 stub');
}

export async function writeBundle(
	_runId:  string,
	_key:    CacheKey,
	_bundle: AnalyzeContextBundle,
): Promise<void> {
	throw new Error('analyze/context/cache.ts: writeBundle is a P4 stub');
}
