/**
 * executeStep -- per-result summarization + tool_result compaction.
 *
 * Mirrors [plans/code-analyzer-execute-step-per-result-summarization.md]:
 *
 *  - Static system prompt (closed skill catalog, DOs/DONTs) lives in
 *    `prompts/flow/execute-step/system.md`; only REPO_CONTEXT varies.
 *  - User prompt is dynamic per step: imperative numbered task list +
 *    workspace-root directive.
 *  - The orchestrator runs a manual tool loop. After every successful
 *    `skill_invoke` (and `skill_load_page`) result, it calls
 *    `summarizeResult` to extract a structured `EvidenceEntry`
 *    immediately. This means a step's evidence is captured incrementally
 *    and is robust to the local model giving up partway through the
 *    loop -- partial progress survives.
 *  - After each capture, the corresponding `tool_result` block in
 *    `messages[]` is REWRITTEN to a slim ~250-char stub referencing the
 *    captured entry (Phase 2.5 "compaction"). This keeps the outer
 *    tool-loop conversation roughly flat in size across iterations,
 *    preventing the deep-multi-turn empty-text bug we've seen on
 *    devstral-small-2 + Ollama at ~10k+ input tokens.
 *  - `StepOutput.facts` + `.citations` are aggregated from the captured
 *    EvidenceEntry[]. There is NO final JSON-envelope inference -- the
 *    legacy Phase β pattern was abandoned because devstral fails the
 *    closing-envelope turn deterministically under deep-conversation
 *    pressure.
 */

import type { LLMProvider, LLMMessage, ToolDefinition, ContentBlock, ToolCall } from '../../../shared/types.js';
import type { Session } from '../../session.js';
import type { RepoSizeSummary } from '../../../daemon/repo-summary.js';
import { formatRepoSizeSummary } from '../../../daemon/repo-summary.js';
import { getTool } from '../../../daemon/tools/registry.js';
import { executeTool } from '../../tools/executor.js';
import { getLogger } from '../../../shared/logger.js';
import { loadFlowPrompt } from './prompts/loader.js';
import { summarizeResult } from './summarize-result.js';
import type { EvidenceEntry } from './summarize-result.js';

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
	/** Section-level review criteria, passed through to the summarizer
	 *  so it can score the relevance of each skill result. Falls back
	 *  to a single criterion derived from `step.intent` if absent. */
	readonly criteria?:       readonly string[] | undefined;
}

export async function executeStep(input: ExecuteStepInput): Promise<StepOutput> {
	const t0 = Date.now();

	const tools = wireSkillMetaTools();
	if (tools.length === 0) {
		log.warn({ stepId: input.step.id }, 'executeStep: skill meta-tools not registered; emitting failed StepOutput');
		return emptyFailedStep(input.step.id, Date.now() - t0);
	}

	const system     = buildStepSystemPrompt(input.repoSizeSummary);
	const userPrompt = buildStepUserPrompt(input.step, input.repoSizeSummary?.repoPath);

	const messages: LLMMessage[] = [
		{ role: 'system', content: system },
		{ role: 'user',   content: userPrompt },
	];

	const plannedSkillIds = new Set(input.step.skills.map(s => s.skillId));
	const calledSkillIds:  string[]        = [];
	const evidence:        EvidenceEntry[] = [];
	const maxIterations = input.maxIterations ?? 16;
	const maxTokens     = input.maxTokens     ?? 4096;
	const criteria      = (input.criteria !== undefined && input.criteria.length > 0)
		? input.criteria
		: inferCriteriaForStep(input.step);

	let iteration  = 0;
	let stopReason: 'no-tools' | 'empty-output' | 'max-iter' = 'max-iter';

	while (iteration < maxIterations) {
		const resp = await input.provider.complete(messages, { maxTokens, tools });
		iteration++;
		const text      = (resp.text ?? '').trim();
		const toolCalls = resp.toolCalls ?? [];

		// Soft stop: the model emitted no tool calls. Loop exits with
		// whatever evidence has been captured so far.
		if (toolCalls.length === 0) {
			stopReason = text.length === 0 ? 'empty-output' : 'no-tools';
			log.info(
				{ stepId: input.step.id, iteration, stopReason, textLen: text.length, evidenceCount: evidence.length },
				'executeStep: loop exited (no tool calls)',
			);
			break;
		}

		// Push the assistant turn (text + tool_use blocks) before dispatching
		// so the next turn sees what the model just decided.
		messages.push({ role: 'assistant', content: assembleAssistantBlocks(text, toolCalls) });

		const toolResultBlocks: ContentBlock[] = [];
		for (const call of toolCalls) {
			if (call.name === 'skill_invoke' && typeof call.input['skillId'] === 'string') {
				calledSkillIds.push(call.input['skillId'] as string);
			}
			input.onProgress?.(formatProgressLine(input.step.id, call));

			const result = await executeTool(call, { session: input.session });

			const trBlock: { type: 'tool_result'; tool_use_id: string; content: string; isError?: true } = {
				type:        'tool_result',
				tool_use_id: call.id,
				content:     typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
				...(result.isError === true ? { isError: true as const } : {}),
			};
			toolResultBlocks.push(trBlock);

			// Phase 2: per-result summarization. Only for successful
			// `skill_invoke` / `skill_load_page` calls -- those produce
			// evidence. `skill_describe` returns static schema docs that
			// don't get summarized.
			const isEvidenceProducing = (call.name === 'skill_invoke' || call.name === 'skill_load_page')
				&& result.isError !== true;
			if (isEvidenceProducing) {
				const skillId = String(call.input['skillId'] ?? call.name);
				const args    = (call.input['args'] as Record<string, unknown> | undefined) ?? call.input;
				try {
					const entry = await summarizeResult(input.provider, {
						skillId,
						args,
						resultText: trBlock.content,
						objective:  input.step.intent,
						criteria,
					});
					evidence.push(entry);

					// Phase 2.5: compact this just-dispatched tool_result
					// block in-place. The model's next tool-picking turn
					// now sees a slim ~250-char stub instead of ~4KB raw
					// result, which keeps the outer conversation flat.
					const entryId = `e_${evidence.length}`;
					trBlock.content = renderEntryStub(entryId, entry, skillId, args);
				} catch (err) {
					log.warn(
						{ err: (err as Error).message, skillId, stepId: input.step.id },
						'executeStep: summarizeResult failed -- skipping entry',
					);
				}
			}
		}

		messages.push({ role: 'user', content: toolResultBlocks });
	}

	if (iteration >= maxIterations) {
		log.info(
			{ stepId: input.step.id, iteration, evidenceCount: evidence.length },
			'executeStep: hit max iterations',
		);
	}

	const extraSkillsCalled = [...new Set(calledSkillIds.filter(id => !plannedSkillIds.has(id)))];
	const facts             = uniqueFlattenFacts(evidence);
	const citations         = mergeCitations(evidence);
	const status            = determineStatus({
		evidenceCount:      evidence.length,
		facts,
		citations,
		calledSkillIds,
		plannedSkillCount:  input.step.skills.length,
	});

	log.info(
		{
			stepId:           input.step.id,
			iteration,
			stopReason,
			evidenceCount:    evidence.length,
			facts:            facts.length,
			citations:        citations.length,
			calledSkillIds:   calledSkillIds.length,
			plannedSkillIds:  input.step.skills.length,
			status,
			durationMs:       Date.now() - t0,
		},
		'executeStep: complete',
	);

	return {
		stepId:    input.step.id,
		status,
		facts,
		citations,
		...(extraSkillsCalled.length > 0 ? { extraSkillsCalled } : {}),
		durationMs: Date.now() - t0,
	};
}

// ---------------------------------------------------------------------------
// Internals -- tool wiring + progress
// ---------------------------------------------------------------------------

function wireSkillMetaTools(): ToolDefinition[] {
	const out: ToolDefinition[] = [];
	const invokeT   = getTool('skill_invoke');
	const describeT = getTool('skill_describe');
	const loadPageT = getTool('skill_load_page');
	if (invokeT)   out.push({ name: invokeT.id,   description: invokeT.description,   inputSchema: invokeT.inputSchema });
	if (describeT) out.push({ name: describeT.id, description: describeT.description, inputSchema: describeT.inputSchema });
	if (loadPageT) out.push({ name: loadPageT.id, description: loadPageT.description, inputSchema: loadPageT.inputSchema });
	return out;
}

function formatProgressLine(stepId: string, call: ToolCall): string {
	const skillRef = call.name === 'skill_invoke'
		? String(call.input['skillId'] ?? '?')
		: call.name === 'skill_describe'
		? String(call.input['id'] ?? '?')
		: call.name === 'skill_load_page'
		? String(call.input['spillId'] ?? '?')
		: '';
	return `  [${stepId}] ${call.name}${skillRef ? `(${skillRef})` : ''}`;
}

function assembleAssistantBlocks(text: string, toolCalls: readonly ToolCall[]): ContentBlock[] {
	const blocks: ContentBlock[] = [];
	if (text.length > 0) blocks.push({ type: 'text', text });
	for (const c of toolCalls) {
		blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
	}
	return blocks;
}

// ---------------------------------------------------------------------------
// Internals -- prompt assembly
// ---------------------------------------------------------------------------

function buildStepSystemPrompt(repoSizeSummary: RepoSizeSummary | undefined): string {
	const repoContext = (repoSizeSummary !== undefined && !repoSizeSummary.empty)
		? '\n\n## Repository under analysis\n' + formatRepoSizeSummary(repoSizeSummary, 'detailed')
		: '';
	return loadFlowPrompt('execute-step', { REPO_CONTEXT: repoContext });
}

function buildStepUserPrompt(step: DiscoveryStep, repoPath: string | undefined): string {
	const parts: string[] = [];
	parts.push(`## Step: ${step.id}`);
	parts.push(`Intent: ${step.intent.trim()}`);
	if (repoPath !== undefined && repoPath.length > 0) {
		parts.push('');
		parts.push(`**Workspace root:** \`${repoPath}\``);
		parts.push(`Use this exact path as the \`repoPath\` argument on every skill call below.`);
		parts.push(`For \`modulePath\` / \`file\` arguments, prefix this root onto the repo-relative paths`);
		parts.push(`shown in the repository summary.`);
	}
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
	parts.push('When you have run the planned tasks (and any minimal extras you');
	parts.push('needed), STOP calling tools. The orchestrator is capturing');
	parts.push("structured evidence from every skill result as you go -- you");
	parts.push("don't need to summarise at the end.");
	return parts.join('\n');
}

function renderChainHint(
	call:     PlannedSkillCall,
	byCallId: ReadonlyMap<string, number>,
): string | null {
	if (call.dependsOn === undefined) return null;
	const sourceIdx = byCallId.get(call.dependsOn);
	const sourceRef = sourceIdx !== undefined ? `task ${sourceIdx}` : `task \`${call.dependsOn}\``;
	return `Chain: use the \`entityId\` from ${sourceRef}'s result.`;
}

/**
 * Derive 2-3 review criteria from `step.intent` for the summarizer.
 * Used when the caller doesn't pass section-level criteria through.
 * Heuristic: phrase the intent as a question + name "specific entities
 * and counts" + name "verbatim citations" so the summarizer scores by
 * the same shape the cycle-reviewer scores by.
 */
function inferCriteriaForStep(step: DiscoveryStep): readonly string[] {
	return [
		`answer the step intent: ${step.intent.trim()}`,
		'name specific entities, file paths, or counts from the skill result',
		'carry citations verbatim from the skill output',
	];
}

// ---------------------------------------------------------------------------
// Internals -- Phase 2.5 compaction stub renderer
// ---------------------------------------------------------------------------

/**
 * Format a captured EvidenceEntry as the compact stub that replaces the
 * raw tool_result block in `messages[]`. Stable, parseable shape:
 *
 *   [evidence e_3: code.entity.locate-by-name(name="FSDirectory")
 *     facts=2 cites=1 conf=high]
 *
 * ~200-300 chars vs ~4KB of raw tool_result -- ~15x compaction.
 * The full result remains accessible on disk via the SkillSpillRecord
 * (`skill_load_page` can fetch any specific page if the model needs it).
 */
export function renderEntryStub(
	entryId:  string,
	entry:    EvidenceEntry,
	skillId:  string,
	args:     Record<string, unknown>,
): string {
	const argSig = renderArgsForStub(args);
	return [
		`[evidence ${entryId}: ${skillId}(${argSig})`,
		`  facts=${entry.facts.length} cites=${entry.citations.length} conf=${entry.confidence}`,
		`  raw result available via skill_load_page if needed.]`,
	].join('\n');
}

function renderArgsForStub(args: Record<string, unknown>): string {
	// Compact one-line representation. Skip nested objects (just show
	// the keys). Quote strings; show numbers as-is. ~50 chars max.
	const parts: string[] = [];
	for (const [k, v] of Object.entries(args)) {
		if (typeof v === 'string')      parts.push(`${k}="${v.length > 30 ? v.slice(0, 30) + '...' : v}"`);
		else if (typeof v === 'number') parts.push(`${k}=${v}`);
		else if (typeof v === 'boolean')parts.push(`${k}=${v}`);
		else if (Array.isArray(v))      parts.push(`${k}=[${v.length}]`);
		else if (v && typeof v === 'object') parts.push(`${k}={${Object.keys(v as Record<string, unknown>).length} keys}`);
		else                            parts.push(`${k}=?`);
		if (parts.join(', ').length > 80) { parts.push('...'); break; }
	}
	return parts.join(', ');
}

// ---------------------------------------------------------------------------
// Internals -- evidence aggregation
// ---------------------------------------------------------------------------

function uniqueFlattenFacts(evidence: readonly EvidenceEntry[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const e of evidence) {
		for (const f of e.facts) {
			const key = f.trim().toLowerCase();
			if (key.length === 0 || seen.has(key)) continue;
			seen.add(key);
			out.push(f);
		}
	}
	return out;
}

/**
 * Merge citations across all captured EvidenceEntry objects into the
 * structured Citation[] shape the writer expects. Deduplicate on
 * `(path, startLine, endLine)`. Parses the legacy `path:foo.ts#L1-L20`
 * strings into structured Citation objects when present.
 */
function mergeCitations(evidence: readonly EvidenceEntry[]): Citation[] {
	const seen = new Set<string>();
	const out: Citation[] = [];
	for (const e of evidence) {
		// Per EvidenceEntry's interface contract: when `citationObjs` is
		// present, it's the authoritative shape and `citations` is the
		// legacy string form for back-compat. Use one OR the other per
		// entry, never both -- otherwise the same source appears twice
		// when the structured form has fuller metadata than the string.
		const fromObjs = e.citationObjs ?? [];
		if (fromObjs.length > 0) {
			for (const c of fromObjs) {
				const key = citationKey(c);
				if (seen.has(key)) continue;
				seen.add(key);
				out.push(c);
			}
		} else {
			for (const s of e.citations) {
				const c = parseLegacyCitation(s);
				if (c === null) continue;
				const key = citationKey(c);
				if (seen.has(key)) continue;
				seen.add(key);
				out.push(c);
			}
		}
	}
	return out;
}

function citationKey(c: Citation): string {
	return `${c.path}|${c.startLine ?? ''}|${c.endLine ?? ''}`;
}

/**
 * Parse a `path:foo.ts#L1-L20` (or `path:foo.ts#L42`) legacy citation
 * string into a structured `Citation`. Returns `null` for shapes that
 * don't match.
 */
function parseLegacyCitation(s: string): Citation | null {
	if (s.length === 0) return null;
	const stripped = s.startsWith('path:') ? s.slice('path:'.length) : s;
	const hashIdx  = stripped.lastIndexOf('#L');
	if (hashIdx === -1) {
		// Just `path:foo.ts` with no line range.
		return { path: stripped };
	}
	const path  = stripped.slice(0, hashIdx);
	const range = stripped.slice(hashIdx + 2);   // after `#L`
	const dash  = range.indexOf('-L');
	if (dash === -1) {
		const start = Number.parseInt(range, 10);
		if (Number.isFinite(start)) return { path, startLine: start };
		return { path };
	}
	const start = Number.parseInt(range.slice(0, dash), 10);
	const end   = Number.parseInt(range.slice(dash + 2), 10);
	const cite: { -readonly [K in keyof Citation]: Citation[K] } = { path };
	if (Number.isFinite(start)) cite.startLine = start;
	if (Number.isFinite(end))   cite.endLine   = end;
	return cite;
}

// ---------------------------------------------------------------------------
// Internals -- status determination
// ---------------------------------------------------------------------------

function determineStatus(args: {
	readonly evidenceCount:     number;
	readonly facts:             readonly string[];
	readonly citations:         readonly Citation[];
	readonly calledSkillIds:    readonly string[];
	readonly plannedSkillCount: number;
}): 'ok' | 'partial' | 'failed' {
	// failed: zero captured evidence at all -- the model produced
	// nothing the summarizer could extract from.
	if (args.evidenceCount === 0) return 'failed';
	// partial: model ran fewer skills than the cloud asked for, OR
	// captured facts but no citations (citation diversity is the
	// reviewer's primary signal).
	if (args.citations.length === 0) return 'partial';
	if (args.calledSkillIds.length < args.plannedSkillCount) return 'partial';
	return 'ok';
}

function emptyFailedStep(stepId: string, durationMs: number): StepOutput {
	return {
		stepId,
		status:    'failed',
		facts:     [],
		citations: [],
		durationMs,
	};
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

export const _buildStepSystemPromptForTest   = buildStepSystemPrompt;
export const _buildStepUserPromptForTest     = buildStepUserPrompt;
export const _determineStatusForTest         = determineStatus;
export const _inferCriteriaForStepForTest    = inferCriteriaForStep;
export const _uniqueFlattenFactsForTest      = uniqueFlattenFacts;
export const _mergeCitationsForTest          = mergeCitations;
export const _parseLegacyCitationForTest     = parseLegacyCitation;
