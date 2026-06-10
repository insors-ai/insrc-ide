/**
 * Real-Ollama integration test for the cycle-review v2 writer
 * (Phase 1 of plans/section-flow-architecture-redesign.md).
 *
 * The unit tests assert that the writer produces certain SUBSTRINGS
 * and the extractor accepts well-formed responses. This test closes
 * the loop: a real qwen3.6 instance reads the rendered prompt, emits
 * its own JSON, and the extractor + closure scan must agree with
 * what the model said. Catches:
 *
 *   - The model refusing to emit `stepSummaries` (the new field).
 *   - The model paraphrasing the closure marker keyword (e.g.
 *     "Closes the gap" instead of "CLOSES <id> fully").
 *   - The model inventing gap-ids not in the prompt's fact list.
 *   - The model using numeric indices instead of the literal id.
 *
 * Gated on `INSRC_TEST_OLLAMA=1` + an Ollama daemon serving
 * `qwen3.6:35b-a3b`. Skips cleanly otherwise.
 *
 *   INSRC_TEST_OLLAMA=1 npx tsx --test \
 *     src/insrc/agent/prompts/__tests__/cycle-review.ollama.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	_resetPromptRegistryForTest,
	registerAllPromptWriters,
	getPromptRegistry,
} from '../index.js';
import {
	ollamaTest,
	buildOllamaTestProvider,
	parseJsonResponse,
} from './ollama-harness.js';
import {
	_extractStepSummariesForTest as extractStepSummaries,
	_scanClosureClaimsForTest    as scanClosureClaims,
} from '../../section-flow/step-cycle-review.js';
import { emptyCycleMemory } from '../../content-gen/discovery-plan.js';
import type { LLMMessage } from '../../../shared/types.js';
import type { CatalogSkill } from '../../content-gen/plan-tree-runner.js';
import type {
	DiscoveryStep, StepOutput,
} from '../../content-gen/discovery-plan.js';
import type { RequiredFact } from '../../section-flow/fact-gap-types.js';
import type { TodoSpec } from '../../section-flow/types.js';
import type { CycleReviewWriterInput } from '../writers/cycle-review.js';

test.beforeEach(() => {
	_resetPromptRegistryForTest();
	registerAllPromptWriters();
});

// ---------------------------------------------------------------------------
// Fixture: a small but realistic cycle that targets two known gap-ids
// (`ingrn-fields` + `json-shape`) and produced one ok + one failed step.
// ---------------------------------------------------------------------------

const TODO: TodoSpec = {
	id: 'todo-x',
	objective: 'Map the GRN JSON files to the INGRN Pydantic class.',
	origin: 'initial',
};

const GAP_FACTS: readonly RequiredFact[] = [
	{ id: 'ingrn-fields', fact: 'INGRN class field list', why: 'baseline', status: 'absent' },
	{ id: 'json-shape',   fact: 'GRN JSON top-level shape', why: 'data side', status: 'absent' },
];

const CATALOG: readonly CatalogSkill[] = [
	{ id: 'code.class.extract-fields',     description: 'Extract declared fields of a class entity.',      family: 'class',  owner: 'code-analyzer', inputs: {}, outputPaths: [] },
	{ id: 'data.source.file.sample-shape', description: 'Sample one row of a JSON file, return its shape.', family: 'source', owner: 'data-analyzer', inputs: {}, outputPaths: [] },
];

const STEPS: readonly DiscoveryStep[] = [
	{
		id: 'step-1', intent: 'extract INGRN field list',
		skills: [{ id: 's1.a', skillId: 'code.class.extract-fields', context: 'class=INGRN' }],
		targetsCriteria: [0],
	},
	{
		id: 'step-2', intent: 'sample GRN JSON shape',
		skills: [{ id: 's2.a', skillId: 'data.source.file.sample-shape', context: 'path=grn-basic.json' }],
		targetsCriteria: [1],
	},
];

const CYCLE_OUTPUTS: readonly StepOutput[] = [
	{
		stepId: 'step-1', status: 'ok',
		facts: [
			'INGRN declares 21 fields',
			'fields include: grn_number, grn_date, vendor_details, items[]',
		],
		citations: [{ path: '/repo/insors/grn.py', startLine: 40, endLine: 207 }],
		durationMs: 100,
	},
	{
		stepId: 'step-2', status: 'failed',
		facts: [],
		citations: [],
		durationMs: 50,
	},
];

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------

ollamaTest(test, 'cycle-review v2: real qwen3.6 emits stepSummaries with closure markers', async () => {
	const writer = getPromptRegistry().get<CycleReviewWriterInput, readonly LLMMessage[]>('cycle-review');
	assert.equal(writer.version, 2, 'highest-version selection should pick v2');

	const messages = [...writer.build({
		todo: TODO, gapFacts: GAP_FACTS,
		stepsThisCycle: STEPS, cycleOutputs: CYCLE_OUTPUTS,
		cycleMemory: emptyCycleMemory(GAP_FACTS.map(g => g.fact)),
		cycle: 1, catalog: CATALOG,
		isRetry: false, priorFailureReason: undefined,
	})];

	const provider = buildOllamaTestProvider();
	const response = await provider.complete(messages, {
		maxTokens:       3072,
		temperature:     0,
		responseFormat:  'json',
		disableThinking: true,
	});

	// Structural shape -- the model is allowed to choose keep/new_steps
	// freely, but it MUST emit the four top-level keys (scratchpad is
	// optional, so we treat it leniently).
	const parsed = parseJsonResponse(response) as Record<string, unknown>;
	assert.ok(Array.isArray(parsed['keep']),         'keep must be an array');
	assert.ok(Array.isArray(parsed['new_steps']),    'new_steps must be an array');
	assert.ok(
		parsed['stepSummaries'] !== undefined && parsed['stepSummaries'] !== null,
		'stepSummaries must be present (v2 required field)',
	);

	// Extract via the production code path so we cover both writer +
	// caller in one test.
	const validCalls = new Map<string, ReadonlySet<string>>(
		STEPS.map(s => [s.id, new Set(s.skills.map(sk => sk.id))]),
	);
	const summaries = extractStepSummaries(response.text, validCalls);

	// Both steps' single calls must produce a summary entry.
	assert.ok(summaries['step-1']?.['s1.a'] !== undefined, 'step-1/s1.a must have a summary');
	assert.ok(summaries['step-2']?.['s2.a'] !== undefined, 'step-2/s2.a must have a summary');

	// At least one closure marker must scan cleanly -- proves the
	// model used the fixed vocabulary, not paraphrase.
	const gapIds = new Set(GAP_FACTS.map(g => g.id));
	const claims = scanClosureClaims(summaries, gapIds);
	assert.ok(
		claims.length >= 1,
		`expected at least one parseable closure marker; got summaries=${JSON.stringify(summaries)}`,
	);

	// The failed step (step-2) -- no actual evidence emitted -- should
	// either OFF-TOPIC or PARTIALLY supports something. Anything that
	// claims CLOSES from an empty output is a fabrication.
	const step2Claims = claims.filter(c => c.stepId === 'step-2');
	for (const c of step2Claims) {
		assert.notEqual(
			c.verdict, 'closes-fully',
			`step-2 had status=failed; reviewer must NOT claim CLOSES (got ${JSON.stringify(c)})`,
		);
	}
});
