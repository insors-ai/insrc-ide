/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `internal.handoff.*` stubs.
 *
 * Spawn + return wire to the external coding agent (Claude Code /
 * Codex) subprocess pipeline. The pipeline lands in Phase 2a; until
 * then these are explicit `NotImplementedError` stubs so callers
 * fail loudly if they reach for handoff in Phase 1.
 *
 * Inputs / outputs are typed against the design's spawn contract so
 * the Phase 2a implementation can drop in without breaking call
 * sites.
 */

import type { InternalIpcHandler } from '../types.js';
import { InternalIpcNotImplementedError } from '../types.js';

export interface HandoffSpawnInput {
	readonly specId:       string;
	readonly agentName:    'claude-code' | 'codex';
	readonly worktreePath: string;
	readonly permissions:  unknown;  // Permission block; shaped in Phase 3.
}

export interface HandoffSpawnOutput {
	readonly handoffId: string;
	readonly pid:       number;
}

export interface HandoffReturnInput {
	readonly handoffId: string;
}

export interface HandoffReturnOutput {
	readonly deliverable: string;
	readonly trace:       string;
	readonly exitCode:    number;
}

export const handoffSpawn: InternalIpcHandler<HandoffSpawnInput, HandoffSpawnOutput> = {
	name: 'internal.handoff.spawn',
	async invoke() {
		throw new InternalIpcNotImplementedError('internal.handoff.spawn', 'Phase 2a');
	},
};

export const handoffReturn: InternalIpcHandler<HandoffReturnInput, HandoffReturnOutput> = {
	name: 'internal.handoff.return',
	async invoke() {
		throw new InternalIpcNotImplementedError('internal.handoff.return', 'Phase 2a');
	},
};
