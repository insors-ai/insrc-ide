/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Daemon-side gate IPC wiring.
 *
 * Composes the Phase 3 Day 2 hook-server primitives into a pair of
 * handlers the daemon registers on its IpcServer:
 *
 *   - gate.request-permission (stream) -- the hook script calls
 *     this. The daemon evaluates the spec's PermissionsBlock and
 *     either returns a synchronous verdict or pauses for a user
 *     prompt via the IDE modal (Phase 3 Day 4 wires the modal
 *     pipeline on the extension side; this module is agnostic to
 *     how the prompt is surfaced).
 *
 *   - gate.resolve (rpc) -- the IDE calls this when the user
 *     clicks Allow / Deny.
 *
 * Spec lookup reads the persisted spec meta at
 * `~/.insrc/handoffs/<sessionId>/<specId>.meta.json` (Phase 2a
 * persistence path).
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
	makeRequestPermissionHandler,
	makeGateResolveHandler,
	type PendingPrompt,
} from '../gating/hook-server.js';
import type { PermissionsBlock, SpecMeta } from '../handoff/types.js';
import { getLogger } from '../shared/logger.js';

const log = getLogger('daemon:gate');

function loadSpecPolicy(specId: string, sessionId: string): PermissionsBlock | undefined {
	const handoffsRoot = join(homedir(), '.insrc', 'handoffs');
	const metaPath     = join(handoffsRoot, sessionId, `${specId}.meta.json`);
	try {
		const raw  = readFileSync(metaPath, 'utf8');
		const meta = JSON.parse(raw) as SpecMeta;
		return meta.permissions;
	} catch (err) {
		log.warn({ specId, sessionId, err: (err as Error).message },
			'gate: failed to load spec meta; defaulting to no policy (handler returns deny)');
		return undefined;
	}
}

const sharedPending = new Map<string, PendingPrompt>();

const built = makeRequestPermissionHandler({
	lookupSpec:     loadSpecPolicy,
	pendingPrompts: sharedPending,
});

export const gateRequestPermissionStream = built.handler;
export const gateResolveRpc               = makeGateResolveHandler(sharedPending);

/**
 * Test seam: expose the pending map so tests can inspect it without
 * round-tripping through the IPC layer.
 */
export const _pendingForTest = sharedPending;
