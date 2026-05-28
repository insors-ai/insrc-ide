/**
 * Skills-routing pipeline for the data-analyzer (data-analyzer-skills.md
 * §7 + §8).
 *
 * Routes a free-form question through the meta-skills:
 *
 *     classify-question → select-scope → runSkill per ScopedInvocation
 *                       → calibrate-confidence
 *
 * Returns a structured pipeline result the orchestrator adapts into
 * `AcceptedTask[]` + `DataAnalyzerResult[]` (the legacy shapes the
 * synthesise step still consumes).
 *
 * This is the only data-analyzer routing path; the legacy plan-LLM
 * pipeline has been removed.
 *
 * v1 scope:
 *   - Sequential skill execution. Per-skill streaming progress is a
 *     follow-up (the orchestrator's task-driven model would expose
 *     each skill as its own task, but that requires extending
 *     `TaskResult` to surface structured `data` -- deferred).
 *   - The review step is skipped in skills-routing mode. SkillResults
 *     carry their own confidence + notes which the calibrate-confidence
 *     skill rolls into a final verdict.
 */

import { runSkill } from '../../../daemon/skills/invoke.js';
import { runDataAnalyzerGuard, type DataSessionDefaults } from './tool-call-guard.js';
import type { Session } from '../../session.js';
import type {
	AcceptedTask,
} from './state.js';
import type {
	BlockedReason,
	Confidence,
	ConnectionSummary,
	DataAnalysisKind,
	DataAnalysisTask,
	DataAnalysisConcern,
	DataAnalyzerResult,
	DataCitation,
	DataFinding,
	FindingSeverity,
	ToolCallSummary,
} from './types.js';
import type { LLMProvider, ProviderName } from '../../../shared/types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Capabilities the orchestrator threads in. Keep this surface small --
 * the pipeline's job is to bind the meta-skills to a session, not to
 * own session lifecycle.
 */
export interface SkillsPipelineDeps {
	readonly session: Session;
	/** Resolves an `LLMProvider` for `cloud` / `local` / `auto` affinity. */
	readonly resolveProvider: (affinity: 'local' | 'cloud' | 'auto') => LLMProvider;
	readonly signal?: AbortSignal | undefined;
}

export interface SkillsPipelineInput {
	readonly question:    string;
	readonly connections: readonly ConnectionSummary[];
}

export interface ClassifyOutputView {
	readonly questionType:     string;
	readonly candidates:       readonly { readonly skillId: string; readonly rationale: string; readonly mustHaveScope: string }[];
	readonly fallbacks:        readonly string[];
	readonly uncertaintyNotes: readonly string[];
}

export interface SelectScopeOutputView {
	readonly scoped: readonly {
		readonly skillId:       string;
		readonly args:          Record<string, unknown>;
		readonly resolvedScope: { readonly connectionId: string; readonly target?: string; readonly columns?: readonly string[] };
		readonly ambiguity?:    { readonly kind: string; readonly alternatives?: readonly string[] };
	}[];
	readonly notes: readonly string[];
}

export interface PerSkillExecution {
	readonly skillId:       string;
	readonly args:          Record<string, unknown>;
	readonly resolvedScope: { readonly connectionId: string; readonly target?: string; readonly columns?: readonly string[] };
	readonly value:         unknown;
	readonly confidence:    'high' | 'medium' | 'low';
	readonly notes:         readonly string[];
	readonly toolCalls:     readonly { readonly toolId: string; readonly durationMs: number; readonly error?: string }[];
	readonly errored:       boolean;
}

export interface SkillsPipelineResult {
	readonly classify: ClassifyOutputView;
	readonly select:   SelectScopeOutputView;
	readonly executions: readonly PerSkillExecution[];
	/** Aggregated final confidence (rolled by `meta.calibrate-confidence`). */
	readonly finalConfidence: Confidence;
	/** Free-form planner-facing notes captured from each stage. */
	readonly notes: readonly string[];
	/** True when the pipeline short-circuited (classify or select returned low). */
	readonly aborted: boolean;
}

// ---------------------------------------------------------------------------
// Pipeline runner
// ---------------------------------------------------------------------------

/**
 * Run the four-stage meta-pipeline. Returns a structured result; never
 * throws (errors degrade to `aborted: true` with notes). The
 * orchestrator decides how to react -- typically, when `aborted` is
 * true it surfaces the notes to the user without running a synthesise
 * step.
 */
export async function runSkillsPipeline(
	input: SkillsPipelineInput,
	deps: SkillsPipelineDeps,
): Promise<SkillsPipelineResult> {
	const notes: string[] = [];

	// Project the full ConnectionSummary down to the lean shape the
	// meta-skills' input schemas accept. classify-question and
	// select-scope both declare `additionalProperties: false`, so
	// only the documented keys flow through.
	//
	// `path` + `label` are included so the meta-skills can map
	// question targets (file paths, directory paths, user-assigned
	// labels) to the right connection id. Without them, the LLM sees
	// only opaque `ephemeral:<hash>` strings and can't disambiguate
	// which connection matches a path-shaped target -- the source
	// of the "select-scope returned confidence=low" failure that
	// motivated the connection-roster-enrichment fix.
	type MetaConnection = {
		readonly id:     string;
		readonly family: string;
		readonly kind?:  string;
		readonly label?: string;
		readonly path?:  string;
	};
	const connectionsForMeta: readonly MetaConnection[] = input.connections.map((c): MetaConnection => ({
		id:     c.id,
		family: c.family,
		...(c.kind  !== undefined && c.kind.length  > 0 ? { kind:  c.kind  } : {}),
		...(c.label !== undefined && c.label.length > 0 ? { label: c.label } : {}),
		...(c.path  !== undefined && c.path.length  > 0 ? { path:  c.path  } : {}),
	}));

	// 1. classify-question.
	const classify = await runSkill<{ question: string; connections: readonly MetaConnection[] }, ClassifyOutputView>(
		'data.meta.classify-question',
		{ question: input.question, connections: connectionsForMeta },
		buildSkillRunnerDeps(deps),
	);
	if (classify.confidence === 'low' || classify.value.candidates.length === 0) {
		const reason = classify.notes !== undefined && classify.notes.length > 0
			? `classify-question returned confidence=low: ${classify.notes.join('; ')}`
			: 'classify-question returned no candidates';
		notes.push(reason);
		return {
			classify: classify.value,
			select:   { scoped: [], notes: [] },
			executions: [],
			finalConfidence: 'low',
			notes,
			aborted: true,
		};
	}

	// 2. select-scope (uses the same lean connections shape).
	const select = await runSkill<
		{ question: string; candidates: ClassifyOutputView['candidates']; connections: readonly MetaConnection[] },
		SelectScopeOutputView
	>(
		'data.meta.select-scope',
		{
			question:    input.question,
			candidates:  classify.value.candidates,
			connections: connectionsForMeta,
		},
		buildSkillRunnerDeps(deps),
	);
	if (select.confidence === 'low' || select.value.scoped.length === 0) {
		const reason = select.notes !== undefined && select.notes.length > 0
			? `select-scope returned confidence=low: ${select.notes.join('; ')}`
			: 'select-scope returned no scoped invocations';
		notes.push(reason);
		return {
			classify: classify.value,
			select:   select.value,
			executions: [],
			finalConfidence: 'low',
			notes,
			aborted: true,
		};
	}

	// 3. Per-scoped runSkill (sequential v1).
	const executions: PerSkillExecution[] = [];
	for (const inv of select.value.scoped) {
		// Phase B of plans/analyzers/data-analyzer-parity.md: run the
		// silent guard (Stages 1-3.5: fuzzy name resolve / arg rename /
		// type coerce / session-default inject) before dispatch. Acts
		// as defense-in-depth on top of select-scope's output -- the
		// LLM behind select-scope usually picks the right shape, but
		// the guard catches arg-name drift and array/scalar mistakes
		// before they hit runSkill's hard input validation. Stage-4
		// rejection is deliberately NOT invoked (see the data-side
		// guard module's doc for why).
		const guarded = await runDataAnalyzerGuard(
			{ id: `scoped-${inv.skillId}`, name: inv.skillId, input: inv.args },
			buildSessionDefaults(inv.resolvedScope),
		);
		const dispatchSkillId = guarded.kind === 'coerced' ? guarded.call.name  : inv.skillId;
		const dispatchArgs    = guarded.kind === 'coerced' ? guarded.call.input : inv.args;
		const guardNotes      = guarded.kind === 'coerced' ? guarded.notes      : [];

		// Stage 1 unknown-tool-name rejection is the only path that
		// still refuses dispatch in Phase B. Record as an errored
		// execution -- the corrective text is captured in notes for
		// downstream visibility.
		if (guarded.kind === 'rejected') {
			executions.push({
				skillId:       inv.skillId,
				args:          inv.args,
				resolvedScope: inv.resolvedScope,
				value:         null,
				confidence:    'low',
				notes:         [`data-analyzer:tool-call-guard rejected: ${guarded.reason}`],
				toolCalls:     [],
				errored:       true,
			});
			continue;
		}

		try {
			const result = await runSkill<Record<string, unknown>, unknown>(
				dispatchSkillId,
				dispatchArgs,
				buildSkillRunnerDeps(deps),
			);
			executions.push({
				skillId:       inv.skillId,
				args:          dispatchArgs,
				resolvedScope: inv.resolvedScope,
				value:         result.value,
				confidence:    result.confidence,
				notes:         [...guardNotes, ...(result.notes ?? [])],
				toolCalls:     result.toolCalls.map(tc => ({
					toolId:     tc.toolId,
					durationMs: tc.durationMs,
					...(tc.error !== undefined ? { error: tc.error } : {}),
				})),
				errored:       false,
			});
		} catch (err) {
			executions.push({
				skillId:       inv.skillId,
				args:          inv.args,
				resolvedScope: inv.resolvedScope,
				value:         null,
				confidence:    'low',
				notes:         [`skill execution threw: ${(err as Error).message}`],
				toolCalls:     [],
				errored:       true,
			});
		}
	}

	// 4. calibrate-confidence over the aggregated execution set.
	const calibrated = await runCalibrate(deps, input.question, executions);
	if (calibrated.notes.length > 0) {
		notes.push(...calibrated.notes);
	}

	return {
		classify: classify.value,
		select:   select.value,
		executions,
		finalConfidence: calibrated.confidence,
		notes,
		aborted: false,
	};
}

interface CalibrateRollup {
	readonly confidence: Confidence;
	readonly notes:      readonly string[];
}

async function runCalibrate(
	deps: SkillsPipelineDeps,
	question: string,
	executions: readonly PerSkillExecution[],
): Promise<CalibrateRollup> {
	if (executions.length === 0) { return { confidence: 'low', notes: ['no executions to calibrate'] }; }

	// data.meta.calibrate-confidence consumes a list of {confidence,
	// notes, toolErrored?} pairs and a question + tool-error trace.
	// Shape adapted from the shipped skill's input schema.
	type CalibrateInput = {
		readonly question: string;
		readonly findings: readonly { readonly confidence: Confidence; readonly notes: readonly string[] }[];
		readonly toolErrors: readonly { readonly toolId: string; readonly error: string }[];
	};
	type CalibrateOutput = {
		readonly confidence: Confidence;
		readonly rationale: readonly string[];
	};

	const findings = executions.map(e => ({
		confidence: e.confidence,
		notes:      e.notes,
	}));
	const toolErrors = executions.flatMap(e =>
		e.toolCalls
			.filter(tc => tc.error !== undefined)
			.map(tc => ({ toolId: tc.toolId, error: tc.error ?? '' })),
	);

	try {
		const result = await runSkill<CalibrateInput, CalibrateOutput>(
			'data.meta.calibrate-confidence',
			{ question, findings, toolErrors },
			buildSkillRunnerDeps(deps),
		);
		return {
			confidence: result.value.confidence,
			notes:      result.value.rationale ?? [],
		};
	} catch (err) {
		// Calibration failure -> fall back to min-confidence rollup.
		const rolled = rollupMinConfidence(executions);
		return {
			confidence: rolled,
			notes:      [`calibrate-confidence skill failed: ${(err as Error).message}`],
		};
	}
}

function rollupMinConfidence(executions: readonly PerSkillExecution[]): Confidence {
	const rank: Record<Confidence, number> = { high: 2, medium: 1, low: 0 };
	let min: Confidence = 'high';
	for (const e of executions) {
		if (rank[e.confidence] < rank[min]) { min = e.confidence; }
	}
	return min;
}

function buildSkillRunnerDeps(deps: SkillsPipelineDeps): {
	session: Session;
	resolveProvider: (affinity: 'local' | 'cloud' | 'auto') => LLMProvider;
	signal?: AbortSignal;
} {
	return {
		session:         deps.session,
		resolveProvider: deps.resolveProvider,
		...(deps.signal !== undefined ? { signal: deps.signal } : {}),
	};
}

/**
 * Project a select-scope `resolvedScope` into the Phase-B guard's
 * `DataSessionDefaults` shape. Today this is just `connectionId` --
 * `schema` + `database` aren't present on the resolved-scope shape
 * yet. When richer scope concepts land (e.g. select-scope emitting
 * a fully-qualified `(connection, schema)` tuple), the additional
 * fields wire through here.
 */
function buildSessionDefaults(
	scope: { readonly connectionId: string; readonly target?: string },
): DataSessionDefaults {
	return scope.connectionId !== '' ? { connectionId: scope.connectionId } : {};
}

// ---------------------------------------------------------------------------
// Adapter: SkillsPipelineResult → AcceptedTask[] (legacy shape)
// ---------------------------------------------------------------------------

/**
 * Adapt a `SkillsPipelineResult` into the legacy `AcceptedTask[]`
 * shape. Each `PerSkillExecution` becomes a synthetic `DataAnalysisTask`
 * + `DataAnalyzerResult` pair the existing synthesise prompt builder
 * can consume without modification.
 *
 * The synthetic task uses `DataAnalysisKind: 'free-form'` (the
 * catch-all kind) and stores the skillId + scope in the task hint
 * for traceability. The synthetic result derives its `findings` +
 * `citations` from the skill's typed value when possible (currently:
 * one finding per execution with a derived citation; richer
 * extraction lands in step 4b's orchestrator wiring once we know
 * which skill output shapes need bespoke handling).
 */
export function pipelineResultToAcceptedTasks(
	pipeline: SkillsPipelineResult,
	itemIdPrefix: string,
): AcceptedTask[] {
	const out: AcceptedTask[] = [];
	for (let i = 0; i < pipeline.executions.length; i++) {
		const exec = pipeline.executions[i]!;
		const itemId = `${itemIdPrefix}-skill-${i}`;
		const task: DataAnalysisTask = {
			itemId,
			kind:    'free-form' as DataAnalysisKind,
			question: `[skill] ${exec.skillId}`,
			origin:  'plan',
			...(exec.resolvedScope.connectionId !== undefined ? {
				scope: {
					connections: [exec.resolvedScope.connectionId],
					...(exec.resolvedScope.target !== undefined ? { targets: [exec.resolvedScope.target] } : {}),
				},
			} : {}),
			hint: `skillsRouting v1: skill=${exec.skillId} scope=${JSON.stringify(exec.resolvedScope)}`,
		};
		const finding = buildFindingFromExecution(exec);
		const citations = finding === null ? [] : [...finding.citations];
		const result: DataAnalyzerResult = {
			itemId,
			answer:     buildAnswerFromExecution(exec),
			findings:   finding === null ? [] : [finding],
			citations,
			confidence: exec.confidence,
			toolCalls:  exec.toolCalls.map((tc): ToolCallSummary => ({
				name:       tc.toolId,
				argsHash:   '',          // skill-routed calls don't expose per-call arg hashes; left empty in v1
				durationMs: tc.durationMs,
				resultRows: 0,           // not surfaced by the SkillResult.toolCalls summary; left 0 in v1
				...(tc.error !== undefined ? { error: tc.error } : {}),
			})),
			...(exec.errored ? { blockedReason: 'tool-error-abort' as BlockedReason } : {}),
		};
		out.push({ task, result });
	}
	return out;
}

function buildAnswerFromExecution(exec: PerSkillExecution): string {
	if (exec.errored) {
		return `Skill \`${exec.skillId}\` failed: ${exec.notes.join('; ')}`;
	}
	const summary =
		exec.value === null || exec.value === undefined
			? '(no value)'
			: typeof exec.value === 'object'
				? safePreview(exec.value)
				: String(exec.value);
	return `Result of \`${exec.skillId}\`:\n\`\`\`json\n${summary}\n\`\`\``;
}

function buildFindingFromExecution(exec: PerSkillExecution): DataFinding | null {
	if (exec.errored) { return null; }

	// v1 emits a single, generic finding per execution. Concern + severity
	// are derived from the skill's family-shaped id prefix:
	//   data.profile.*   → 'profile'   info
	//   data.quality.*   → 'quality'   warn (high-confidence) / info
	//   data.drift.*     → 'drift'     warn
	//   data.pii.*       → 'pii'       error
	//   data.lineage.*   → 'lineage'   info
	//   data.timeseries  → 'timeseries' info
	//   default          → 'free-form' info
	// Step 4b will add per-output-shape extractors so findings are
	// richer (one per quality-dimension violation, one per PII match,
	// etc.). v1 keeps the synthesise prompt shape intact; richer
	// findings come later.
	const concern  = familyToConcern(exec.skillId);
	const severity = familyToSeverity(exec.skillId, exec.confidence);
	const issue    = exec.notes.length > 0 ? exec.notes[0]! : `${exec.skillId} returned a result.`;
	const citation = buildCitationFromScope(exec);
	if (citation === null) { return null; }
	return { concern, severity, issue, citations: [citation] };
}

function familyToConcern(skillId: string): DataAnalysisConcern {
	// Maps the skill family-prefix onto the closest existing
	// DataAnalysisConcern enum value. The legacy concern set
	// (schema-drift / pii-exposure / lineage-gap / consistency /
	// capacity-risk) was designed for the pre-skills planner; the
	// mapping below is best-effort. A richer concern enum lands
	// alongside the orchestrator wiring in step 4b.
	if (skillId.startsWith('data.drift.'))         { return 'schema-drift'; }
	if (skillId.startsWith('data.pii.'))           { return 'pii-exposure'; }
	if (skillId.startsWith('data.sensitivity.'))   { return 'pii-exposure'; }
	if (skillId.startsWith('data.lineage.'))       { return 'lineage-gap'; }
	if (skillId.startsWith('data.quality.consistency')) { return 'consistency'; }
	if (skillId.startsWith('data.cardinality.'))   { return 'capacity-risk'; }
	// Profile / distribution / dependency / source-introspection /
	// timeseries / quality (other dimensions) all fall through to
	// `consistency` as the closest neutral bucket.
	return 'consistency';
}

function familyToSeverity(skillId: string, confidence: Confidence): FindingSeverity {
	if (skillId.startsWith('data.pii.'))    { return 'error'; }
	if (skillId.startsWith('data.drift.'))  { return confidence === 'high' ? 'warn' : 'info'; }
	if (skillId.startsWith('data.quality.')) { return confidence === 'high' ? 'warn' : 'info'; }
	return 'info';
}

function buildCitationFromScope(exec: PerSkillExecution): DataCitation | null {
	const scope = exec.resolvedScope;
	if (typeof scope.connectionId !== 'string' || scope.connectionId.length === 0) { return null; }
	if (scope.target !== undefined) {
		return {
			kind:         'rdbms',
			connectionId: scope.connectionId,
			table:        scope.target,
			...(scope.columns !== undefined && scope.columns.length > 0 ? { column: scope.columns[0] } : {}),
		};
	}
	return {
		kind:       'kv',
		connectionId: scope.connectionId,
		keyPattern:   '*',
	};
}

function safePreview(value: unknown): string {
	try {
		const json = JSON.stringify(value, null, 2);
		return json.length <= 4096 ? json : json.slice(0, 4096) + '\n... <truncated>';
	} catch {
		return '<unserializable value>';
	}
}

// ---------------------------------------------------------------------------
// Provider selection: cloud-small-tier defaults per active provider
// ---------------------------------------------------------------------------

/**
 * Plan §7.1 specified small/fast tier per provider (gpt-4o-mini /
 * claude-haiku-4-5 / gemini-2.5-flash / mistral-small-latest). The
 * pipeline reads this for hint-only telemetry; the actual provider
 * resolution flows through `deps.resolveProvider` which respects the
 * session's bound model. Future plans/auth can surface this in the
 * Model Providers pane defaults.
 */
export const SKILLS_ROUTING_DEFAULT_MODEL: Readonly<Record<ProviderName, string>> = {
	local:     '',                            // no override; ollama config wins
	openai:    'gpt-4o-mini',
	anthropic: 'claude-haiku-4-5',
	gemini:    'gemini-2.5-flash',
	mistral:   'mistral-small-latest',
};
