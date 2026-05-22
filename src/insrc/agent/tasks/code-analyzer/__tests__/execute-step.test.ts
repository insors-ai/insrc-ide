/**
 * Tests for executeStep after the per-result-summarization rewrite
 * ([plans/code-analyzer-execute-step-per-result-summarization.md]).
 *
 * Coverage:
 *   - Pure helpers: inferCriteriaForStep, uniqueFlattenFacts,
 *     mergeCitations, parseLegacyCitation, renderEntryStub.
 *   - determineStatus: ok / partial / failed across the relevant cases
 *     (now keyed on evidence.length, not just facts).
 *   - Prompt assembly: system prompt mentions per-result evidence
 *     capture and the "STOP calling tools" exit; the closing-envelope
 *     contract is gone.
 *   - End-to-end behavior via FakeProvider where the model emits no
 *     tool calls -- verifies the soft-stop path returns whatever
 *     evidence was captured (in these tests: zero).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	executeStep,
	renderEntryStub,
	formatArgsInline,
	applyEvictionWindow,
	_buildStepSystemPromptForTest    as buildStepSystemPrompt,
	_buildStepUserPromptForTest      as buildStepUserPrompt,
	_determineStatusForTest          as determineStatus,
	_inferCriteriaForStepForTest     as inferCriteriaForStep,
	_uniqueFlattenFactsForTest       as uniqueFlattenFacts,
	_mergeCitationsForTest           as mergeCitations,
	_parseLegacyCitationForTest      as parseLegacyCitation,
	_DEFAULT_EVICTION_WINDOW         as DEFAULT_EVICTION_WINDOW,
	type _EvictableEntryForTest      as EvictableEntry,
} from '../execute-step.js';

import type {
	DiscoveryStep,
	PlannedSkillCall,
} from '../../../content-gen/discovery-plan.js';
import type { EvidenceEntry } from '../summarize-result.js';
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

function fakeProvider(responses: readonly LLMResponse[]): { provider: LLMProvider; calls: LLMMessage[][] } {
	const calls: LLMMessage[][] = [];
	let i = 0;
	const provider: LLMProvider = {
		supportsTools: true,
		async complete(messages: LLMMessage[], _opts?: CompletionOpts): Promise<LLMResponse> {
			calls.push([...messages]);
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

function fixtureEntry(overrides: Partial<EvidenceEntry> = {}): EvidenceEntry {
	return {
		skillId:    'code.entity.locate-by-name',
		args:       { name: 'FSDirectory' },
		facts:      ['Found 3 entities named FSDirectory'],
		citations:  ['path:/repo/FSDirectory.java#L1-L400'],
		confidence: 'high',
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// inferCriteriaForStep
// ---------------------------------------------------------------------------

test('inferCriteriaForStep: returns 3 criteria including the step intent', () => {
	const crit = inferCriteriaForStep(fixtureStep());
	assert.equal(crit.length, 3);
	assert.ok(crit[0]!.includes('investigate the FSDirectory class'));
	assert.ok(crit.some(c => /specific entities/.test(c)));
	assert.ok(crit.some(c => /citations verbatim/.test(c)));
});

// ---------------------------------------------------------------------------
// uniqueFlattenFacts
// ---------------------------------------------------------------------------

test('uniqueFlattenFacts: dedups across entries case-insensitively', () => {
	const out = uniqueFlattenFacts([
		fixtureEntry({ facts: ['Found 3 entities', 'INode tree class'] }),
		fixtureEntry({ facts: ['found 3 entities', 'Another fact'] }),
	]);
	assert.deepEqual([...out], ['Found 3 entities', 'INode tree class', 'Another fact']);
});

test('uniqueFlattenFacts: empty / blank facts are dropped', () => {
	const out = uniqueFlattenFacts([
		fixtureEntry({ facts: ['real', '', '   '] }),
	]);
	assert.deepEqual([...out], ['real']);
});

// ---------------------------------------------------------------------------
// parseLegacyCitation
// ---------------------------------------------------------------------------

test('parseLegacyCitation: path with line range -> structured', () => {
	const c = parseLegacyCitation('path:/repo/a.ts#L1-L20');
	assert.deepEqual(c, { path: '/repo/a.ts', startLine: 1, endLine: 20 });
});

test('parseLegacyCitation: path with single line -> structured', () => {
	const c = parseLegacyCitation('path:/repo/a.ts#L42');
	assert.deepEqual(c, { path: '/repo/a.ts', startLine: 42 });
});

test('parseLegacyCitation: path without #L -> path only', () => {
	const c = parseLegacyCitation('path:/repo/a.ts');
	assert.deepEqual(c, { path: '/repo/a.ts' });
});

test('parseLegacyCitation: empty -> null', () => {
	assert.equal(parseLegacyCitation(''), null);
});

test('parseLegacyCitation: tolerates missing path: prefix', () => {
	const c = parseLegacyCitation('/repo/a.ts#L1-L5');
	assert.deepEqual(c, { path: '/repo/a.ts', startLine: 1, endLine: 5 });
});

// ---------------------------------------------------------------------------
// mergeCitations
// ---------------------------------------------------------------------------

test('mergeCitations: dedups on (path, startLine, endLine) across entries', () => {
	const out = mergeCitations([
		fixtureEntry({ citations: ['path:/repo/a.ts#L1-L20'] }),
		fixtureEntry({ citations: ['path:/repo/a.ts#L1-L20', 'path:/repo/b.ts#L5-L9'] }),
	]);
	assert.equal(out.length, 2);
	assert.equal(out[0]!.path, '/repo/a.ts');
	assert.equal(out[1]!.path, '/repo/b.ts');
});

test('mergeCitations: prefers citationObjs when present', () => {
	const out = mergeCitations([
		{
			skillId:      'x',
			args:         {},
			facts:        ['fact'],
			citations:    ['path:/repo/a.ts#L1'],
			citationObjs: [{ path: '/repo/a.ts', startLine: 1, endLine: 50, label: 'Foo' }],
			confidence:   'high',
		},
	]);
	assert.equal(out.length, 1);
	assert.equal(out[0]!.endLine, 50);
	assert.equal(out[0]!.label, 'Foo');
});

// ---------------------------------------------------------------------------
// renderEntryStub (Phase 7 evicted-tool_result stub)
// ---------------------------------------------------------------------------

test('renderEntryStub: golden header with skillId + args', () => {
	const stub = renderEntryStub('e_3', fixtureEntry(), 'code.entity.locate-by-name', { name: 'FSDirectory' });
	assert.match(stub, /^\[evicted tool_result e_3: code\.entity\.locate-by-name\(name="FSDirectory"\)/);
});

test('renderEntryStub: surfaces facts verbatim under "facts:" header', () => {
	const stub = renderEntryStub('e_1', fixtureEntry({
		facts: ['FSDirectory class at lines 106-2081', 'BlockManager has 3 callers'],
	}), 'sk', {});
	assert.match(stub, /facts:\n {4}- FSDirectory class at lines 106-2081\n {4}- BlockManager has 3 callers/);
});

test('renderEntryStub: surfaces citations and confidence', () => {
	const stub = renderEntryStub('e_1', fixtureEntry({
		facts:      ['fact1'],
		citations:  ['path:/repo/a.ts#L1-L20', 'path:/repo/b.ts#L5'],
		confidence: 'medium',
	}), 'sk', {});
	assert.match(stub, /confidence: medium/);
	assert.match(stub, /citations: path:\/repo\/a\.ts#L1-L20; path:\/repo\/b\.ts#L5/);
});

test('renderEntryStub: states original is not recoverable + warns against skill_load_page', () => {
	// Honest replacement for the Phase 2.5 "raw result available via skill_load_page" lie.
	const stub = renderEntryStub('e_1', fixtureEntry(), 'sk', {});
	assert.match(stub, /original tool_result evicted; not recoverable/);
	assert.match(stub, /do NOT call skill_load_page with this id/);
	assert.doesNotMatch(stub, /raw result available via skill_load_page/);
});

test('renderEntryStub: truncates very long string args', () => {
	const longName = 'a'.repeat(100);
	const stub = renderEntryStub('e_1', fixtureEntry(), 'sk', { name: longName });
	assert.match(stub, /name="a{30}\.\.\."/);
});

test('renderEntryStub: arrays + nested objects render as size markers', () => {
	const stub = renderEntryStub(
		'e_1',
		fixtureEntry(),
		'sk',
		{ items: [1, 2, 3, 4], nested: { a: 1, b: 2 } },
	);
	assert.match(stub, /items=\[4\]/);
	assert.match(stub, /nested=\{2 keys\}/);
});

test('renderEntryStub: stays under ~800 chars even for chunky entries with full facts', () => {
	const stub = renderEntryStub('e_42', fixtureEntry({
		facts:     ['f1', 'f2', 'f3', 'f4'],
		citations: ['path:/repo/a.ts#L1-L10', 'path:/repo/b.ts#L100-L200'],
	}), 'code.entity.locate-by-name', { name: 'FSDirectory', kinds: ['class', 'function'], language: 'java' });
	// Phase 7 surfaces facts + citations verbatim (vs Phase 2.5's bare counts);
	// budget loosens from ~400 to ~800 chars to accommodate.
	assert.ok(stub.length < 800, `stub is ${stub.length} chars`);
});

// ---------------------------------------------------------------------------
// applyEvictionWindow (Phase 7 sliding window)
// ---------------------------------------------------------------------------

function makeEvictableEntry(entryId: string): EvictableEntry {
	return {
		block:   { type: 'tool_result', tool_use_id: `tu_${entryId}`, content: `RAW_${entryId}` },
		entryId,
		entry:   fixtureEntry({ facts: [`${entryId} fact`] }),
		skillId: 'code.entity.locate-by-name',
		args:    { name: entryId },
		evicted: false,
	};
}

test('applyEvictionWindow: window=1 keeps the most recent raw, stubs older', () => {
	const entries: EvictableEntry[] = [
		makeEvictableEntry('e_1'),
		makeEvictableEntry('e_2'),
		makeEvictableEntry('e_3'),
	];
	applyEvictionWindow(entries, 1);
	assert.equal(entries[0]!.evicted, true);
	assert.equal(entries[1]!.evicted, true);
	assert.equal(entries[2]!.evicted, false);
	assert.match(entries[0]!.block.content, /^\[evicted tool_result e_1:/);
	assert.match(entries[1]!.block.content, /^\[evicted tool_result e_2:/);
	assert.equal(entries[2]!.block.content, 'RAW_e_3');   // most recent stays raw
});

test('applyEvictionWindow: window=0 stubs everything (legacy Phase 2.5 behavior)', () => {
	const entries: EvictableEntry[] = [
		makeEvictableEntry('e_1'),
		makeEvictableEntry('e_2'),
	];
	applyEvictionWindow(entries, 0);
	assert.equal(entries[0]!.evicted, true);
	assert.equal(entries[1]!.evicted, true);
	assert.match(entries[0]!.block.content, /^\[evicted tool_result e_1:/);
	assert.match(entries[1]!.block.content, /^\[evicted tool_result e_2:/);
});

test('applyEvictionWindow: window=2 keeps the last two raw', () => {
	const entries: EvictableEntry[] = [
		makeEvictableEntry('e_1'),
		makeEvictableEntry('e_2'),
		makeEvictableEntry('e_3'),
		makeEvictableEntry('e_4'),
	];
	applyEvictionWindow(entries, 2);
	assert.equal(entries[0]!.evicted, true);
	assert.equal(entries[1]!.evicted, true);
	assert.equal(entries[2]!.evicted, false);
	assert.equal(entries[3]!.evicted, false);
	assert.equal(entries[2]!.block.content, 'RAW_e_3');
	assert.equal(entries[3]!.block.content, 'RAW_e_4');
});

test('applyEvictionWindow: window >= entries.length is a no-op', () => {
	const entries: EvictableEntry[] = [
		makeEvictableEntry('e_1'),
		makeEvictableEntry('e_2'),
	];
	applyEvictionWindow(entries, 5);
	assert.equal(entries[0]!.evicted, false);
	assert.equal(entries[1]!.evicted, false);
	assert.equal(entries[0]!.block.content, 'RAW_e_1');
	assert.equal(entries[1]!.block.content, 'RAW_e_2');
});

test('applyEvictionWindow: idempotent -- re-evicting an already-evicted entry is a no-op', () => {
	const entries: EvictableEntry[] = [
		makeEvictableEntry('e_1'),
		makeEvictableEntry('e_2'),
	];
	applyEvictionWindow(entries, 1);
	const stubAfterFirstCall = entries[0]!.block.content;
	// Manually mutate to detect double-stubbing.
	entries[0]!.block.content = 'TAMPERED';
	applyEvictionWindow(entries, 1);
	// Already-evicted entry was NOT re-written (the evicted flag short-circuits).
	assert.equal(entries[0]!.block.content, 'TAMPERED');
	// And the second entry (now older after a hypothetical new push) would be stubbed,
	// but here it's still the most-recent so it stays raw.
	assert.equal(entries[1]!.block.content, 'RAW_e_2');
	// Sanity: the original stub format is what we expected.
	assert.match(stubAfterFirstCall, /^\[evicted tool_result e_1:/);
});

test('applyEvictionWindow: negative window is treated as 0', () => {
	const entries: EvictableEntry[] = [makeEvictableEntry('e_1')];
	applyEvictionWindow(entries, -3);
	assert.equal(entries[0]!.evicted, true);
});

test('DEFAULT_EVICTION_WINDOW is 1', () => {
	assert.equal(DEFAULT_EVICTION_WINDOW, 1);
});

// ---------------------------------------------------------------------------
// formatArgsInline (shared by formatProgressLine + renderEntryStub)
// ---------------------------------------------------------------------------

test('formatArgsInline: quotes string values', () => {
	assert.equal(formatArgsInline({ name: 'FSDirectory' }), 'name="FSDirectory"');
});

test('formatArgsInline: renders numbers + booleans bare', () => {
	assert.equal(formatArgsInline({ pageIndex: 2, includeBody: true, verbose: false }), 'pageIndex=2, includeBody=true, verbose=false');
});

test('formatArgsInline: arrays render as [N] size marker', () => {
	assert.equal(formatArgsInline({ kinds: ['class', 'function', 'method'] }), 'kinds=[3]');
});

test('formatArgsInline: nested objects render as {N keys}', () => {
	assert.equal(formatArgsInline({ filter: { a: 1, b: 2, c: 3 } }), 'filter={3 keys}');
});

test('formatArgsInline: truncates string values at 30 chars with "..." suffix', () => {
	const long = 'a'.repeat(100);
	assert.equal(formatArgsInline({ name: long }), `name="${'a'.repeat(30)}..."`);
});

test('formatArgsInline: keeps strings up to 30 chars intact', () => {
	const exactly30 = 'a'.repeat(30);
	assert.equal(formatArgsInline({ name: exactly30 }), `name="${exactly30}"`);
});

test('formatArgsInline: caps total length around 80 chars + appends "..."', () => {
	const result = formatArgsInline({
		a: 'short value here',
		b: 'another value',
		c: 'and a third',
		d: 'and a fourth one',
		e: 'and a fifth',
	});
	assert.ok(result.endsWith('...'), `expected trailing "..."; got: ${result}`);
	// Allow some headroom -- the cap is enforced AFTER pushing the
	// trigger part, so the final string includes that part + ", ...".
	assert.ok(result.length < 120, `expected ~80-char cap, got ${result.length}: ${result}`);
});

test('formatArgsInline: empty args -> empty string', () => {
	assert.equal(formatArgsInline({}), '');
});

test('formatArgsInline: unknown value types render as "?"', () => {
	assert.equal(formatArgsInline({ x: null, y: undefined }), 'x=?, y=?');
});

// ---------------------------------------------------------------------------
// determineStatus (new signature: keys on evidence.length)
// ---------------------------------------------------------------------------

test('determineStatus: zero evidence -> failed', () => {
	assert.equal(determineStatus({
		evidenceCount:     0,
		facts:             [],
		citations:         [],
		calledSkillIds:    [],
		plannedSkillCount: 2,
	}), 'failed');
});

test('determineStatus: evidence captured but no citations -> partial', () => {
	assert.equal(determineStatus({
		evidenceCount:     2,
		facts:             ['a', 'b'],
		citations:         [],
		calledSkillIds:    ['code.entity.summary'],
		plannedSkillCount: 1,
	}), 'partial');
});

test('determineStatus: fewer skills called than planned -> partial', () => {
	assert.equal(determineStatus({
		evidenceCount:     1,
		facts:             ['a'],
		citations:         [{ path: '/x.ts' }],
		calledSkillIds:    ['code.entity.locate-by-name'],
		plannedSkillCount: 2,
	}), 'partial');
});

test('determineStatus: all planned called + evidence + citations -> ok', () => {
	assert.equal(determineStatus({
		evidenceCount:     2,
		facts:             ['a', 'b'],
		citations:         [{ path: '/x.ts' }],
		calledSkillIds:    ['code.entity.locate-by-name', 'code.entity.summary'],
		plannedSkillCount: 2,
	}), 'ok');
});

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

test('buildStepSystemPrompt: loads static MD with the skill catalog', () => {
	const prompt = buildStepSystemPrompt(undefined);
	assert.match(prompt, /Skill primitives/);
	assert.match(prompt, /code\.entity\.locate-by-name/);
	assert.match(prompt, /code\.entity\.summary/);
	assert.match(prompt, /Chain A/);
	assert.match(prompt, /Chain B/);
});

test('buildStepSystemPrompt: describes per-result evidence capture + STOP-calling-tools exit', () => {
	const prompt = buildStepSystemPrompt(undefined);
	assert.match(prompt, /captures structured evidence/i);
	assert.match(prompt, /STOP calling tools/);
});

test('buildStepSystemPrompt: documents the compaction marker the model will see in tool_results', () => {
	const prompt = buildStepSystemPrompt(undefined);
	assert.match(prompt, /\[evidence e_/);
	assert.match(prompt, /facts=.*cites=.*conf=/);
});

test('buildStepSystemPrompt: does NOT mention the legacy closing JSON envelope', () => {
	const prompt = buildStepSystemPrompt(undefined);
	assert.doesNotMatch(prompt, /Final output \(your LAST assistant turn\)/);
	assert.doesNotMatch(prompt, /Hard rules on the envelope/);
});

test('buildStepSystemPrompt: documents DOs/DONTs', () => {
	const prompt = buildStepSystemPrompt(undefined);
	assert.match(prompt, /## DOs/);
	assert.match(prompt, /## DON'Ts/);
});

test('buildStepSystemPrompt: omits repo-context block when repoSizeSummary is undefined', () => {
	const prompt = buildStepSystemPrompt(undefined);
	assert.doesNotMatch(prompt, /## Repository under analysis/);
});

test('buildStepUserPrompt: names the step id + intent + imperative task list', () => {
	const prompt = buildStepUserPrompt(fixtureStep(), undefined);
	assert.match(prompt, /## Step: step-1/);
	assert.match(prompt, /Intent: investigate the FSDirectory class/);
	assert.match(prompt, /## Tasks \(run in order\)/);
	assert.match(prompt, /1\. Invoke `code\.entity\.locate-by-name` for \*\*the FSDirectory class\*\*\./);
	assert.match(prompt, /2\. Invoke `code\.entity\.summary` for \*\*use entityId from s1\.a\*\*\./);
});

test('buildStepUserPrompt: emits a Chain hint line for dependsOn calls', () => {
	const prompt = buildStepUserPrompt(fixtureStep(), undefined);
	assert.match(prompt, /Chain: use the `entityId` from task 1's result/);
});

test('buildStepUserPrompt: closes by telling the model to STOP calling tools (no envelope contract)', () => {
	const prompt = buildStepUserPrompt(fixtureStep(), undefined);
	assert.match(prompt, /STOP calling tools/);
	assert.doesNotMatch(prompt, /JSON envelope/i);
});

test('buildStepUserPrompt: surfaces the workspace root + repoPath directive when provided', () => {
	const prompt = buildStepUserPrompt(fixtureStep(), '/Users/u/work/hadoop');
	assert.match(prompt, /\*\*Workspace root:\*\* `\/Users\/u\/work\/hadoop`/);
	assert.match(prompt, /Use this exact path as the `repoPath` argument/);
});

test('buildStepUserPrompt: omits workspace-root block when repoPath is undefined or empty', () => {
	const promptUndef = buildStepUserPrompt(fixtureStep(), undefined);
	assert.doesNotMatch(promptUndef, /Workspace root/);
	const promptEmpty = buildStepUserPrompt(fixtureStep(), '');
	assert.doesNotMatch(promptEmpty, /Workspace root/);
});

// ---------------------------------------------------------------------------
// executeStep end-to-end (no tool calls -- soft-stop path only)
// ---------------------------------------------------------------------------

test('executeStep: model emits text without tool calls -> exits cleanly, status=failed (zero evidence)', async () => {
	const { provider, calls } = fakeProvider([
		{ text: 'I have nothing to do here.', stopReason: 'end_turn' },
	]);
	const out = await executeStep({
		provider,
		session: FAKE_SESSION,
		step:    fixtureStep(),
	});
	assert.equal(out.status, 'failed');
	assert.equal(out.facts.length, 0);
	assert.equal(out.citations.length, 0);
	assert.equal(calls.length, 1, 'only one inference call -- loop should exit on no-tools');
});

test('executeStep: regression -- empty text + no tool calls still exits without crashing', async () => {
	// This is the Devstral empty-text bug pattern. Pre-rewrite, executeStep
	// would emit the "failed to parse step emission JSON" warning and
	// return failed. Post-rewrite it should also return failed -- but it
	// should NOT have tried to parse a closing envelope.
	const { provider } = fakeProvider([
		{ text: '', stopReason: 'end_turn' },
	]);
	const out = await executeStep({
		provider,
		session: FAKE_SESSION,
		step:    fixtureStep(),
	});
	assert.equal(out.status, 'failed');
	assert.equal(out.facts.length, 0);
	assert.equal(out.citations.length, 0);
});

test('executeStep: stepId preserved from input', async () => {
	const { provider } = fakeProvider([
		{ text: '', stopReason: 'end_turn' },
	]);
	const out = await executeStep({
		provider,
		session: FAKE_SESSION,
		step:    { ...fixtureStep(), id: 'step-42' },
	});
	assert.equal(out.stepId, 'step-42');
});

test('executeStep: respects max-iter cap (zero canned responses would throw; cap=0 short-circuits the loop)', async () => {
	const { provider, calls } = fakeProvider([]);
	const out = await executeStep({
		provider,
		session:       FAKE_SESSION,
		step:          fixtureStep(),
		maxIterations: 0,
	});
	assert.equal(out.status, 'failed');
	assert.equal(calls.length, 0, 'no inference calls when maxIterations=0');
});
