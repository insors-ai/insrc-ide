/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `insrc_workflow_step` phase='synthesize' handler.
 *
 * The client emitted the artifact JSON. We:
 *   1. Validate JSON shape + citations + boundary via
 *      `finalizeArtifact`.
 *   2. Write the artifact (md + json) atomically.
 *   3. Release the state token + return `next: 'done'`.
 */

import { getLogger } from '../../../shared/logger.js';
import { finalizeArtifact } from '../../../workflow/orchestrator.js';
import { defineArtifactPaths, hldArtifactPaths, lldArtifactPaths, stubArtifactPaths, writeAtomic, appendRunLog } from '../../../workflow/storage.js';
import type { WorkflowIntent } from '../../../workflow/types.js';
import { assertStage, decodeState } from '../state.js';
import { releaseState } from '../state-store.js';
import type {
	WorkflowStepDone,
	WorkflowStepError,
	WorkflowStepInputSynthesize,
} from '../types.js';

const log = getLogger('mcp:workflow-step:synthesize');

export async function handleSynthesize(
	input: WorkflowStepInputSynthesize,
): Promise<WorkflowStepDone | WorkflowStepError> {
	const state = decodeState(input.state);
	assertStage(state, 'awaiting_synthesize');

	if (state.stepOutputs === undefined) {
		return errorResult(
			'no-step-outputs',
			`state stage is 'awaiting_synthesize' but stepOutputs is missing`,
			false,
		);
	}
	const elapsedMs = Date.now() - state.startedAtMs;
	const result = finalizeArtifact(
		state.intent,
		state.stepOutputs,
		state.runId,
		elapsedMs,
		input.artifact,
	);
	if (!result.ok) {
		const failure = result.failure;
		const code = failure.ok ? 'synthesize-unknown' : `synthesize-${failure.kind}`;
		return errorResult(code, formatFailure(failure), true);
	}
	const paths = pathsForWorkflow(state.intent, state.slug);
	writeAtomic(paths.md,   result.finalized.renderedMd);
	writeAtomic(paths.json, result.finalized.renderedJson);
	appendRunLog(state.slug, state.intent.workflow, state.runId, {
		ts:    new Date().toISOString(),
		event: 'artifact-written',
		md:    paths.md,
		json:  paths.json,
		elapsedMs,
	});
	log.info(
		{ runId: state.runId, workflow: state.intent.workflow, path: paths.md, elapsedMs },
		'insrc_workflow_step[synthesize]: artifact written; releasing state',
	);
	releaseState(inputStateToken(input.state));
	return {
		next:     'done',
		path:     paths.md,
		markdown: result.finalized.renderedMd,
		artifact: result.finalized.artifact,
	};
}

function pathsForWorkflow(
	intent: WorkflowIntent,
	slug:   string,
): { readonly md: string; readonly json: string } {
	const { workflow, repoPath } = intent;
	if (workflow === 'stub')        return stubArtifactPaths(repoPath, slug);
	if (workflow === 'define')      return defineArtifactPaths(repoPath, slug);
	if (workflow === 'design.epic') {
		const { md, json } = hldArtifactPaths(repoPath, slug);
		return { md, json };
	}
	if (workflow === 'design.story') {
		const storyId = intent.params['storyId'];
		if (typeof storyId !== 'string' || storyId.length === 0) {
			throw new Error(`design.story synthesize requires params.storyId`);
		}
		const { md, json } = lldArtifactPaths(repoPath, slug, storyId);
		return { md, json };
	}
	throw new Error(`pathsForWorkflow: workflow '${workflow}' not yet supported`);
}

function formatFailure(f: import('../../../workflow/synthesizer.js').ValidationResult): string {
	if (f.ok) return 'ok';
	const details = f.details === undefined ? '' : ` — details: ${f.details.join(' | ')}`;
	return `${f.message}${details}`;
}

function inputStateToken(state: string): string {
	// The token is the whole `state` string; no envelope.
	return state;
}

function errorResult(code: string, message: string, retryable: boolean): WorkflowStepError {
	return { next: 'error', error: { code, message, retryable } };
}
