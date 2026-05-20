/**
 * Phase δ integration tests for plans/code-analyzer-discovery-plan-loop.md.
 *
 * Exercises `runDiscoveryFlow` end-to-end through fake cloud + local
 * providers. Each test pre-loads canned JSON responses; the loop
 * consumes them across cycles. Covers:
 *
 *   - Happy path: cloud expands 2 steps, local executes both, cloud
 *     reviews + emits empty new_steps -> terminate at cycle 1
 *   - Cycle-3 termination: cloud keeps asking; loop hits maxCycles
 *   - Early termination at cycle 2 (cloud says empty new_steps)
 *   - Redraft path: prose reviewer says redraft -> one redraft attempt
 *   - Feature flag toggle (isDiscoveryFlowEnabled)
 *   - Adapter (StepOutput[] -> EvidenceEntry[] for writer)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	runDiscoveryFlow,
	isDiscoveryFlowEnabled,
	_adaptStepOutputsForWriterForTest as adaptStepOutputsForWriter,
	_renderCitationAsStringForTest    as renderCitationAsString,
} from '../discovery-flow.js';
import { registerSkillTools } from '../../../../daemon/tools/builtins/skills/invoke-skill.js';
import type { PlannedAction } from '../../../content-gen/plan-actions.js';
import type { LLMProvider, LLMMessage, LLMResponse, CompletionOpts } from '../../../../shared/types.js';
import type { Session } from '../../../session.js';
import type { StepOutput } from '../../../content-gen/discovery-plan.js';

// Tests rely on the skill_invoke / skill_describe meta-tools being
// registered (executeStep guards against missing tools).
registerSkillTools();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SECTION: PlannedAction = {
	id:                'hdfs-arch',
	title:             'HDFS Architecture & Core Components',
	objective:         'Describe the NameNode + DataNode subsystems.',
	maxBudgetTokens:   2000,
	reviewCriteria: [
		'Names NameNode core classes',
		'Explains block placement',
	],
};

const FAKE_SESSION: Session = {} as unknown as Session;

// Canned local-LLM emission: structured step output JSON.
const LOCAL_STEP_OUTPUT_JSON = JSON.stringify({
	facts: ['FSDirectory anchors the namespace'],
	citations: [{
		path: '/repo/FSDirectory.java',
		startLine: 1,
		endLine: 400,
		label: 'FSDirectory',
	}],
});

const LOCAL_STEP_OUTPUT_NO_CITATIONS_JSON = JSON.stringify({
	facts: ['DataNode module exists'],
	citations: [],
});

const CLOUD_PLAN_CYCLE_1 = JSON.stringify({
	cycle: 1,
	steps: [
		{
			id: 'step-1',
			intent: 'investigate FSDirectory',
			skills: [{ id: 's1.a', skillId: 'code.entity.locate-by-name', context: 'FSDirectory' }],
			targetsCriteria: [0],
		},
		{
			id: 'step-2',
			intent: 'examine DataNode block storage',
			skills: [{ id: 's2.a', skillId: 'code.source.module.describe', context: 'datanode module' }],
			targetsCriteria: [1],
		},
	],
});

const CLOUD_REVIEW_TERMINATE = JSON.stringify({
	keep:      ['step-1', 'step-2'],
	new_steps: [],
});

const CLOUD_REVIEW_MORE_STEPS = JSON.stringify({
	keep:      ['step-1'],
	new_steps: [{
		id: 'step-3',
		intent: 'investigate block placement strategy',
		skills: [{ id: 's3.a', skillId: 'code.entity.locate-by-name', context: 'BlockPlacementPolicy' }],
		targetsCriteria: [1],
	}],
});

const PROSE_ACCEPT = JSON.stringify({ verdict: 'accept', notes: [] });
const PROSE_REDRAFT = JSON.stringify({ verdict: 'redraft', notes: ['paragraph 2 has process narration'] });

// Local writer's prose response (free-form markdown).
const FAKE_PROSE = `FSDirectory anchors the HDFS namespace ([FSDirectory.java](path:/repo/FSDirectory.java#L1-L400)).

The DataNode module exists but the gather did not surface specific block-storage classes.`;

const FAKE_PROSE_REDRAFT = `FSDirectory anchors the HDFS namespace ([FSDirectory.java](path:/repo/FSDirectory.java#L1-L400)).

Block storage details are not available; this is a gap.`;

// ---------------------------------------------------------------------------
// Provider construction
// ---------------------------------------------------------------------------

function fakeProvider(responses: readonly (string | Error)[]): LLMProvider {
	let i = 0;
	return {
		supportsTools: true,
		async complete(_messages: LLMMessage[], _opts?: CompletionOpts): Promise<LLMResponse> {
			const next = responses[i++];
			if (next === undefined) throw new Error(`fake provider out of canned responses (idx=${i - 1})`);
			if (next instanceof Error) throw next;
			return { text: next, stopReason: 'end_turn' };
		},
		async *stream() { return; },
		async embed() { return []; },
	};
}

// ---------------------------------------------------------------------------
// adaptStepOutputsForWriter
// ---------------------------------------------------------------------------

test('adaptStepOutputsForWriter: maps StepOutput[] to EvidenceEntry[] correctly', () => {
	const outs: StepOutput[] = [
		{
			stepId:    'step-1',
			status:    'ok',
			facts:     ['fact one', 'fact two'],
			citations: [{ path: '/a.ts', startLine: 1, endLine: 20, label: 'Foo' }],
			durationMs: 100,
		},
		{
			stepId:    'step-2',
			status:    'partial',
			facts:     ['fact three'],
			citations: [{ path: '/b.ts' }],
			durationMs: 50,
		},
	];
	const out = adaptStepOutputsForWriter(outs);
	assert.equal(out.length, 2);
	assert.equal(out[0]!.skillId, 'step-1');
	assert.equal(out[0]!.confidence, 'high');
	assert.equal(out[0]!.facts.length, 2);
	assert.equal(out[0]!.citations.length, 1);
	assert.equal(out[0]!.citations[0], '[Foo](path:/a.ts#L1-L20)');
	assert.equal(out[1]!.confidence, 'medium');
	// Label falls back to file basename when not provided.
	assert.equal(out[1]!.citations[0], '[b.ts](path:/b.ts)');
});

test('renderCitationAsString: handles each optional combo', () => {
	assert.equal(
		renderCitationAsString({ path: '/foo.ts', startLine: 1, endLine: 10, label: 'L' }),
		'[L](path:/foo.ts#L1-L10)',
	);
	assert.equal(
		renderCitationAsString({ path: '/foo.ts', startLine: 5 }),
		'[foo.ts](path:/foo.ts#L5)',
	);
	assert.equal(
		renderCitationAsString({ path: '/foo.ts' }),
		'[foo.ts](path:/foo.ts)',
	);
});

// ---------------------------------------------------------------------------
// isDiscoveryFlowEnabled
// ---------------------------------------------------------------------------

test('isDiscoveryFlowEnabled: env unset -> false', () => {
	const prior = process.env['INSRC_ANALYZER_FLOW'];
	delete process.env['INSRC_ANALYZER_FLOW'];
	try {
		assert.equal(isDiscoveryFlowEnabled(), false);
	} finally {
		if (prior !== undefined) process.env['INSRC_ANALYZER_FLOW'] = prior;
	}
});

test('isDiscoveryFlowEnabled: env=discovery -> true', () => {
	const prior = process.env['INSRC_ANALYZER_FLOW'];
	process.env['INSRC_ANALYZER_FLOW'] = 'discovery';
	try {
		assert.equal(isDiscoveryFlowEnabled(), true);
	} finally {
		if (prior !== undefined) process.env['INSRC_ANALYZER_FLOW'] = prior;
		else delete process.env['INSRC_ANALYZER_FLOW'];
	}
});

test('isDiscoveryFlowEnabled: any other value -> false', () => {
	const prior = process.env['INSRC_ANALYZER_FLOW'];
	process.env['INSRC_ANALYZER_FLOW'] = 'gather-write';
	try {
		assert.equal(isDiscoveryFlowEnabled(), false);
	} finally {
		if (prior !== undefined) process.env['INSRC_ANALYZER_FLOW'] = prior;
		else delete process.env['INSRC_ANALYZER_FLOW'];
	}
});

// ---------------------------------------------------------------------------
// runDiscoveryFlow end-to-end
// ---------------------------------------------------------------------------

test('runDiscoveryFlow: happy path -- cycle 1 terminates, writer + prose-accept', async () => {
	const cloud = fakeProvider([
		CLOUD_PLAN_CYCLE_1,        // expandDiscoveryPlan
		CLOUD_REVIEW_TERMINATE,    // reviewCycle (terminates)
		PROSE_ACCEPT,              // reviewProse
	]);
	const local = fakeProvider([
		LOCAL_STEP_OUTPUT_JSON,                 // step-1
		LOCAL_STEP_OUTPUT_NO_CITATIONS_JSON,    // step-2 (partial)
		FAKE_PROSE,                              // writer
	]);
	const result = await runDiscoveryFlow({
		localProvider: local,
		cloudProvider: cloud,
		session:       FAKE_SESSION,
		action:        SECTION,
		request:       'analyze HDFS',
		tier:          'XL',
	});
	assert.equal(result.cyclesRun, 1);
	assert.equal(result.retainedStepCount, 2);
	assert.equal(result.proseVerdict, 'accept');
	assert.equal(result.proseRedraftFired, false);
	assert.match(result.markdown, /FSDirectory anchors the HDFS namespace/);
});

test('runDiscoveryFlow: cycle 1 -> cycle 2 with new_steps, terminate at cycle 2', async () => {
	// Cycle 2's review must reference step-3 (the new_step from cycle
	// 1's review); the canned CLOUD_REVIEW_TERMINATE references step-1
	// + step-2 which are stale by cycle 2, so we build a cycle-2-
	// specific termination response inline.
	const cycle2Terminate = JSON.stringify({ keep: ['step-3'], new_steps: [] });
	const cloud = fakeProvider([
		CLOUD_PLAN_CYCLE_1,        // expand cycle 1
		CLOUD_REVIEW_MORE_STEPS,   // review cycle 1 -> keep step-1, new step-3
		cycle2Terminate,           // review cycle 2 -> keep step-3, terminate
		PROSE_ACCEPT,
	]);
	const local = fakeProvider([
		LOCAL_STEP_OUTPUT_JSON,                 // cycle 1: step-1
		LOCAL_STEP_OUTPUT_NO_CITATIONS_JSON,    // cycle 1: step-2
		LOCAL_STEP_OUTPUT_JSON,                 // cycle 2: step-3
		FAKE_PROSE,
	]);
	const result = await runDiscoveryFlow({
		localProvider: local,
		cloudProvider: cloud,
		session:       FAKE_SESSION,
		action:        SECTION,
		request:       'analyze HDFS',
		tier:          'XL',
	});
	assert.equal(result.cyclesRun, 2);
	// Cycle 1 kept step-1; cycle 2 kept step-3 -- total 2 retained.
	assert.equal(result.retainedStepCount, 2);
	assert.equal(result.proseRedraftFired, false);
});

test('runDiscoveryFlow: cycle cap (maxCycles=3) -- cloud keeps asking, loop terminates', async () => {
	const cloud = fakeProvider([
		CLOUD_PLAN_CYCLE_1,        // expand cycle 1
		CLOUD_REVIEW_MORE_STEPS,   // review cycle 1 -> more
		CLOUD_REVIEW_MORE_STEPS,   // review cycle 2 -> more
		CLOUD_REVIEW_MORE_STEPS,   // review cycle 3 -> more (but cap hits)
		PROSE_ACCEPT,
	]);
	const local = fakeProvider([
		LOCAL_STEP_OUTPUT_JSON,                 // cycle 1: step-1
		LOCAL_STEP_OUTPUT_NO_CITATIONS_JSON,    // cycle 1: step-2
		LOCAL_STEP_OUTPUT_JSON,                 // cycle 2: step-3
		LOCAL_STEP_OUTPUT_JSON,                 // cycle 3: step-3 (same id; new ask)
		FAKE_PROSE,
	]);
	const result = await runDiscoveryFlow({
		localProvider: local,
		cloudProvider: cloud,
		session:       FAKE_SESSION,
		action:        SECTION,
		request:       'analyze HDFS',
		tier:          'XL',
	});
	assert.equal(result.cyclesRun, 3);
});

test('runDiscoveryFlow: prose redraft path -- reviewer redraft -> one redraft attempt', async () => {
	const cloud = fakeProvider([
		CLOUD_PLAN_CYCLE_1,
		CLOUD_REVIEW_TERMINATE,
		PROSE_REDRAFT,             // first prose review: redraft
	]);
	const local = fakeProvider([
		LOCAL_STEP_OUTPUT_JSON,
		LOCAL_STEP_OUTPUT_NO_CITATIONS_JSON,
		FAKE_PROSE,                 // first draft
		FAKE_PROSE_REDRAFT,         // redraft
	]);
	const result = await runDiscoveryFlow({
		localProvider: local,
		cloudProvider: cloud,
		session:       FAKE_SESSION,
		action:        SECTION,
		request:       'analyze HDFS',
		tier:          'XL',
	});
	assert.equal(result.proseRedraftFired, true);
	assert.equal(result.proseVerdict, 'redraft');
	// The picker picks the version with more citations. Original
	// has one citation; redraft has one citation. The original is kept
	// (ties go to the original, since redraft.citations > orig fails).
	assert.match(result.markdown, /FSDirectory anchors the HDFS namespace/);
});

test('runDiscoveryFlow: perCycleSummary tracks kept ids per cycle', async () => {
	const cloud = fakeProvider([
		CLOUD_PLAN_CYCLE_1,
		CLOUD_REVIEW_TERMINATE,    // keeps both step-1 + step-2
		PROSE_ACCEPT,
	]);
	const local = fakeProvider([
		LOCAL_STEP_OUTPUT_JSON,
		LOCAL_STEP_OUTPUT_NO_CITATIONS_JSON,
		FAKE_PROSE,
	]);
	const result = await runDiscoveryFlow({
		localProvider: local,
		cloudProvider: cloud,
		session:       FAKE_SESSION,
		action:        SECTION,
		request:       'analyze HDFS',
		tier:          'XL',
	});
	assert.equal(result.perCycleSummary.length, 1);
	assert.equal(result.perCycleSummary[0]!.cycle, 1);
	assert.equal(result.perCycleSummary[0]!.stepsRun, 2);
	assert.deepEqual([...result.perCycleSummary[0]!.keptIds].sort(), ['step-1', 'step-2']);
});
