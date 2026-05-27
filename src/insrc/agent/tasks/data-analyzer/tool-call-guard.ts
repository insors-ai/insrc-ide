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

import { runSilentGuardStages, guardLocalToolCall, type GuardDeps, type GuardOutcome } from '../../tool-call-guard.js';
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
 * Options for the data-side guard wrapper. The Phase-B default
 * suppresses Stage-4 schema-reject; Phase-D mode (`enableSchemaReject:
 * true`) turns it on. executeDataStep -- which DOES have a tool-loop
 * that can feed correctives back to the LLM -- uses Phase-D mode.
 * The skills-pipeline (which has no LLM tool-loop) stays on Phase-B
 * mode (default).
 */
export interface DataGuardOpts {
	/**
	 * When true, run Stage 4 (typed schema-rejection corrective). The
	 * rejected outcome carries a categorised corrective prompt
	 * (missing / unexpected / typeMismatch) the caller should feed
	 * back to the LLM as the next-turn `tool_result`. Phase D of
	 * plans/analyzers/data-analyzer-parity.md.
	 *
	 * Default `false` (Phase B silent behaviour: schema mismatches
	 * fall through to the underlying runner).
	 */
	readonly enableSchemaReject?: boolean;
}

/**
 * Run the data-side guard on one tool call before dispatch.
 *
 * Returns:
 *   - `pass`     -- nothing changed; dispatch the original call.
 *   - `coerced`  -- one or more silent transforms applied (rename,
 *                   type-coerce, session-default inject); dispatch
 *                   the coerced call instead.
 *   - `rejected` -- Stage-1 unknown-tool-name OR (Phase-D only)
 *                   Stage-4 schema mismatch. Caller should NOT
 *                   dispatch; the corrective ToolResult is in
 *                   `correctiveResult`. In Phase D mode the
 *                   corrective lists the schema's full valid arg set
 *                   with descriptions (DA-C1) and unknown-tool
 *                   suggestions include their one-line descriptions
 *                   (DA-C2).
 */
export async function runDataAnalyzerGuard(
	call:             ToolCall,
	sessionDefaults?: DataSessionDefaults,
	opts?:            DataGuardOpts,
): Promise<DataGuardOutcome> {
	const deps: GuardDeps = {
		listSkillIds:        listDataSkillIds,
		getSkillInputSchema: defaultGetDataSkillSchema,
		getArgRenames:       getDataSkillArgRenames,
		getSkillDescription: defaultGetDataSkillDescription,
		...(sessionDefaults !== undefined ? { sessionDefaults: normalizeDefaults(sessionDefaults) } : {}),
	};

	// Phase D mode: route through the full guard pipeline (Stages 1-4).
	// Stage-4 reject builds a categorised corrective that the caller's
	// tool-loop should feed back as a tool_result on the next turn.
	if (opts?.enableSchemaReject === true) {
		const outcome = await guardLocalToolCall(call, deps);
		return outcome as DataGuardOutcome;
	}

	// Phase B mode (default): silent stages only.
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
 * Source the skill's one-line description for unknown-tool corrective
 * suggestions (DA-C2). The Skill registry stores a `description` field
 * (which may be a paragraph); we surface it verbatim and let the
 * formatter truncate.
 */
function defaultGetDataSkillDescription(id: string): string | undefined {
	const skill = getSkill(id);
	return skill?.description;
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
