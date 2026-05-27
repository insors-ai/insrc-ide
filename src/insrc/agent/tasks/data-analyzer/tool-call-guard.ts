/**
 * Pre-dispatch silent guard for the data-analyzer (Phase B of
 * plans/analyzers/data-analyzer-parity.md).
 *
 * Wraps `runSilentGuardStages` from agent/tool-call-guard.ts with
 * data-analyzer-specific deps:
 *   - skill catalog narrowed to `data.*` skills only (so the LLM
 *     can't accidentally invoke a code-side skill that happens to
 *     fuzzy-match a data skill name).
 *   - per-skill arg renames sourced from
 *     ./tool-call-guard-rules.ts (currently empty).
 *   - session defaults shaped for data: `connectionId`, `schema`,
 *     `database`.
 *
 * **Phase B == silent stages only.** Stage 4 (typed schema-rejection
 * corrective) is deliberately NOT invoked here -- today's
 * data-analyzer dispatch paths (skills-pipeline.ts +
 * analyzer/runner.ts short tool loops) lack the tool-loop that
 * feeds correctives back to the LLM. Schema validation falls
 * through to the underlying runner (`runSkill` or `executeTool`)
 * where mismatches surface as runtime errors as before. Phase D
 * adds the Stage-4 corrective once Phase C's discovery-flow tool
 * loop lands.
 */

import { runSilentGuardStages, type GuardDeps, type GuardOutcome } from '../../tool-call-guard.js';
import type { ToolCall } from '../../../shared/types.js';
import { listSkills, getSkill } from '../../../daemon/skills/registry.js';
import { getDataSkillArgRenames } from './tool-call-guard-rules.js';
import { getLogger } from '../../../shared/logger.js';

const log = getLogger('data-analyzer:tool-call-guard');

/**
 * Session-derived defaults for data-analyzer skill dispatch. Mirrors
 * the code-side's `repoPath` injection but keyed off the active
 * connection / schema / database in the data-analyzer session
 * state. Passed to the guard so the LLM doesn't have to repeat
 * these on every skill call.
 */
export interface DataSessionDefaults {
	readonly connectionId?: string | undefined;
	readonly schema?:       string | undefined;
	readonly database?:     string | undefined;
}

/**
 * Outcome of the data-side silent guard. Mirrors the code-side
 * `GuardOutcome` shape but is narrower: only `pass`, `coerced`, or
 * `rejected` (Stage 1 unknown-name; Stage 4 reject is deferred to
 * Phase D).
 */
export type DataGuardOutcome =
	| { readonly kind: 'pass';     readonly call: ToolCall }
	| { readonly kind: 'coerced';  readonly call: ToolCall; readonly notes: readonly string[] }
	| Extract<GuardOutcome, { kind: 'rejected' }>;

/**
 * Run Phase-B silent stages (1-3.5) on one tool call before
 * dispatch. Returns:
 *
 *   - `pass`     -- nothing changed; dispatch the original call.
 *   - `coerced`  -- one or more silent transforms applied (rename,
 *                   type-coerce, session-default inject); dispatch
 *                   the coerced call instead.
 *   - `rejected` -- ONLY for Stage-1 unknown-tool-name failures
 *                   (the tool doesn't exist in the data-skill
 *                   catalog). Caller should NOT dispatch; the
 *                   corrective ToolResult is in `correctiveResult`.
 *
 * Schema-mismatch cases (missing required, unexpected, type
 * mismatch) fall through silently in Phase B -- they surface as
 * runtime errors from the underlying runner. Phase D upgrades these
 * to typed correctives once the discovery-flow tool loop lands.
 */
export function runDataAnalyzerGuard(
	call:             ToolCall,
	sessionDefaults?: DataSessionDefaults,
): DataGuardOutcome {
	const deps: GuardDeps = {
		listSkillIds:        listDataSkillIds,
		getSkillInputSchema: defaultGetDataSkillSchema,
		getArgRenames:       getDataSkillArgRenames,
		...(sessionDefaults !== undefined ? { sessionDefaults: normalizeDefaults(sessionDefaults) } : {}),
	};

	const silent = runSilentGuardStages(call, deps);
	if (silent.kind === 'rejected') {
		return silent;
	}

	if (silent.notes.length === 0) {
		return { kind: 'pass', call };
	}

	log.info(
		{
			originalName: call.name,
			resolvedName: silent.coercedCall.name,
			notes:        silent.notes,
		},
		'data-analyzer:tool-call-guard: coerced before dispatch',
	);

	return { kind: 'coerced', call: silent.coercedCall, notes: silent.notes };
}

// ---------------------------------------------------------------------------
// Default deps backed by the data-skill registry
// ---------------------------------------------------------------------------

/**
 * List only the `data.*` skill ids. Filtering this narrowly prevents
 * fuzzy-matching from coercing a misspelled name to a code-side
 * skill ("code.entity.summary") when the LLM is mid-data-analysis.
 */
export function listDataSkillIds(): readonly string[] {
	return listSkills()
		.filter(s => s.id.startsWith('data.'))
		.map(s => s.id);
}

function defaultGetDataSkillSchema(id: string): Record<string, unknown> | undefined {
	const skill = getSkill(id);
	return skill?.inputs;
}

/**
 * Strip undefined entries off the session defaults so the guard's
 * Stage-3.5 inject only sees concrete values. Callers commonly pass
 * `{ connectionId: session.currentConnectionId, schema: undefined }`
 * and we don't want a fake "undefined" inject muddying the notes.
 */
function normalizeDefaults(d: DataSessionDefaults): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (d.connectionId !== undefined && d.connectionId !== '') out['connectionId'] = d.connectionId;
	if (d.schema       !== undefined && d.schema       !== '') out['schema']       = d.schema;
	if (d.database     !== undefined && d.database     !== '') out['database']     = d.database;
	return out;
}

// Test exports.
export const _normalizeDefaultsForTest = normalizeDefaults;
