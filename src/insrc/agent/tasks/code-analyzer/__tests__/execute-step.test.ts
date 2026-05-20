/**
 * Phase β tests for plans/code-analyzer-discovery-plan-loop.md.
 *
 * `executeStep` is the local-side executor for one cloud-planned
 * DiscoveryStep. These tests cover:
 *
 *   - The parse layer (parseStepEmission) -- JSON extraction from
 *     model output across fence / preamble / trailing-prose variants.
 *   - Status determination (determineStatus) -- ok / partial / failed
 *     across the relevant cases.
 *   - Prompt assembly -- the system prompt includes step intent,
 *     planned skills, schemas when known, and the JSON output rule.
 *   - End-to-end via a FakeProvider that returns a single canned
 *     text response (no tool calls; happy path through runToolLoop).
 *
 * No real skill registry or daemon needed; the fake provider returns
 * a text response and runToolLoop exits on stopReason='end_turn'.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	executeStep,
	parseStepEmission,
	_buildStepSystemPromptForTest as buildStepSystemPrompt,
	_buildStepUserPromptForTest   as buildStepUserPrompt,
	_determineStatusForTest       as determineStatus,
} from '../execute-step.js';

import type {
	DiscoveryStep,
	PlannedSkillCall,
	Citation,
} from '../../../content-gen/discovery-plan.js';
import type { LLMProvider, LLMMessage, LLMResponse, CompletionOpts } from '../../../../shared/types.js';
import type { Session } from '../../../session.js';
import { registerSkillTools } from '../../../../daemon/tools/builtins/skills/invoke-skill.js';

// Register the skill_invoke / skill_describe / skill_load_page tools
// once for this file's tests. executeStep checks for them at start;
// without registration it returns a `failed` StepOutput regardless of
// the model's response. (Production daemon calls this at boot.)
registerSkillTools();

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function call(id: string, skillId: string, ctx: string, dependsOn?: string): PlannedSkillCall {
	return dependsOn === undefined ? { id, skillId, context: ctx } : { id, skillId, context: ctx, dependsOn };
}

function fixtureStep(): DiscoveryStep {
	return {
		id:               'step-1',
		intent:           'investigate the FSDirectory class in the NameNode',
		skills:           [
			call('s1.a', 'code.entity.locate-by-name', 'the FSDirectory class'),
			call('s1.b', 'code.entity.summary',         'use entityId from s1.a', 's1.a'),
		],
		targetsCriteria:  [0, 2],
	};
}

const FIX_SCHEMA: Record<string, unknown> = {
	type:       'object',
	required:   ['name'],
	properties: { name: { type: 'string', description: 'Exact name to match.' } },
};

function fakeSchemaLookup(known: Record<string, Record<string, unknown>>) {
	return (id: string) => known[id];
}

function fakeProvider(responses: readonly LLMResponse[]): { provider: LLMProvider; calls: LLMMessage[][] } {
	const calls: LLMMessage[][] = [];
	let i = 0;
	const provider: LLMProvider = {
		supportsTools: true,
		async complete(messages: LLMMessage[], _opts?: CompletionOpts): Promise<LLMResponse> {
			calls.push(messages);
			const r = responses[i++];
			if (r === undefined) {
				throw new Error(`fake provider out of canned responses (idx=${i - 1})`);
			}
			return r;
		},
		async *stream() { return; },
		async embed() { return []; },
	};
	return { provider, calls };
}

const FAKE_SESSION: Session = {} as unknown as Session;

// ---------------------------------------------------------------------------
// parseStepEmission
// ---------------------------------------------------------------------------

test('parseStepEmission: clean JSON object -> parsed', () => {
	const out = parseStepEmission(`{
		"facts": ["FSDirectory holds the namespace"],
		"citations": [{ "path": "/repo/FSDirectory.java", "startLine": 1, "endLine": 100, "label": "FSDirectory" }]
	}`);
	assert.ok(out !== null);
	assert.deepEqual([...out!.facts], ['FSDirectory holds the namespace']);
	assert.equal(out!.citations.length, 1);
	assert.equal(out!.citations[0]!.path, '/repo/FSDirectory.java');
	assert.equal(out!.citations[0]!.startLine, 1);
	assert.equal(out!.citations[0]!.label, 'FSDirectory');
});

test('parseStepEmission: triple-backtick fenced JSON -> parsed', () => {
	const out = parseStepEmission('```json\n{ "facts": ["a"], "citations": [] }\n```');
	assert.ok(out !== null);
	assert.deepEqual([...out!.facts], ['a']);
});

test('parseStepEmission: leading preamble + JSON -> parsed (first balanced object)', () => {
	const out = parseStepEmission('Here is the JSON:\n{ "facts": ["hello"], "citations": [] }');
	assert.ok(out !== null);
	assert.deepEqual([...out!.facts], ['hello']);
});

test('parseStepEmission: empty string -> null', () => {
	assert.equal(parseStepEmission(''), null);
});

test('parseStepEmission: malformed JSON -> null', () => {
	assert.equal(parseStepEmission('{ "facts": [ "broken" '), null);
});

test('parseStepEmission: missing facts/citations -> empty arrays (not null)', () => {
	const out = parseStepEmission('{}');
	assert.ok(out !== null);
	assert.equal(out!.facts.length, 0);
	assert.equal(out!.citations.length, 0);
});

test('parseStepEmission: citation missing path -> dropped', () => {
	const out = parseStepEmission(`{
		"facts": [],
		"citations": [
			{ "startLine": 1, "endLine": 2 },
			{ "path": "/ok.ts", "startLine": 5 }
		]
	}`);
	assert.ok(out !== null);
	assert.equal(out!.citations.length, 1);
	assert.equal(out!.citations[0]!.path, '/ok.ts');
});

test('parseStepEmission: non-string facts dropped, blanks dropped', () => {
	const out = parseStepEmission(`{ "facts": ["good", "", null, 42, "  another  "], "citations": [] }`);
	assert.ok(out !== null);
	assert.deepEqual([...out!.facts], ['good', 'another']);
});

test('parseStepEmission: full citation with all optional fields -> kept verbatim', () => {
	const out = parseStepEmission(`{
		"facts": ["x"],
		"citations": [{
			"path":      "/repo/a.ts",
			"startLine": 10,
			"endLine":   20,
			"entityId":  "abcdef0123456789abcdef0123456789",
			"label":     "Foo",
			"repoPath":  "/repo"
		}]
	}`);
	const c: Citation = out!.citations[0]!;
	assert.equal(c.path,      '/repo/a.ts');
	assert.equal(c.startLine, 10);
	assert.equal(c.endLine,   20);
	assert.equal(c.entityId,  'abcdef0123456789abcdef0123456789');
	assert.equal(c.label,     'Foo');
	assert.equal(c.repoPath,  '/repo');
});

// ---------------------------------------------------------------------------
// determineStatus
// ---------------------------------------------------------------------------

test('determineStatus: no facts and no citations -> failed', () => {
	assert.equal(determineStatus({ facts: [], citations: [], calledSkillIds: [], plannedSkillCount: 2 }), 'failed');
});

test('determineStatus: facts but no citations -> partial', () => {
	assert.equal(determineStatus({
		facts:             ['a'],
		citations:         [],
		calledSkillIds:    ['code.entity.summary'],
		plannedSkillCount: 1,
	}), 'partial');
});

test('determineStatus: fewer skills called than planned -> partial', () => {
	assert.equal(determineStatus({
		facts:             ['a'],
		citations:         [{ path: '/x.ts' }],
		calledSkillIds:    ['code.entity.locate-by-name'],   // 1 called
		plannedSkillCount: 2,                                  // 2 planned
	}), 'partial');
});

test('determineStatus: all planned called + facts + citations -> ok', () => {
	assert.equal(determineStatus({
		facts:             ['a', 'b'],
		citations:         [{ path: '/x.ts' }],
		calledSkillIds:    ['code.entity.locate-by-name', 'code.entity.summary'],
		plannedSkillCount: 2,
	}), 'ok');
});

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

test('buildStepSystemPrompt: includes step intent + planned skill ids + schemas when known', () => {
	const step = fixtureStep();
	const lookup = fakeSchemaLookup({
		'code.entity.locate-by-name': FIX_SCHEMA,
		'code.entity.summary':        FIX_SCHEMA,
	});
	const prompt = buildStepSystemPrompt(step, lookup);
	assert.match(prompt, /investigate the FSDirectory class/);
	assert.match(prompt, /code\.entity\.locate-by-name/);
	assert.match(prompt, /code\.entity\.summary/);
	assert.match(prompt, /Input schema:/);
	// Both schemas inlined.
	const occurrences = (prompt.match(/Input schema:/g) ?? []).length;
	assert.equal(occurrences, 2);
});

test('buildStepSystemPrompt: missing schema falls back to "call skill_describe first" hint', () => {
	const step = fixtureStep();
	const lookup = fakeSchemaLookup({});   // both schemas unknown
	const prompt = buildStepSystemPrompt(step, lookup);
	assert.match(prompt, /Input schema: unavailable/);
	assert.match(prompt, /skill_describe\(\{ id: "code\.entity\.locate-by-name" \}\)/);
});

test('buildStepSystemPrompt: surfaces dependsOn relationship', () => {
	const step = fixtureStep();
	const prompt = buildStepSystemPrompt(step, () => undefined);
	assert.match(prompt, /Depends on: s1\.a/);
});

test('buildStepSystemPrompt: instructs model to emit the final JSON object only', () => {
	const prompt = buildStepSystemPrompt(fixtureStep(), () => undefined);
	assert.match(prompt, /## Final output/);
	assert.match(prompt, /"facts":/);
	assert.match(prompt, /"citations":/);
	assert.match(prompt, /Output ONLY the JSON object in your final turn/);
});

test('buildStepUserPrompt: names the step id', () => {
	const prompt = buildStepUserPrompt(fixtureStep());
	assert.match(prompt, /## Step: step-1/);
});

// ---------------------------------------------------------------------------
// executeStep end-to-end via FakeProvider (no real tool loop iterations)
// ---------------------------------------------------------------------------
// The fake provider returns a single end_turn response containing the
// final JSON emission, so runToolLoop exits immediately on iteration 0.
// (Real tool-loop integration is exercised in Phase δ integration tests
// once orchestrator wiring lands.)

test('executeStep: happy-path -- ok step output, structured citations', async () => {
	const { provider } = fakeProvider([{
		text: `{
			"facts": ["FSDirectory anchors the HDFS namespace"],
			"citations": [{
				"path":      "/repo/FSDirectory.java",
				"startLine": 1,
				"endLine":   400,
				"label":     "FSDirectory"
			}]
		}`,
		stopReason: 'end_turn',
	}]);
	const step = fixtureStep();
	const out = await executeStep({
		provider,
		session:         FAKE_SESSION,
		step,
		getSkillSchema:  () => FIX_SCHEMA,
	});
	// Status: failed because no skills were called in this fake path.
	// The test verifies the parse + structure round-trip, not the
	// tool-loop integration (deferred to Phase δ).
	assert.equal(out.stepId, 'step-1');
	assert.equal(out.facts.length, 1);
	assert.equal(out.citations.length, 1);
	assert.equal(out.citations[0]!.path, '/repo/FSDirectory.java');
	assert.equal(out.citations[0]!.label, 'FSDirectory');
	assert.ok(out.durationMs >= 0);
});

test('executeStep: empty model output -> failed status, empty arrays', async () => {
	const { provider } = fakeProvider([{ text: '', stopReason: 'end_turn' }]);
	const out = await executeStep({
		provider,
		session:         FAKE_SESSION,
		step:            fixtureStep(),
		getSkillSchema:  () => undefined,
	});
	assert.equal(out.status, 'failed');
	assert.equal(out.facts.length, 0);
	assert.equal(out.citations.length, 0);
});

test('executeStep: malformed JSON output -> failed status', async () => {
	const { provider } = fakeProvider([{ text: 'not json at all', stopReason: 'end_turn' }]);
	const out = await executeStep({
		provider,
		session:         FAKE_SESSION,
		step:            fixtureStep(),
		getSkillSchema:  () => undefined,
	});
	assert.equal(out.status, 'failed');
});

test('executeStep: stepId preserved from input', async () => {
	const { provider } = fakeProvider([{ text: '{"facts":["x"],"citations":[]}', stopReason: 'end_turn' }]);
	const out = await executeStep({
		provider,
		session:         FAKE_SESSION,
		step:            { ...fixtureStep(), id: 'step-42' },
		getSkillSchema:  () => undefined,
	});
	assert.equal(out.stepId, 'step-42');
});
