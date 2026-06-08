/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Live test: step-section-review -- both the review verdict call AND
 * the revise-edits rewrite call.
 *
 * Strategy: feed a deliberately weak section markdown ("incomplete
 * comparison, no specifics") so the reviewer is pushed toward
 * `revise-edits` and we get to exercise BOTH LLM calls in one trial.
 * If the reviewer accepts it cleanly, we still pass (the rewrite
 * path didn't fire) but flag pass-degraded.
 *
 * Run: source ~/.insors && npx tsx scripts/live-section-flow/04-section-review.ts
 */

import { reviewSection } from '../../src/insrc/agent/section-flow/step-section-review.js';
import type { TodoSpec } from '../../src/insrc/agent/section-flow/types.js';
import type { MemoryShapeBundle } from '../../src/insrc/agent/working-memory/index.js';
import { buildOllama, parseArgs, runTrials, combineChecks, checkNonEmpty, type TrialResult } from './_lib.js';

const TODO: TodoSpec = {
	id:        'todo-grn-mapping',
	objective: 'Compare a sample JSON GRN payload against the INGRN pydantic class.',
	origin:    'initial',
};

const MEMORY: MemoryShapeBundle = {
	system: '', summary: '', recent: '', semantic: '', code: '',
};

// Deliberately weak section markdown.
const CANDIDATE = `# GRN payload vs INGRN class

We looked at a payload and a class. They are similar but there are differences.

## Findings

Some fields match, some do not. More work is needed to enumerate the gaps.
`;

const FINDINGS = {
	perRoot: [
		{
			rootId:        'discover',
			verdict:       'accept' as const,
			cyclesConsumed: 0,
			exhausted:     false,
			content:       'discovered JSON payload with 14 top-level keys; INGRN class has 18 fields',
		},
		{
			rootId:        'analyze',
			verdict:       'accept' as const,
			cyclesConsumed: 0,
			exhausted:     false,
			content:       '4 INGRN fields have no corresponding JSON key; 1 JSON key has wrong type',
		},
	],
} as const;

async function main(): Promise<void> {
	const args = parseArgs(process.argv);
	const provider = buildOllama(args);

	const exit = await runTrials({
		name: 'step-section-review',
		args,
		trial: async (i): Promise<TrialResult> => {
			const t0 = Date.now();
			try {
				const result = await reviewSection({
					todo:      TODO,
					memory:    MEMORY,
					candidate: CANDIDATE,
					findings:  FINDINGS,
					provider,
				});
				const dur = Date.now() - t0;
				const verdict = result.finalVerdict;
				const cycles  = result.cyclesConsumed;
				const knownVerdicts: readonly string[] = ['accept', 'force-accept'];

				const checks = [
					knownVerdicts.includes(verdict) ? null : `unexpected final verdict: ${verdict}`,
					checkNonEmpty(result.finalMarkdown, 'finalMarkdown'),
					cycles === 0 ? 'reviewer accepted weak candidate without firing any revise cycles (expected at least 1)' : null,
				];
				const { outcome, summary } = combineChecks(checks);
				return {
					outcome,
					summary: `${summary}; verdict=${verdict}, cycles=${cycles}, exhausted=${result.exhausted}`,
					durationMs: dur,
					details: args.verbose ? {
						finalMarkdownPreview: result.finalMarkdown.slice(0, 200),
					} : undefined,
				};
			} catch (err) {
				return {
					outcome:    'fail',
					summary:    `reviewSection threw: ${(err as Error).message}`,
					durationMs: Date.now() - t0,
				};
			}
		},
	});

	process.exit(exit);
}

void main();
