/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `/review` meta-task template.
 *
 * The simplest viable template: one analysis step + a single soft acceptance criterion
 * (deliverable lists at least one finding). Read-only (`worktreeMode: 'none'`). Serves
 * as M2's end-to-end smoke test for the entire framework -- if /review works through
 * the chat panel, the orchestrator + IPC + emission set are correct.
 *
 * Per-template design doc retrofit lands at `design/meta-task-review.html` in M6.1.
 *
 * Plan ref: [`plans/meta-tasks.md`](../../../../plans/meta-tasks.md) M2.6.
 */

import type { MetaTaskTemplate } from './index.js';
import type { ScopeManifest, Plan } from '../types.js';

const REVIEW_PHASE2_PRELUDE = `You are running as a code-review meta-task step.

Your job is to identify concrete findings in the in-scope code or artifacts that the user should know about. Concrete examples: a bug, a contract drift, a missing test, a security smell, a perf hot path, a dead-code path, a documentation gap.

Output format (markdown):

  # Review: <one-line summary>

  ## Findings
  - **<short title>** -- <2-4 sentence description> (location: <file:line> if applicable)
  - ...

  ## Notes
  <free-form context the user should know>

Rules:
  - At least one finding. If you genuinely find none, emit one finding stating that and explain what you looked at.
  - File:line citations are markdown links when possible.
  - Don't propose fixes here -- this template is read-only review.
`;

const planFn = (scope: ScopeManifest): Plan => ({
	revision: 0,
	steps: [
		{
			name: 'R1 analyze',
			intent: scope.intent,
			acceptance: [
				{
					id:          'soft.has-findings',
					description: 'Deliverable lists at least one finding (positive or negative).',
					kind:        'soft',
				},
			],
		},
	],
});

const reviewTemplate: MetaTaskTemplate = {
	id:           'review',
	displayName:  'Review',
	worktreeMode: 'none',
	plan:         planFn,
	phase2SystemPrelude: REVIEW_PHASE2_PRELUDE,
};

export { reviewTemplate };
