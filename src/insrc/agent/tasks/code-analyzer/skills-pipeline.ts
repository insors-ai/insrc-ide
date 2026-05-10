/**
 * Skills-routing pipeline for the code-analyzer (code-analyzer-skills.md
 * §7 + §8). Mirror of the data-analyzer pipeline shipped in
 * agent/tasks/data-analyzer/skills-pipeline.ts.
 *
 * Drop-in replacement for the legacy plan / per-task / runner path that
 * routes a free-form question through the code-analyzer meta-skills:
 *
 *     code.meta.classify-question
 *       -> code.meta.select-scope
 *       -> runSkill per ScopedInvocation
 *       -> data.meta.calibrate-confidence (shared)
 *
 * Returns a structured pipeline result the orchestrator adapts into
 * `{ task, result }[]` (the legacy shape the synthesise step still
 * consumes).
 *
 * Gated behind `INSRC_CODE_ANALYZER_SKILLS_ROUTING` (off by default).
 * The legacy code path stays untouched; flipping the flag back off
 * restores the original behaviour.
 *
 * v1 scope:
 *   - Sequential skill execution. Per-skill streaming progress is a
 *     follow-up.
 *   - Review step is skipped in skills-routing mode. SkillResults
 *     carry their own confidence + notes which calibrate-confidence
 *     rolls into a final verdict.
 *   - Drill-down / re-run / diff stay legacy-only for v1; the flag
 *     is captured at run-start so re-running an old report keeps
 *     using its captured value.
 */

import { runSkill } from '../../../daemon/skills/invoke.js';
import type { Session } from '../../session.js';
import type {
	AnalysisKind,
	AnalysisScope,
	AnalysisTask,
	AnalyzerResult,
	CodeAnalysisConcern,
	CodeCitation,
	Confidence,
	Finding,
	FindingSeverity,
	RepoSummary,
	ToolCallSummary,
} from './types.js';
import type { LLMProvider, ProviderName } from '../../../shared/types.js';

/**
 * Sentinel string the orchestrator's bootstrap pass-through task
 * carries when skills-routing is on. `next()` detects this exact
 * string and routes to the skills-pipeline branch instead of the
 * legacy LLM-plan parser.
 */
export const SKILLS_ROUTING_BOOTSTRAP_MARKER = '__skills-routing-bootstrap__';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SkillsPipelineDeps {
	readonly session: Session;
	readonly resolveProvider: (affinity: 'local' | 'cloud' | 'auto') => LLMProvider;
	readonly signal?: AbortSignal | undefined;
}

interface RepoMetaContext {
	readonly path:               string;
	readonly primaryLanguages?:  readonly string[];
	readonly detectedOrms?:      readonly string[];
	readonly migrationTool?:     string;
}

export interface SkillsPipelineInput {
	readonly question: string;
	readonly repo:     RepoMetaContext;
	/**
	 * Optional prior-turn facts the meta-skills can use to resolve
	 * label -> identifier references (e.g. "HDFS Core" -> the actual
	 * `modulePath` that turn 1 surfaced). Threaded by the chat-handler
	 * after `retrievePriorContext`; if absent, the skills run cold.
	 * conversation-flow-refinement.md Phase 4.
	 *
	 * Only the typed `facts` half is forwarded to skills today --
	 * the `artifacts` previews stay with the enhancer (Phase 3) and
	 * the orchestrator's audit pane.
	 */
	readonly priorFacts?: PriorFactsForSkills;
}

/**
 * Subset of agent/intent/retriever.ts `PriorFacts` that meta-skills
 * actually consume. Mirror-shape on purpose so the orchestrator can
 * pass through without coupling skills-pipeline to the retriever
 * module's import surface.
 */
export interface PriorFactsForSkills {
	readonly modules?:   readonly { path: string; label?: string; fileCount?: number }[];
	readonly entities?:  readonly { entityRef: string; name: string; kind: string; file?: string }[];
	readonly tables?:    readonly { connectionId: string; name: string; columns?: string[] }[];
	readonly ormModels?: readonly { name: string; table?: string; dialect: string }[];
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
		readonly resolvedScope: { readonly repoPath: string; readonly entityRef?: string; readonly file?: string; readonly className?: string; readonly model?: string };
		readonly ambiguity?:    { readonly kind: string; readonly alternatives?: readonly string[] };
	}[];
	readonly notes: readonly string[];
}

export interface PerSkillExecution {
	readonly skillId:       string;
	readonly args:          Record<string, unknown>;
	readonly resolvedScope: { readonly repoPath: string; readonly entityRef?: string; readonly file?: string; readonly className?: string; readonly model?: string };
	readonly value:         unknown;
	readonly confidence:    Confidence;
	readonly notes:         readonly string[];
	readonly toolCalls:     readonly { readonly toolId: string; readonly durationMs: number; readonly error?: string }[];
	readonly errored:       boolean;
}

export interface SkillsPipelineResult {
	readonly classify: ClassifyOutputView;
	readonly select:   SelectScopeOutputView;
	readonly executions: readonly PerSkillExecution[];
	readonly finalConfidence: Confidence;
	readonly notes: readonly string[];
	readonly aborted: boolean;
}

// ---------------------------------------------------------------------------
// Pipeline runner
// ---------------------------------------------------------------------------

/**
 * Run the four-stage meta-pipeline. Returns a structured result;
 * never throws (errors degrade to `aborted: true` with notes).
 */
export async function runSkillsPipeline(
	input: SkillsPipelineInput,
	deps: SkillsPipelineDeps,
): Promise<SkillsPipelineResult> {
	const notes: string[] = [];

	const repo = pruneRepo(input.repo);

	// 1. classify-question.
	const classify = await runSkill<{ question: string; repo: RepoMetaContext }, ClassifyOutputView>(
		'code.meta.classify-question',
		{ question: input.question, repo },
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

	// 2. select-scope.
	const select = await runSkill<
		{
			question:    string;
			candidates:  ClassifyOutputView['candidates'];
			repo:        RepoMetaContext;
			priorFacts?: PriorFactsForSkills;
		},
		SelectScopeOutputView
	>(
		'code.meta.select-scope',
		{
			question:   input.question,
			candidates: classify.value.candidates,
			repo,
			// Phase 4: thread prior-turn facts so select-scope can
			// resolve label references (e.g. "HDFS Core") against
			// modules / entities / tables the prior turn surfaced.
			...(input.priorFacts !== undefined ? { priorFacts: input.priorFacts } : {}),
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

	// 4. calibrate-confidence (shared with data-analyzer).
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
	if (executions.length === 0) return { confidence: 'low', notes: ['no executions to calibrate'] };

	type CalibrateInput = {
		readonly question: string;
		readonly findings: readonly { readonly confidence: Confidence; readonly notes: readonly string[] }[];
		readonly toolErrors: readonly { readonly toolId: string; readonly error: string }[];
	};
	type CalibrateOutput = {
		readonly confidence: Confidence;
		readonly rationale: readonly string[];
	};

	const findings = executions.map(e => ({ confidence: e.confidence, notes: e.notes }));
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
		return { confidence: result.value.confidence, notes: result.value.rationale ?? [] };
	} catch (err) {
		const rolled = rollupMinConfidence(executions);
		return { confidence: rolled, notes: [`calibrate-confidence skill failed: ${(err as Error).message}`] };
	}
}

function rollupMinConfidence(executions: readonly PerSkillExecution[]): Confidence {
	const rank: Record<Confidence, number> = { high: 2, medium: 1, low: 0 };
	let min: Confidence = 'high';
	for (const e of executions) {
		if (rank[e.confidence] < rank[min]) min = e.confidence;
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

function pruneRepo(repo: RepoMetaContext): RepoMetaContext {
	const out: { -readonly [K in keyof RepoMetaContext]?: RepoMetaContext[K] } = { path: repo.path };
	if (repo.primaryLanguages !== undefined && repo.primaryLanguages.length > 0) {
		out.primaryLanguages = repo.primaryLanguages;
	}
	if (repo.detectedOrms !== undefined && repo.detectedOrms.length > 0) {
		out.detectedOrms = repo.detectedOrms;
	}
	if (repo.migrationTool !== undefined && repo.migrationTool.length > 0) {
		out.migrationTool = repo.migrationTool;
	}
	return out as RepoMetaContext;
}

// ---------------------------------------------------------------------------
// Adapter: SkillsPipelineResult → { task, result }[] (legacy shape)
// ---------------------------------------------------------------------------

export interface AcceptedTaskPair {
	readonly task:   AnalysisTask;
	readonly result: AnalyzerResult;
}

/**
 * Adapt a `SkillsPipelineResult` into the legacy
 * `{ task: AnalysisTask; result: AnalyzerResult }[]` shape that
 * `buildSynthesisPrompt` consumes. Each `PerSkillExecution`
 * becomes a synthetic task + result pair. The synthetic task
 * uses `AnalysisKind: 'free-form'` (the catch-all kind) and
 * stores the skillId in `hint` for traceability.
 *
 * Findings are derived best-effort from the skill's family
 * prefix; richer extractors per output shape land as a follow-up.
 */
export function pipelineResultToAcceptedTasks(
	pipeline: SkillsPipelineResult,
	itemIdPrefix: string,
): AcceptedTaskPair[] {
	const out: AcceptedTaskPair[] = [];
	for (let i = 0; i < pipeline.executions.length; i++) {
		const exec = pipeline.executions[i]!;
		const itemId = `${itemIdPrefix}-skill-${i}`;
		const scope = scopeFromExecution(exec);
		const task: AnalysisTask = {
			itemId,
			kind:       'free-form' as AnalysisKind,
			question:   `[skill] ${exec.skillId}`,
			origin:     'plan',
			retryCount: 0,
			...(scope !== undefined ? { scope } : {}),
			hint:       `skillsRouting v1: skill=${exec.skillId} scope=${JSON.stringify(exec.resolvedScope)}`,
		};
		const finding = buildFindingFromExecution(exec);
		const citations = finding === null ? [] : [...finding.citations];
		const result: AnalyzerResult = {
			itemId,
			answer:     buildAnswerFromExecution(exec),
			findings:   finding === null ? [] : [finding],
			citations,
			confidence: exec.confidence,
			toolCalls:  exec.toolCalls.map((tc): ToolCallSummary => ({
				name:       tc.toolId,
				argsHash:   '',     // skill-routed calls don't expose per-call arg hashes; left empty in v1
				durationMs: tc.durationMs,
				resultRows: 0,      // not surfaced by SkillResult.toolCalls; left 0 in v1
				...(tc.error !== undefined ? { error: tc.error } : {}),
			})),
		};
		out.push({ task, result });
	}
	return out;
}

function scopeFromExecution(exec: PerSkillExecution): AnalysisScope | undefined {
	const scope = exec.resolvedScope;
	const entityIds = scope.entityRef !== undefined ? [scope.entityRef] : undefined;
	const paths     = scope.file      !== undefined ? [scope.file]      : undefined;
	if (entityIds === undefined && paths === undefined) return undefined;
	const out: { -readonly [K in keyof AnalysisScope]?: AnalysisScope[K] } = {};
	if (entityIds !== undefined) out.entityIds = entityIds;
	if (paths     !== undefined) out.paths     = paths;
	return out as AnalysisScope;
}

function buildAnswerFromExecution(exec: PerSkillExecution): string {
	if (exec.errored) return `Skill \`${exec.skillId}\` failed: ${exec.notes.join('; ')}`;
	const summary =
		exec.value === null || exec.value === undefined
			? '(no value)'
			: typeof exec.value === 'object'
				? safePreview(exec.value)
				: String(exec.value);
	return `Result of \`${exec.skillId}\`:\n\`\`\`json\n${summary}\n\`\`\``;
}

function buildFindingFromExecution(exec: PerSkillExecution): Finding | null {
	if (exec.errored) return null;
	const concern  = familyToConcern(exec.skillId);
	const severity = familyToSeverity(exec.skillId, exec.confidence);
	const issue    = exec.notes.length > 0 ? exec.notes[0]! : `${exec.skillId} returned a result.`;
	const citation = buildCitationFromScope(exec);
	if (citation === null) return null;
	return { file: citation.path, concern, severity, issue, citations: [citation] };
}

function familyToConcern(skillId: string): CodeAnalysisConcern {
	if (skillId === 'code.quality.duplication')      return 'duplicates';
	if (skillId.startsWith('code.quality.'))         return 'smells';
	if (skillId === 'code.compare.signature')        return 'interface-mismatch';
	if (skillId === 'code.compare.impl-vs-doc')      return 'consistency';
	if (skillId === 'code.compare.entity-versions')  return 'impact';
	// orm + migration shape "structural consistency between code and data".
	if (skillId.startsWith('code.orm.'))             return 'consistency';
	if (skillId.startsWith('code.migration.'))       return 'consistency';
	return 'smells';
}

function familyToSeverity(skillId: string, confidence: Confidence): FindingSeverity {
	if (skillId.startsWith('code.quality.')) return confidence === 'high' ? 'warn' : 'info';
	if (skillId.startsWith('code.compare.')) return confidence === 'high' ? 'warn' : 'info';
	return 'info';
}

function buildCitationFromScope(exec: PerSkillExecution): CodeCitation | null {
	const scope = exec.resolvedScope;
	const path = scope.file ?? scope.repoPath;
	if (path.length === 0) return null;
	const c: { -readonly [K in keyof CodeCitation]?: CodeCitation[K] } = { path };
	if (scope.entityRef !== undefined) c.entityId = scope.entityRef;
	return c as CodeCitation;
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
// Repo context derivation
// ---------------------------------------------------------------------------

/**
 * Project a `RepoSummary` (the orchestrator's planning-time repo
 * snapshot) onto the lean `RepoMetaContext` shape the meta-skills'
 * input schemas accept. detectedOrms / migrationTool are not yet
 * carried by RepoSummary; v1 leaves them undefined so the catalog's
 * `code.orm.*` / `code.migration.*` skills get pre-filtered out.
 * Future enhancement: an orchestrator-side step that calls
 * `code_orm_scan` + `code_migration_walk` once at planning to
 * populate these.
 */
export function repoContextFromSummary(summary: RepoSummary): RepoMetaContext {
	const out: { -readonly [K in keyof RepoMetaContext]?: RepoMetaContext[K] } = { path: summary.rootPath };
	if (summary.primaryLanguages.length > 0) {
		out.primaryLanguages = summary.primaryLanguages;
	}
	return out as RepoMetaContext;
}

// ---------------------------------------------------------------------------
// Provider selection: cloud-small-tier defaults per active provider
// ---------------------------------------------------------------------------

/**
 * Plan §7.1 specified small/fast tier per provider. Same model
 * shortlist as data-analyzer's skills-pipeline.
 */
export const SKILLS_ROUTING_DEFAULT_MODEL: Readonly<Record<ProviderName, string>> = {
	local:     '',
	openai:    'gpt-4o-mini',
	anthropic: 'claude-haiku-4-5',
	gemini:    'gemini-2.5-flash',
	mistral:   'mistral-small-latest',
};
