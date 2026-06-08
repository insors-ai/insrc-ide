/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Live test: per-leaf shape resolver (the 2-step executor's first stage).
 *
 * Picks a specific real registered skill, hands the resolver a thin
 * leaf objective + a synthetic prior-output map, and asserts:
 *   - The resolver returns kind:'ok' with args satisfying the skill's
 *     `required` set (the bar the end-to-end run failed when leaves
 *     hit `invalid-input` every time).
 *   - The args reference values that could only have come from the
 *     prior outputs / context (not invented).
 *
 * Run: source ~/.insors && npx tsx scripts/live-section-flow/10-shape-resolve.ts
 */

import { resolveSkillShape } from '../../src/insrc/agent/section-flow/shape-resolve.js';
import { registerAllSkills } from '../../src/insrc/daemon/skills/index.js';
import { getSkill } from '../../src/insrc/daemon/skills/registry.js';
import { buildOllama, parseArgs, runTrials, combineChecks, type TrialResult } from './_lib.js';

// Pick a skill from the data-analyzer side that takes a connectionId
// + a file path -- representative of what a "discover the data shape"
// leaf in the section-flow would invoke.
const SKILL_ID = 'data.source.file.sample-shape';

const OBJECTIVE = 'Sample the GRN test fixture at test/integration/data/BB/GRN/grn-basic.json and extract its top-level field shape.';
const PRIOR_OUTPUTS = {
	'discover-files': JSON.stringify({
		files: [
			{ path: 'test/integration/data/BB/GRN/grn-basic.json',           size: 2048 },
			{ path: 'test/integration/data/BB/GRN/grn-missing-fields.json',  size: 1500 },
			{ path: 'test/integration/data/BB/GRN/grn-extra-fields.json',    size: 2200 },
		],
	}),
};
const USER_QUESTION = 'Analyze how the JSON test fixtures in test/integration/data/BB/GRN map to the Pydantic INGRN class.';
const CONTEXT_BAG = {
	sessionId:         'live-test-session',
	primaryConnection: 'fs-local',
	codeRepoPath:      '/repo/root',
};

async function main(): Promise<void> {
	const args = parseArgs(process.argv);
	const provider = buildOllama(args);

	registerAllSkills();
	const skill = getSkill(SKILL_ID);
	if (skill === undefined) {
		console.error(`required skill ${SKILL_ID} is not registered; aborting`);
		process.exit(2);
	}
	const required = Array.isArray((skill.inputs as Record<string, unknown>)['required'])
		? ((skill.inputs as Record<string, unknown>)['required'] as string[])
		: [];
	console.log(`(skill ${SKILL_ID}: required=[${required.join(',')}])`);

	const exit = await runTrials({
		name: 'shape-resolve (2-step executor stage 1)',
		args,
		trial: async (i): Promise<TrialResult> => {
			const t0 = Date.now();
			const result = await resolveSkillShape({
				skillId:      SKILL_ID,
				objective:    OBJECTIVE,
				priorOutputs: PRIOR_OUTPUTS,
				userQuestion: USER_QUESTION,
				contextBag:   CONTEXT_BAG,
				provider,
			});
			const dur = Date.now() - t0;
			if (result.kind === 'failed') {
				return {
					outcome:    'fail',
					summary:    `resolveSkillShape failed: ${result.reason} (retried=${result.retried})`,
					durationMs: dur,
				};
			}
			const argKeys = Object.keys(result.args);
			const missing = required.filter(r => !argKeys.includes(r));
			// Sanity: did the model surface a value that traces back to the
			// prior output? Look for the basic.json path in any string arg.
			const referencesPrior = JSON.stringify(result.args).includes('grn-basic.json');

			const checks = [
				missing.length === 0 ? null : `missing required: ${missing.join(', ')}`,
				referencesPrior ? null : 'args do not reference any value from the prior output (possibly invented from thin air)',
			];
			const { outcome, summary } = combineChecks(checks);
			return {
				outcome,
				summary: `${summary}; argKeys=[${argKeys.join(',')}] retried=${result.retried}`,
				durationMs: dur,
				details: args.verbose ? {
					argsJson: result.args,
				} : { args: JSON.stringify(result.args).slice(0, 200) },
			};
		},
	});

	process.exit(exit);
}

void main();
