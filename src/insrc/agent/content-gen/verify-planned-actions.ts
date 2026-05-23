/**
 * Phase 10.B of plans/code-analyzer-hallucination-mitigation.md.
 *
 * Pre-flight probe that runs AFTER the planner returns its action
 * list but BEFORE we hand them to the per-section discovery loops.
 * For each action, extract candidate entity names from `title +
 * objective` (light NER: PascalCase tokens, dotted java identifiers,
 * file basenames). Probe each top candidate via the entity name
 * index. If ALL candidates miss AND the title is concrete (i.e.
 * contains at least one named entity), DROP the action.
 *
 * Why: in the live HDFS NameNode drill-down the planner emitted a
 * "Caching Layer & In-Memory Structures" section for a system that
 * has no real cache. The writer then filled that section with
 * `cacheReadWriteLock`, "LRU eviction on `INodeMap`",
 * `CacheableIPList.refresh`-mis-cited-as-cache-invalidation -- all
 * invented. Dropping the section at the planner-output stage
 * eliminates the failure mode entirely.
 *
 * Loose titles ("Operational Observability", "Configuration Tuning")
 * that don't name a specific entity skip the probe by design --
 * those sections rely on free-form discovery, not on a single anchor
 * class.
 */

import { findEntitiesByName } from '../../db/entities.js';
import { getLogger } from '../../shared/logger.js';
import type { PlannedAction } from './plan-actions.js';

const log = getLogger('code-analyzer:verify-planned-actions');

// ---------------------------------------------------------------------------
// Candidate extraction (light NER, no LLM)
// ---------------------------------------------------------------------------

/**
 * Extract candidate entity names from a section title + objective.
 * Returns the candidates sorted by likely centrality (longest first
 * is a decent proxy: longer multi-word PascalCase tokens are usually
 * the section's anchor class).
 *
 * Patterns matched:
 *   - PascalCase identifiers (`FSNamesystem`, `BlockManager`,
 *     `INodeFile`) -- two or more capital letters in a row, plus a
 *     mix of upper/lower
 *   - Dotted Java identifiers (`org.apache.hadoop.hdfs.NameNode` --
 *     last segment kept)
 *   - File basenames (`FSNamesystem.java`, `BlockManager.scala`)
 *
 * Excluded:
 *   - Bare uppercase words that are common English ("Server",
 *     "Architecture", "Management") -- only kept when paired with
 *     another capital-letter cluster forming a CamelCase identifier
 *   - Generic axis labels ("Layer", "Subsystem", "Module")
 */
const EXCLUDE_WORDS = new Set<string>([
	'Server', 'Architecture', 'Management', 'Layer', 'Module',
	'Subsystem', 'Component', 'Pipeline', 'Protocol', 'Implementation',
	'Configuration', 'Observability', 'Validation', 'Persistence',
	'Coordination', 'Tuning', 'Performance', 'Caching', 'Storage',
	'Operations', 'Service', 'Manager', 'Handler', 'NameNode', // 'NameNode'
	// is a generic anchor by itself in HDFS analyses -- we want SUB-
	// component entities like FSNamesystem, BlockManager, etc. Tests
	// using just "NameNode" as title fall through to objective parsing.
]);

const PASCAL_CASE_RE = /\b([A-Z][a-z0-9]*(?:[A-Z][a-z0-9]*){1,})\b/g;
const FILE_BASENAME_RE = /\b([A-Z][A-Za-z0-9]+)\.(java|ts|tsx|py|go|scala|js)\b/g;

export function extractCandidateNames(title: string, objective: string): string[] {
	const text = `${title} ${objective}`;
	const seen = new Set<string>();

	// PascalCase identifiers (the main signal)
	let m: RegExpExecArray | null;
	while ((m = PASCAL_CASE_RE.exec(text)) !== null) {
		const cand = m[1]!;
		if (!EXCLUDE_WORDS.has(cand)) seen.add(cand);
	}

	// File basenames
	while ((m = FILE_BASENAME_RE.exec(text)) !== null) {
		seen.add(m[1]!);
	}

	// Sort by length descending -- longer multi-word identifiers tend
	// to be the anchor (e.g. "BlockPlacementPolicyDefault" over
	// "Block").
	return [...seen].sort((a, b) => b.length - a.length);
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

export interface VerifyPlannedActionsResult {
	readonly kept:    readonly PlannedAction[];
	readonly dropped: readonly {
		readonly action:     PlannedAction;
		readonly candidates: readonly string[];
		readonly reason:     string;
	}[];
}

export interface VerifyPlannedActionsOptions {
	/** Repo root to probe within. When undefined, locate-by-name
	 *  spans every registered repo. */
	readonly repoPath?: string | undefined;
	/** Max candidates per action to probe (capped to bound DB cost).
	 *  Defaults to 2 (the longest two -- the anchor + a backup). */
	readonly probeTopN?: number | undefined;
}

/**
 * Run the pre-flight probe on a planner action list. Returns the
 * kept actions + a list of dropped actions with reasons (for
 * logging / debugging).
 *
 * Drop policy:
 *   - If the title+objective yields NO candidates, KEEP the action
 *     (loose titles like "Operational Observability" rely on
 *     free-form discovery and don't need a concrete anchor).
 *   - If the title+objective yields candidates AND ALL probed
 *     candidates return 0 entity matches, DROP the action.
 *   - Otherwise (≥1 candidate matched), KEEP.
 */
export async function verifyPlannedActions(
	actions: readonly PlannedAction[],
	opts: VerifyPlannedActionsOptions = {},
): Promise<VerifyPlannedActionsResult> {
	const probeTopN = opts.probeTopN ?? 2;
	const kept:    PlannedAction[] = [];
	const dropped: VerifyPlannedActionsResult['dropped'][number][] = [];

	for (const action of actions) {
		const candidates = extractCandidateNames(action.title, action.objective);

		if (candidates.length === 0) {
			// No concrete anchor in the title -- can't verify. Trust the
			// planner; keep.
			kept.push(action);
			continue;
		}

		const probed = candidates.slice(0, probeTopN);
		let anyHit = false;
		for (const name of probed) {
			try {
				const matches = await findEntitiesByName(
					null as never,
					[name],
					opts.repoPath !== undefined ? { repo: opts.repoPath, limit: 1 } : { limit: 1 },
				);
				if (matches.length > 0) { anyHit = true; break; }
			} catch (err) {
				// Probe error -- conservative: keep the action; the
				// section's discovery flow will surface the error
				// separately.
				log.warn(
					{ actionId: action.id, name, err: (err as Error).message },
					'verifyPlannedActions: probe error; defaulting to keep',
				);
				anyHit = true;
				break;
			}
		}

		if (anyHit) {
			kept.push(action);
		} else {
			dropped.push({
				action,
				candidates: probed,
				reason: `No entity matches found for any of: ${probed.join(', ')}`,
			});
			log.warn(
				{
					actionId:   action.id,
					title:      action.title,
					candidates: probed,
				},
				'verifyPlannedActions: dropping section -- no anchor entity in index',
			);
		}
	}

	return { kept, dropped };
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

export const _extractCandidateNamesForTest = extractCandidateNames;
