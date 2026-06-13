/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `internal.gating.evaluate` stub.
 *
 * Permission policy + risk ratchet evaluation. Lands in Phase 3
 * alongside the bin/insrc-permission-hook script and the
 * `gating/permission-policy.ts` + `gating/risk-ratchet.ts` modules.
 *
 * Stubbed here with a typed signature so call sites can be written
 * against the contract before Phase 3 fills in the body.
 */

import type { InternalIpcHandler } from '../types.js';
import { InternalIpcNotImplementedError } from '../types.js';

export interface GatingEvaluateInput {
	/** Draft spec the local LLM just assembled. */
	readonly draftSpec: unknown;
}

export interface GatingEvaluateOutput {
	readonly permissions: unknown;
	readonly riskTag:     'low' | 'medium' | 'high';
	readonly deniedPaths: readonly string[];
}

export const gatingEvaluate: InternalIpcHandler<GatingEvaluateInput, GatingEvaluateOutput> = {
	name: 'internal.gating.evaluate',
	async invoke() {
		throw new InternalIpcNotImplementedError('internal.gating.evaluate', 'Phase 3');
	},
};
