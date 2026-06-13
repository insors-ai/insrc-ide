/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `internal.memory.recall` -- ANN bundle over prior turns (turn_vec)
 * and response segments (response_segment_vec), scoped to the active
 * session.
 *
 * Phase 1 wraps `retrieveClassifierMemory` which already bundles the
 * dual-vector query and handles per-side failure gracefully (turn-vec
 * empty / segment-vec empty / embed unavailable). No behaviour change.
 */

import { retrieveClassifierMemory } from '../../agent/intent/classifier-memory.js';
import type {
	ClassifierMemory,
	RetrieveClassifierMemoryOpts,
} from '../../agent/intent/classifier-memory.js';
import type { Session } from '../../agent/session.js';
import type { InternalIpcHandler } from '../types.js';

export interface MemoryRecallInput {
	readonly session: Session;
	readonly message: string;
	readonly opts?:   RetrieveClassifierMemoryOpts | undefined;
}

export const memoryRecall: InternalIpcHandler<MemoryRecallInput, ClassifierMemory> = {
	name: 'internal.memory.recall',
	async invoke(input) {
		return retrieveClassifierMemory(input.session, input.message, input.opts);
	},
};
