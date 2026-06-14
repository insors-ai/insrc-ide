/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyRiskRatchet } from '../risk-ratchet.js';
import type { PermissionsBlock } from '../../handoff/types.js';

const EMPTY: PermissionsBlock = { allow: [], prompt: [], deny: [] };

// ---------------------------------------------------------------------------
// Identity / no rule hits
// ---------------------------------------------------------------------------

test('applyRiskRatchet: empty permissions -> effective risk == LLM-proposed; no ratchet reason', () => {
	for (const r of ['low', 'medium', 'high'] as const) {
		const out = applyRiskRatchet({ draftPermissions: EMPTY, llmProposedRisk: r });
		assert.equal(out.effectiveRisk,  r);
		assert.equal(out.ratchetReason,  undefined);
	}
});

test("applyRiskRatchet: 'safe' rules (src/** Edit, npm test Bash) don't ratchet anything", () => {
	const draft: PermissionsBlock = {
		allow:  [{ tool: 'Edit', paths: ['src/**', 'test/**'] }, { tool: 'Bash', commands: ['npm test', 'git status'] }],
		prompt: [], deny: [],
	};
	const out = applyRiskRatchet({ draftPermissions: draft, llmProposedRisk: 'low' });
	assert.equal(out.effectiveRisk, 'low');
	assert.equal(out.ratchetReason, undefined);
});

// ---------------------------------------------------------------------------
// High-risk path patterns ratchet to high
// ---------------------------------------------------------------------------

test('applyRiskRatchet: Edit migrations/** ratchets low->high with a reason', () => {
	const draft: PermissionsBlock = {
		allow:  [{ tool: 'Edit', paths: ['src/**', 'migrations/**'] }],
		prompt: [], deny: [],
	};
	const out = applyRiskRatchet({ draftPermissions: draft, llmProposedRisk: 'low' });
	assert.equal(out.effectiveRisk, 'high');
	assert.match(out.ratchetReason ?? '', /migrations/);
});

test('applyRiskRatchet: Edit infra/** ratchets medium->high', () => {
	const draft: PermissionsBlock = {
		allow:  [{ tool: 'Edit', paths: ['infra/aws/**'] }],
		prompt: [], deny: [],
	};
	const out = applyRiskRatchet({ draftPermissions: draft, llmProposedRisk: 'medium' });
	assert.equal(out.effectiveRisk, 'high');
	assert.match(out.ratchetReason ?? '', /infra/);
});

test('applyRiskRatchet: high-risk hit when LLM already proposed high -> no reason (already at floor)', () => {
	const draft: PermissionsBlock = {
		allow:  [{ tool: 'Edit', paths: ['migrations/**'] }],
		prompt: [], deny: [],
	};
	const out = applyRiskRatchet({ draftPermissions: draft, llmProposedRisk: 'high' });
	assert.equal(out.effectiveRisk, 'high');
	assert.equal(out.ratchetReason, undefined);
});

test('applyRiskRatchet: high-risk pattern can sit in the prompt bucket and still ratchet', () => {
	const draft: PermissionsBlock = {
		allow:  [], deny: [],
		prompt: [{ tool: 'Edit', paths: ['**/.env'] }],
	};
	const out = applyRiskRatchet({ draftPermissions: draft, llmProposedRisk: 'low' });
	assert.equal(out.effectiveRisk, 'high');
	assert.match(out.ratchetReason ?? '', /\.env/);
});

test('applyRiskRatchet: high-risk pattern in the deny bucket also ratchets (spec touches the path even to deny it)', () => {
	const draft: PermissionsBlock = {
		allow:  [], prompt: [],
		deny:   [{ tool: 'Edit', paths: ['secrets/**'] }],
	};
	const out = applyRiskRatchet({ draftPermissions: draft, llmProposedRisk: 'low' });
	assert.equal(out.effectiveRisk, 'high');
	assert.match(out.ratchetReason ?? '', /secrets/);
});

// ---------------------------------------------------------------------------
// High-risk command substrings
// ---------------------------------------------------------------------------

test("applyRiskRatchet: 'git push' in any Bash rule ratchets to high", () => {
	const draft: PermissionsBlock = {
		allow:  [], deny: [],
		prompt: [{ tool: 'Bash', commands: ['git push origin main'] }],
	};
	const out = applyRiskRatchet({ draftPermissions: draft, llmProposedRisk: 'low' });
	assert.equal(out.effectiveRisk, 'high');
	assert.match(out.ratchetReason ?? '', /git push/);
});

test("applyRiskRatchet: 'rm -rf', 'sudo', 'npm publish' all ratchet to high", () => {
	for (const cmd of ['rm -rf /tmp/x', 'sudo systemctl restart x', 'npm publish']) {
		const draft: PermissionsBlock = {
			allow:  [{ tool: 'Bash', commands: [cmd] }],
			prompt: [], deny: [],
		};
		const out = applyRiskRatchet({ draftPermissions: draft, llmProposedRisk: 'low' });
		assert.equal(out.effectiveRisk, 'high', `expected high for cmd='${cmd}'`);
	}
});

// ---------------------------------------------------------------------------
// Medium-risk command substrings
// ---------------------------------------------------------------------------

test("applyRiskRatchet: 'git reset' ratchets low->medium (not to high)", () => {
	const draft: PermissionsBlock = {
		allow:  [], deny: [],
		prompt: [{ tool: 'Bash', commands: ['git reset --hard'] }],
	};
	const out = applyRiskRatchet({ draftPermissions: draft, llmProposedRisk: 'low' });
	assert.equal(out.effectiveRisk, 'medium');
	assert.match(out.ratchetReason ?? '', /git reset/);
});

test("applyRiskRatchet: 'npm install' in allow ratchets low->medium", () => {
	const draft: PermissionsBlock = {
		allow:  [{ tool: 'Bash', commands: ['npm install'] }],
		prompt: [], deny: [],
	};
	const out = applyRiskRatchet({ draftPermissions: draft, llmProposedRisk: 'low' });
	assert.equal(out.effectiveRisk, 'medium');
});

test('applyRiskRatchet: medium-risk hit when LLM already at medium -> no reason', () => {
	const draft: PermissionsBlock = {
		allow:  [{ tool: 'Bash', commands: ['npm install'] }],
		prompt: [], deny: [],
	};
	const out = applyRiskRatchet({ draftPermissions: draft, llmProposedRisk: 'medium' });
	assert.equal(out.effectiveRisk, 'medium');
	assert.equal(out.ratchetReason, undefined);
});

// ---------------------------------------------------------------------------
// Mixed signal: high-risk hits take precedence over medium-risk hits
// ---------------------------------------------------------------------------

test('applyRiskRatchet: high-risk and medium-risk both hit -> ratchets to high (high wins)', () => {
	const draft: PermissionsBlock = {
		allow:  [{ tool: 'Bash', commands: ['npm install', 'git push origin main'] }],
		prompt: [], deny: [],
	};
	const out = applyRiskRatchet({ draftPermissions: draft, llmProposedRisk: 'low' });
	assert.equal(out.effectiveRisk, 'high');
	assert.match(out.ratchetReason ?? '', /git push/);
});

// ---------------------------------------------------------------------------
// Critical anti-bypass: LLM-proposed risk cannot LOWER the effective risk
// ---------------------------------------------------------------------------

test('applyRiskRatchet: LLM cannot propose low to bypass a high-risk path (the rule still ratchets)', () => {
	const draft: PermissionsBlock = {
		allow:  [{ tool: 'Edit', paths: ['prod/**'] }],
		prompt: [], deny: [],
	};
	const out = applyRiskRatchet({ draftPermissions: draft, llmProposedRisk: 'low' });
	assert.equal(out.effectiveRisk, 'high');
});

test('applyRiskRatchet: LLM-proposed risk above the ratchet result is preserved (LLM can voluntarily set higher)', () => {
	// Spec touches a medium-risk command but LLM marked the whole spec
	// as high anyway (cautious). Effective risk stays at high.
	const draft: PermissionsBlock = {
		allow:  [{ tool: 'Bash', commands: ['npm install'] }],
		prompt: [], deny: [],
	};
	const out = applyRiskRatchet({ draftPermissions: draft, llmProposedRisk: 'high' });
	assert.equal(out.effectiveRisk, 'high');
});
