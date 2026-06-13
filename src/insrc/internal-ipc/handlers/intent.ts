/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `internal.intent.resolve` -- the single funnel for user-message
 * intent classification (per CLAUDE.md, no other module classifies
 * intent).
 *
 * Phase 1 wires the local-LLM-facing handler to the existing
 * `resolveIntent` implementation. No behaviour change; this is the
 * registry entry that lets us enforce the "no graph/repo/search
 * access" rule on the local-LLM surface.
 */

import { resolveIntent } from '../../agent/intent/resolver.js';
import type { ResolvedIntent, ResolveIntentOpts } from '../../agent/intent/resolver.js';
import type { Session } from '../../agent/session.js';
import type { InternalIpcHandler } from '../types.js';

export interface IntentResolveInput {
	readonly session:     Session;
	readonly rawMessage:  string;
	readonly opts?:       ResolveIntentOpts | undefined;
}

export const intentResolve: InternalIpcHandler<IntentResolveInput, ResolvedIntent> = {
	name: 'internal.intent.resolve',
	async invoke(input) {
		return resolveIntent(input.session, input.rawMessage, input.opts);
	},
};
