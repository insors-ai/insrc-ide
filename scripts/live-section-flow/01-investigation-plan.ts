/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Live test: step-investigation-plan -- the first LLM-touching step in
 * the section-flow pipeline. Feeds a synthetic question + scope brief
 * and asserts:
 *   - the existing validator inside `runInvestigationPlan` accepts
 *     the response (1-12 TODOs, no near-dupes, kebab ids, objective
 *     <= 240 chars), and
 *   - the TODOs reference at least one term from the seed question
 *     (sanity check that the model didn't drift).
 *
 * Run: source ~/.insors && npx tsx scripts/live-section-flow/01-investigation-plan.ts
 */

import { runInvestigationPlan } from '../../src/insrc/agent/section-flow/step-investigation-plan.js';
import type { ScopeStepResult } from '../../src/insrc/agent/section-flow/types.js';
import {
	buildOllama, parseArgs, runTrials, combineChecks,
	checkContainsAny, checkNotRefusal,
	type TrialResult,
} from './_lib.js';

const QUESTION = 'Analyze how the JSON test fixtures in test/integration/data/BB/GRN map to the Pydantic INGRN class definition. Document field coverage and type-mismatch risks.';
const SCOPE: ScopeStepResult = {
	scope:      'M',
	subtype:    'cross-file-mapping',
	reasoning:  'compares JSON fixtures against a Python class -- needs both data + code skills',
	isTrivial:  false,
	contextRefs: [
		{ kind: 'path', value: 'test/integration/data/BB/GRN' },
		{ kind: 'class', value: 'INGRN' },
	],
};

const SEED_TERMS = ['grn', 'ingrn', 'fixture', 'json', 'field', 'mapping', 'class', 'pydantic'];

async function main(): Promise<void> {
	const args = parseArgs(process.argv);
	const provider = buildOllama(args);

	const exit = await runTrials({
		name: 'step-investigation-plan',
		args,
		trial: async (i): Promise<TrialResult> => {
			const t0 = Date.now();
			try {
				const result = await runInvestigationPlan({
					question: QUESTION,
					scope:    SCOPE,
					provider,
				});
				const dur = Date.now() - t0;
				const todoText = result.todos.map(t => t.objective).join(' | ');
				const checks = [
					checkContainsAny(todoText, SEED_TERMS, 'todos'),
					checkNotRefusal(todoText, 'todos'),
				];
				const { outcome, summary } = combineChecks(checks);
				return {
					outcome,
					summary: `${summary}; ${result.todos.length} TODOs, retried=${result.retried}, fastPath=${result.isFastPath}`,
					durationMs: dur,
					details: args.verbose ? {
						todos: result.todos.map(t => `${t.id}: ${t.objective}`),
						reasoning: result.reasoning,
					} : undefined,
				};
			} catch (err) {
				return {
					outcome:    'fail',
					summary:    `runInvestigationPlan threw: ${(err as Error).message}`,
					durationMs: Date.now() - t0,
				};
			}
		},
	});

	process.exit(exit);
}

void main();
