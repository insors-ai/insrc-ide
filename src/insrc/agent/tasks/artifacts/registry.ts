/**
 * Kind registry + dispatcher for artifact tasks.
 *
 * Each kind is a module that owns its own source-fetch + source-render
 * pipeline and returns a fully-formed `ArtifactResult`. The registry
 * maps `ArtifactKind` to a thin runner function; the daemon's
 * `artifact:*` tools (see daemon/tools/builtins/artifact/) call
 * `dispatch(kind, opts)` and let the runner do the work.
 *
 * All five kinds are wired to runnable modules in
 * `agent/tasks/artifacts/kinds/`. Kinds self-select between
 * structured source paths (Prisma / compose / Kuzu / LLM for
 * wireframe) and free-text fallback scaffolds.
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
// Runner signature
// ---------------------------------------------------------------------------

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

type KindRunner = (
	opts: KindRunOpts,
	input: unknown,
) => Promise<ArtifactResult>;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const RUNNERS: Readonly<Record<ArtifactKind, KindRunner>> = {
	wireframe: async (opts, input) =>
		runWireframe({ ...opts, input: input as WireframeInput }),
	er: async (opts, input) =>
		runEr({ ...opts, input: input as ErInput }),
	sequence: async (opts, input) =>
		runSequence({ ...opts, input: input as SequenceInput }),
	flow: async (opts, input) =>
		runFlow({ ...opts, input: input as FlowInput }),
	deployment: async (opts, input) =>
		runDeployment({ ...opts, input: input as DeploymentInput }),
};

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
	const runner = RUNNERS[kind];
	// The record is exhaustive over ArtifactKind, so every kind in the
	// union has a runner. The lookup never actually returns undefined
	// at runtime, but noUncheckedIndexedAccess would flag it; we use
	// the type-narrowed accessor to keep the type checker happy.
	log.debug({ kind, sessionId: opts.sessionId }, 'artifact dispatch');
	return runner(opts, input);
}

/**
 * Expose the runner set for introspection (tests; future
 * `artifact.list_templates`-adjacent tool).
 */
export function listRunnableKinds(): readonly ArtifactKind[] {
	return Object.keys(RUNNERS) as ArtifactKind[];
}
