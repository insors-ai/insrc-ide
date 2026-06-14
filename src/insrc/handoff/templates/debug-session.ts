/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * DEBUG-SESSION template (Phase 2a wedge template).
 *
 * Two shapes (design §5.2):
 *
 *   - SPEC      : what insrc emits to the external agent.
 *                 Scope + memory excerpts + acceptance criteria +
 *                 constraints + discovery guidance. Deliberately light
 *                 on content -- discovery happens at execution time
 *                 via MCP tools, not via pre-fetched entity content.
 *
 *   - DELIVERABLE: the structure the agent's output must satisfy at
 *                 audit time. Five sections: Reproduce, Localize,
 *                 Hypothesize, Test, Conclude.
 *
 * Template version: 1. Breaking changes ship as DEBUG-SESSION.v2;
 * specs persist their templateVersion so the audit path uses the
 * right validator.
 */

import type { AcceptanceCriterion } from '../types.js';
import type { RenderSpecInput, TemplateDefinition } from './types.js';

const TEMPLATE_VERSION = 1;

export interface DebugSessionInput extends RenderSpecInput {
	/**
	 * Optional: the specific failing test name (e.g. 'foo.test.ts').
	 * When the upstream classifier knows it, surfacing it in the spec
	 * tells the agent where to start without forcing it. Stays out of
	 * scope when unknown -- the agent discovers via insrc_entity_search.
	 */
	readonly failingTest?: string | undefined;
}

function renderSpec(input: DebugSessionInput): string {
	const sections: string[] = [];
	sections.push(`# Debug Session: ${input.intent}`);
	sections.push('');
	sections.push(renderObjective(input));
	sections.push(renderScope(input));
	sections.push(renderMemoryExcerpts(input));
	sections.push(renderAcceptanceCriteria(input));
	sections.push(renderConstraints(input));
	sections.push(renderDiscoveryGuidance(input));
	sections.push(renderDeliverableStructureReference());
	return sections.join('\n');
}

function renderObjective(input: DebugSessionInput): string {
	const lines: string[] = ['## Objective', input.intent];
	if (input.failingTest !== undefined && input.failingTest.length > 0) {
		lines.push('', `Failing test (hint): \`${input.failingTest}\``);
	}
	lines.push('');
	return lines.join('\n');
}

function renderScope(input: DebugSessionInput): string {
	const s = input.scope;
	const lines: string[] = ['## Scope'];
	lines.push(`- Repo: \`${s.repoId}\` at \`${s.repoPath}\``);
	lines.push(`- In-scope paths: ${formatList(s.inScopeGlobs)}`);
	lines.push(`- Out-of-scope (do not modify): ${formatList(s.outOfScopePaths)}`);
	if (s.entryPointHints !== undefined && s.entryPointHints.length > 0) {
		lines.push('- Entry point hints (optional starting points):');
		for (const h of s.entryPointHints) {
			lines.push(`  - \`${h.entityId}\`${h.note !== undefined ? ` -- ${h.note}` : ''}`);
		}
	}
	if (s.dependencyClosureRepos !== undefined && s.dependencyClosureRepos.length > 0) {
		lines.push(`- Dependency closure (read-only): ${formatList(s.dependencyClosureRepos)}`);
	}
	lines.push('');
	return lines.join('\n');
}

function renderMemoryExcerpts(input: DebugSessionInput): string {
	if (input.memoryRefs.length === 0) return '';
	const lines: string[] = ['## Memory excerpts (related prior conversation)'];
	for (const m of input.memoryRefs) {
		lines.push(`- [${m.kind}:${m.id}] ${m.oneLineSummary}`);
	}
	lines.push('');
	lines.push('These are POINTERS, not content. Use `insrc_memory_recall` /');
	lines.push('`insrc_artifact_get` to expand any that seem relevant to your');
	lines.push("investigation. insrc didn't pre-fetch their content -- you have");
	lines.push('better judgment about what to actually read.');
	lines.push('');
	return lines.join('\n');
}

function renderAcceptanceCriteria(input: DebugSessionInput): string {
	const lines: string[] = ['## Acceptance Criteria'];
	for (const c of input.acceptance) {
		lines.push(`- [ ] ${c.kind}: ${c.description}${formatVerifier(c)}`);
	}
	lines.push('');
	return lines.join('\n');
}

function formatVerifier(c: AcceptanceCriterion): string {
	if (c.kind !== 'machine' || c.verifier === undefined) return '';
	switch (c.verifier.type) {
		case 'file-exists':
			return ` (verifier: file \`${c.verifier.path}\` exists)`;
		case 'regex-match':
			return ` (verifier: \`${c.verifier.pattern}\` matches in \`${c.verifier.path}\`)`;
		case 'shell-exit':
			return ` (verifier: \`${c.verifier.command}\` exits 0)`;
	}
}

function renderConstraints(input: DebugSessionInput): string {
	const lines: string[] = ['## Constraints'];
	lines.push(`- Sandbox: \`${input.worktreePath}\``);
	lines.push(`- Risk: ${input.riskTag}`);
	lines.push(`- Time budget: ${input.timeBudgetSec}s`);
	if (input.scope.outOfScopePaths.length > 0) {
		lines.push(`- May NOT modify: ${formatList(input.scope.outOfScopePaths)}`);
	}
	lines.push('');
	return lines.join('\n');
}

function renderDiscoveryGuidance(input: DebugSessionInput): string {
	const lines: string[] = ['## Discovery guidance'];
	const startHint = input.failingTest !== undefined && input.failingTest.length > 0
		? `\`insrc_entity_search("${input.failingTest}", repo="${input.scope.repoId}")\``
		: `\`insrc_entity_search("<failing test name>", repo="${input.scope.repoId}")\``;
	lines.push(`- Start with ${startHint} to locate the test and likely impl files.`);
	lines.push('- Use `insrc_entity_callers(<id>)` / `insrc_entity_callees(<id>)` for impact analysis.');
	lines.push('- Use `insrc_memory_recall("<prior fix attempts>")` if you suspect this issue has come up before.');
	lines.push('- Use native Read/Grep/Glob for everything else.');
	lines.push("- Don't assume the spec lists every file you'll need; scope is deliberately light.");
	lines.push('');
	return lines.join('\n');
}

function renderDeliverableStructureReference(): string {
	const lines: string[] = ['## Deliverable structure'];
	lines.push('Write your investigation into `spec-deliverable.md` using EXACTLY');
	lines.push('these five level-2 (`## `) section headers, in this order. Header');
	lines.push('level matters: the audit pipeline matches `^## <Name>` exactly; `#`');
	lines.push("or `###` headers are treated as missing and force `revise-major`.");
	lines.push('');
	lines.push('Required section headers (literal markdown):');
	lines.push('');
	lines.push('- `## Reproduce`   -- steps + commands you ran to reproduce the bug.');
	lines.push('- `## Localize`    -- evidence you gathered: log spans, stack traces,');
	lines.push('                      file:line refs.');
	lines.push('- `## Hypothesize` -- ranked candidate causes with cited evidence.');
	lines.push('- `## Test`        -- outputs from tests you ran on each hypothesis.');
	lines.push('- `## Conclude`    -- determined cause + the applied fix description.');
	lines.push('');
	lines.push('You may put a single `# <one-line title>` line at the top, but the');
	lines.push("five required section headers above MUST use `## ` -- not `# ` or `### `.");
	lines.push('');
	return lines.join('\n');
}

function renderDeliverableStub(): string {
	return [
		'# Debug Session Deliverable',
		'',
		'## Reproduce',
		'<TODO>',
		'',
		'## Localize',
		'<TODO>',
		'',
		'## Hypothesize',
		'<TODO>',
		'',
		'## Test',
		'<TODO>',
		'',
		'## Conclude',
		'<TODO>',
		'',
	].join('\n');
}

function defaultAcceptance(_input: DebugSessionInput): readonly AcceptanceCriterion[] {
	return [
		{
			id:          'soft.root-cause',
			description: 'Fix targets the root cause identified in Conclude.',
			kind:        'soft',
		},
		{
			id:          'soft.no-regression',
			description: 'No new test failures introduced beyond the one being debugged.',
			kind:        'soft',
		},
	];
}

function formatList(items: readonly string[]): string {
	if (items.length === 0) return '(none)';
	return items.map(s => `\`${s}\``).join(', ');
}

export const DEBUG_SESSION_REQUIRED_SECTIONS = [
	'Reproduce',
	'Localize',
	'Hypothesize',
	'Test',
	'Conclude',
] as const;

export const debugSessionTemplate: TemplateDefinition<DebugSessionInput> = {
	id:                          'DEBUG-SESSION',
	version:                     TEMPLATE_VERSION,
	defaultRisk:                 'low',
	renderSpec,
	renderDeliverableStub,
	requiredDeliverableSections: DEBUG_SESSION_REQUIRED_SECTIONS,
	defaultAcceptance,
};

// Test-only exports:
export const _renderObjectiveForTest             = renderObjective;
export const _renderScopeForTest                 = renderScope;
export const _renderMemoryExcerptsForTest        = renderMemoryExcerpts;
export const _renderAcceptanceCriteriaForTest    = renderAcceptanceCriteria;
export const _renderConstraintsForTest           = renderConstraints;
export const _renderDiscoveryGuidanceForTest     = renderDiscoveryGuidance;
export const _renderDeliverableStubForTest       = renderDeliverableStub;
export const _defaultAcceptanceForTest           = defaultAcceptance;
