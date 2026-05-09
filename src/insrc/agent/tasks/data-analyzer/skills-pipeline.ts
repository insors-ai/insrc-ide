/**
 * Skills-routing pipeline for the data-analyzer (data-analyzer-skills.md
 * §7 + §8).
 *
 * Drop-in replacement for the legacy plan / per-task / runner path that
 * routes a free-form question through the meta-skills:
 *
 *     classify-question → select-scope → runSkill per ScopedInvocation
 *                       → calibrate-confidence
 *
 * Returns a structured pipeline result the orchestrator adapts into
 * `AcceptedTask[]` + `DataAnalyzerResult[]` (the legacy shapes the
 * synthesise step still consumes).
 *
 * Gated behind `insrc.dataAnalyzer.skillsRouting` (off by default).
 * The legacy code path stays untouched; flipping the flag back off
 * restores the original behaviour.
 *
 * v1 scope:
 *   - Sequential skill execution. Per-skill streaming progress is a
 *     follow-up (the orchestrator's task-driven model would expose
 *     each skill as its own task, but that requires extending
 *     `TaskResult` to surface structured `data` -- deferred).
 *   - The review step is skipped in skills-routing mode. SkillResults
 *     carry their own confidence + notes which the calibrate-confidence
 *     skill rolls into a final verdict; the legacy reviewer's per-task
 *     contract doesn't fit one-shot skill results.
 *   - Drill-down / rerun / diff stay legacy-only for v1. The flag is
 *     captured at run start; re-running an old report keeps using its
 *     captured value.
 */

import { runSkill } from '../../../daemon/skills/invoke.js';
import type { Session } from '../../session.js';
import type {
	AcceptedTask,
	DataAnalysisState,
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
	// meta-skills' input schemas accept ({ id, family, kind? }).
	// classify-question and select-scope both declare
	// `additionalProperties: false` on their connection items, so
	// passing the full summary (which has `name`, `tier`, etc.)
	// trips input validation.
	const connectionsForMeta = input.connections.map((c): { id: string; family: string; kind?: string } => ({
		id:     c.id,
		family: c.family,
		...(c.kind !== undefined ? { kind: c.kind } : {}),
	}));

	// 1. classify-question.
	const classify = await runSkill<{ question: string; connections: readonly { id: string; family: string; kind?: string }[] }, ClassifyOutputView>(
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
		{ question: string; candidates: ClassifyOutputView['candidates']; connections: readonly { id: string; family: string; kind?: string }[] },
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
		try {
			const result = await runSkill<Record<string, unknown>, unknown>(
				inv.skillId,
				inv.args,
				buildSkillRunnerDeps(deps),
			);
			executions.push({
				skillId:       inv.skillId,
				args:          inv.args,
				resolvedScope: inv.resolvedScope,
				value:         result.value,
				confidence:    result.confidence,
				notes:         result.notes ?? [],
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
// Feature flag
// ---------------------------------------------------------------------------

/**
 * Read site for `insrc.dataAnalyzer.skillsRouting`. Returns true when
 * the orchestrator should use the skills-routing path instead of the
 * legacy plan + per-task runner. Default: false.
 *
 * The flag lives in `state.skillsRouting` on the run state so a
 * re-run of an old report keeps the original routing behaviour even
 * if the user has flipped the flag in the meantime. Step 4b wires
 * this; v1 returns false unconditionally.
 *
 * In step 4b the orchestrator persists the captured value into
 * `K_STATE.skillsRouting` at run start; a follow-up surfaces the
 * flag through `tools.config.set` IPC and the Model Providers
 * pane settings UI.
 */
export function isSkillsRoutingEnabled(state: DataAnalysisState | undefined): boolean {
	const ss = state as DataAnalysisState & { readonly skillsRouting?: boolean } | undefined;
	return ss?.skillsRouting === true;
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
