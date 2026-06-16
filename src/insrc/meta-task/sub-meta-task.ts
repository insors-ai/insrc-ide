/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Sub-meta-task invocation.
 *
 * Lets one meta-task call another as a sub-step. The contract from design §3:
 *
 *   - **PersistRoot**: child writes under `<parentRoot>/sub-<n>-<templateId>/`.
 *     Built via `parent.subStoreFor(stepIndex, ...)`.
 *   - **Catalog**: child sees a snapshot of parent's deliverable catalog at
 *     invocation time, so its phase-1 fetchers can pull upstream deliverables
 *     by id. Parent's later steps see the child's deliverables under their
 *     sub-namespace path so the catalog grows monotonically.
 *   - **Gates**: child runs headless by default (M5 wires the opt-out for
 *     sub-tasks that need their own user gate, e.g. the planner asking for
 *     plan-approval inside `/plan`).
 *   - **Worktree**: inherits parent's mode when compatible. M5 wires the
 *     real inheritance logic (M3 templates are read-only / `none` so this is
 *     a moot point for now).
 *   - **IPC**: emissions flow through the parent's `MetaTaskEmitter` -- the
 *     chat panel sees them as part of the same session. The orchestrator
 *     suppresses the `done` / terminal signal on sub-tasks so the parent's
 *     IPC stream stays open through completion.
 *
 * Plan ref: [`plans/meta-tasks.md`](../../../plans/meta-tasks.md) M3.3.
 */

import { randomBytes } from 'crypto';

import { runMetaTask, type RunMetaTaskOpts, type MetaTaskResult } from './orchestrator.js';
import { MetaTaskStore } from './persist.js';
import type { DeliverableCatalog } from './types.js';


export interface RunSubMetaTaskOpts extends Omit<RunMetaTaskOpts, 'store' | 'parentMetaTaskId' | 'parentCatalog'> {
	/**
	 * The parent meta-task's store. The sub-task's store is derived from
	 * this via `parent.subStoreFor(parentStepIndex, ...)`.
	 */
	readonly parentStore: MetaTaskStore;
	/**
	 * Which step of the parent invoked this sub. Drives the on-disk naming
	 * (`sub-<n>-<templateId>/`).
	 */
	readonly parentStepIndex: number;
	/** Deliverable catalog visible to the sub-task at start. */
	readonly parentCatalog: DeliverableCatalog;
}


/**
 * Run a meta-task as a sub-task of `parentStore.metaTaskId`. Returns the
 * same `MetaTaskResult` shape `runMetaTask` returns -- the parent reads
 * `result.deliverables` + `result.synthesis` and decides what to surface
 * to its own subsequent steps.
 */
export async function runSubMetaTask(opts: RunSubMetaTaskOpts): Promise<MetaTaskResult> {
	const childMetaTaskId = (opts.allocId ?? defaultSubAllocId)();
	const childStore = opts.parentStore.subStoreFor(opts.parentStepIndex, {
		metaTaskId: childMetaTaskId,
		templateId: opts.templateId,
	});

	return runMetaTask({
		...opts,
		store:             childStore,
		parentMetaTaskId:  opts.parentStore.metaTaskId,
		parentCatalog:     opts.parentCatalog,
		// Force the orchestrator to reuse our pre-allocated child id instead
		// of generating a fresh one.
		allocId:           () => childMetaTaskId,
	});
}


function defaultSubAllocId(): string {
	return `sub-${randomBytes(4).toString('hex')}`;
}
