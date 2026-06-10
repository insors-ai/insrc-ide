/**
 * Render a gap-facts list (RequiredFact entries with absent or partial
 * status) as a deterministic numbered block for embedding in a prompt.
 *
 * Indices in the rendered output are stable: caller-side
 * `targetsCriteria` arrays index into the same positions. Used by
 * fact-gap-analysis, discovery-plan-expansion, cycle-review, sketch,
 * decide-next-step.
 */

import type { RequiredFact } from '../../section-flow/fact-gap-types.js';

export function renderFactGaps(gapFactList: readonly RequiredFact[]): string {
	if (gapFactList.length === 0) { return '(no gap facts)'; }
	const lines: string[] = [];
	for (let i = 0; i < gapFactList.length; i++) {
		const f = gapFactList[i]!;
		lines.push(`[${i}] ${f.id} (${f.status})`);
		lines.push(`    fact: ${f.fact}`);
		lines.push(`    why:  ${f.why}`);
		if (f.suggestedSkills !== undefined && f.suggestedSkills.length > 0) {
			lines.push(`    suggested: ${f.suggestedSkills.join(', ')}`);
		}
	}
	return lines.join('\n');
}
