/**
 * Phase G of plans/code-analyzer-gather-then-write.md.
 *
 * Separates tool gathering from prose generation. The model picks skills
 * via the standard `skill_invoke` / `skill_describe` / `skill_load_page`
 * meta-tools (same as the interleaved writer used). After each
 * successful invoke, the orchestrator makes a SEPARATE summarization
 * call to extract 1-3 structured facts + citations from the raw tool
 * result. The accumulated `EvidenceLedger` is the persistent state
 * that survives eviction -- next-turn prompts include the ledger so
 * the model never loses track of what it has already covered (the run
 * #9 failure mode where eviction stubbed prior tool results was the
 * trigger for this redesign).
 *
 * No prose for the section is emitted here. The writer (Phase W in
 * write-from-evidence.ts) consumes the ledger in one shot.
 *
 * Stop conditions (in order):
 *   1. Model emits the `EVIDENCE_COMPLETE` sentinel in text -- explicit
 *      "I have enough" signal.
 *   2. Model returns an assistant turn with no tool calls AND no
 *      sentinel -- soft stop (treat as "model decided to stop without
 *      saying so").
 *   3. `maxIterations` reached -- hard cap backstop.
 *   4. Consecutive errored / empty tool calls exceed N -- the
 *      orchestrator force-stops (the loop is making no progress).
 */

import type { LLMProvider, LLMMessage, ToolDefinition, ContentBlock } from '../../../shared/types.js';
import type { Session } from '../../session.js';
import type { PlannedAction } from '../../content-gen/plan-actions.js';
import type { RepoSizeSummary } from '../../../daemon/repo-summary.js';
import { getTool } from '../../../daemon/tools/registry.js';
import { executeTool } from '../../tools/executor.js';
import { buildAnalyzerSkillCatalog, formatAnalyzerSkillCatalog, type AnalyzerRepoContext, type CatalogEntry } from './skill-catalog.js';
import { formatRepoSizeSummary } from '../../../daemon/repo-summary.js';
import { getLogger } from '../../../shared/logger.js';
import { loadFlowPrompt, normalizeTier } from './prompts/loader.js';
import type { ScopeSize } from '../../../shared/classify.js';

const log = getLogger('code-analyzer:gather');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Structured summary of one skill_invoke result. Survives eviction;
 *  feeds the ledger that Phase W consumes. */
export interface EvidenceEntry {
	readonly skillId:    string;
	readonly args:       Record<string, unknown>;
	/** 1-3 short key facts extracted from the skill result. */
	readonly facts:      readonly string[];
	/** `path:foo.ts#L1-L20`-style citation strings. The write phase
	 *  carries these verbatim into the prose. */
	readonly citations:  readonly string[];
	readonly confidence: 'high' | 'medium' | 'low';
}

/** Raw skill-call trace -- shape kept compatible with the prior
 *  `CapturedSkillCall` so the reviewer pipeline can consume it
 *  unchanged. */
export interface CapturedSkillCall {
	readonly skillId:    string;
	readonly args:       Record<string, unknown>;
	readonly resultText: string;
	readonly errored:    boolean;
	readonly rejectionReason?: string | undefined;
}

export interface GatherEvidenceInput {
	readonly provider:             LLMProvider;
	readonly session:              Session;
	readonly action:               PlannedAction;
	readonly request:              string;
	readonly repoContext:          AnalyzerRepoContext;
	readonly repoSizeSummary?:     RepoSizeSummary | undefined;
	/** Hard cap on tool-call iterations. Default 32. The interleaved
	 *  writer used 64 because writing happened inside the loop and ate
	 *  budget; gather-only sections don't need that headroom. */
	readonly maxIterations?:       number | undefined;
	readonly maxTokens?:           number | undefined;
	readonly onProgress?:          ((message: string) => void) | undefined;
	/** Skills the LLM described in a prior pass. Seeds the
	 *  describe-before-invoke protocol so a round-2 gather doesn't
	 *  re-describe. */
	readonly priorDescribedSkills?: ReadonlySet<string> | undefined;
	/** Scope tier classified at run-start. Drives which per-tier
	 *  exploration checklist the gather prompt dispatches to
	 *  (`sections/coverage-angles/{tier}.md`). Optional with a
	 *  fallback to 'M' to keep older callers working. */
	readonly tier?:                ScopeSize | undefined;
}

export interface EvidenceLedger {
	readonly evidence:         readonly EvidenceEntry[];
	readonly describedSkills:  ReadonlySet<string>;
	readonly skillCalls:       readonly CapturedSkillCall[];
	readonly skillsCalled:     readonly string[];
	readonly iterations:       number;
	readonly hitLimit:         boolean;
	/** True when the model explicitly emitted the EVIDENCE_COMPLETE sentinel. */
	readonly completedByModel: boolean;
	/** Set when the orchestrator force-stopped the loop (e.g. no
	 *  progress for N consecutive turns). */
	readonly forceStoppedReason?: string;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ITERATIONS    = 32;
const DEFAULT_MAX_TOKENS        = 800;
const SUMMARY_MAX_TOKENS        = 400;
const NO_PROGRESS_THRESHOLD     = 4;
const EVIDENCE_COMPLETE_SENTINEL = 'EVIDENCE_COMPLETE';

const EVIDENCE_SUMMARY_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		facts: {
			type: 'array',
			items: { type: 'string', maxLength: 200 },
			minItems: 1,
			maxItems: 4,
		},
		citations: {
			type: 'array',
			items: { type: 'string' },
		},
		confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
	},
	required: ['facts', 'citations', 'confidence'],
	additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function gatherEvidence(input: GatherEvidenceInput): Promise<EvidenceLedger> {
	const t0 = Date.now();
	const catalog       = buildAnalyzerSkillCatalog(input.repoContext);
	const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;
	const maxTokens     = input.maxTokens     ?? DEFAULT_MAX_TOKENS;

	const messages: LLMMessage[] = [
		{ role: 'system', content: buildSystemPrompt(catalog, input.repoSizeSummary, input.tier ?? 'M') },
		{ role: 'user',   content: buildUserPrompt(input) },
	];

	const skillInvokeTool   = getTool('skill_invoke');
	const skillDescribeTool = getTool('skill_describe');
	const skillLoadPageTool = getTool('skill_load_page');
	const tools: ToolDefinition[] = [];
	if (skillInvokeTool)   { tools.push({ name: skillInvokeTool.id,   description: skillInvokeTool.description,   inputSchema: skillInvokeTool.inputSchema }); }
	if (skillDescribeTool) { tools.push({ name: skillDescribeTool.id, description: skillDescribeTool.description, inputSchema: skillDescribeTool.inputSchema }); }
	if (skillLoadPageTool) { tools.push({ name: skillLoadPageTool.id, description: skillLoadPageTool.description, inputSchema: skillLoadPageTool.inputSchema }); }

	if (tools.length === 0) {
		log.warn({ actionId: input.action.id }, 'gatherEvidence: skill meta-tools not registered -- emitting empty ledger');
		return {
			evidence:         [],
			describedSkills:  new Set<string>(input.priorDescribedSkills),
			skillCalls:       [],
			skillsCalled:     [],
			iterations:       0,
			hitLimit:         false,
			completedByModel: false,
			forceStoppedReason: 'tools-not-registered',
		};
	}

	const evidence:       EvidenceEntry[]      = [];
	const skillCalls:     CapturedSkillCall[]  = [];
	const skillsCalled:   string[]             = [];
	const describedSkills = new Set<string>(input.priorDescribedSkills);

	let iterations           = 0;
	let completedByModel     = false;
	let consecutiveNoProgress = 0;
	let forceStoppedReason: string | undefined;

	log.info(
		{ actionId: input.action.id, maxIterations, maxTokens, catalogSize: catalog.length },
		'gatherEvidence: starting',
	);

	while (iterations < maxIterations) {
		const resp = await input.provider.complete(messages, { maxTokens, tools });
		iterations++;

		const responseText = (resp.text ?? '').trim();
		const toolCalls    = resp.toolCalls ?? [];

		// Stop condition 1: explicit sentinel.
		if (responseText.includes(EVIDENCE_COMPLETE_SENTINEL)) {
			completedByModel = true;
			log.info({ actionId: input.action.id, iterations }, 'gatherEvidence: EVIDENCE_COMPLETE');
			break;
		}

		// Stop condition 2: model returned text with no tool calls and no sentinel.
		// Soft stop -- the model decided to stop without saying so.
		if (toolCalls.length === 0) {
			log.info({ actionId: input.action.id, iterations, textLen: responseText.length }, 'gatherEvidence: model emitted text without tool call -- soft stop');
			break;
		}

		// Push the assistant turn into history before dispatching tools so
		// the next turn can reference what the model just decided. Use the
		// ContentBlock[] shape (text + tool_use blocks) the providers expect.
		const assistantBlocks: ContentBlock[] = [];
		if (responseText.length > 0) {
			assistantBlocks.push({ type: 'text', text: responseText });
		}
		for (const c of toolCalls) {
			assistantBlocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
		}
		messages.push({ role: 'assistant', content: assistantBlocks });

		let madeProgressThisIter = false;
		const toolResultBlocks: ContentBlock[] = [];

		for (const call of toolCalls) {
			input.onProgress?.(`  [${input.action.id}/gather] ${call.name}`);

			// Track describes so a future invoke without prior describe gets
			// rejected by the same protocol the interleaved writer used.
			if (call.name === 'skill_describe' && typeof call.input['id'] === 'string') {
				describedSkills.add(call.input['id'] as string);
			}

			// Protocol enforcement: skill_invoke requires a prior skill_describe.
			if (call.name === 'skill_invoke' && typeof call.input['skillId'] === 'string') {
				const sid = call.input['skillId'] as string;
				if (!describedSkills.has(sid)) {
					toolResultBlocks.push({
						type:        'tool_result',
						tool_use_id: call.id,
						content:     `[protocol-error] You must call \`skill_describe({ id: "${sid}" })\` BEFORE \`skill_invoke\` for that skill.`,
						isError:     true,
					});
					continue;
				}
			}

			// Dispatch the tool through the standard executor.
			const result = await executeTool(call, {
				session: input.session,
			});

			toolResultBlocks.push({
				type:        'tool_result',
				tool_use_id: call.id,
				content:     result.content,
				...(result.isError === true ? { isError: true } : {}),
			});

			if (call.name !== 'skill_invoke') {
				// describe / load_page do not produce evidence entries.
				if (!result.isError) { madeProgressThisIter = true; }
				continue;
			}

			// Capture raw trace for reviewer-side evidence.
			const skillId = typeof call.input['skillId'] === 'string' ? call.input['skillId'] as string : '?';
			const args    = (call.input['args'] as Record<string, unknown> | undefined) ?? {};
			const data    = (result as { data?: { rejectionReason?: string } }).data;
			const rejectionReason = data?.rejectionReason;
			skillsCalled.push(skillId);
			skillCalls.push({
				skillId,
				args,
				resultText: result.content,
				errored:    result.isError === true,
				...(rejectionReason !== undefined ? { rejectionReason } : {}),
			});

			if (result.isError) {
				// Don't waste a summarization call on a failed result. The
				// S.1 schema-on-invalid-input mechanism already injected
				// the corrective schema into result.content; the next turn
				// will see it and (hopefully) retry with the right args.
				continue;
			}

			// Summarize this skill result into a structured entry.
			try {
				const entry = await summarizeResult(input.provider, {
					skillId,
					args,
					resultText: result.content,
					objective:  input.action.objective,
					criteria:   input.action.reviewCriteria,
				});
				evidence.push(entry);
				madeProgressThisIter = true;
			} catch (err) {
				log.warn({ err: (err as Error).message, skillId }, 'gatherEvidence: summarizeResult failed -- skipping entry');
			}
		}

		// Append tool-result blocks as a user turn, then refresh the
		// ledger context so it survives any subsequent eviction. The
		// ledger update must come AFTER the tool-result blocks (so the
		// model's next assistant turn sees: assistant->user(results)->user(ledger)).
		if (toolResultBlocks.length > 0) {
			messages.push({ role: 'user', content: toolResultBlocks });
		}
		updateLedgerContext(messages, evidence);

		if (madeProgressThisIter) {
			consecutiveNoProgress = 0;
		} else {
			consecutiveNoProgress++;
			if (consecutiveNoProgress >= NO_PROGRESS_THRESHOLD) {
				forceStoppedReason = `no-progress-for-${NO_PROGRESS_THRESHOLD}-iters`;
				log.warn({ actionId: input.action.id, iterations }, 'gatherEvidence: force-stop (no progress)');
				break;
			}
		}
	}

	const hitLimit = iterations >= maxIterations && !completedByModel && forceStoppedReason === undefined;

	log.info(
		{
			actionId:        input.action.id,
			iterations,
			evidenceCount:   evidence.length,
			skillsCalledN:   skillsCalled.length,
			completedByModel,
			hitLimit,
			forceStoppedReason,
			durationMs:      Date.now() - t0,
		},
		'gatherEvidence: complete',
	);

	const out: EvidenceLedger = {
		evidence,
		describedSkills,
		skillCalls,
		skillsCalled,
		iterations,
		hitLimit,
		completedByModel,
		...(forceStoppedReason !== undefined ? { forceStoppedReason } : {}),
	};
	return out;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function buildSystemPrompt(
	catalog:         readonly CatalogEntry[],
	repoSizeSummary: RepoSizeSummary | undefined,
	tier:            ScopeSize,
): string {
	// Phase 2 of plans/code-analyzer-externalize-prompts.md +
	// Phase D of plans/code-analyzer-scope-tier-prompts.md.
	// Prose lives in prompts/flow/gather/system.md and the sections it
	// composes. This function only assembles the variable values
	// (skill catalog + optional repo summary + tier slug) and hands
	// them to the loader. The tier slug dispatches the per-tier
	// coverage-angles section.
	const skillCatalog = formatAnalyzerSkillCatalog(catalog);
	const repoContext  = (repoSizeSummary !== undefined && !repoSizeSummary.empty)
		? '\n\n## Repository under analysis\n' + formatRepoSizeSummary(repoSizeSummary, 'detailed')
		: '';
	return loadFlowPrompt('gather', {
		SKILL_CATALOG: skillCatalog,
		REPO_CONTEXT:  repoContext,
		TIER:          normalizeTier(tier),
	});
}

function buildUserPrompt(input: GatherEvidenceInput): string {
	const parts: string[] = [];
	parts.push('## Original request');
	parts.push(input.request.trim());
	parts.push('');
	parts.push('## Section to investigate');
	parts.push(`title:     ${input.action.title}`);
	parts.push(`objective: ${input.action.objective}`);
	parts.push('');
	parts.push('## Review criteria (what the reviewer will score on)');
	for (const c of input.action.reviewCriteria) {
		parts.push(`- ${c}`);
	}
	parts.push('');
	parts.push(`Begin gathering. When you have enough, emit \`${EVIDENCE_COMPLETE_SENTINEL}\`.`);
	return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Ledger context refresh
// ---------------------------------------------------------------------------

const LEDGER_CONTEXT_MARKER = '<!-- LEDGER_CONTEXT -->';

/**
 * Maintain a single user message at the END of the conversation that
 * summarises the evidence captured so far. This survives eviction of
 * tool-result blocks and keeps the model from re-investigating
 * already-covered ground.
 */
function updateLedgerContext(messages: LLMMessage[], evidence: readonly EvidenceEntry[]): void {
	// Drop any prior ledger-context message we appended.
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (typeof m.content === 'string' && m.content.startsWith(LEDGER_CONTEXT_MARKER)) {
			messages.splice(i, 1);
		}
	}

	if (evidence.length === 0) { return; }

	const lines: string[] = [
		LEDGER_CONTEXT_MARKER,
		'## Evidence captured so far',
		'You have already gathered the following. Do NOT re-investigate these:',
		'',
	];
	for (let i = 0; i < evidence.length; i++) {
		const e = evidence[i]!;
		lines.push(`${i + 1}. **${e.skillId}** (${e.confidence})`);
		for (const f of e.facts) {
			lines.push(`   - ${f}`);
		}
		if (e.citations.length > 0) {
			lines.push(`   citations: ${e.citations.join(', ')}`);
		}
	}
	lines.push('');
	lines.push(`When you judge the evidence above is sufficient to cover the objective + criteria, emit \`${EVIDENCE_COMPLETE_SENTINEL}\`.`);
	messages.push({ role: 'user', content: lines.join('\n') });
}

// ---------------------------------------------------------------------------
// Summarization (separate LLM call per skill result)
// ---------------------------------------------------------------------------

interface SummarizeInput {
	skillId:    string;
	args:       Record<string, unknown>;
	resultText: string;
	objective:  string;
	criteria:   readonly string[];
}

async function summarizeResult(provider: LLMProvider, input: SummarizeInput): Promise<EvidenceEntry> {
	const system = [
		'You are extracting structured evidence from one skill-invocation result.',
		'',
		'Output a JSON object matching this shape exactly:',
		'  { "facts": [string, ...], "citations": [string, ...], "confidence": "high"|"medium"|"low" }',
		'',
		'Rules:',
		'  - `facts`: 1-3 SHORT statements naming SPECIFIC entities, counts, or file paths',
		'    surfaced by this skill call. Each fact <= 200 chars. NO speculation -- only what',
		'    the result text shows.',
		'  - `citations`: file references the result text contains (path:foo.ts#L1-L20 shape).',
		'    Carry them verbatim. Empty array is fine if none are present.',
		'  - `confidence`: high if the result was rich + clear; medium if partial; low if errored,',
		'    empty, or off-topic for the objective.',
		'',
		'Output ONLY the JSON. No prose, no preamble.',
	].join('\n');

	const user = [
		'## Section objective',
		input.objective,
		'',
		'## Review criteria',
		input.criteria.map(c => `- ${c}`).join('\n'),
		'',
		`## Skill invoked: ${input.skillId}`,
		'args:',
		'```json',
		JSON.stringify(input.args, null, 2),
		'```',
		'',
		'## Result',
		input.resultText,
	].join('\n');

	const resp = await provider.complete(
		[
			{ role: 'system', content: system },
			{ role: 'user',   content: user },
		],
		{
			maxTokens:      SUMMARY_MAX_TOKENS,
			responseFormat: { schema: EVIDENCE_SUMMARY_SCHEMA },
		},
	);

	let parsed: { facts?: unknown; citations?: unknown; confidence?: unknown } | undefined;
	try {
		parsed = JSON.parse(resp.text.trim());
	} catch {
		// Fall through; we'll synthesize a low-confidence entry below.
	}

	const facts: string[] = Array.isArray(parsed?.facts)
		? parsed!.facts.filter((f: unknown): f is string => typeof f === 'string' && f.length > 0).slice(0, 4)
		: [];
	const citations: string[] = Array.isArray(parsed?.citations)
		? parsed!.citations.filter((c: unknown): c is string => typeof c === 'string' && c.length > 0)
		: [];
	const confidence: 'high' | 'medium' | 'low' =
		parsed?.confidence === 'high' || parsed?.confidence === 'medium' || parsed?.confidence === 'low'
			? parsed.confidence
			: 'low';

	return {
		skillId:    input.skillId,
		args:       input.args,
		facts:      facts.length > 0 ? facts : [`(no facts extracted from ${input.skillId})`],
		citations,
		confidence,
	};
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

export const _EVIDENCE_COMPLETE_SENTINEL = EVIDENCE_COMPLETE_SENTINEL;
export const _LEDGER_CONTEXT_MARKER      = LEDGER_CONTEXT_MARKER;
export const _updateLedgerContextForTest = updateLedgerContext;
export const _summarizeResultForTest     = summarizeResult;
