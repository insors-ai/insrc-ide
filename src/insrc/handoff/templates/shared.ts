/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared template-rendering helpers used by every Phase-7
 * template module.
 *
 * Pulled out of `debug-session.ts` once the second template
 * landed and the pattern was clearly stable: every template
 * emits the same `## Objective`, `## Scope`,
 * `## Memory excerpts`, `## Acceptance Criteria`, and
 * `## Constraints` blocks; only the discovery guidance and the
 * deliverable structure differ. Keeping these in one place
 * means a future change to (say) the memory-excerpts disclaimer
 * propagates to every template at once.
 *
 * Each helper is intentionally small + pure -- no I/O, no
 * config lookup. The caller passes a `RenderSpecInput`-shaped
 * object and gets a string back ready to concatenate into the
 * final spec.
 *
 * DEBUG-SESSION still has its own copies of these for backwards
 * compatibility with the existing test fixtures; the Phase 7
 * templates use these shared versions.
 */

import type { AcceptanceCriterion } from '../types.js';
import type { RenderSpecInput } from './types.js';

export function renderObjective(input: RenderSpecInput, heading = '## Objective'): string {
	return [heading, input.intent, ''].join('\n');
}

export function renderScope(input: RenderSpecInput): string {
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

export function renderMemoryExcerpts(input: RenderSpecInput): string {
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

export function renderAcceptanceCriteria(input: RenderSpecInput): string {
	const lines: string[] = ['## Acceptance Criteria'];
	for (const c of input.acceptance) {
		lines.push(`- [ ] ${c.kind}: ${c.description}${formatVerifier(c)}`);
	}
	lines.push('');
	return lines.join('\n');
}

export function renderConstraints(input: RenderSpecInput): string {
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

/**
 * Build the `## Deliverable structure` block. Every template's
 * deliverable structure reference follows the same shape: lead
 * with the audit-pipeline matching rule, then list the required
 * sections in order. This helper takes the section names and
 * their one-line descriptions; the audit pipeline match is
 * always identical (`^## <Name>` literal at level 2).
 */
export function renderDeliverableStructureReference(args: {
	readonly sections: readonly { name: string; oneLine: string }[];
	readonly leadIn?: string;
}): string {
	const lines: string[] = ['## Deliverable structure'];
	lines.push(args.leadIn ?? 'Write your output into `spec-deliverable.md` using EXACTLY');
	lines.push('these level-2 (`## `) section headers, in this order. Header level');
	lines.push('matters: the audit pipeline matches `^## <Name>` exactly; `#`');
	lines.push("or `###` headers are treated as missing and force `revise-major`.");
	lines.push('');
	lines.push('Required section headers (literal markdown):');
	lines.push('');
	const namePad = Math.max(...args.sections.map(s => s.name.length));
	for (const s of args.sections) {
		const pad = ' '.repeat(namePad - s.name.length);
		lines.push(`- \`## ${s.name}\`${pad}  -- ${s.oneLine}`);
	}
	lines.push('');
	lines.push('You may put a single `# <one-line title>` line at the top, but the');
	lines.push("required section headers above MUST use `## ` -- not `# ` or `### `.");
	lines.push('');
	return lines.join('\n');
}

/**
 * Build a stub deliverable file given the section names. Every
 * template's stub follows the same shape: a top-level `# ...`
 * title, then one `## <Section>` header per required section
 * with a `<TODO>` placeholder body.
 */
export function renderDeliverableStub(title: string, sections: readonly string[]): string {
	const lines: string[] = [`# ${title}`, ''];
	for (const s of sections) {
		lines.push(`## ${s}`);
		lines.push('<TODO>');
		lines.push('');
	}
	return lines.join('\n');
}

export function formatList(items: readonly string[]): string {
	if (items.length === 0) return '(none)';
	return items.map(s => `\`${s}\``).join(', ');
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

/**
 * Standard discovery-guidance lead-in shared across templates.
 * Each template appends its own template-specific guidance to
 * this list.
 */
export function renderDiscoveryGuidance(args: {
	readonly extraBullets: readonly string[];
	readonly repoId?: string | undefined;
}): string {
	const lines: string[] = ['## Discovery guidance'];
	for (const b of args.extraBullets) {
		lines.push(`- ${b}`);
	}
	lines.push('- Use `insrc_entity_callers(<id>)` / `insrc_entity_callees(<id>)` for impact analysis.');
	lines.push('- Use `insrc_memory_recall("<topic>")` when prior conversation may have addressed this.');
	lines.push('- Use native Read/Grep/Glob for everything else.');
	lines.push("- Don't assume the spec lists every file you'll need; scope is deliberately light.");
	lines.push('');
	return lines.join('\n');
}
