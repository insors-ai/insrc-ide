/**
 * executeStep -- Phase β of plans/code-analyzer-discovery-plan-loop.md.
 *
 * Runs ONE cloud-planned `DiscoveryStep` on the local LLM:
 *
 *   - The system prompt is loaded from `prompts/flow/execute-step/`,
 *     which embeds the static skill catalog ({{section:skill-glossary}})
 *     so the local LLM knows what every skill *does* and what
 *     arguments each one takes -- the prompt is otherwise stable
 *     across all step calls in a section, which keeps the KV cache
 *     warm.
 *   - The user prompt is dynamic per step: an imperative ordered task
 *     list ("Invoke `X` for **Y**. Chain: use the entityId from task
 *     N's result.") that names the specific skill + concrete target
 *     for each `PlannedSkillCall` the cloud chose.
 *   - Local runs a focused tool loop (skill_invoke + skill_describe
 *     available) and emits ONE final assistant turn containing a JSON
 *     object with `facts` + `citations`. The orchestrator parses this
 *     into a `StepOutput`.
 */

import type { LLMProvider, LLMMessage, ToolDefinition } from '../../../shared/types.js';
import type { Session } from '../../session.js';
import type { RepoSizeSummary } from '../../../daemon/repo-summary.js';
import { formatRepoSizeSummary } from '../../../daemon/repo-summary.js';
import { getTool } from '../../../daemon/tools/registry.js';
import { runToolLoop } from '../../tools/loop.js';
import { getLogger } from '../../../shared/logger.js';
import { loadFlowPrompt } from './prompts/loader.js';

import type {
	Citation,
	DiscoveryStep,
	PlannedSkillCall,
	StepOutput,
} from '../../content-gen/discovery-plan.js';

const log = getLogger('code-analyzer:execute-step');

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface ExecuteStepInput {
	readonly provider:        LLMProvider;
	readonly session:         Session;
	readonly step:            DiscoveryStep;
	/** Optional repo-size summary; if present, formatted and embedded
	 *  into the {{REPO_CONTEXT}} slot of the system prompt. */
	readonly repoSizeSummary?: RepoSizeSummary | undefined;
	/** Default 16 iterations -- enough for ~5 cloud-named skills (each:
	 *  describe + invoke = 2 turns) plus a couple of extras. */
	readonly maxIterations?:  number | undefined;
	readonly maxTokens?:      number | undefined;
	readonly onProgress?:     ((message: string) => void) | undefined;
}

export async function executeStep(input: ExecuteStepInput): Promise<StepOutput> {
	const t0 = Date.now();

	const skillInvokeTool   = getTool('skill_invoke');
	const skillDescribeTool = getTool('skill_describe');
	const tools: ToolDefinition[] = [];
	if (skillInvokeTool)   tools.push({ name: skillInvokeTool.id,   description: skillInvokeTool.description,   inputSchema: skillInvokeTool.inputSchema });
	if (skillDescribeTool) tools.push({ name: skillDescribeTool.id, description: skillDescribeTool.description, inputSchema: skillDescribeTool.inputSchema });

	if (tools.length === 0) {
		// Skill meta-tools not registered (test env without daemon, or
		// a deployment that disabled them). Return a failed step output
		// rather than crashing -- the orchestrator handles status.
		log.warn({ stepId: input.step.id }, 'executeStep: skill meta-tools not registered; emitting failed StepOutput');
		return {
			stepId:    input.step.id,
			status:    'failed',
			facts:     [],
			citations: [],
			durationMs: Date.now() - t0,
		};
	}

	const system     = buildStepSystemPrompt(input.repoSizeSummary);
	const userPrompt = buildStepUserPrompt(input.step);

	const messages: LLMMessage[] = [
		{ role: 'system', content: system },
		{ role: 'user',   content: userPrompt },
	];

	// Track which skills the model actually invoked vs which the cloud
	// asked for -- the diff is `extraSkillsCalled`.
	const plannedSkillIds = new Set(input.step.skills.map(s => s.skillId));
	const calledSkillIds:  string[] = [];

	const loopOpts: Parameters<typeof runToolLoop>[1] = {
		provider:       input.provider,
		tools,
		intent:         'code-analyzer-execute-step',
		permissionMode: 'auto-accept',
		session:        input.session,
		maxTokens:      input.maxTokens ?? 4096,
		maxIterations:  input.maxIterations ?? 16,
		disableTransitionNudge: true,
	};
	loopOpts.onToolCall = (call) => {
		if (call.name === 'skill_invoke' && typeof call.input['skillId'] === 'string') {
			calledSkillIds.push(call.input['skillId'] as string);
		}
		// Mirror the live-stream progress format used by gather + patch
		// (helpful when the orchestrator surfaces the chat panel).
		const skillRef = call.name === 'skill_invoke'
			? String(call.input['skillId'] ?? '?')
			: call.name === 'skill_describe'
			? String(call.input['id'] ?? '?')
			: '';
		input.onProgress?.(`  [${input.step.id}] ${call.name}${skillRef ? `(${skillRef})` : ''}`);
	};

	const loopResult = await runToolLoop(messages, loopOpts);

	const extraSkillsCalled = [...new Set(calledSkillIds.filter(id => !plannedSkillIds.has(id)))];

	// Parse the final assistant text as a structured emission. The
	// model is instructed to emit a JSON object at the end of the
	// loop; if parsing fails or fields are missing we report a
	// `failed` step rather than a synthesised fabrication.
	const parsed = parseStepEmission(loopResult.response);
	if (parsed === null) {
		log.warn({ stepId: input.step.id, responseLen: loopResult.response.length }, 'executeStep: failed to parse step emission JSON');
		return {
			stepId:    input.step.id,
			status:    'failed',
			facts:     [],
			citations: [],
			...(extraSkillsCalled.length > 0 ? { extraSkillsCalled } : {}),
			durationMs: Date.now() - t0,
		};
	}

	const status = determineStatus({
		facts:                parsed.facts,
		citations:            parsed.citations,
		calledSkillIds,
		plannedSkillCount:    input.step.skills.length,
	});

	return {
		stepId:    input.step.id,
		status,
		facts:     parsed.facts,
		citations: parsed.citations,
		...(extraSkillsCalled.length > 0 ? { extraSkillsCalled } : {}),
		durationMs: Date.now() - t0,
	};
}

// ---------------------------------------------------------------------------
// Internals -- prompt assembly
// ---------------------------------------------------------------------------

function buildStepSystemPrompt(repoSizeSummary: RepoSizeSummary | undefined): string {
	// Static across all step calls -- skill catalog, DOs/DONTs, envelope
	// schema all live in `prompts/flow/execute-step/system.md`. Only the
	// repo-size summary varies (per session).
	const repoContext = (repoSizeSummary !== undefined && !repoSizeSummary.empty)
		? '\n\n## Repository under analysis\n' + formatRepoSizeSummary(repoSizeSummary, 'detailed')
		: '';
	return loadFlowPrompt('execute-step', { REPO_CONTEXT: repoContext });
}

function buildStepUserPrompt(step: DiscoveryStep): string {
	// Dynamic, per-step. Imperative task list -- one numbered item per
	// PlannedSkillCall, with the bolded target and (optionally) a Chain
	// line that names the source task + the field to pull. The model
	// reads the skill's argument schema from the catalog in the system
	// prompt; the user message says what to invoke and what to invoke
	// it for.
	const parts: string[] = [];
	parts.push(`## Step: ${step.id}`);
	parts.push(`Intent: ${step.intent.trim()}`);
	parts.push('');
	parts.push('## Tasks (run in order)');
	parts.push('');

	const byCallId = new Map<string, number>();
	step.skills.forEach((c, i) => byCallId.set(c.id, i + 1));

	for (let i = 0; i < step.skills.length; i++) {
		const call = step.skills[i]!;
		parts.push(`${i + 1}. Invoke \`${call.skillId}\` for **${call.context.trim()}**.`);
		const chainLine = renderChainHint(call, byCallId);
		if (chainLine !== null) {
			parts.push(`   ${chainLine}`);
		}
	}

	parts.push('');
	parts.push('After all tasks complete (and any minimal extras you needed),');
	parts.push('emit the JSON envelope as your FINAL assistant turn -- top-level');
	parts.push('JSON only, no markdown fences, no preamble.');
	return parts.join('\n');
}

/**
 * Render the "Chain: ..." hint line for a planned call that has a
 * `dependsOn` reference. Returns `null` for non-chained calls.
 *
 * The hint names the source task by its 1-based index (matching the
 * numbered task list the model just read) and names the field to pull
 * -- defaulting to `entityId`, which is the dominant chain shape
 * (locate-by-name or search-by-vector feeding summary/callers).
 */
function renderChainHint(
	call:        PlannedSkillCall,
	byCallId:    ReadonlyMap<string, number>,
): string | null {
	if (call.dependsOn === undefined) return null;
	const sourceIdx = byCallId.get(call.dependsOn);
	const sourceRef = sourceIdx !== undefined ? `task ${sourceIdx}` : `task \`${call.dependsOn}\``;
	return `Chain: use the \`entityId\` from ${sourceRef}'s result.`;
}

// ---------------------------------------------------------------------------
// Internals -- parsing the final emission
// ---------------------------------------------------------------------------

interface ParsedEmission {
	readonly facts:     readonly string[];
	readonly citations: readonly Citation[];
}

/**
 * Parse the model's final assistant text into `{ facts, citations }`.
 * Robust to:
 *   - leading "Here is the JSON:" preambles
 *   - triple-backtick fences (with or without info string)
 *   - trailing prose after the JSON
 * Returns `null` on unrecoverable failure so the caller can mark the
 * step as `failed`.
 */
export function parseStepEmission(text: string): ParsedEmission | null {
	if (text.trim().length === 0) return null;

	// Strip fences + extract the first { ... } object.
	const json = extractJsonObject(text);
	if (json === null) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
	const obj = parsed as Record<string, unknown>;

	const factsRaw = obj['facts'];
	const facts: string[] = Array.isArray(factsRaw)
		? (factsRaw as unknown[]).filter((f): f is string => typeof f === 'string' && f.trim().length > 0).map(f => f.trim())
		: [];

	const citationsRaw = obj['citations'];
	const citations: Citation[] = Array.isArray(citationsRaw)
		? (citationsRaw as unknown[]).map(parseCitation).filter((c): c is Citation => c !== null)
		: [];

	return { facts, citations };
}

function parseCitation(raw: unknown): Citation | null {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const c = raw as Record<string, unknown>;
	const path = c['path'];
	if (typeof path !== 'string' || path.length === 0) return null;
	const cite: { -readonly [K in keyof Citation]: Citation[K] } = { path };
	if (typeof c['startLine'] === 'number') cite.startLine = c['startLine'];
	if (typeof c['endLine']   === 'number') cite.endLine   = c['endLine'];
	if (typeof c['entityId']  === 'string' && c['entityId'].length > 0) cite.entityId = c['entityId'];
	if (typeof c['label']     === 'string' && c['label'].length > 0)    cite.label    = c['label'];
	if (typeof c['repoPath']  === 'string' && c['repoPath'].length > 0) cite.repoPath = c['repoPath'];
	return cite;
}

function extractJsonObject(text: string): string | null {
	// Drop a leading triple-backtick fence if present.
	let t = text.trim();
	const fence = t.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
	if (fence) t = fence[1]!.trim();
	// Find the first balanced {...} block in the (possibly de-fenced) text.
	const start = t.indexOf('{');
	if (start === -1) return null;
	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = start; i < t.length; i++) {
		const ch = t[i]!;
		if (escape) { escape = false; continue; }
		if (ch === '\\') { escape = true; continue; }
		if (ch === '"')  { inString = !inString; continue; }
		if (inString) continue;
		if (ch === '{') depth++;
		else if (ch === '}') {
			depth--;
			if (depth === 0) return t.slice(start, i + 1);
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Internals -- status determination
// ---------------------------------------------------------------------------

function determineStatus(args: {
	readonly facts:              readonly string[];
	readonly citations:          readonly Citation[];
	readonly calledSkillIds:     readonly string[];
	readonly plannedSkillCount:  number;
}): 'ok' | 'partial' | 'failed' {
	// failed: no facts AND no citations -- the model emitted an empty
	// envelope, treat like the step didn't produce evidence.
	if (args.facts.length === 0 && args.citations.length === 0) return 'failed';
	// partial: the cloud asked for N skills but fewer were actually
	// invoked, OR the model produced facts but no citations (cited
	// claims are the contract). Use the looser threshold.
	if (args.citations.length === 0) return 'partial';
	if (args.calledSkillIds.length < args.plannedSkillCount) return 'partial';
	return 'ok';
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

export const _buildStepSystemPromptForTest = buildStepSystemPrompt;
export const _buildStepUserPromptForTest   = buildStepUserPrompt;
export const _determineStatusForTest       = determineStatus;
