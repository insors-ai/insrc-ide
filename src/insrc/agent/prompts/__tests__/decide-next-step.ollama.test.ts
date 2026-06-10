/**
 * Real-Ollama integration tests for the decide-next-step writer + caller
 * (Phase 4 of plans/section-flow-architecture-redesign.md).
 *
 * The decide-next-step turn is a CLOUD-tier prompt in production
 * (planning needs the headroom). Running it against local qwen3.6
 * exercises the structural contract:
 *
 *   - The model picks `execute-step` / `replan-sketch` / `terminate`
 *     correctly given the TOC + lastStep.
 *   - On a fixture where every gap has a `CLOSES <gap-id> fully`
 *     marker in the TOC, the model emits `terminate` + verdict=
 *     `covered` rather than scheduling redundant steps (the run-5-7
 *     failure mode the redesign explicitly targets).
 *   - The model emits a parseable `lastStepArtifactSummary` with
 *     closure markers for the last step's call ids.
 *
 * Gated on `INSRC_TEST_OLLAMA=1`. Skips cleanly otherwise.
 *
 *   INSRC_TEST_OLLAMA=1 npx tsx --test \
 *     src/insrc/agent/prompts/__tests__/decide-next-step.ollama.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	_resetPromptRegistryForTest,
	registerAllPromptWriters,
} from '../index.js';
import { ollamaTest, buildOllamaTestProvider } from './ollama-harness.js';
import { runDecideNextStep } from '../../section-flow/step-decide-next-step.js';
import type { CatalogSkill } from '../../content-gen/plan-tree-runner.js';
import type { RequiredFact } from '../../section-flow/fact-gap-types.js';
import type { TodoSpec } from '../../section-flow/types.js';
import type { DiscoveryStep } from '../../content-gen/discovery-plan.js';
import type { DecideLastStepRawOutputs } from '../decide-next-step.js';

test.beforeEach(() => {
	_resetPromptRegistryForTest();
	registerAllPromptWriters();
});

const TODO: TodoSpec = {
	id:        'todo-x',
	objective: 'Map GRN JSON files to the INGRN Pydantic class.',
	origin:    'initial',
};

const CATALOG: readonly CatalogSkill[] = [
	{ id: 'code.entity.locate-by-name',    description: 'Locate a code entity by name; returns entityId + path + lineStart/End.', family: 'entity', owner: 'code-analyzer', inputs: {}, outputPaths: [] },
	{ id: 'code.class.extract-fields',     description: 'Extract declared fields of a class entity by 32-char hex entityId.',     family: 'class',  owner: 'code-analyzer', inputs: {}, outputPaths: [] },
	{ id: 'data.source.file.sample-shape', description: 'Sample one row of a JSON file, return its top-level shape.',             family: 'source', owner: 'data-analyzer', inputs: {}, outputPaths: [] },
];

const GAPS: readonly RequiredFact[] = [
	{ id: 'ingrn-fields', fact: 'INGRN class field list',   why: 'baseline coverage', status: 'absent' },
	{ id: 'json-shape',   fact: 'GRN JSON top-level shape', why: 'data side',         status: 'absent' },
];

const SKETCH: readonly DiscoveryStep[] = [
	{ id: 'step-1', intent: 'locate INGRN by name', skills: [{ id: 's1.a', skillId: 'code.entity.locate-by-name', context: 'name=INGRN' }], targetsCriteria: [0] },
	{ id: 'step-2', intent: 'extract INGRN fields', skills: [{ id: 's2.a', skillId: 'code.class.extract-fields', context: 'use locate entityId', dependsOn: 'step-1.s1.a' }], targetsCriteria: [0] },
	{ id: 'step-3', intent: 'sample GRN JSON shape', skills: [{ id: 's3.a', skillId: 'data.source.file.sample-shape', context: 'path=grn-basic.json' }], targetsCriteria: [1] },
];

// TOC with both gaps already CLOSES-marked. Decide-next-step MUST
// terminate=covered here.
const COVERED_TOC = [
	'## TABLE OF CONTENTS (artifacts available; call shared.memory.get-artifact({id}) to fetch)',
	'',
	'sess-1:1700000003:data.source.file.sample-shape: sampled grn-basic.json showing grn_number, grn_date, vendor_details, items[]. CLOSES json-shape fully',
	'sess-1:1700000002:code.class.extract-fields: INGRN declares 21 fields including vendor_id, buyer_id, items[]. CLOSES ingrn-fields fully',
	'sess-1:1700000001:code.entity.locate-by-name: located INGRN at insors/grn.py:40 with entityId b209...8442. PARTIALLY supports ingrn-fields',
].join('\n');

const LAST_STEP_SAMPLE: DecideLastStepRawOutputs = {
	stepId:     'step-3',
	stepIntent: 'sample GRN JSON shape',
	skills: [{
		callId:  's3.a',
		skillId: 'data.source.file.sample-shape',
		context: 'path=grn-basic.json',
		rawText: JSON.stringify({ topLevelKeys: ['grn_number', 'grn_date', 'vendor_details', 'items'] }),
	}],
};

ollamaTest(test, 'decide-next-step: real qwen3.6 terminates=covered when every gap has a CLOSES marker', async () => {
	const provider = buildOllamaTestProvider();
	const r = await runDecideNextStep({
		todo: TODO, gapFacts: GAPS, sketch: SKETCH, catalog: CATALOG,
		toc: COVERED_TOC, lastStep: LAST_STEP_SAMPLE, provider,
	});

	assert.equal(
		r.action, 'terminate',
		`expected terminate when TOC covers every gap; got action=${r.action} reasoning="${r.reasoning}"`,
	);
	if (r.action === 'terminate') {
		assert.equal(r.verdict, 'covered', `expected verdict=covered; got "${r.verdict}" reasoning="${r.reasoning}"`);
	}

	// The model MUST emit a parseable last-step summary for s3.a -- it
	// has a raw output and the prompt rules require one per callId.
	assert.ok(
		(r.lastStepSummaries['s3.a'] ?? '').length > 0,
		`expected lastStepArtifactSummary[s3.a]; got ${JSON.stringify(r.lastStepSummaries)}`,
	);
});

ollamaTest(test, 'decide-next-step: first turn picks the sketch\'s first step (execute-step)', async () => {
	const provider = buildOllamaTestProvider();
	const r = await runDecideNextStep({
		todo: TODO, gapFacts: GAPS, sketch: SKETCH, catalog: CATALOG,
		toc: '## TABLE OF CONTENTS\n(no artifacts persisted yet)',
		lastStep: undefined, provider,
	});

	assert.equal(
		r.action, 'execute-step',
		`expected execute-step on the first turn with the sketch ready; got action=${r.action} reasoning="${r.reasoning}"`,
	);
	if (r.action === 'execute-step') {
		// Sketch is the default trajectory; first step is locate-by-name.
		assert.equal(
			r.step.skills[0]!.skillId, 'code.entity.locate-by-name',
			`expected first step to follow the sketch (locate-by-name); got ${r.step.skills[0]!.skillId}`,
		);
	}
	// No lastStep -> no summaries.
	assert.deepEqual(r.lastStepSummaries, {});
});
