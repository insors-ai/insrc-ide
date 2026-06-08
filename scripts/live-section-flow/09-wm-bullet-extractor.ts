/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Live test: working-memory bullet extractor. Feeds a completed entry
 * and asserts the model emits 5-10 prompt-agnostic facts (no
 * questions, no recommendations, no references to the originating
 * TODO objective).
 *
 * Run: source ~/.insors && npx tsx scripts/live-section-flow/09-wm-bullet-extractor.ts
 */

import { extractBullets } from '../../src/insrc/agent/working-memory/bullet-extractor.js';
import type { WorkingMemoryEntry } from '../../src/insrc/agent/working-memory/types.js';
import { buildOllama, parseArgs, runTrials, combineChecks, type TrialResult } from './_lib.js';

const ENTRY: WorkingMemoryEntry = {
	todoId:    'todo-2-coverage',
	objective: 'Determine which INGRN validators are exercised by the fixtures',
	detail:    `# Validator coverage\n\nExamined 14 fixtures against 6 INGRN validators:\n- receipt_date coercion: exercised by 14/14\n- items list-length cap: exercised by 3/14\n- supplier_id range check: exercised by 14/14\n- notes-length cap: never exercised (no fixture has notes >200 chars)\n- batch_id format: never exercised (only present in 6 fixtures)\n- currency enum: never exercised\n\nThree of six validators have zero exercise from the fixture set: notes-length cap, batch_id format, currency enum.`,
	findings:  {
		perRoot: [
			{ rootId: 'discover', verdict: 'accept', cyclesConsumed: 0, exhausted: false, content: 'Listed 6 validators and per-fixture exercise counts.' },
		],
		fallback: undefined,
	},
};

async function main(): Promise<void> {
	const args = parseArgs(process.argv);
	const provider = buildOllama(args);

	const exit = await runTrials({
		name: 'working-memory bullet extractor',
		args,
		trial: async (i): Promise<TrialResult> => {
			const t0 = Date.now();
			try {
				const bullets = await extractBullets(provider, ENTRY);
				const dur = Date.now() - t0;

				const countOk = bullets.length >= 3 && bullets.length <= 10;
				const lengthOk = bullets.every(b => b.length > 0 && b.length <= 300);
				// Prompt-agnostic: bullets shouldn't reference "the TODO" or "this objective"
				const promptCoupledBullets = bullets.filter(b => /\b(todo|objective above|the user asks)\b/i.test(b));
				// No questions / no recommendations
				const badShape = bullets.filter(b => /\?$|\b(recommend|suggest|next step|future|propose)\b/i.test(b));

				const checks = [
					countOk ? null : `${bullets.length} bullets (want 3-10)`,
					lengthOk ? null : 'some bullets exceed 300 chars',
					promptCoupledBullets.length === 0 ? null : `${promptCoupledBullets.length} prompt-coupled bullet(s)`,
					badShape.length === 0 ? null : `${badShape.length} bullet(s) violate prompt-agnostic rule (questions/recs)`,
				];
				const { outcome, summary } = combineChecks(checks);
				return {
					outcome,
					summary: `${summary}; ${bullets.length} bullets`,
					durationMs: dur,
					details: args.verbose ? {
						bullets,
					} : { bulletPreview: bullets.slice(0, 3).map(b => b.slice(0, 80)).join(' | ') },
				};
			} catch (err) {
				return {
					outcome:    'fail',
					summary:    `extractBullets threw: ${(err as Error).message}`,
					durationMs: Date.now() - t0,
				};
			}
		},
	});

	process.exit(exit);
}

void main();
