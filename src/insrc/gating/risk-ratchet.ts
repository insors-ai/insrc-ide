/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Risk ratchet -- deterministic rules that RAISE a spec's risk tag
 * above whatever the local LLM proposed. LLMs can never lower risk
 * below what these rules require.
 *
 * Design §9.4:
 *
 *   risk:low      ->  Mode C only (sandbox + final diff review)
 *   risk:medium   ->  Mode A pre-flight + Mode C audit
 *   risk:high     ->  Mode A pre-flight + Mode B in-flight + Mode C audit
 *
 * Ratchet rules look at the spec's permission block AND its
 * out-of-scope deny list to detect "this spec is touching dangerous
 * paths" and ratchet up regardless of the LLM's emitted tag.
 *
 * The rule sets are intentionally narrow + auditable. Adding a rule
 * is a deliberate code edit -- never a runtime LLM decision.
 */

import type { PermissionRule, PermissionsBlock, RiskTag } from '../handoff/types.js';
import { matchGlob } from './permission-policy.js';

/**
 * Patterns that force `risk: high`. Any rule whose paths/commands
 * matches these is considered "touches dangerous territory" --
 * irrespective of which permission bucket (allow/prompt) the spec
 * put it in.
 *
 * Path patterns are matched against EACH path entry in the rule's
 * paths list using `matchGlob`. Command patterns are matched as
 * exact substrings (case-sensitive).
 */
export const HIGH_RISK_PATH_PATTERNS = [
	'**/infra/**',
	'**/migrations/**',
	'**/prod/**',
	'**/.env',
	'**/secrets/**',
	'**/credentials/**',
] as const;

export const HIGH_RISK_COMMAND_SUBSTRINGS = [
	'git push',
	'rm -rf',
	'sudo',
	'npm publish',
	'docker push',
	'kubectl apply',
	'terraform apply',
] as const;

/**
 * Patterns that force `risk: medium` (when not already at high).
 * Branch-affecting and dependency-shifting commands.
 */
export const MEDIUM_RISK_COMMAND_SUBSTRINGS = [
	'git reset',
	'git rebase',
	'npm install',
	'npm uninstall',
	'pnpm add',
	'pnpm remove',
] as const;

const ORDER: Record<RiskTag, number> = { low: 0, medium: 1, high: 2 };

/**
 * Apply ratchet rules to a draft permission block + LLM-proposed
 * risk. Returns the same draft (no mutation) plus the EFFECTIVE
 * risk tag the spec assembler should record.
 */
export function applyRiskRatchet(args: {
	readonly draftPermissions: PermissionsBlock;
	readonly llmProposedRisk:  RiskTag;
}): { readonly effectiveRisk: RiskTag; readonly ratchetReason: string | undefined } {
	const all = [...args.draftPermissions.allow, ...args.draftPermissions.prompt, ...args.draftPermissions.deny];

	let effective = args.llmProposedRisk;
	let reason: string | undefined;

	const highHits = collectHits(all, HIGH_RISK_PATH_PATTERNS, HIGH_RISK_COMMAND_SUBSTRINGS);
	if (highHits.length > 0) {
		effective = raise(effective, 'high');
		if (effective === 'high' && args.llmProposedRisk !== 'high') {
			reason = `ratcheted to high: ${highHits.slice(0, 3).join('; ')}`;
		}
	} else {
		const medHits = collectHits(all, [] as readonly string[], MEDIUM_RISK_COMMAND_SUBSTRINGS);
		if (medHits.length > 0) {
			effective = raise(effective, 'medium');
			if (effective === 'medium' && args.llmProposedRisk !== 'medium') {
				reason = `ratcheted to medium: ${medHits.slice(0, 3).join('; ')}`;
			}
		}
	}

	return reason === undefined
		? { effectiveRisk: effective, ratchetReason: undefined }
		: { effectiveRisk: effective, ratchetReason: reason };
}

function raise(current: RiskTag, candidate: RiskTag): RiskTag {
	return ORDER[candidate] > ORDER[current] ? candidate : current;
}

function collectHits(
	rules:        readonly PermissionRule[],
	pathPatterns: readonly string[],
	cmdPatterns:  readonly string[],
): string[] {
	const hits: string[] = [];
	for (const rule of rules) {
		if (rule.paths !== undefined) {
			for (const path of rule.paths) {
				for (const pattern of pathPatterns) {
					if (matchGlob(pattern, path)) {
						hits.push(`path '${path}' matches ${pattern}`);
					}
				}
			}
		}
		if (rule.commands !== undefined) {
			for (const command of rule.commands) {
				for (const pattern of cmdPatterns) {
					if (command.includes(pattern)) {
						hits.push(`command '${command}' contains '${pattern}'`);
					}
				}
			}
		}
	}
	return hits;
}
