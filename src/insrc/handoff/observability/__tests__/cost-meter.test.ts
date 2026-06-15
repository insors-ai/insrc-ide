/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Cost meter tests. Pins:
 *
 *   - Wall-time is the delta between the injected clock at openCostMeter
 *     and the clock at finalize / first terminal event.
 *   - recordSpec sets a char-floor on specMdChars.
 *   - recordChunk accumulates stdout / stderr chars separately.
 *   - Token estimate = ceil(totalChars / charsPerToken).
 *   - agent-completed payload populates exitCode + durationMs.
 *   - audit-ready / handoff-final populate the verdict.
 *   - Mode B request / resolved events count allow / deny separately.
 *   - handoff-error captures the stage.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { openCostMeter } from '../cost-meter.js';

test('cost: wall-time spans openCostMeter to finalize', () => {
	let t = 100;
	const m = openCostMeter({ nowMs: () => t });
	t = 250;
	m.finalize();
	const s = m.snapshot();
	assert.equal(s.startedAt, 100);
	assert.equal(s.endedAt,   250);
	assert.equal(s.durationMs, 150);
});

test('cost: handoff-final implicitly finalizes', () => {
	let t = 500;
	const m = openCostMeter({ nowMs: () => t });
	t = 600;
	m.record({ kind: 'handoff-final', specId: 's', verdict: 'accept', diff: 'd', worktreePath: '/w' });
	const s = m.snapshot();
	assert.equal(s.endedAt, 600);
	assert.equal(s.verdict, 'accept');
});

test('cost: handoff-error finalizes and stamps stage', () => {
	let t = 1;
	const m = openCostMeter({ nowMs: () => t });
	t = 3;
	m.record({ kind: 'handoff-error', stage: 'spawn', message: 'boom' });
	const s = m.snapshot();
	assert.equal(s.endedAt, 3);
	assert.equal(s.errorStage, 'spawn');
});

test('cost: token estimate aggregates spec + stdout + stderr through the chars-per-token ratio', () => {
	const m = openCostMeter({ nowMs: () => 0, charsPerToken: 4 });
	m.recordSpec('aaaaaaaa');             // 8 chars
	m.recordChunk('stdout', 4);
	m.recordChunk('stderr', 4);
	const s = m.snapshot();
	assert.equal(s.specMdChars, 8);
	assert.equal(s.stdoutChars, 4);
	assert.equal(s.stderrChars, 4);
	assert.equal(s.charsPerToken, 4);
	assert.equal(s.estimatedTokens, 4);  // ceil(16/4)
});

test('cost: recordSpec is monotone (only the largest value sticks)', () => {
	const m = openCostMeter();
	m.recordSpec('aa');     // 2
	m.recordSpec('aaaaa');  // 5 -> wins
	m.recordSpec('aaa');    // 3 -- ignored
	assert.equal(m.snapshot().specMdChars, 5);
});

test('cost: spec-ready event seeds specMdChars to the preview length (floor)', () => {
	const m = openCostMeter();
	m.record({ kind: 'spec-ready', specId: 's', templateId: 'DEBUG-SESSION', preview: 'abc' });
	assert.equal(m.snapshot().specMdChars, 3);
	// recordSpec later supersedes with the full text.
	m.recordSpec('abcdefghij');
	assert.equal(m.snapshot().specMdChars, 10);
});

test('cost: agent-completed populates exitCode + durationMs', () => {
	const m = openCostMeter();
	m.record({ kind: 'agent-completed', specId: 's', exitCode: 0, durationMs: 1234, stdoutLen: 0 });
	const s = m.snapshot();
	assert.equal(s.agentExitCode, 0);
	assert.equal(s.agentDurationMs, 1234);
});

test('cost: audit-ready stamps verdict + diffBytes', () => {
	const m = openCostMeter();
	m.record({
		kind: 'audit-ready', specId: 's',
		verdict: 'revise-edits', reason: 'r',
		editHintCount: 0, machineCheckCount: 2, diffBytes: 999,
	});
	const s = m.snapshot();
	assert.equal(s.verdict, 'revise-edits');
	assert.equal(s.diffBytes, 999);
});

test('cost: Mode B prompts count allow vs deny separately', () => {
	const m = openCostMeter();
	m.record({ kind: 'mode-b-gate-request', specId: 's', gateId: 'g1', tool: 'Bash', input: {}, sessionId: 'sess' });
	m.record({ kind: 'mode-b-gate-request', specId: 's', gateId: 'g2', tool: 'Bash', input: {}, sessionId: 'sess' });
	m.record({ kind: 'mode-b-gate-resolved', specId: 's', gateId: 'g1', verdict: 'allow' });
	m.record({ kind: 'mode-b-gate-resolved', specId: 's', gateId: 'g2', verdict: 'deny'  });
	const s = m.snapshot();
	assert.equal(s.modeBPromptCount, 2);
	assert.equal(s.modeBAllowCount, 1);
	assert.equal(s.modeBDenyCount,  1);
});

test('cost: snapshot before finalize uses now() for the running duration', () => {
	let t = 50;
	const m = openCostMeter({ nowMs: () => t });
	t = 75;
	const sBefore = m.snapshot();
	assert.equal(sBefore.endedAt, undefined);
	assert.equal(sBefore.durationMs, 25);  // running clock
	t = 100;
	m.finalize();
	const sAfter = m.snapshot();
	assert.equal(sAfter.endedAt, 100);
	assert.equal(sAfter.durationMs, 50);   // frozen
});
