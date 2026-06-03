/**
 * Tests for the two-stage skill-tree planner runner (P4 of
 * plans/planner-skill-tree.md).
 *
 * All LLM calls are mocked via a scripted fake provider. Coverage:
 *   - Happy path: stage 1 returns a shortlist, stage 2 returns a
 *     valid tree, runner returns degraded:false.
 *   - Stage 1 returns ids not in the catalog -> dropped silently.
 *   - Stage 1 returns nothing -> fallback tree returned.
 *   - Stage 2 returns malformed tree -> retry; if retry succeeds,
 *     happy path; if retry fails, fallback.
 *   - Worked-example tree (embedded in the stage-2 prompt) parses
 *     and validates -- a regression guard so prompt edits don't
 *     ship a bad example.
 *   - Prompt builders produce expected blocks (intent, question,
 *     shortlist instructions, catalog format).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	planTree,
	_stage1SystemPromptForTest as stage1Sys,
	_stage1UserPromptForTest   as stage1User,
	_stage2SystemPromptForTest as stage2Sys,
	_exampleTreeJsonForTest    as exampleTreeJson,
	type CatalogSkill,
	type PlanTreeInput,
} from '../plan-tree-runner.js';
import { validatePlannedTree, type PlannedTree } from '../plan-tree.js';
import type {
	LLMProvider,
	LLMResponse,
	LLMMessage,
	CompletionOpts,
} from '../../../shared/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CATALOG: readonly CatalogSkill[] = [
	{
		id: 'data.source.file.sample-shape',
		owner: 'data-analyzer', family: 'source-sampling',
		description: 'Infer per-field types and frequency from JSON / CSV / Parquet files.',
		inputs: {
			type: 'object',
			properties: { connectionId: { type: 'string' }, limit: { type: 'number' } },
			required: ['connectionId'],
		},
		outputPaths: ['fields', 'fields[*]', 'fields[*].path', 'fields[*].types', 'fields[*].nullable', 'sampleSize'],
	},
	{
		id: 'code.class.extract-fields',
		owner: 'code-analyzer', family: 'code-binding',
		description: 'Extract the named class\'s field list and types from source.',
		inputs: {
			type: 'object',
			properties: {
				className: { type: 'string' },
				language:  { type: 'string' },
				repoPath:  { type: 'string' },
			},
			required: ['className'],
		},
		outputPaths: ['found', 'fields', 'fields[*]', 'fields[*].name', 'fields[*].type'],
	},
	{
		id: 'shared.compare.fields-vs-shape',
		owner: 'shared', family: 'synthesis',
		description: 'Align a class field list with a data shape; emit a structured mapping.',
		inputs: {
			type: 'object',
			properties: {
				classFields: { type: 'array' },
				dataShape:   { type: 'array' },
			},
			required: ['classFields', 'dataShape'],
		},
		outputPaths: ['alignment', 'alignment[*]', 'alignment[*].jsonKey', 'alignment[*].classField', 'alignment[*].match'],
	},
	{
		id: 'data.answer-question',
		owner: 'data-analyzer', family: 'meta',
		description: 'Fallback L2 dispatcher for open-ended data questions.',
		inputs: { type: 'object', properties: { question: { type: 'string' }, connections: { type: 'array' } }, required: ['question'] },
		outputPaths: ['sections', 'sections[*]', 'sections[*].title', 'sections[*].body'],
	},
];

const FALLBACK_TREE: PlannedTree = {
	intentBrief: 'Fallback: L2 dispatcher for the full question.',
	root: {
		id: 'fallback', title: 'Fallback', objective: 'L2 fallback after planner failure.',
		kind: 'leaf', skill: 'data.answer-question', emit: 'section',
		inputs: { question: { source: 'literal', value: 'placeholder' } },
	},
};

const INPUT_BASE: PlanTreeInput = {
	intent:         'data-analysis',
	request:        'Map JSON fixtures to the INGRN pydantic class.',
	summaryContext: '/repo/x -- python project, scope tier M.',
	catalog:        CATALOG,
	fallback:       FALLBACK_TREE,
};

// ---------------------------------------------------------------------------
// Scripted fake provider
// ---------------------------------------------------------------------------

interface Script {
	readonly responses: readonly LLMResponse[];
}

function makeProvider(script: Script): {
	provider: LLMProvider;
	calls:    () => readonly LLMMessage[][];
} {
	let i = 0;
	const calls: LLMMessage[][] = [];
	const provider: LLMProvider = {
		complete: async (messages: LLMMessage[], _opts?: CompletionOpts): Promise<LLMResponse> => {
			calls.push(messages);
			const r = script.responses[i] ?? script.responses[script.responses.length - 1]!;
			i += 1;
			return r;
		},
		stream:   async function* () { yield ''; },
		embed:    async () => [],
		supportsTools: true,
	};
	return { provider, calls: () => calls };
}

function toolUse(name: string, input: unknown): LLMResponse {
	return {
		text:       '',
		stopReason: 'tool_use',
		toolCalls:  [{ id: 'tc-1', name, input: input as Record<string, unknown> }],
		usage:      { inputTokens: 100, outputTokens: 200 },
	};
}

function endTurnNoTool(): LLMResponse {
	return { text: 'nope', stopReason: 'end_turn' };
}

const HAPPY_TREE = {
	intentBrief: 'INGRN comparison.',
	root: {
		id: 'root', title: 't', objective: 'compose',
		kind: 'composition', composition: 'sequence', inputs: {}, emit: 'discard',
		children: [
			{ id: 'cls', title: 't', objective: 'o',
			  kind: 'leaf', skill: 'code.class.extract-fields', emit: 'intermediate',
			  inputs: {
				className: { source: 'question', extract: '\\bINGRN\\b' },
				repoPath:  { source: 'context',  key: 'codeRepoPath' },
			  } },
			{ id: 'shp', title: 't', objective: 'o',
			  kind: 'leaf', skill: 'data.source.file.sample-shape', emit: 'intermediate',
			  inputs: { connectionId: { source: 'context', key: 'primaryConnection' } } },
			{ id: 'aln', title: 't', objective: 'o',
			  kind: 'leaf', skill: 'shared.compare.fields-vs-shape', emit: 'section',
			  inputs: {
				classFields: { source: 'node', nodeId: 'cls', path: 'fields' },
				dataShape:   { source: 'node', nodeId: 'shp', path: 'fields' },
			  } },
		],
	},
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('planTree: happy path -- stage 1 shortlists, stage 2 returns valid tree', async () => {
	const { provider } = makeProvider({
		responses: [
			toolUse('submit_shortlist', { skillIds: ['code.class.extract-fields', 'data.source.file.sample-shape', 'shared.compare.fields-vs-shape'] }),
			toolUse('submit_tree', HAPPY_TREE),
		],
	});

	const result = await planTree(INPUT_BASE, provider);
	assert.equal(result.degraded, false, `expected non-degraded; note=${result.note}`);
	assert.equal(result.tree.root.id, 'root');
	assert.deepEqual([...(result.shortlist ?? [])], ['code.class.extract-fields', 'data.source.file.sample-shape', 'shared.compare.fields-vs-shape']);
});

test('planTree: stage 1 hallucinated ids are dropped silently', async () => {
	const { provider } = makeProvider({
		responses: [
			toolUse('submit_shortlist', {
				skillIds: [
					'code.class.extract-fields',
					'foo.does-not-exist',                  // hallucinated -- dropped
					'data.source.file.sample-shape',
					'shared.compare.fields-vs-shape',
				],
			}),
			toolUse('submit_tree', HAPPY_TREE),
		],
	});

	const result = await planTree(INPUT_BASE, provider);
	assert.equal(result.degraded, false);
	assert.equal((result.shortlist ?? []).includes('foo.does-not-exist'), false);
	assert.equal(result.shortlist?.length, 3);
});

test('planTree: stage 1 returns no recognized ids -> fallback tree', async () => {
	const { provider } = makeProvider({
		responses: [
			toolUse('submit_shortlist', { skillIds: ['foo.bar', 'baz.qux'] }),
		],
	});
	const result = await planTree(INPUT_BASE, provider);
	assert.equal(result.degraded, true);
	assert.match(result.note ?? '', /stage-1/);
	assert.equal(result.tree.root.id, 'fallback');
});

test('planTree: stage 1 returns no tool call -> fallback', async () => {
	const { provider } = makeProvider({ responses: [endTurnNoTool()] });
	const result = await planTree(INPUT_BASE, provider);
	assert.equal(result.degraded, true);
	assert.match(result.note ?? '', /no submit_shortlist tool_use/);
});

test('planTree: stage 2 returns malformed tree -> retries once -> success', async () => {
	const { provider } = makeProvider({
		responses: [
			// Stage 1: ok.
			toolUse('submit_shortlist', { skillIds: ['code.class.extract-fields', 'data.source.file.sample-shape', 'shared.compare.fields-vs-shape'] }),
			// Stage 2 first pass: tree with a forward-ref wire (invalid).
			toolUse('submit_tree', {
				intentBrief: 'bad first pass',
				root: {
					id: 'r', title: 't', objective: 'o',
					kind: 'composition', inputs: {}, emit: 'discard',
					children: [
						{ id: 'a', title: 't', objective: 'o',
						  kind: 'leaf', skill: 'shared.compare.fields-vs-shape', emit: 'section',
						  // Refs sibling 'b' before it -- forward ref, rejected.
						  inputs: {
							classFields: { source: 'node', nodeId: 'b', path: 'fields' },
							dataShape:   { source: 'literal', value: [] },
						  } },
						{ id: 'b', title: 't', objective: 'o',
						  kind: 'leaf', skill: 'code.class.extract-fields', emit: 'intermediate', inputs: {} },
					],
				},
			}),
			// Stage 2 retry: valid tree.
			toolUse('submit_tree', HAPPY_TREE),
		],
	});

	const result = await planTree(INPUT_BASE, provider);
	assert.equal(result.degraded, false, `expected non-degraded after retry; note=${result.note}`);
	assert.equal(result.tree.root.id, 'root');
});

test('planTree: stage 2 fails twice -> fallback tree', async () => {
	const { provider, calls } = makeProvider({
		responses: [
			toolUse('submit_shortlist', { skillIds: ['code.class.extract-fields', 'data.source.file.sample-shape', 'shared.compare.fields-vs-shape'] }),
			// First stage-2 attempt: no tool call.
			endTurnNoTool(),
			// Retry: also no tool call.
			endTurnNoTool(),
		],
	});

	const result = await planTree(INPUT_BASE, provider);
	assert.equal(result.degraded, true);
	assert.match(result.note ?? '', /stage-2/);
	assert.equal(result.tree.root.id, 'fallback');
	// Should have made: stage 1 + stage 2 attempt + stage 2 retry = 3 calls.
	assert.equal(calls().length, 3);
});

test('planTree: empty request throws', async () => {
	const { provider } = makeProvider({ responses: [] });
	await assert.rejects(() => planTree({ ...INPUT_BASE, request: '' }, provider), /non-empty/);
});

// ---------------------------------------------------------------------------
// Worked-example regression guard
// ---------------------------------------------------------------------------

test('embedded worked example: parses + structurally validates', () => {
	const parsed = JSON.parse(exampleTreeJson);
	// Structural validation only -- the example references skill ids that
	// may not exist in the test catalog; the orchestrator's strict lookups
	// would reject them, but the worked example exists to TEACH the shape,
	// not to be executed.
	const r = validatePlannedTree(parsed);
	assert.notEqual(typeof r, 'string', `embedded worked example failed structural validation: ${r as string}`);
});

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

test('stage 1 system prompt: declares submit_shortlist + selection rules', () => {
	const sys = stage1Sys('data-analysis', 12);
	assert.match(sys, /SKILL-SHORTLIST stage/);
	assert.match(sys, /submit_shortlist/);
	assert.match(sys, /pick the 4-12 skills/);
	assert.match(sys, /multiple owners when the question/);
});

test('stage 1 user prompt: includes catalog one-liners with owner/family', () => {
	const user = stage1User(INPUT_BASE);
	assert.match(user, /## Question/);
	assert.match(user, /Map JSON fixtures to the INGRN pydantic class/);
	assert.match(user, /\[code-analyzer \/ code-binding\]/);
	assert.match(user, /\[shared \/ synthesis\]/);
});

test('stage 2 system prompt: teaches wiring DSL + context keys + emit kinds', () => {
	const sys = stage2Sys('data-analysis');
	assert.match(sys, /Wiring DSL/);
	assert.match(sys, /source.*literal.*question.*context.*node/s);
	assert.match(sys, /codeRepoPath/);
	assert.match(sys, /primaryConnection/);
	assert.match(sys, /emit: "section"/);
	assert.match(sys, /emit: "intermediate"/);
	assert.match(sys, /at most 32 leaves, 4 levels deep, 8 children/i);
});
