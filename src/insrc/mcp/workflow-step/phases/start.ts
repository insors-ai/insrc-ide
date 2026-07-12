/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `insrc_workflow_step` phase='start' handler.
 *
 * 1. Resolve the repo path (explicit param > INSRC_REPO env).
 * 2. Build a WorkflowIntent from focus + workflow + params.
 * 3. Look up the workflow's decomposer prompt + schema.
 * 4. Seed the state (stage='awaiting_plan').
 * 5. Return emit_plan.
 */

import { getLogger } from '../../../shared/logger.js';
import { deriveSlug } from '../../../workflow/slug.js';
import type { WorkflowIntent } from '../../../workflow/types.js';
import { prepareDecompose } from '../../../workflow/orchestrator.js';
import { encodeState, STATE_VERSION, type WorkflowStepStatePayload } from '../state.js';
import type { WorkflowStepEmitPlan, WorkflowStepInputStart } from '../types.js';

const log = getLogger('mcp:workflow-step:start');

export async function handleStart(
	input: WorkflowStepInputStart,
): Promise<WorkflowStepEmitPlan> {
	const repoPath = resolveRepoPath(input.repo);
	if (repoPath === undefined) {
		throw new Error(
			`insrc_workflow_step[start]: no repo. Pass \`repo\` explicitly or set INSRC_REPO ` +
			`in the MCP server's environment.`,
		);
	}
	const runId = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	// Slug source per workflow:
	//   - `define` / `stub` derive from focus (new artifact tree).
	//   - `design.epic` / `design.story` reuse the Epic's slug — the
	//     HLD + LLDs live under `docs/designs/<epicSlug>/`. Requires
	//     intent.params.epicSlug.
	const params = input.params ?? {};
	const slug   = slugFor(input.workflow, input.focus, params);

	const intent: WorkflowIntent = {
		workflow:      input.workflow,
		focus:         input.focus,
		repoPath,
		repoIndexedAt: null,   // Phase A: no repo-indexedAt lookup; wire in Phase B via analyze.
		params,
	};

	const prepared = prepareDecompose(intent);

	const state: WorkflowStepStatePayload = {
		version:     STATE_VERSION,
		runId,
		slug,
		startedAtMs: Date.now(),
		intent,
		stage:       'awaiting_plan',
	};

	log.info(
		{ runId, workflow: intent.workflow, slug, focus: input.focus.slice(0, 80) },
		'insrc_workflow_step[start]: emitting decomposer prompt',
	);

	return {
		next:     'emit_plan',
		guidance:
			`Emit a WorkflowPlan JSON matching the schema below, then call ` +
			`insrc_workflow_step again with phase="plan", plan=<your JSON>, ` +
			`state=<the state field verbatim>.`,
		prompt:   prepared.systemPrompt,
		userTurn: prepared.userTurn,
		schema:   prepared.schema,
		state:    encodeState(state),
	};
}

function resolveRepoPath(explicit: string | undefined): string | undefined {
	if (explicit !== undefined && explicit.length > 0) return explicit;
	const env = process.env['INSRC_REPO'];
	if (env !== undefined && env.length > 0) return env;
	return undefined;
}

function slugFor(
	workflow: string,
	focus:    string,
	params:   Record<string, unknown>,
): string {
	if (workflow === 'design.epic' || workflow === 'design.story') {
		const s = params['epicSlug'];
		if (typeof s !== 'string' || s.length === 0) {
			throw new Error(
				`insrc_workflow_step[start]: workflow '${workflow}' requires params.epicSlug.`,
			);
		}
		return s;
	}
	return deriveSlug(focus);
}
