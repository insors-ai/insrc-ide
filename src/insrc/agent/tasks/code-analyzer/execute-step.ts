/**
 * executeStep -- per-result summarization + windowed tool_result eviction.
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
 *  - Phase 7 (2026-05-22): the most-recent `evictionWindow` (default 1)
 *    evidence-producing tool_results stay RAW in the model's context.
 *    Older results are rewritten in-place to a compact stub right before
 *    the next inference call. This lets the model read concrete handles
 *    (entityIds, paths, spillIds) from the immediately-prior tool result
 *    when chaining skills, while keeping the outer conversation flat as
 *    the loop deepens. Set `evictionWindow = 0` to restore the legacy
 *    Phase 2.5 "stub immediately" behavior (used by paths that need to
 *    work around devstral-small-2's deep-multi-turn empty-text bug).
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
	/** Sliding window for tool_result eviction (Phase 7). The most-recent
	 *  N evidence-producing tool_results stay raw in the model's context;
	 *  everything older is rewritten in-place to a stub before the next
	 *  inference. Defaults to 1 (immediately-prior raw result preserved,
	 *  all older stubbed). Set to 0 for the legacy Phase 2.5 "stub
	 *  immediately" behavior; set higher for chains where the model needs
	 *  handle continuity across several turns. */
	readonly evictionWindow?: number | undefined;
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
	const evictableEntries: EvictableEntry[] = [];
	const maxIterations = input.maxIterations ?? 16;
	const maxTokens     = input.maxTokens     ?? 4096;
	const evictionWindow = Math.max(0, input.evictionWindow ?? DEFAULT_EVICTION_WINDOW);
	const criteria      = (input.criteria !== undefined && input.criteria.length > 0)
		? input.criteria
		: inferCriteriaForStep(input.step);

	let iteration  = 0;
	let stopReason: 'no-tools' | 'empty-output' | 'max-iter' = 'max-iter';

	while (iteration < maxIterations) {
		// Phase 7: rewrite older evidence-producing tool_results to their
		// stub form before the next inference call. The most-recent
		// `evictionWindow` entries stay raw so the model can extract
		// concrete handles (entityIds, paths, spillIds) when chaining skills.
		applyEvictionWindow(evictableEntries, evictionWindow);

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

					// Phase 7: record this tool_result block as evictable.
					// The block keeps its RAW content for now; the eviction
					// pass at the top of the next iteration will rewrite it
					// to the stub when it falls outside `evictionWindow`.
					const entryId = `e_${evidence.length}`;
					evictableEntries.push({
						block:    trBlock,
						entryId,
						entry,
						skillId,
						args,
						evicted:  false,
					});
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
// Internals -- Phase 7 eviction window
// ---------------------------------------------------------------------------

/** Default eviction window: keep the most-recent 1 evidence-producing
 *  tool_result raw, stub everything older before the next inference. */
const DEFAULT_EVICTION_WINDOW = 1;

/** Mutable record tracking one evidence-producing tool_result that may
 *  be rewritten in-place when it falls outside the eviction window.
 *  `block` is the actual `tool_result` ContentBlock object pushed into
 *  `messages[]` -- mutating `block.content` updates what the model sees
 *  on the next inference call. */
interface EvictableEntry {
	readonly block:    { type: 'tool_result'; tool_use_id: string; content: string; isError?: true };
	readonly entryId:  string;
	readonly entry:    EvidenceEntry;
	readonly skillId:  string;
	readonly args:     Record<string, unknown>;
	evicted:           boolean;
}

/**
 * Phase 7 sliding-window eviction. Keep the most-recent `windowSize`
 * entries' `block.content` as raw tool_result text; rewrite every older
 * entry's `block.content` to the compaction stub (once, idempotent via
 * the `evicted` flag). Mutates `entries[i].block.content` and
 * `entries[i].evicted` in place.
 *
 * `windowSize = 0` matches the legacy Phase 2.5 behavior (stub every
 * captured result before the next inference). Default in `executeStep`
 * is 1, which preserves the most recent tool_result so the model can
 * extract concrete handles (entityIds, paths, spillIds) when chaining.
 */
export function applyEvictionWindow(
	entries: readonly EvictableEntry[],
	windowSize: number,
): void {
	const w = Math.max(0, windowSize);
	const cutoff = Math.max(0, entries.length - w);
	for (let i = 0; i < cutoff; i++) {
		const e = entries[i]!;
		if (e.evicted) continue;
		e.block.content = renderEntryStub(e.entryId, e.entry, e.skillId, e.args);
		e.evicted = true;
	}
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
	// Surface the full skill command in the chat stream -- the skill id
	// AND a compact representation of the args -- so the live console
	// shows what's actually being executed, not just the meta-tool name.
	//
	// skill_invoke: render the inner skillId(args).
	// skill_describe / skill_load_page: render the meta-tool itself with
	//   its inline args (small enough to inline).
	if (call.name === 'skill_invoke') {
		const skillId = String(call.input['skillId'] ?? '?');
		const args    = (call.input['args'] as Record<string, unknown> | undefined) ?? {};
		const argSig  = formatArgsInline(args);
		return `  [${stepId}] ${skillId}(${argSig})`;
	}
	return `  [${stepId}] ${call.name}(${formatArgsInline(call.input)})`;
}

/**
 * Compact one-line rendering of an arguments object for surfacing in
 * the chat stream + the Phase 2.5 compaction stub. Strings are quoted
 * + truncated at 30 chars; numbers / booleans render bare; arrays as
 * `[N]`; nested objects as `{K keys}`. Total length capped at ~80
 * chars (then suffixed with `...`).
 */
export function formatArgsInline(args: Record<string, unknown>): string {
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
// Internals -- evicted tool_result stub renderer
// ---------------------------------------------------------------------------

/**
 * Format a captured EvidenceEntry as the stub that replaces the raw
 * tool_result block in `messages[]` once it falls outside the eviction
 * window (Phase 7). Surfaces the captured `facts` + `citations` verbatim
 * so the model retains the summarized content after raw eviction, and
 * explicitly states that the original tool_result is no longer
 * recoverable (correcting the Phase 2.5 stub's false promise that
 * `skill_load_page` could be used to refetch).
 *
 * Stable, machine-parseable header:
 *
 *   [evicted tool_result e_3: code.entity.locate-by-name(name="FSDirectory")
 *
 * Followed by `confidence`, the fact list, citations (if any), and a
 * terminal "not recoverable" line so the model doesn't waste turns
 * calling `skill_load_page` with the evidence id.
 */
export function renderEntryStub(
	entryId:  string,
	entry:    EvidenceEntry,
	skillId:  string,
	args:     Record<string, unknown>,
): string {
	const lines: string[] = [
		`[evicted tool_result ${entryId}: ${skillId}(${formatArgsInline(args)})`,
		`  confidence: ${entry.confidence}`,
	];
	if (entry.facts.length > 0) {
		lines.push('  facts:');
		for (const f of entry.facts) {
			lines.push(`    - ${f}`);
		}
	}
	if (entry.citations.length > 0) {
		lines.push(`  citations: ${entry.citations.join('; ')}`);
	}
	lines.push('  (original tool_result evicted; not recoverable -- do NOT call skill_load_page with this id)');
	lines.push(']');
	return lines.join('\n');
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
export const _DEFAULT_EVICTION_WINDOW        = DEFAULT_EVICTION_WINDOW;
export type _EvictableEntryForTest           = EvictableEntry;
export const _parseLegacyCitationForTest     = parseLegacyCitation;
