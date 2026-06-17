/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Daemon-wide singleton SubstrateRuntime (memory-context M1.5).
 *
 * One workspace per daemon for now; the workspace id is derived from the daemon
 * boot fingerprint (`<insrc>` -- placeholder until per-repo workspace identity
 * lands). The runtime owns the memory store, the assertion classifier with
 * the Ollama-backed Layer 2 hook, the assertion index, the feedback bus, and
 * the lifecycle runner.
 *
 * Wired into the daemon at startup (`daemon/index.ts`). Re-init replaces the
 * prior instance (used by tests + dev reload).
 */

import { getLogger } from '../../shared/logger.js';
import { PATHS } from '../../shared/paths.js';
import type { LLMProvider } from '../../shared/types.js';

import { createMemoryStore } from './memory-store.js';
import { createSubstrateRuntime, type SubstrateRuntime } from './runtime.js';
import { createOllamaLayer2Hook } from './classifier/ollama-hook.js';
import { PREFERENCE_SUBJECTS } from './taxonomy/preference-subjects.js';
import type { OwnerId } from './types.js';

const log = getLogger('substrate:singleton');

const DAEMON_WORKSPACE_ID = 'insrc';

let instance: SubstrateRuntime | undefined;

export interface InitSubstrateRuntimeOpts {
	readonly localProvider: LLMProvider;
	readonly workspaceId?:  string;
	readonly rootDir?:      string;
}

/**
 * Initialise the daemon-wide substrate runtime. Idempotent; subsequent calls
 * replace the prior instance (handy for tests + dev reload, no impact in
 * production where this is called once at startup).
 */
export function initSubstrateRuntime(opts: InitSubstrateRuntimeOpts): SubstrateRuntime {
	const workspaceId = opts.workspaceId ?? DAEMON_WORKSPACE_ID;
	const rootDir     = opts.rootDir     ?? PATHS.substrate;

	const memory = createMemoryStore({ workspaceId, rootDir });
	const llmClassify = createOllamaLayer2Hook({ provider: opts.localProvider });

	const runtime = createSubstrateRuntime({
		memory,
		classifier: { llmClassify },
	});

	instance = runtime;
	log.info({ workspaceId, rootDir }, 'substrate runtime initialised');
	return runtime;
}

/**
 * Get the daemon-wide substrate runtime. Throws if `initSubstrateRuntime` hasn't
 * been called yet. Callers expect to run inside the daemon boot sequence; tests
 * should call `initSubstrateRuntime` with a scripted provider.
 */
export function getSubstrateRuntime(): SubstrateRuntime {
	if (instance === undefined) {
		throw new Error('substrate runtime not initialised; call initSubstrateRuntime(...) first');
	}
	return instance;
}

/** Returns `true` when `initSubstrateRuntime` has been called. */
export function hasSubstrateRuntime(): boolean {
	return instance !== undefined;
}

/** Reset for tests. */
export function _resetSubstrateRuntimeForTests(): void {
	instance = undefined;
}


// ---------------------------------------------------------------------------
// Bootstrapped owners (declared at daemon startup)
//
// The `agent:chat` owner represents the free-form chat agent. Preferences
// captured during regular chat conversation route here. Other owners (per
// meta-task, per Pair/Delegate session) get registered when those agents
// activate, per memory-context G9.
// ---------------------------------------------------------------------------

export const AGENT_CHAT_OWNER: OwnerId = 'agent:chat';

const AGENT_CHAT_DESCRIPTION = 'Free-form chat agent. Receives all assertion subjects so '
	+ "the user's general-chat preferences land somewhere even when no specialised "
	+ 'agent is active.';

/**
 * Register the `agent:chat` owner with broad assertion interest -- every
 * `PreferenceSubject` routes here when no more-specific owner is interested.
 * Called once after `initSubstrateRuntime`. Uses `runtime.assertionIndex.register`
 * directly rather than the heavier `registerSkill` path because the chat owner
 * is not a skill (no `execute`).
 */
export function registerAgentChatOwner(runtime: SubstrateRuntime): void {
	const interests = PREFERENCE_SUBJECTS.map(s => ({
		subjectPattern: s,
		description:    AGENT_CHAT_DESCRIPTION,
	}));
	runtime.assertionIndex.register(AGENT_CHAT_OWNER, interests);
	log.info({ owner: AGENT_CHAT_OWNER, subjects: PREFERENCE_SUBJECTS.length }, 'agent:chat owner registered');
}
