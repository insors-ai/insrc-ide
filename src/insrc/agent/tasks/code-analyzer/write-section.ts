/**
 * Section writer using a tool-calling loop -- Phase F.2/F.3 of
 * plans/intent-funnel-followups.md.
 *
 * Replaces the old "classify-question -> select-scope ->
 * pre-fetch evidence -> expand-action" cloud-orchestrated pipeline
 * with a single tool loop driven by the LOCAL LLM. The LLM sees:
 *   - The section objective + review criteria + user request
 *   - The repo summary block (from Phase E.1b)
 *   - A closed-list catalog of available skill IDs
 *   - Two meta-tools (`skill_invoke`, `skill_describe`) it uses
 *     to call those skills as needed
 *
 * The LLM decides what evidence it needs and fetches it
 * iteratively. When it's gathered enough to answer the objective
 * + criteria, it emits the section markdown as its final text
 * response.
 *
 * Reference implementation: agent/tasks/shared/investigate.ts
 * (same shape; that one uses fs+graph tools, this one uses the
 * analyzer's skill catalog via the skill_invoke meta-tool).
 */

import type { LLMProvider, LLMMessage, ToolDefinition } from '../../../shared/types.js';
import type { Session } from '../../session.js';
import type { PlannedAction } from '../../content-gen/plan-actions.js';
import type { RepoSizeSummary } from '../../../daemon/repo-summary.js';
import type { ReviewWorkItem } from '../../content-gen/review-action.js';
import { runToolLoop, type ToolLoopResult } from '../../tools/loop.js';
import { getTool } from '../../../daemon/tools/registry.js';
import { buildAnalyzerSkillCatalog, formatAnalyzerSkillCatalog, type AnalyzerRepoContext } from './skill-catalog.js';
import { formatRepoSizeSummary } from '../../../daemon/repo-summary.js';
import { getLogger } from '../../../shared/logger.js';
import {
	parsePatches,
	applyPatches,
	type PatchBlock,
	type WorkItemStatus,
} from './apply-patches.js';

const log = getLogger('code-analyzer:write-section');

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export interface WriteSectionInput {
	readonly provider:        LLMProvider;
	readonly session:         Session;
	readonly action:          PlannedAction;
	readonly request:         string;
	readonly repoContext:     AnalyzerRepoContext;
	readonly repoSizeSummary?: RepoSizeSummary | undefined;
	/** Hard cap on tool-call iterations (default 10). */
	readonly maxToolCalls?:   number | undefined;
	/** Maximum tokens per LLM turn (default 1500 or action's budget). */
	readonly maxTokens?:      number | undefined;
	/** Streaming progress callback for tool calls + text deltas. */
	readonly onProgress?:     ((message: string) => void) | undefined;
	/**
	 * Reviewer's refine hint from a prior pass. When set, this is
	 * surfaced in the user prompt so the LLM knows what to fix on its
	 * second draft (e.g. "the previous draft was empty -- summarise
	 * README.md lines 1-199").
	 */
	readonly refineHint?:     string | undefined;
	/**
	 * Skill IDs the LLM has already described in a PRIOR section-
	 * writing pass (round 1, when this is round 2). Seeds the
	 * describe-before-invoke protocol so the round-2 retry doesn't
	 * waste rounds re-discovering schemas already learned.
	 */
	readonly priorDescribedSkills?: ReadonlySet<string> | undefined;
}

/**
 * Captured skill invocation during the tool loop. The reviewer
 * (cloud LLM) sees these as `evidence` so it can fact-check the
 * section markdown against what the LLM actually fetched.
 */
export interface CapturedSkillCall {
	readonly skillId:    string;
	readonly args:       Record<string, unknown>;
	/** Raw skill result body (tool-result text). */
	readonly resultText: string;
	/** True when the tool call returned `success: false` (skill error). */
	readonly errored:    boolean;
	/** Typed rejection reason when the skill runner short-circuited.
	 *  Distinguishes invalid-input vs feasibility-failed vs execute-
	 *  threw vs protocol-error vs depth-exceeded. Absent on successful
	 *  calls and on errored calls whose runner-side data did not carry
	 *  a reason. */
	readonly rejectionReason?: string | undefined;
}

export interface WriteSectionOutput {
	/** The section markdown -- concatenation of every assistant text turn
	 *  the LLM produced during the interleaved-investigation loop, joined
	 *  by blank lines. NOT just the final turn's text. */
	readonly markdown:       string;
	/** Number of tool-loop iterations executed. */
	readonly toolCallCount:  number;
	/** True if the loop terminated by hitting the max-iteration cap. */
	readonly hitLimit:       boolean;
	/** Skill IDs invoked across the loop, in call order. */
	readonly skillsCalled:   readonly string[];
	/** Full skill-call trace (args + results) for the reviewer. */
	readonly skillCalls:     readonly CapturedSkillCall[];
	/** Skill IDs the LLM described in this pass (cumulative -- seeded
	 *  from `priorDescribedSkills` plus any new describes in this run).
	 *  Caller threads this into a round-2 retry so it doesn't waste
	 *  rounds re-describing skills already learned. */
	readonly describedSkills: ReadonlySet<string>;
}

const DEFAULT_MAX_TOOL_CALLS = 10;

// ---------------------------------------------------------------------------
// Phase F: patch-loop entry point shape
// ---------------------------------------------------------------------------

export interface PatchSectionInput {
	readonly provider:             LLMProvider;
	readonly session:              Session;
	readonly action:               PlannedAction;
	readonly request:              string;
	readonly repoContext:          AnalyzerRepoContext;
	readonly repoSizeSummary?:     RepoSizeSummary | undefined;
	readonly maxToolCalls?:        number | undefined;
	readonly maxTokens?:           number | undefined;
	readonly onProgress?:          ((message: string) => void) | undefined;
	/** The draft markdown the writer should patch (output of the
	 *  previous round). */
	readonly draftMarkdown:        string;
	/** The reviewer's typed work-item list (Phase E). */
	readonly workItems:            readonly ReviewWorkItem[];
	/** Skill IDs the LLM already described in a prior round; seeds the
	 *  describe-before-invoke protocol so the patch round doesn't waste
	 *  iterations re-discovering schemas already learned. */
	readonly priorDescribedSkills: ReadonlySet<string>;
	/** Successful skill calls from prior rounds; surfaced to the reviewer
	 *  as evidence for round-N review so cumulative evidence is scored. */
	readonly priorSkillCalls:      readonly CapturedSkillCall[];
	/** Phase L.3: round number (2 or 3). Round 3 gets an escalation
	 *  prompt that explicitly tells the model the previous attempts
	 *  produced zero blocks. */
	readonly round:                2 | 3;
}

export interface PatchSectionOutput extends WriteSectionOutput {
	/** Per-item status the patch loop reports. */
	readonly itemStatuses: readonly WorkItemStatus[];
	/** True when the writer emitted zero `patch:<id>` / `skip:<id>`
	 *  blocks. Signals the orchestrator's F.4 escape hatch to fall back
	 *  to a writeSectionWithTools redraft. */
	readonly patchProtocolFollowed: boolean;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT_INTRO = [
	'You are INVESTIGATING one section of a code-analysis report. Your job is to use tools to',
	'gather evidence AND to interpret each result as you receive it -- the section is grown',
	'paragraph by paragraph across many turns, NOT synthesised in one final turn at the end.',
	'',
	'You will receive:',
	'  - The user\'s ORIGINAL REQUEST (for orientation).',
	'  - The SECTION you are investigating: title + objective + review criteria.',
	'  - A REPO SUMMARY (file counts, top modules, languages).',
	'  - A SKILL CATALOG of read-only skills you may invoke.',
	'',
	'## How each turn works',
	'',
	'EVERY assistant turn begins with TEXT (your analysis paragraph). Then -- optionally --',
	'one or more tool calls. The orchestrator collects the text from EVERY one of your turns',
	'and concatenates them into the section body. Your paragraphs ARE the section.',
	'',
	'Turn shapes:',
	'',
	'  - First turn:  Open with a TOPIC SENTENCE about the SUBJECT you are about to describe',
	'                 -- the code, the subsystem, the pattern. Do NOT narrate your process',
	'                 ("I will investigate...", "Let me start by..."). Then a tool call.',
	'',
	'                 WRONG: "I will investigate the test architecture by examining unit and',
	'                 integration test modules across HDFS, MapReduce, and YARN to identify',
	'                 their organization."',
	'                 RIGHT: "The test architecture spans three repository module trees',
	'                 (HDFS, MapReduce, YARN), with each tree carrying its own',
	'                 `src/test/java/` hierarchy and a distinct cluster-simulation fixture."',
	'',
	'  - Mid turn:    Each paragraph states a SPECIFIC fact from the previous tool result --',
	'                 entity name, file path with line range, a count or a quoted constant.',
	'                 NOT "now I will look at X" but "the previous call showed X has 142',
	'                 files including [`NameNode`](path:.../NameNode.java#L120-L350)". The',
	'                 paragraph is the persistent record of what you learned. Then another',
	'                 tool call (if you need more evidence) OR no tool call (if the next',
	'                 thing is the closing paragraph).',
	'',
	'  - Final turn:  Closing paragraph naming the most important takeaway from the',
	'                 investigation as a whole. NO tool call. The loop exits here.',
	'',
	'                 If you have more to investigate, DO NOT close -- make the next tool',
	'                 call instead. NEVER write "Let me now investigate X" as a closing',
	'                 paragraph. If X is worth investigating, call the tool. If it is not,',
	'                 omit X entirely.',
	'',
	'## Tool protocol',
	'',
	'  1. For each skill you intend to use, FIRST call `skill_describe({ id: <skillId> })` to',
	'     fetch its input/output schema. The tool loop ENFORCES this -- `skill_invoke` for a',
	'     skill you have not described returns a protocol-error and does NOT execute. Describe',
	'     once per skill per section; subsequent invocations of the same skill do not need to',
	'     re-describe.',
	'',
	'  2. Once described, call `skill_invoke({ skillId, args })` with `args` matching the schema',
	'     you just learned.',
	'',
	'  3. Tool results are EVIDENCE. The very next turn\'s paragraph must INTERPRET that evidence',
	'     -- name the entities, quote the counts, cite the files. Don\'t describe the call;',
	'     describe what the call told you about the repo.',
	'',
	'  4. Large skill outputs are pageable. When a `skill_invoke` result shows a `**Paging:**`',
	'     section, the result has been projected -- you saw the first page; the rest is on disk.',
	'     If a topic needs the long tail (sampling pages for patterns, finding rare cases, etc.),',
	'     call `skill_load_page({ spillId, fieldPath, pageIndex })` with the spillId from the',
	'     original result. Each page you load should be followed by a paragraph that interprets',
	'     what that page added before you page further or move on.',
	'',
	'## What each paragraph must look like',
	'',
	'  - Specific. Numbers, names, file paths, line ranges. Not "this module has many classes"',
	'    but "this module has 142 files including [`NameNode`](path:.../NameNode.java#L120) and',
	'    [`DataNode`](path:.../DataNode.java#L180)".',
	'',
	'  - Inline clickable citations -- ALWAYS when the evidence carries a file:',
	'      [`HdfsServerConstants`](path:hadoop-hdfs/.../HdfsServerConstants.java#L42-L58)',
	'      [`startCommonServices`](path:hadoop-hdfs/.../NameNode.java#L432)',
	'      [`src/auth/`](path:src/auth/)',
	'    URI shape: `path:<workspace-relative-file-or-dir>(#L<startLine>(-L<endLine>)?)?`.',
	'    Bare backticks (`identifierName` with no link) only when no file is known.',
	'',
	'  - Self-contained. The paragraph must read on its own when stitched into the section --',
	'    no "as shown above", "from the previous tool result", or "as we saw earlier".',
	'',
	'  - Prefer production-source citations over test-source. When a path is under `test/`,',
	'    `__tests__/`, `*.test.*`, or `*.spec.*`, frame the claim as "tested" rather than',
	'    "implemented" and cite the production source the test exercises when possible.',
	'',
	'  - Use the repo\'s own vocabulary. If the repo has modules like `insors/ocr/` or classes',
	'    like `CaseExtractionAgent`, reference them by name. Generic framings are a code smell.',
	'',
	'## What NOT to write',
	'',
	'  - Meta-narration about your own process: "Let me check...", "I\'ll now investigate...",',
	'    "Next, I need to...". Just write the analysis directly. These phrases also MUST NOT',
	'    appear as the LAST sentence of any turn -- if you write one, the next thing you',
	'    emit must be the announced tool call, not a turn ending. Announcing an action and',
	'    then stopping is the most common failure mode of this loop; the orchestrator will',
	'    nudge you to either execute the action or rewrite the closing without it.',
	'',
	'  - Internal markers: `[tool calls executed]`, `<!-- ... -->`, `[tool_result ...]`, etc.',
	'    These are conversation scaffolding, not section content.',
	'',
	'  - Section headings (no `## <title>` lines). The orchestrator adds the section heading',
	'    when stitching the report.',
	'',
	'  - Fabricated entities or paths. Every named entity and file path must come from a skill',
	'    result you have actually received in this conversation.',
	'',
	'## When to stop',
	'',
	'When every review criterion is addressed by a paragraph in your investigation, end with a',
	'closing paragraph and NO tool call. Don\'t artificially extend with more tool calls if you',
	'have what you need.',
	'',
	'## Memory model',
	'',
	'Your conversation history is bounded. As the loop runs, older `tool_result` blocks may be',
	'EVICTED from your context once their analysis paragraph has been written -- a stub like',
	'`[evicted -- ... use skill_load_page ... if you need to re-examine ...]` replaces the raw',
	'content. Two implications:',
	'',
	'  1. The paragraph you write IS the persistent record of what you learned from a tool',
	'     result. State numbers, names, file paths, line ranges INLINE in the paragraph. Don\'t',
	'     write "as the previous tool_result showed" -- that result may no longer be in your',
	'     context by the time the paragraph is read.',
	'',
	'  2. The on-disk spill is the source of truth and is NEVER lost. If you need to re-examine',
	'     evidence you already analysed -- e.g. to compare findings across pages, or to surface',
	'     a specific entity you noticed earlier -- issue a `skill_load_page` call with the',
	'     spillId from the original `skill_invoke` result. The spill carries the COMPLETE',
	'     payload; eviction only reclaims the in-context copy.',
].join('\n');

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function writeSectionWithTools(input: WriteSectionInput): Promise<WriteSectionOutput> {
	const catalog = buildAnalyzerSkillCatalog(input.repoContext);

	// Build the system prompt: intro rules + skill catalog block.
	const sysParts: string[] = [SYSTEM_PROMPT_INTRO, '', formatAnalyzerSkillCatalog(catalog)];
	const systemPrompt = sysParts.join('\n');

	// Build the user prompt: original request + section card + repo summary.
	const userParts: string[] = [];
	userParts.push('## Original request');
	userParts.push(input.request.trim());
	userParts.push('');
	userParts.push('## Section to draft');
	userParts.push(`title:     ${input.action.title}`);
	userParts.push(`objective: ${input.action.objective}`);
	userParts.push('');
	userParts.push('## Review criteria');
	for (const c of input.action.reviewCriteria) {
		userParts.push(`- ${c}`);
	}
	if (input.repoSizeSummary !== undefined && !input.repoSizeSummary.empty) {
		userParts.push('');
		userParts.push('## Repo summary');
		userParts.push(formatRepoSizeSummary(input.repoSizeSummary, 'detailed'));
	}
	if (input.refineHint !== undefined && input.refineHint.trim().length > 0) {
		userParts.push('');
		userParts.push('## Reviewer hint (you have ONE more attempt)');
		userParts.push('Your previous attempt was rejected by the reviewer. Address this directly in this investigation:');
		userParts.push('');
		userParts.push(input.refineHint.trim());
		userParts.push('');
		userParts.push('Gather whatever additional evidence you need and write paragraphs that address the hint as you go. Do not echo this hint or refer to "the previous attempt" in your paragraphs.');
	}
	userParts.push('');
	userParts.push('Begin. Your FIRST turn opens with a topic sentence about the SUBJECT (the code, the subsystem, the pattern), then calls a tool. Do not narrate your process. Subsequent turns interpret the previous tool result -- specific facts inline -- before deciding what to call next. The final turn is a closing paragraph naming the most important takeaway; no tool call. If you have more to investigate, do not close -- call the next tool instead.');
	const userPrompt = userParts.join('\n');

	const messages: LLMMessage[] = [
		{ role: 'system', content: systemPrompt },
		{ role: 'user',   content: userPrompt },
	];

	const skillInvokeTool   = getTool('skill_invoke');
	const skillDescribeTool = getTool('skill_describe');
	const skillLoadPageTool = getTool('skill_load_page');
	const tools: ToolDefinition[] = [];
	if (skillInvokeTool)   tools.push({ name: skillInvokeTool.id,   description: skillInvokeTool.description,   inputSchema: skillInvokeTool.inputSchema });
	if (skillDescribeTool) tools.push({ name: skillDescribeTool.id, description: skillDescribeTool.description, inputSchema: skillDescribeTool.inputSchema });
	if (skillLoadPageTool) tools.push({ name: skillLoadPageTool.id, description: skillLoadPageTool.description, inputSchema: skillLoadPageTool.inputSchema });

	if (tools.length === 0) {
		log.warn({ actionId: input.action.id }, 'writeSectionWithTools: skill meta-tools not registered -- emitting stub');
		return {
			markdown:      `_Section draft unavailable -- the analyzer's skill tools (\`skill_invoke\` / \`skill_describe\`) are not registered._`,
			toolCallCount: 0,
			hitLimit:      false,
			skillsCalled:  [],
			skillCalls:    [],
			describedSkills: new Set<string>(),
		};
	}

	// Phase F.6 / fix 11.1: enforce the describe-before-invoke
	// protocol. `describedSkills` is seeded from priorDescribedSkills
	// (so round-2 retries don't re-discover schemas round-1 learned)
	// and grows as the LLM calls `skill_describe`. `skill_invoke` for
	// a skill not in the set is short-circuited with a protocol-error
	// tool result; the skill body is NOT executed.
	const describedSkills = new Set<string>(input.priorDescribedSkills ?? []);

	const skillsCalled: string[] = [];
	const skillCalls:   CapturedSkillCall[] = [];
	// Buffer the args at toolCall time so we can pair them with the
	// result at toolResult time. Keyed by the loop's iteration index
	// (1-based) since the loop emits onToolCall then onToolResult
	// for each call before moving on.
	const pendingByIteration = new Map<number, { skillId: string; args: Record<string, unknown> }>();
	let nextIteration = 0;
	const trackToolCall = (call: { name: string; input: Record<string, unknown> }): void => {
		nextIteration++;
		if (call.name === 'skill_describe' && typeof call.input['id'] === 'string') {
			describedSkills.add(call.input['id'] as string);
		}
		if (call.name === 'skill_invoke' && typeof call.input['skillId'] === 'string') {
			const skillId = call.input['skillId'] as string;
			const args    = (call.input['args'] as Record<string, unknown> | undefined) ?? {};
			skillsCalled.push(skillId);
			pendingByIteration.set(nextIteration, { skillId, args });
		}
	};
	const trackToolResult = (
		call: { name: string },
		result: { output: string; success: boolean; rejectionReason?: string | undefined },
	): void => {
		const pending = pendingByIteration.get(nextIteration);
		if (pending !== undefined && call.name === 'skill_invoke') {
			skillCalls.push({
				skillId:    pending.skillId,
				args:       pending.args,
				resultText: result.output,
				errored:    result.success === false,
				...(result.rejectionReason !== undefined ? { rejectionReason: result.rejectionReason } : {}),
			});
			pendingByIteration.delete(nextIteration);
		}
	};

	const maxToolCalls = input.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
	const maxTokens    = input.maxTokens    ?? input.action.maxBudgetTokens;

	log.info(
		{
			actionId:     input.action.id,
			catalogSize:  catalog.length,
			maxToolCalls,
			maxTokens,
			refinePass:   input.refineHint !== undefined && input.refineHint.trim().length > 0,
		},
		'writeSectionWithTools: starting tool loop',
	);

	const loopOpts: Parameters<typeof runToolLoop>[1] = {
		provider:       input.provider,
		tools,
		intent:         'code-analyzer-section',
		permissionMode: 'auto-accept',
		session:        input.session,
		maxTokens,
		maxIterations:  maxToolCalls,
	};
	loopOpts.onToolCall = (call) => {
		trackToolCall(call);
		const inputSummary = call.name === 'skill_invoke'
			? String(call.input['skillId'] ?? '?')
			: summariseInput(call.input);
		input.onProgress?.(`  [${input.action.id}] ${call.name}(${inputSummary})`);
	};
	loopOpts.onToolResult = (call, result) => {
		// Pull `rejectionReason` off result.data when present so the
		// captured trace + reviewer evidence builder can branch on
		// typed reason rather than substring-matching `output`.
		const data = (result as { data?: { rejectionReason?: string } }).data;
		const rejectionReason = data?.rejectionReason;
		trackToolResult(call, {
			output:  result.content,
			success: !result.isError,
			...(rejectionReason !== undefined ? { rejectionReason } : {}),
		});
	};
	// Mandatory describe-before-invoke protocol enforcement.
	loopOpts.interceptToolCall = (call) => {
		if (call.name !== 'skill_invoke') return null;
		const sid = typeof call.input['skillId'] === 'string' ? call.input['skillId'] : '';
		if (sid.length === 0) return null;
		if (describedSkills.has(sid)) return null;
		log.info(
			{ actionId: input.action.id, skillId: sid },
			'writeSectionWithTools: protocol violation -- skill_invoke without prior skill_describe; rejecting',
		);
		return {
			toolCallId: call.id,
			content:
				`[protocol-error] You must call \`skill_describe({ id: "${sid}" })\` ` +
				`BEFORE \`skill_invoke\` for that skill. The describe step is mandatory and ` +
				`enforced by the tool loop -- this invocation was NOT executed. Call ` +
				`skill_describe first to fetch the skill's input schema, then retry the ` +
				`invocation with args matching the schema.`,
			isError: true,
			// Synthetic rejection reason -- distinguishes the protocol
			// short-circuit from runner-side failures so the reviewer
			// evidence splitter can categorise correctly.
			data: { rejectionReason: 'protocol-error' },
		};
	};

	// Cap the loop's iterations independently of the global tool-config
	// default by post-checking. runToolLoop reads the global default;
	// we'll surface hitLimit via the result so the caller can decide
	// whether to accept the partial section.
	const result: ToolLoopResult = await runToolLoop(messages, loopOpts);

	// Phase D: per-section instrumentation. Paragraph count + citation
	// density tell us whether the model is actually following the
	// interleaved-investigation pattern; evictionsApplied + tokensFinal
	// tell us whether the memory model is working.
	const paragraphCount = countParagraphs(result.response);
	const citationCount  = countCitations(result.response);
	const avgTextLengthPerTurn = paragraphCount > 0
		? Math.round(result.response.length / paragraphCount)
		: 0;
	// Phase J.4: detect first-turn process-narration framing ("I will
	// investigate...", "Let me start by..."). The prompt rewrite in
	// J.1 tells the writer to open with a SUBJECT topic sentence;
	// this metric tells us whether the rewrite landed across runs.
	const firstTurnFramingDetected = isProcessNarrationFraming(
		result.response.split(/\n\s*\n/, 1)[0] ?? '',
	);

	log.info(
		{
			actionId:                   input.action.id,
			toolCallCount:              result.iterations,
			hitLimit:                   result.hitLimit,
			skillsCalled,
			textLength:                 result.response.length,
			paragraphCount,
			avgTextLengthPerTurn,
			citationCount,
			evictionsApplied:           result.evictionsApplied,
			inputTokensFinal:           result.inputTokensFinal,
			transitionPhraseNudgeFired: result.transitionPhraseNudgeFired,
			firstTurnFramingDetected,
		},
		'writeSectionWithTools: tool loop complete',
	);

	// Section-level cap is now enforced by runToolLoop directly
	// (via opts.maxIterations); no post-check needed.

	return {
		markdown:      result.response,
		toolCallCount: result.iterations,
		hitLimit:      result.hitLimit,
		skillsCalled,
		skillCalls,
		describedSkills,
	};
}

/**
 * Count paragraphs in the concatenated section text. Counts non-empty
 * blocks separated by blank lines (`\n\s*\n`). NOTE: this is paragraph
 * count, not turn count -- a single turn may emit multiple paragraphs,
 * and Phase A.2 also joins between turns with `\n\n`. Both contribute.
 * The metric reflects "how many paragraphs of prose did the section
 * end up with", which is the quality signal we actually care about.
 */
function countParagraphs(text: string): number {
	const trimmed = text.trim();
	if (trimmed.length === 0) return 0;
	return trimmed.split(/\n\s*\n/).filter(p => p.trim().length > 0).length;
}

/**
 * Count clickable `[label](path:...)` citations in the section text.
 * Used as a quality signal -- substantive sections should have
 * inline citations pointing at specific entities / files / line
 * ranges, not just prose.
 */
function countCitations(text: string): number {
	const matches = text.match(/\[[^\]]+\]\(path:[^)]+\)/g);
	return matches === null ? 0 : matches.length;
}

/**
 * Phase J.4: detect whether the FIRST paragraph of a section reads as
 * process-narration framing ("I will investigate the test architecture
 * by examining...") rather than a subject topic sentence ("The test
 * architecture spans three repository module trees..."). The J.1
 * prompt rewrite teaches the writer to open with the latter; this
 * metric measures whether the rewrite is landing across runs.
 */
function isProcessNarrationFraming(firstParagraph: string): boolean {
	const trimmed = firstParagraph.trim();
	if (trimmed.length === 0) return false;
	return /^(i will (investigate|examine|analyze|analyse|explore|look at|describe|cover)|let me (investigate|examine|start|begin|first)|i'll (investigate|examine|start|begin|first|look)|i need to (investigate|examine|look))\b/i.test(trimmed);
}

// ---------------------------------------------------------------------------
// Phase F + L: patch-loop system prompt
// ---------------------------------------------------------------------------

/**
 * Phase L.2 + L.3: the patch prompt is built per-round so round 3 can
 * escalate. The 2026-05-16 run #2 surfaced that the model treats the
 * old prompt's "for each work item: 1, 2, 3" as a serial OUTER loop
 * (announce ALL items, then gather ALL evidence, then... never emit
 * the patch blocks). The L.2 rewrite restructures the protocol to
 * make per-item interleaving explicit, and to anchor the patch block
 * IMMEDIATELY after each item's prose+evidence.
 */
function buildPatchSystemPrompt(round: 2 | 3): string {
	const base: string[] = [
		'You are REVISING a section draft. The cloud reviewer has flagged',
		'a list of concrete work items; your job is to address each item by',
		'patching the existing draft. You do NOT rewrite the whole section.',
		'',
		'You will receive:',
		'  - The current draft markdown, with paragraphs numbered (1-indexed).',
		'  - A list of work items, each with: id, kind, where, issue, action.',
		'  - The same SKILL CATALOG and meta-tools as the original investigation.',
		'',
		'## Work-item kinds',
		'',
		'  - `fix`     -- factual error in the draft. Verify with a skill call',
		'                 if needed, then replace the paragraph with a corrected',
		'                 version. Unaddressed `fix` items drop section confidence.',
		'  - `enhance` -- correct but thin. Gather more evidence (skill call),',
		'                 then replace the paragraph with a thicker version.',
		'  - `add`     -- coverage missing. Run a sub-investigation (skill calls),',
		'                 then INSERT a new paragraph at the anchor.',
		'  - `trim`    -- redundant / off-topic. Delete the paragraph; no skill',
		'                 call needed; the patch body should be empty.',
		'',
		'## Output protocol (REQUIRED -- read carefully)',
		'',
		'Process ONE work item at a time. For each item, complete ALL THREE',
		'steps before moving to the next item. Do NOT batch the prose for',
		'every item upfront and then try to gather evidence at the end.',
		'',
		'Per-item loop (repeat for every work item, in order):',
		'',
		'  1. ANNOUNCE: write ONE prose sentence naming the item id and what',
		'     change you are about to make. Example:',
		'     "For wi-2 (enhance, paragraph 3), I will add file:line refs',
		'     for DatanodeManager."',
		'  2. GATHER (only if needed): make a single skill call (or skill_describe',
		'     first if the skill is new). Use the tool result to inform the',
		'     patch body below.',
		'  3. EMIT THE PATCH BLOCK: this is the only output the orchestrator',
		'     reads. Prose outside the fenced block is DISCARDED.',
		'',
		'        ```patch:wi-2',
		'        The DatanodeManager [`DatanodeManager`](path:.../DatanodeManager.java#L80-L420)',
		'        tracks heartbeats from every DataNode in the cluster...',
		'        ```',
		'',
		'     For `add` items, name the anchor in the fence:',
		'',
		'        ```patch:wi-5 after=paragraph-2',
		'        <new paragraph content>',
		'        ```',
		'',
		'     For `trim`, emit an EMPTY body (the paragraph at the `where`',
		'     is deleted):',
		'',
		'        ```patch:wi-7',
		'        ```',
		'',
		'  4. If you genuinely cannot address an item (evidence is missing',
		'     or contradictory), emit a `skip:<id>` block with a one-sentence',
		'     reason INSTEAD of a `patch:<id>` block:',
		'',
		'        ```skip:wi-3',
		'        The repo has no Kerberos integration; the claim was wrong',
		'        but I could not determine the correct subsystem.',
		'        ```',
		'',
		'## Why per-item interleaving matters',
		'',
		'A previous run of this loop failed because the model wrote:',
		'',
		'  WRONG: "I will enhance paragraph 2 by adding citations. I will',
		'         enhance paragraph 1 by clarifying scopes. I will trim',
		'         paragraph 3. Let me now gather evidence."',
		'  (then gathered evidence forever; never emitted a patch block;',
		'  the orchestrator parsed zero blocks and the section did not',
		'  improve)',
		'',
		'  RIGHT: "For wi-1 (enhance, paragraph 2): adding DatanodeManager',
		'         citation."',
		'         <skill_invoke for code.entity.summary>',
		'         ```patch:wi-1',
		'         The DatanodeManager [`DatanodeManager`](path:...) tracks',
		'         heartbeats from every DataNode...',
		'         ```',
		'         "For wi-2 (enhance, paragraph 1): clarifying the fs and',
		'         util subsystem scopes."',
		'         ```patch:wi-2',
		'         The fs and util subsystems both live under',
		'         org.apache.hadoop but address different layers...',
		'         ```',
		'',
		'Each work item MUST produce either a `patch:<id>` or `skip:<id>`',
		'block before you move on. A turn without ANY patch/skip blocks is',
		'treated as silent failure and the orchestrator will run a redraft',
		'fallback that is unlikely to satisfy the reviewer.',
		'',
		'## What NOT to do',
		'',
		'  - Do NOT batch all announcements first, then gather evidence,',
		'    then emit blocks. Process per item, end to end.',
		'  - Do NOT rewrite the whole section. The orchestrator preserves',
		'    every paragraph you do not touch.',
		'  - Do NOT emit a `patch:` block for an item id that was not in',
		'    your work-item list.',
		'  - Do NOT skip an item without emitting a `skip:<id>` block --',
		'    the orchestrator interprets a missing block as silent failure.',
		'  - Do NOT include section headings (`## <title>`) inside any patch',
		'    body. The orchestrator stitches headings during report assembly.',
		'  - Do NOT include `[evicted ...]` stubs or other internal markers',
		'    in your patch bodies.',
		'',
		'## Patch body content (terminal-artifact rule)',
		'',
		'  Each patch body becomes a STANDALONE paragraph in the final',
		'  report. It is a TERMINAL artifact -- there is no "next" inside',
		'  the patch body. Do NOT include transition phrases. Do NOT promise',
		'  further investigation.',
		'',
		'    WRONG: "The HDFS module contains 707 files including',
		'           DFSConfigKeys. Next, I will examine the MapReduce',
		'           module."',
		'    RIGHT: "The HDFS module contains 707 files including',
		'           [`DFSConfigKeys`](path:.../DFSConfigKeys.java#L1-L2034),',
		'           which defines the configuration keys that govern block',
		'           placement, replication factor, and the heartbeat interval."',
		'',
		'  Other rules:',
		'',
		'  - Patch bodies must be plain markdown paragraphs (no fenced code',
		'    blocks inside a patch).',
		'  - Citations use the same shape as the original draft:',
		'    `[label](path:<file>(#L<startLine>(-L<endLine>)?)?)`. Preserve',
		'    existing citations the unaffected paragraphs already carry; add',
		'    new ones where the work item asks for them.',
		'  - Be specific. The reviewer rejected the previous draft for being',
		'    thin; the patched paragraph must concretely address the item.',
	];

	if (round === 3) {
		// Phase L.3: third-round escalation. The second-round patch loop
		// already ran on this draft and (if we reached round 3) failed
		// or produced an unreviewed result. Tell the model directly.
		const escalation: string[] = [
			'',
			'## ESCALATION -- THIRD ATTEMPT',
			'',
			'This is your THIRD attempt at this section. The first two passes',
			'either emitted zero fenced blocks or produced output the reviewer',
			'rejected. The orchestrator will ship the BEST draft from across',
			'all three attempts (lexicographic on fix-items-addressed,',
			'citations, paragraphs, length) -- but it CANNOT credit you for',
			'items you announce but do not emit blocks for.',
			'',
			'For this attempt:',
			'  - You MUST emit a `patch:<id>` or `skip:<id>` block for EVERY',
			'    work item in your input. A turn with zero blocks ships',
			'    nothing from this round.',
			'  - If an item cannot be addressed, use `skip:<id>` with a',
			'    one-sentence reason. A skip block IS productive output --',
			'    it tells the orchestrator you tried and explains why.',
			'  - Skill calls are optional this round. If the previous',
			'    rounds gathered the evidence already, just write the',
			'    patch body from what is in your context.',
			'  - Silence is the worst possible response.',
		];
		return [...base, ...escalation].join('\n');
	}
	return base.join('\n');
}

// ---------------------------------------------------------------------------
// Phase F: patchSectionWithTools
// ---------------------------------------------------------------------------

/**
 * Phase F entry point. Runs the writer in PATCH mode: the model sees
 * the round-1 draft plus the reviewer's typed work-item list and emits
 * fenced `patch:<id>` / `skip:<id>` blocks the orchestrator applies
 * back into the draft via `applyPatches`.
 *
 * Key differences from `writeSectionWithTools`:
 *
 *   - Different SYSTEM prompt (patch protocol; no "first turn: framing").
 *   - The patch-loop response is parsed into PatchBlocks; the section
 *     markdown is the result of `applyPatches(draftMarkdown, workItems, blocks)`,
 *     NOT the concatenation of assistant turns.
 *   - Transition-phrase nudge is disabled (no "closing paragraph" in
 *     the patch protocol -- it would misfire).
 *   - `priorSkillCalls` are surfaced to the orchestrator so it can pass
 *     cumulative evidence to the reviewer.
 *
 * Returns the patched markdown + per-item statuses. If the writer
 * emitted zero patch/skip blocks, `patchProtocolFollowed` is `false`
 * and the orchestrator should fall back to a `writeSectionWithTools`
 * redraft (F.4 escape hatch).
 */
export async function patchSectionWithTools(input: PatchSectionInput): Promise<PatchSectionOutput> {
	const catalog = buildAnalyzerSkillCatalog(input.repoContext);

	// SYSTEM = patch-loop intro + skill catalog block.
	const systemPrompt = [buildPatchSystemPrompt(input.round), '', formatAnalyzerSkillCatalog(catalog)].join('\n');

	// USER = original request + section card + numbered draft + work-item list.
	const userParts: string[] = [];
	userParts.push('## Original request');
	userParts.push(input.request.trim());
	userParts.push('');
	userParts.push('## Section being revised');
	userParts.push(`title:     ${input.action.title}`);
	userParts.push(`objective: ${input.action.objective}`);
	userParts.push('');
	userParts.push('## Review criteria');
	for (const c of input.action.reviewCriteria) {
		userParts.push(`- ${c}`);
	}
	if (input.repoSizeSummary !== undefined && !input.repoSizeSummary.empty) {
		userParts.push('');
		userParts.push('## Repo summary');
		userParts.push(formatRepoSizeSummary(input.repoSizeSummary, 'detailed'));
	}

	// Current draft with paragraphs numbered for the model.
	userParts.push('');
	userParts.push('## Current draft (paragraphs numbered)');
	const paragraphs = splitDraftParagraphs(input.draftMarkdown);
	if (paragraphs.length === 0) {
		userParts.push('_(draft is empty)_');
	} else {
		for (let i = 0; i < paragraphs.length; i++) {
			userParts.push(`[paragraph ${i + 1}]`);
			userParts.push(paragraphs[i]!);
			userParts.push('');
		}
	}

	// Work items the writer must address.
	userParts.push('## Work items to address (in order)');
	for (const wi of input.workItems) {
		userParts.push(`- **${wi.id}** (${wi.kind}, where: ${wi.where})`);
		userParts.push(`  issue: ${wi.issue}`);
		userParts.push(`  action: ${wi.action}`);
		if (wi.evidenceRefs !== undefined && wi.evidenceRefs.length > 0) {
			userParts.push(`  evidence: ${wi.evidenceRefs.join(', ')}`);
		}
	}
	userParts.push('');
	userParts.push('Begin. Process ONE work item end-to-end before starting the next: write your prose announcement, make any tool call you need, then emit the `patch:<id>` or `skip:<id>` block. Repeat for the next item. Do NOT batch all announcements first. The orchestrator parses the fenced blocks; prose outside them is discarded.');

	const messages: LLMMessage[] = [
		{ role: 'system', content: systemPrompt },
		{ role: 'user',   content: userParts.join('\n') },
	];

	const skillInvokeTool   = getTool('skill_invoke');
	const skillDescribeTool = getTool('skill_describe');
	const skillLoadPageTool = getTool('skill_load_page');
	const tools: ToolDefinition[] = [];
	if (skillInvokeTool)   tools.push({ name: skillInvokeTool.id,   description: skillInvokeTool.description,   inputSchema: skillInvokeTool.inputSchema });
	if (skillDescribeTool) tools.push({ name: skillDescribeTool.id, description: skillDescribeTool.description, inputSchema: skillDescribeTool.inputSchema });
	if (skillLoadPageTool) tools.push({ name: skillLoadPageTool.id, description: skillLoadPageTool.description, inputSchema: skillLoadPageTool.inputSchema });

	if (tools.length === 0) {
		log.warn({ actionId: input.action.id }, 'patchSectionWithTools: skill meta-tools not registered -- emitting stub');
		return {
			markdown:               input.draftMarkdown,
			toolCallCount:          0,
			hitLimit:               false,
			skillsCalled:           [],
			skillCalls:             [],
			describedSkills:        new Set<string>(input.priorDescribedSkills),
			itemStatuses:           input.workItems.map(wi => ({ id: wi.id, status: 'skipped' as const, reason: 'tools-not-registered' })),
			patchProtocolFollowed:  false,
		};
	}

	const describedSkills = new Set<string>(input.priorDescribedSkills);
	const skillsCalled: string[] = [];
	const skillCalls: CapturedSkillCall[] = [];
	const pendingByIteration = new Map<number, { skillId: string; args: Record<string, unknown> }>();
	let nextIteration = 0;

	const trackToolCall = (call: { name: string; input: Record<string, unknown> }): void => {
		nextIteration++;
		if (call.name === 'skill_describe' && typeof call.input['id'] === 'string') {
			describedSkills.add(call.input['id'] as string);
		}
		if (call.name === 'skill_invoke' && typeof call.input['skillId'] === 'string') {
			const skillId = call.input['skillId'] as string;
			const args    = (call.input['args'] as Record<string, unknown> | undefined) ?? {};
			skillsCalled.push(skillId);
			pendingByIteration.set(nextIteration, { skillId, args });
		}
	};
	const trackToolResult = (
		call: { name: string },
		result: { output: string; success: boolean; rejectionReason?: string | undefined },
	): void => {
		const pending = pendingByIteration.get(nextIteration);
		if (pending !== undefined && call.name === 'skill_invoke') {
			skillCalls.push({
				skillId:    pending.skillId,
				args:       pending.args,
				resultText: result.output,
				errored:    result.success === false,
				...(result.rejectionReason !== undefined ? { rejectionReason: result.rejectionReason } : {}),
			});
			pendingByIteration.delete(nextIteration);
		}
	};

	const maxToolCalls = input.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
	const maxTokens    = input.maxTokens    ?? input.action.maxBudgetTokens;

	log.info(
		{
			actionId:    input.action.id,
			catalogSize: catalog.length,
			maxToolCalls,
			maxTokens,
			workItems:   input.workItems.length,
			draftBytes:  input.draftMarkdown.length,
		},
		'patchSectionWithTools: starting patch loop',
	);

	const loopOpts: Parameters<typeof runToolLoop>[1] = {
		provider:               input.provider,
		tools,
		intent:                 'code-analyzer-section-patch',
		permissionMode:         'auto-accept',
		session:                input.session,
		maxTokens,
		maxIterations:          maxToolCalls,
		// Phase J.2: the patch protocol's output shape is `patch:<id>` /
		// `skip:<id>` blocks, NOT framing-then-close. The transition-
		// phrase nudge would misfire here.
		disableTransitionNudge: true,
	};
	loopOpts.onToolCall = (call) => {
		trackToolCall(call);
		const inputSummary = call.name === 'skill_invoke'
			? String(call.input['skillId'] ?? '?')
			: summariseInput(call.input);
		input.onProgress?.(`  [${input.action.id}/patch] ${call.name}(${inputSummary})`);
	};
	loopOpts.onToolResult = (call, result) => {
		const data = (result as { data?: { rejectionReason?: string } }).data;
		const rejectionReason = data?.rejectionReason;
		trackToolResult(call, {
			output:  result.content,
			success: !result.isError,
			...(rejectionReason !== undefined ? { rejectionReason } : {}),
		});
	};
	loopOpts.interceptToolCall = (call) => {
		if (call.name !== 'skill_invoke') return null;
		const sid = typeof call.input['skillId'] === 'string' ? call.input['skillId'] : '';
		if (sid.length === 0) return null;
		if (describedSkills.has(sid)) return null;
		log.info(
			{ actionId: input.action.id, skillId: sid },
			'patchSectionWithTools: protocol violation -- skill_invoke without prior skill_describe; rejecting',
		);
		return {
			toolCallId: call.id,
			content:
				`[protocol-error] You must call \`skill_describe({ id: "${sid}" })\` ` +
				`BEFORE \`skill_invoke\` for that skill.`,
			isError: true,
			data: { rejectionReason: 'protocol-error' },
		};
	};

	const result: ToolLoopResult = await runToolLoop(messages, loopOpts);

	// Parse the writer's combined text into patch blocks, then apply.
	const blocks: readonly PatchBlock[] = parsePatches(result.response);
	const applied = applyPatches(input.draftMarkdown, input.workItems, blocks);
	const patchProtocolFollowed = blocks.length > 0;

	log.info(
		{
			actionId:              input.action.id,
			toolCallCount:         result.iterations,
			hitLimit:              result.hitLimit,
			skillsCalled,
			patchBlocks:           blocks.length,
			workItems:             input.workItems.length,
			itemsAddressed:        applied.itemStatuses.filter(s => s.status === 'addressed').length,
			itemsPartial:          applied.itemStatuses.filter(s => s.status === 'partial').length,
			itemsSkipped:          applied.itemStatuses.filter(s => s.status === 'skipped').length,
			patchProtocolFollowed,
			evictionsApplied:      result.evictionsApplied,
			inputTokensFinal:      result.inputTokensFinal,
		},
		'patchSectionWithTools: patch loop complete',
	);

	return {
		markdown:               applied.patchedMarkdown,
		toolCallCount:          result.iterations,
		hitLimit:               result.hitLimit,
		skillsCalled,
		skillCalls,
		describedSkills,
		itemStatuses:           applied.itemStatuses,
		patchProtocolFollowed,
	};
}

function splitDraftParagraphs(markdown: string): string[] {
	const trimmed = markdown.trim();
	if (trimmed.length === 0) return [];
	return trimmed.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

export const _isProcessNarrationFramingForTest = isProcessNarrationFraming;
export const _countParagraphsForTest           = countParagraphs;
export const _countCitationsForTest            = countCitations;
export const _splitDraftParagraphsForTest      = splitDraftParagraphs;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summariseInput(input: Record<string, unknown>): string {
	const first = Object.values(input)[0];
	if (typeof first === 'string') {
		return first.length > 60 ? first.slice(0, 57) + '...' : first;
	}
	return JSON.stringify(input).slice(0, 60);
}
