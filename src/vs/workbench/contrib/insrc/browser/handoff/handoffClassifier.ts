/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tiny keyword classifier for the `/handoff` test harness.
 *
 * Maps a user intent string to one of the registered handoff
 * templates by looking for verb / noun cues. Score each template
 * by the number of matching cues; the highest score wins. Ties
 * fall back to the template order below (DEBUG-SESSION first,
 * then SPEC, ...) which mirrors the rough usage frequency.
 *
 * Why so blunt: this is the test harness path. M.2 (the real
 * intent routing in chat) will swap this for `resolveIntent`
 * once that pipeline knows about handoff intents. Until then,
 * the harness only needs to be predictable enough that you can
 * trigger each template by phrasing the prompt accordingly.
 *
 * Explicit override: prefixing the intent with `template=<ID>`
 * short-circuits the classifier so you can force a particular
 * template for testing -- e.g. `/handoff template=MIGRATION upgrade
 * the schema`. The override is stripped from the intent that
 * runHandoff sees.
 */

import type { HandoffTemplateId } from '../../common/handoffService.js';

interface TemplateCues {
	readonly id: HandoffTemplateId;
	readonly cues: readonly RegExp[];
}

/**
 * Order matters as a tiebreaker. The first entry whose score ties
 * the max wins, so the most-common templates lead.
 */
const TEMPLATE_CUES: readonly TemplateCues[] = [
	{
		id: 'DEBUG-SESSION',
		cues: [
			/\b(bug|fix|broken|crash|hang|leak)\b/i,
			/\b(failing|flaky|red)\s+(test|spec|build)\b/i,
			/\b(debug|reproduce|repro|investigate)\b/i,
			/\bstack\s*trace\b/i,
			/\bwhy\s+(does|is|isn'?t)\b/i,
		],
	},
	{
		id: 'SPEC',
		cues: [
			/\b(implement|add|build|create|introduce|wire)\b/i,
			/\b(refactor|extract|inline|rename)\b/i,
			/\bfeature\b/i,
			/\bsupport\s+for\b/i,
		],
	},
	{
		id: 'DESIGN',
		cues: [
			/\b(design|architect|architecture|ADR)\b/i,
			/\b(decide|decision|choose between|tradeoffs?)\b/i,
			/\bhow\s+should\s+we\b/i,
			/\bapproach\b/i,
		],
	},
	{
		id: 'REQUIREMENTS',
		cues: [
			/\b(requirements?|spec(ification)?)\b/i,
			/\b(what\s+should|must|needs?\s+to|stakeholders?)\b/i,
			/\b(scope|goals?)\b/i,
		],
	},
	{
		id: 'TEST-PLAN',
		cues: [
			/\btest\s+(plan|strategy|cases?|coverage)\b/i,
			/\b(unit|integration|e2e|smoke)\b.*\btests?\b/i,
			/\bwhat\s+tests?\b/i,
		],
	},
	{
		id: 'REVIEW',
		cues: [
			/\breview\b/i,
			/\bPR\s+(review|check)\b/i,
			/\b(critique|feedback)\b/i,
		],
	},
	{
		id: 'MIGRATION',
		cues: [
			/\b(migrate|migration|upgrade|cutover|swap)\b/i,
			/\b(schema|version|library)\s+(change|bump|swap)\b/i,
			/\b(rollback|reversible)\b/i,
		],
	},
	{
		id: 'AUDIT',
		cues: [
			/\b(audit|verify|cross-?check)\b/i,
			/\b(check\s+against|reconcile)\b/i,
			/\b(does\s+the\s+\w+\s+actually|claims?)\b/i,
		],
	},
];

const FALLBACK: HandoffTemplateId = 'SPEC';

const OVERRIDE_PREFIX = /^template\s*=\s*([A-Z][A-Z\-]*)\b/i;

export interface ClassifyResult {
	readonly templateId: HandoffTemplateId;
	readonly intent: string;
	readonly viaOverride: boolean;
	/** Match scores per template -- exposed for /handoff verbose
	 *  output and tests. Highest entry wins (tie-break by order). */
	readonly scores: ReadonlyMap<HandoffTemplateId, number>;
}

/**
 * Classify the free-form intent into a template id. Strips any
 * explicit `template=<ID>` override from the leading portion of
 * the intent string before returning the trimmed remainder.
 */
export function classifyHandoffIntent(rawIntent: string): ClassifyResult {
	const trimmed = rawIntent.trim();
	const overrideMatch = OVERRIDE_PREFIX.exec(trimmed);
	if (overrideMatch !== null) {
		const overrideId = overrideMatch[1]!.toUpperCase() as HandoffTemplateId;
		const isKnown = TEMPLATE_CUES.some(t => t.id === overrideId);
		if (isKnown) {
			const remainder = trimmed.slice(overrideMatch[0].length).trim();
			return {
				templateId: overrideId,
				intent: remainder.length > 0 ? remainder : trimmed,
				viaOverride: true,
				scores: new Map([[overrideId, Number.POSITIVE_INFINITY]]),
			};
		}
		// Unknown id -- fall through to keyword scoring with the
		// override left in the intent (a future iteration could
		// warn the user, but for the test harness this is fine).
	}

	const scores = new Map<HandoffTemplateId, number>();
	for (const t of TEMPLATE_CUES) {
		let score = 0;
		for (const re of t.cues) {
			if (re.test(trimmed)) { score++; }
		}
		scores.set(t.id, score);
	}

	let best: HandoffTemplateId = FALLBACK;
	let bestScore = 0;
	for (const t of TEMPLATE_CUES) {
		const s = scores.get(t.id) ?? 0;
		if (s > bestScore) {
			bestScore = s;
			best = t.id;
		}
	}
	return {
		templateId: bestScore > 0 ? best : FALLBACK,
		intent: trimmed,
		viaOverride: false,
		scores,
	};
}
