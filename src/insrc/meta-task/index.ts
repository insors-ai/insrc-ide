/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Meta-task framework entrypoint. Single re-export module so callers
 * (`src/insrc/daemon/meta-task-stream.ts`, future Delegate migration in M4)
 * pull from one path.
 *
 * Plan ref: [`plans/meta-tasks.md`](../../plans/meta-tasks.md).
 */

export { runMetaTask } from './orchestrator.js';
export type { RunMetaTaskOpts, MetaTaskResult } from './orchestrator.js';

export { runSubMetaTask } from './sub-meta-task.js';
export type { RunSubMetaTaskOpts } from './sub-meta-task.js';

export { MetaTaskEmitter } from './event-emitter.js';
export type { MetaTaskEmitterOpts } from './event-emitter.js';

export { MetaTaskStore, stepSlug } from './persist.js';

export { Heartbeat, composeStatus } from './heartbeat.js';

export { getTemplate, listTemplates } from './templates/index.js';
export type { MetaTaskTemplate } from './templates/index.js';

// Bootstrap template registry. The import has the side effect of registering
// every built-in template via the registry pattern.
import './templates/index.js';

export type {
	ContextChunk,
	ContextRequest,
	DeliverableCatalog,
	MetaTaskLifecycleStage,
	MetaTaskMeta,
	NarrowingHint,
	Phase1Ask,
	Phase1Result,
	Phase2Out,
	Plan,
	RetryCaps,
	ScopeManifest,
	StepDescriptor,
	WorktreeMode,
} from './types.js';

export { DEFAULT_RETRY_CAPS } from './types.js';
