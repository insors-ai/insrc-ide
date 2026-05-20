/**
 * executeStep -- Phase β of plans/code-analyzer-discovery-plan-loop.md.
 *
 * Runs ONE cloud-planned `DiscoveryStep` on the local LLM:
 *
 *   - The cloud has named the skills to call + provided semantic
 *     context for each call. The orchestrator looks up authoritative
 *     skill schemas from the registry and injects them into the
 *     prompt so the local LLM has the right arg shapes (eliminating
 *     the `path` vs `file` class of error).
 *   - Local runs a focused tool loop (skill_invoke + skill_describe
 *     available); it may invoke ADDITIONAL skills beyond the cloud's
 *     plan when its judgment says they're needed.
 *   - When the tool loop closes, local emits ONE final assistant
 *     turn containing a JSON object with `facts` + `citations`. The
 *     orchestrator parses this into a `StepOutput`, fills the
 *     bookkeeping fields (stepId, durationMs, status,
 *     extraSkillsCalled), and returns.
 *
 * No prompt MD files yet -- Phase γ lifts the four new flow prompts
 * (discovery-expand / discovery-review / execute-step / prose-review)
 * into the prompts/ tree together. Phase β keeps the system prompt
 * inline so the type + plumbing land + are testable on their own.
 */

import type { LLMProvider, LLMMessage, ToolDefinition } from '../../../shared/types.js';
import type { Session } from '../../session.js';
import { getTool } from '../../../daemon/tools/registry.js';
import { runToolLoop } from '../../tools/loop.js';
import { getLogger } from '../../../shared/logger.js';

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
	/** Schema lookup for the skills the cloud named. Returns the skill's
	 *  `inputs` JSON Schema (from the daemon registry) or `undefined`
	 *  when the skill id is unknown. Tests inject a stub. */
	readonly getSkillSchema:  (skillId: string) => Record<string, unknown> | undefined;
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

	const system = buildStepSystemPrompt(input.step, input.getSkillSchema);
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

function buildStepSystemPrompt(
	step:           DiscoveryStep,
	getSkillSchema: (id: string) => Record<string, unknown> | undefined,
): string {
	const parts: string[] = [
		`You are executing ONE discovery step for a code-analysis report.`,
		``,
		`## Step intent`,
		``,
		step.intent,
		``,
		`## Cloud-planned skill calls (run these IN ORDER)`,
		``,
	];

	for (const call of step.skills) {
		const schema = getSkillSchema(call.skillId);
		parts.push(`### ${call.id}: \`${call.skillId}\``);
		parts.push(`Context (resolve into args): ${call.context}`);
		if (call.dependsOn !== undefined) {
			parts.push(`Depends on: ${call.dependsOn} (use its output to derive args for this call)`);
		}
		if (schema !== undefined) {
			parts.push(`Input schema:`);
			parts.push('```json');
			parts.push(JSON.stringify(schema, null, 2));
			parts.push('```');
		} else {
			parts.push(`Input schema: unavailable -- call \`skill_describe({ id: "${call.skillId}" })\` first.`);
		}
		parts.push(``);
	}

	parts.push(
		`## Extra skills`,
		``,
		`If the cloud's planned calls aren't sufficient to address the`,
		`step intent, you MAY invoke additional skills via \`skill_invoke\`.`,
		`Use \`skill_describe({ id })\` first for any skill you haven't`,
		`already invoked. Keep extras to the minimum needed.`,
		``,
		`## Final output`,
		``,
		`When you have run all the planned skills (and any extras you`,
		`needed), STOP making tool calls and emit ONE final assistant`,
		`turn containing a JSON object with this shape:`,
		``,
		'```json',
		`{`,
		`  "facts":     ["<one or more facts about the step's topic, plain text>"],`,
		`  "citations": [`,
		`    {`,
		`      "path":      "<file path>",`,
		`      "startLine": <number, optional>,`,
		`      "endLine":   <number, optional>,`,
		`      "entityId":  "<32-char hex, optional>",`,
		`      "label":     "<class or function name, optional>"`,
		`    }`,
		`  ]`,
		`}`,
		'```',
		``,
		`Rules:`,
		`  - Every fact must trace to a skill_invoke result from THIS step.`,
		`    If you have no grounded facts, return \`"facts": []\` and`,
		`    \`"citations": []\`. Don't fabricate.`,
		`  - Citations must come from skill outputs. Carry path / line`,
		`    ranges / entityIds verbatim from what the skills returned.`,
		`  - Output ONLY the JSON object in your final turn. No prose`,
		`    around it, no markdown fences in the response, no preamble.`,
	);

	return parts.join('\n');
}

function buildStepUserPrompt(step: DiscoveryStep): string {
	return [
		`## Step: ${step.id}`,
		``,
		`Begin by running the planned skill calls in order. When you have`,
		`enough grounded facts, emit the final JSON object.`,
	].join('\n');
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
