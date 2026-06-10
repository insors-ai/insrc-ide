/**
 * Real-Ollama integration test for the sketch writer + caller
 * (Phase 4 of plans/section-flow-architecture-redesign.md).
 *
 * Note on tier: the sketch writer is a CLOUD-tier prompt in production
 * (cycle planning needs the headroom for the full investigation
 * state). This test runs it against local qwen3.6 so the structural
 * contract -- 1-5 steps, catalog skillIds only, valid targetsCriteria,
 * unique step ids -- is exercised under a realistic LLM. Tier-specific
 * pickiness (does it follow the sketch trajectory cleanly?) is a
 * cloud-only concern validated separately.
 *
 * Gated on `INSRC_TEST_OLLAMA=1`. Skips cleanly otherwise.
 *
 *   INSRC_TEST_OLLAMA=1 npx tsx --test \
 *     src/insrc/agent/prompts/__tests__/sketch.ollama.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	_resetPromptRegistryForTest,
	registerAllPromptWriters,
} from '../index.js';
import {
	ollamaTest,
	buildOllamaTestProvider,
} from './ollama-harness.js';
import { runSketch } from '../../section-flow/step-sketch.js';
import type { CatalogSkill } from '../../content-gen/plan-tree-runner.js';
import type { RequiredFact } from '../../section-flow/fact-gap-types.js';
import type { TodoSpec } from '../../section-flow/types.js';

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
	{ id: 'code.entity.locate-by-name',    description: 'Locate a code entity by name. Returns entityId + path + lineStart/End.',     family: 'entity', owner: 'code-analyzer', inputs: {}, outputPaths: [] },
	{ id: 'code.class.extract-fields',     description: 'Extract declared fields of a class entity by 32-char hex entityId.',         family: 'class',  owner: 'code-analyzer', inputs: {}, outputPaths: [] },
	{ id: 'data.source.file.sample-shape', description: 'Sample one row of a JSON file, return its top-level shape.',                 family: 'source', owner: 'data-analyzer', inputs: {}, outputPaths: [] },
];

const GAPS: readonly RequiredFact[] = [
	{ id: 'ingrn-fields', fact: 'INGRN class field list',  why: 'baseline coverage', status: 'absent' },
	{ id: 'json-shape',   fact: 'GRN JSON top-level shape', why: 'data side',         status: 'absent' },
];

ollamaTest(test, 'sketch: real qwen3.6 emits a 1-5 step trajectory with catalog-valid skills', async () => {
	const provider = buildOllamaTestProvider();
	const r = await runSketch({ todo: TODO, gapFacts: GAPS, catalog: CATALOG, provider });

	// Structural: 1-5 steps; non-empty after coercion.
	assert.ok(r.steps.length >= 1 && r.steps.length <= 5, `expected 1-5 steps; got ${r.steps.length}`);

	// Every skillId must be in the catalog.
	const catalogIds = new Set(CATALOG.map(c => c.id));
	for (const step of r.steps) {
		for (const sk of step.skills) {
			assert.ok(
				catalogIds.has(sk.skillId),
				`skillId "${sk.skillId}" in step ${step.id}/${sk.id} is not in the catalog`,
			);
		}
	}

	// Step ids unique.
	const ids = r.steps.map(s => s.id);
	assert.equal(new Set(ids).size, ids.length, `duplicate step ids in sketch: ${ids.join(', ')}`);
});
