/**
 * Kind registry + dispatcher for artifact tasks.
 *
 * Each kind is a module that owns its own source-fetch + source-render
 * pipeline and returns a fully-formed `ArtifactResult`. The registry
 * maps `ArtifactKind` to a typed `ArtifactKindRegistration<TInput>`
 * via the contract below; the daemon's `artifact:*` tools (see
 * daemon/tools/builtins/artifact/) call `dispatch(kind, opts)` and let
 * the registration's `run` do the work.
 *
 * All five phase-1 kinds are wired here. Adding a new kind is documented
 * in `./README.md` (§4.3 in plans/artifact-tasks.md): three edits ---
 * extend the `ArtifactKind` union, add a `kinds/<id>.ts` module, append
 * one entry to `REGISTRATIONS` below.
 */

import { getLogger } from '../../../shared/logger.js';
import type {
	ArtifactKind,
	ArtifactResult,
	ArtifactOpts,
} from '../../../shared/artifacts.js';
import type { LLMProvider } from '../../../shared/types.js';
import { runDeployment, type DeploymentInput } from './kinds/deployment.js';
import { runEr, type ErInput } from './kinds/er.js';
import { runFlow, type FlowInput } from './kinds/flow.js';
import { runSequence, type SequenceInput } from './kinds/sequence.js';
import { runWireframe, type WireframeInput } from './kinds/wireframe.js';

const log = getLogger('artifact-registry');

// ---------------------------------------------------------------------------
// Kind-extension contract
// ---------------------------------------------------------------------------

/**
 * Per-call dispatch context every kind runner receives. Plumbed by the
 * daemon's `artifact:*` tool handlers from `ToolDeps.session`.
 */
export interface KindRunOpts {
	readonly sessionId: string;
	readonly repoRoot?: string | undefined;
	/**
	 * LLM provider used by kinds that need a stage-2 synthesis pass
	 * from free-text (currently: wireframe). Optional so callers that
	 * never exercise those paths -- tests, controller-supplied sources
	 * -- don't need to pass one. When absent, kinds that would have
	 * called an LLM degrade to their default-scaffold fallback.
	 */
	readonly provider?: LLMProvider | undefined;
}

/**
 * Runner signature for an artifact kind. The registry erases `TInput`
 * to `unknown` when it stores the runner (the JSON-schema validation
 * has already happened in the tool layer); kinds cast back to their
 * own `XxxInput` shape internally. See `./README.md` for the contract.
 */
export type KindRunner<TInput = unknown> = (
	opts: KindRunOpts & { readonly input: TInput },
) => Promise<ArtifactResult>;

/**
 * Typed registration record -- the single shape contributors implement
 * when adding a new kind. The `id` must be a member of the closed
 * `ArtifactKind` union (extend the union in `shared/artifacts.ts`
 * first); `run` is the kind module's exported runner; `templateName`
 * names the bundled template (defaults to `id` -- only override if a
 * kind reuses or sub-paths another kind's template).
 */
export interface ArtifactKindRegistration<TInput = unknown> {
	readonly id: ArtifactKind;
	readonly run: KindRunner<TInput>;
	readonly templateName?: string;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const REGISTRATIONS: readonly ArtifactKindRegistration<never>[] = [
	{
		id: 'wireframe',
		run: (opts => runWireframe({ ...opts, input: opts.input as WireframeInput })) as KindRunner,
	},
	{
		id: 'er',
		run: (opts => runEr({ ...opts, input: opts.input as ErInput })) as KindRunner,
	},
	{
		id: 'sequence',
		run: (opts => runSequence({ ...opts, input: opts.input as SequenceInput })) as KindRunner,
	},
	{
		id: 'flow',
		run: (opts => runFlow({ ...opts, input: opts.input as FlowInput })) as KindRunner,
	},
	{
		id: 'deployment',
		run: (opts => runDeployment({ ...opts, input: opts.input as DeploymentInput })) as KindRunner,
	},
] as readonly ArtifactKindRegistration<never>[];

const RUNNERS: ReadonlyMap<ArtifactKind, KindRunner> = new Map(
	REGISTRATIONS.map(r => [r.id, r.run as KindRunner]),
);

/**
 * Dispatch by kind. The daemon's `artifact:<kind>` tool handler calls
 * this with the kind-specific options payload (already validated
 * against the tool's JSON schema).
 */
export async function dispatch(
	kind: ArtifactKind,
	opts: KindRunOpts,
	input: ArtifactOpts | unknown,
): Promise<ArtifactResult> {
	const runner = RUNNERS.get(kind);
	if (runner === undefined) {
		// Should never happen -- REGISTRATIONS is exhaustive over the
		// closed ArtifactKind union -- but if a contributor extends the
		// union without adding a registration, this surfaces a clear
		// daemon-side error instead of a silent undefined call.
		throw new Error(
			`artifact dispatch: no registration for kind '${kind}'. ` +
			'Add a row to REGISTRATIONS in agent/tasks/artifacts/registry.ts.',
		);
	}
	log.debug({ kind, sessionId: opts.sessionId }, 'artifact dispatch');
	return runner({ ...opts, input });
}

/**
 * Expose the runnable-kind set for introspection (tests; the chat-
 * widget's NL discovery surface; future tooling that wants to enumerate
 * supported kinds).
 */
export function listRunnableKinds(): readonly ArtifactKind[] {
	return REGISTRATIONS.map(r => r.id);
}

/**
 * Expose the registration records (read-only). Useful to tests +
 * tooling that wants more than just the kind id (e.g. template-name
 * resolution).
 */
export function listRegistrations(): readonly ArtifactKindRegistration[] {
	return REGISTRATIONS as readonly ArtifactKindRegistration[];
}
