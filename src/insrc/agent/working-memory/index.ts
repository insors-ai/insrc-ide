/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Working-memory module for the planner-section-task-separation
 * orchestrator. P1.b lands persistence + types; P1.c lands the
 * shape-the-memory step; P1.d lands incremental update + the semantic-
 * bullet cache.
 */

export type {
	WorkingMemoryEntry,
	WorkingMemoryEntryMetadata,
	WorkingMemoryFindings,
	PerRootFinding,
	RootVerdict,
	TodoOrigin,
} from './types.js';

export {
	WorkingMemoryStore,
	openWorkingMemoryStore,
	serialiseEntry,
	parseEntry,
	slugifyTodoId,
	ensureRunDir,
	type ListedEntry,
} from './store.js';

export {
	shapeMemory,
	chunkMemory,
	type MemoryShapeBundle,
	type MemoryShapeInput,
	type MemoryShapeOpts,
	type MemoryShapeResult,
	type MemoryShapeTrace,
	type MemoryChunkHint,
} from './shaper.js';

export {
	incrementalUpdate,
	shouldColdRebuild,
	type IncrementalUpdateInput,
	type IncrementalUpdateOpts,
	type IncrementalUpdateResult,
	type IncrementalUpdateTrace,
	type ColdRebuildInput,
	type LayerName,
	type BulletCache,
	type BulletCacheHit,
} from './updater.js';

export {
	extractBullets,
	type ExtractBulletsOpts,
} from './bullet-extractor.js';
