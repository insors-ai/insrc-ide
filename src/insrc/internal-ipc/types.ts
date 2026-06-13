/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Internal IPC surface -- local-LLM-only.
 *
 * These are in-process typed function handlers that the daemon's
 * orchestration code (chat-handler, section-flow, data-analyzer)
 * calls when it needs intent classification, memory recall, session
 * persistence, audit review, handoff spawn, or gating decisions.
 *
 * Why a registry layer over the underlying functions:
 *
 *   1. Structural enforcement -- by routing local-LLM access through
 *      this surface, we keep `insrc_entity_*` / `insrc_repo_*` /
 *      `insrc_search_*` machinery on the external-agent side of the
 *      design (§4.0). A CI test asserts no file under
 *      `src/insrc/internal-ipc/` imports the disallowed backing
 *      stores. See `__tests__/surface-isolation.test.ts`.
 *
 *   2. Future cross-cutting concerns -- when Phase 5 wires
 *      observability across local-LLM calls, this is the one place
 *      to instrument.
 *
 * These handlers are NOT exposed via MCP. They are not callable from
 * the external agent. They are intentionally not even network-bound;
 * the daemon and the local LLM run in the same process tree.
 *
 * Design refs:
 *   - design/external-agent-integration.md §4.0 "Two surfaces, two audiences"
 *   - design/external-agent-integration.md §4.5 "Local LLM IPC surface"
 *   - plans/external-agent-integration.md §1.6
 */

export class InternalIpcNotImplementedError extends Error {
	constructor(name: string, phase: string) {
		super(`Internal IPC '${name}' is registered but its implementation lands in ${phase}.`);
		this.name = 'InternalIpcNotImplementedError';
	}
}

/**
 * Per-handler descriptor. The `invoke` function is plain typed
 * function call -- no JSON serialization, no socket transport. The
 * `name` field exists for the registry's invariant check and for
 * future telemetry.
 *
 * Each handler module defines its own `Input` and `Output` interfaces
 * and exports a `const handler: InternalIpcHandler<Input, Output>`
 * binding.
 */
export interface InternalIpcHandler<Input, Output> {
	/** `internal.<family>.<verb>` dot-separated. */
	readonly name: string;
	/** Invoke the handler. Throws on error; callers handle. */
	readonly invoke: (input: Input) => Promise<Output>;
}
