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
import type { AssertionInterest } from '../../daemon/substrate/types.js';

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

/**
 * memory-context M3.2. Subjects the review template wants preferences routed
 * to. Narrower than `/plan` -- a code review reflects test policy, code style,
 * and security policy; doc / commit / workflow rules typically aren't load-bearing
 * for a review pass.
 */
const REVIEW_ASSERTION_INTERESTS: readonly AssertionInterest[] = [
	{ subjectPattern: 'test-policy',     description: 'Test coverage, types, and style for review findings' },
	{ subjectPattern: 'code-style',      description: 'Code conventions reflected in review findings' },
	{ subjectPattern: 'security-policy', description: 'Security policies surfaced as review findings' },
];

const reviewTemplate: MetaTaskTemplate = {
	id:           'review',
	displayName:  'Review',
	worktreeMode: 'none',
	plan:         planFn,
	phase2SystemPrelude: REVIEW_PHASE2_PRELUDE,
	// memory-context M3 substrate registration.
	ownerId:            'agent:meta-task:review',
	schemaVersion:      1,
	assertionInterests: REVIEW_ASSERTION_INTERESTS,
	memorySchema: [
		{ namespace: 'user-assertions', kind: 'constraint' },
	],
};

export { reviewTemplate };
