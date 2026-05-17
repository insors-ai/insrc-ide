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
	/**
	 * Phase M.1: when set, the writer runs in RECOVERY mode -- this
	 * is the F.4 escape-hatch fallback after a failed patch loop. The
	 * recovery context carries the prior draft's length and paragraph
	 * count as soft targets so the redraft produces a comparably-full
	 * section instead of a narrow answer to the hint. The system prompt
	 * also swaps to a recovery-mode variant that explicitly says
	 * "produce a fresh comparably-full draft, NOT a focused answer".
	 */
	readonly recoveryContext?: {
		readonly priorDraftLength:    number;
		readonly priorParagraphCount: number;
		readonly priorCitationCount:  number;
	} | undefined;
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

// Phase P.1: raised 10 -> 32 after run #3 showed substantive sections
// hitting the cap at 10 with the model still actively calling tools.
// Phase S.1: raised 32 -> 64 after run #6 showed the model burning
// large portions of the 32-budget on repeated invalid-input retries
// (qwen3-coder:30b hammered `code.entity.summary` with the same wrong
// `entity` arg 10+ times on a single section). The schema-on-invalid-
// input feedback (in invoke-skill.ts) reduces that class of failure,
// but on the worst sections the model still needs more budget to
// recover. 64 leaves room for both substantive investigation AND
// schema-correction retries without truncating early.
// Trade-off: longer worst-case section time. Acceptable per the
// accuracy-over-speed principle in the structured-review plan.
const DEFAULT_MAX_TOOL_CALLS = 64;

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
	'## Citation density requirement',
	'',
	'A section\'s review criteria typically include "names concrete entities with file paths."',
	'`code.source.module.describe` returns MODULE-LEVEL stats (file counts, entity counts, top',
	'paths) but NOT entity-level `path:<file>#L<line>` anchors -- those come from:',
	'',
	'  - `code.entity.summary`        -- one entity with its file + line range',
	'  - `code.source.file.describe`  -- a file with its entities and ranges',
	'  - `code.class.locate-references` / `code.entity.locate-by-name` -- targeted lookups',
	'',
	'If your investigation has made only `module.describe` calls by your THIRD turn AND the',
	'section\'s criteria mention entity-level concerns, you MUST call one of the entity-level',
	'skills before closing. Modules alone produce citation-poor sections; the section will not',
	'pass review without concrete clickable references.',
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
// Phase M.1: recovery-mode preamble for the F.4 escape hatch
// ---------------------------------------------------------------------------

/**
 * Prepended to SYSTEM_PROMPT_INTRO when writeSectionWithTools runs in
 * RECOVERY mode (the F.4 escape hatch after a failed patch loop).
 *
 * The 2026-05-16 run #2 showed F.4 redrafts consistently producing
 * much shorter / weaker output than round 1 (231-1186 chars vs
 * round 1's 2-5k). The hintFromItems collapse primed the model to
 * write a "focused answer" instead of a full draft. This preamble
 * + the recovery-context block in the user message tells the model
 * the redraft must MATCH the prior draft's scope.
 */
const RECOVERY_MODE_PREAMBLE = [
	'## Recovery-mode instructions (READ FIRST)',
	'',
	'You are running as the RECOVERY pass after a failed patch loop.',
	'Read the `## Recovery context` block in the user message for the',
	'prior draft\'s length / paragraph / citation targets. Produce a',
	'FRESH, COMPARABLY FULL section -- NOT a narrow answer to the',
	'reviewer hint.',
	'',
	'Three rules specific to recovery mode:',
	'',
	'  1. The reviewer hint (when provided) is a CONSTRAINT, not the topic.',
	'     Address it as ONE thread within the full section. Do not let it',
	'     dominate the structure. Cover the original section objective and',
	'     review criteria with the same coverage the prior draft did.',
	'',
	'  2. MATCH the prior draft\'s density signals. If the prior draft',
	'     had 5 paragraphs with 9 citations, your redraft should be in',
	'     the same neighborhood. A 2-paragraph stub is a regression.',
	'',
	'  3. Iterate fully. Use the full tool-call budget. Do NOT stop',
	'     after one or two skill calls; gather evidence at the same',
	'     depth the original investigation did.',
].join('\n');

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function writeSectionWithTools(input: WriteSectionInput): Promise<WriteSectionOutput> {
	const catalog = buildAnalyzerSkillCatalog(input.repoContext);

	// Build the system prompt: intro rules + skill catalog block.
	// Phase M.1: recoveryContext prepends a recovery-mode preamble so
	// the F.4 escape-hatch redraft produces a comparably-full section
	// instead of a narrow focused answer to the hint.
	const sysParts: string[] = [];
	if (input.recoveryContext !== undefined) {
		sysParts.push(RECOVERY_MODE_PREAMBLE);
		sysParts.push('');
	}
	sysParts.push(SYSTEM_PROMPT_INTRO);
	sysParts.push('');
	sysParts.push(formatAnalyzerSkillCatalog(catalog));
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
	// Phase M.1: recovery context = soft targets from the prior draft
	// so the redraft matches its scope instead of writing a stub.
	if (input.recoveryContext !== undefined) {
		userParts.push('');
		userParts.push('## Recovery context (READ FIRST)');
		userParts.push('This is a RECOVERY pass. A prior round of patches against the existing draft failed (the model emitted no patch blocks). Your job is to produce a FRESH, COMPARABLY FULL draft of the section -- not a narrow answer to any reviewer hint.');
		userParts.push('');
		userParts.push('Soft targets from the prior draft (match these density signals; do not produce a stub):');
		userParts.push(`  - length:     ~${input.recoveryContext.priorDraftLength} chars`);
		userParts.push(`  - paragraphs: ~${input.recoveryContext.priorParagraphCount}`);
		userParts.push(`  - citations:  ≥${input.recoveryContext.priorCitationCount}`);
		userParts.push('');
		userParts.push('Treat the reviewer hint (if any) below as a CONSTRAINT on the new draft, not the topic. The section objective and review criteria remain the primary target.');
	}
	if (input.refineHint !== undefined && input.refineHint.trim().length > 0) {
		userParts.push('');
		userParts.push(input.recoveryContext !== undefined
			? '## Reviewer hint (constraint, not topic)'
			: '## Reviewer hint (you have ONE more attempt)');
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

	// Phase P.5 + P.6: close-time check. Fires (at most once) when the
	// model attempts end_turn; checks two writer-specific rules:
	//   P.6: minimum skill_invoke count before close. Sections of run
	//        #3 closed after 1-3 calls with 0-3 citations -- "When to
	//        stop" was triggering too eagerly. Min = min(3,
	//        criteria.length).
	//   P.5: entity-drill-down requirement when criteria mention
	//        entity-level concerns. Forces at least one entity-level
	//        skill before closing when 0 citations + only module.describe
	//        calls so far.
	const criteriaMentionEntities = input.action.reviewCriteria.some(c =>
		/\b(class|entit|implement|file:line|specific|concrete|method|function)\w*/i.test(c),
	);
	const minSkillInvokeFloor = Math.min(3, input.action.reviewCriteria.length);
	loopOpts.closeNudge = (ctx) => {
		const skillInvokeCount = skillsCalled.length;
		const onlyModuleDescribe = skillsCalled.every(s => s === 'code.source.module.describe');
		const citationCount = countCitations(ctx.sectionText);
		// P.6: hard floor on skill calls
		if (skillInvokeCount < minSkillInvokeFloor) {
			log.info(
				{ actionId: input.action.id, skillInvokeCount, floor: minSkillInvokeFloor },
				'writeSectionWithTools: P.6 close-floor nudge -- too few skill_invoke calls',
			);
			return (
				`You closed after only ${skillInvokeCount} skill_invoke call${skillInvokeCount === 1 ? '' : 's'}. The section has ${input.action.reviewCriteria.length} review criterion/criteria; ` +
				`the analyzer requires at least ${minSkillInvokeFloor} skill_invoke call${minSkillInvokeFloor === 1 ? '' : 's'} before closing. ` +
				`Make at least ${minSkillInvokeFloor - skillInvokeCount} more skill_invoke call${(minSkillInvokeFloor - skillInvokeCount) === 1 ? '' : 's'} (drilling into a criterion you have not yet covered) before closing.`
			);
		}
		// P.5: entity-drill-down requirement
		if (criteriaMentionEntities && citationCount === 0 && onlyModuleDescribe && skillsCalled.length > 0) {
			log.info(
				{ actionId: input.action.id, skillsCalled, citationCount },
				'writeSectionWithTools: P.5 entity-drill-down nudge -- module-only investigation',
			);
			return (
				`Your draft has 0 clickable citations and you have only called \`code.source.module.describe\`. ` +
				`The section criteria require concrete entity-level references (class names, file:line). ` +
				`Module-describe returns aggregate stats only -- file:line anchors come from \`code.entity.summary\` ` +
				`or \`code.source.file.describe\` or \`code.class.locate-references\`. ` +
				`Call one of these entity-level skills for at least one key entity before closing.`
			);
		}
		return null;
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
		'',
		'## Skill calls are usually unnecessary in patch rounds',
		'',
		'  Round 1 already gathered the evidence -- your conversation',
		'  history includes round 1\'s skill_invoke results. The patch body',
		'  should USUALLY emit from that existing context. Only call a',
		'  skill when the work item explicitly requires NEW evidence (e.g.',
		'  an `add` item asking for a topic round 1 did not investigate).',
		'',
		'  Gathering MORE evidence on a patch round is the single most',
		'  common failure mode of this loop: the model spins on tool calls',
		'  until the iteration cap kills the loop before any `patch:<id>`',
		'  block is emitted. The orchestrator then runs a redraft fallback',
		'  which is unlikely to satisfy the reviewer.',
		'',
		'  Default to ZERO skill calls per work item unless the item\'s',
		'  `kind` is `add` AND its `issue` names a topic not yet covered',
		'  by round 1\'s evidence.',
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
			'  - Skip skill calls entirely on this round. The base prompt',
			'    already says they are usually unnecessary; for round 3',
			'    they are forbidden unless the item kind is `add`. Write',
			'    the patch body from the context you already have.',
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
// Phase R.1: patchSectionItemwise -- per-item patch loop
// ---------------------------------------------------------------------------
//
// Eliminates the ghost-ID failure mode of patchSectionWithTools. Instead of
// asking the writer to emit fenced `patch:<id>` blocks (which both devstral
// and qwen drift on -- `patch:wi_1`, `patch:1`, `patch:enhance-paragraph-1`
// all observed), the orchestrator iterates per work item. The writer never
// sees an ID; it gets one item, one focused prompt, returns one paragraph
// of plain text. The orchestrator slots the response in by `item.where`.
//
// Per-kind handling:
//   fix     -- single LLM call (no skills); replace target paragraph
//   enhance -- single LLM call (no skills); replace target paragraph
//   add     -- single LLM call (up to ~3 skill calls); insert after anchor
//   trim    -- no LLM call; orchestrator-side delete

export interface PatchSectionItemwiseInput {
	readonly provider:             LLMProvider;
	readonly session:              Session;
	readonly action:               PlannedAction;
	readonly request:              string;
	readonly repoContext:          AnalyzerRepoContext;
	readonly repoSizeSummary?:     RepoSizeSummary | undefined;
	readonly maxToolCalls?:        number | undefined;
	readonly maxTokens?:           number | undefined;
	readonly onProgress?:          ((message: string) => void) | undefined;
	readonly draftMarkdown:        string;
	readonly workItems:            readonly ReviewWorkItem[];
	readonly priorDescribedSkills: ReadonlySet<string>;
	readonly priorSkillCalls:      readonly CapturedSkillCall[];
	readonly round:                2 | 3;
}

/** Max skill calls a single `add` item may use inside its sub-loop.
 *  Counts describe + invoke + final assistant turn against this budget. */
const ADD_ITEM_TOOL_CALL_BUDGET = 4;

/** Order in which the per-item loop addresses kinds. `fix` first (the
 *  correctness gate); then `enhance` / `add` (content); then `trim`
 *  (deletes happen last so earlier `where` indices stay valid). */
const KIND_ORDER: Record<ReviewWorkItem['kind'], number> = {
	fix:     0,
	enhance: 1,
	add:     2,
	trim:    3,
};

export async function patchSectionItemwise(input: PatchSectionItemwiseInput): Promise<PatchSectionOutput> {
	const ordered = [...input.workItems].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);

	let workingDraft     = input.draftMarkdown;
	const statuses       = new Map<string, WorkItemStatus>();
	const describedSkills = new Set<string>(input.priorDescribedSkills);
	const skillsCalled: string[]            = [];
	const skillCalls:   CapturedSkillCall[] = [];
	let totalToolCalls   = 0;
	const maxToolCalls   = input.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;

	log.info(
		{
			actionId:   input.action.id,
			round:      input.round,
			workItems:  input.workItems.length,
			draftBytes: input.draftMarkdown.length,
			maxToolCalls,
		},
		'patchSectionItemwise: starting per-item patch loop',
	);

	for (const item of ordered) {
		if (item.kind === 'trim') {
			// No LLM call. Synthesize a patch:<id> block; the applier's
			// trim handler ignores body, deletes the targeted paragraph.
			const status = applyOneItem(workingDraft, item, '');
			workingDraft = status.patchedMarkdown;
			statuses.set(item.id, status.itemStatus);
			input.onProgress?.(`  [${input.action.id}/patch] trim ${item.id} (${item.where})`);
			continue;
		}

		const remaining = maxToolCalls - totalToolCalls;
		if (remaining <= 0) {
			statuses.set(item.id, { id: item.id, status: 'skipped', reason: 'tool-call budget exhausted' });
			continue;
		}

		if (item.kind === 'add') {
			const itemBudget = Math.min(ADD_ITEM_TOOL_CALL_BUDGET, remaining);
			const itemResult = await runAddItem(item, workingDraft, input, describedSkills, itemBudget);
			totalToolCalls += itemResult.toolCalls;
			skillsCalled.push(...itemResult.skillsCalled);
			skillCalls.push(...itemResult.skillCalls);
			const text = itemResult.text.trim();
			if (text.length === 0) {
				statuses.set(item.id, { id: item.id, status: 'skipped', reason: 'empty add response' });
				continue;
			}
			const status = applyOneItem(workingDraft, item, text);
			workingDraft = status.patchedMarkdown;
			statuses.set(item.id, status.itemStatus);
			continue;
		}

		// fix or enhance: one LLM call, no skills
		const text = await runFixEnhanceItem(item, workingDraft, input);
		totalToolCalls += 1;
		const trimmed = text.trim();
		if (trimmed.length === 0) {
			statuses.set(item.id, { id: item.id, status: 'skipped', reason: 'empty fix/enhance response' });
			continue;
		}
		const status = applyOneItem(workingDraft, item, trimmed);
		workingDraft = status.patchedMarkdown;
		statuses.set(item.id, status.itemStatus);
	}

	// Emit statuses in the reviewer's original workItems order so the
	// orchestrator and downstream consumers (picker, todo trace) see a
	// stable shape regardless of how we sequenced execution.
	const itemStatuses: WorkItemStatus[] = input.workItems.map(
		wi => statuses.get(wi.id) ?? { id: wi.id, status: 'skipped', reason: 'not processed' },
	);

	const itemsAddressed = itemStatuses.filter(s => s.status === 'addressed').length;
	// Treat the per-item loop as "protocol followed" whenever any item
	// was addressed. The orchestrator's F.4 escape hatch triggers when
	// this is false -- under R.1 that means the loop genuinely produced
	// zero useful changes (every item returned empty or unresolvable),
	// which is exactly the recovery scenario F.4 is designed for.
	const patchProtocolFollowed = itemsAddressed > 0;

	log.info(
		{
			actionId:        input.action.id,
			round:           input.round,
			toolCallCount:   totalToolCalls,
			hitLimit:        totalToolCalls >= maxToolCalls,
			skillsCalled,
			workItems:       input.workItems.length,
			itemsAddressed,
			itemsPartial:    itemStatuses.filter(s => s.status === 'partial').length,
			itemsSkipped:    itemStatuses.filter(s => s.status === 'skipped').length,
			patchProtocolFollowed,
		},
		'patchSectionItemwise: per-item patch loop complete',
	);

	return {
		markdown:               workingDraft,
		toolCallCount:          totalToolCalls,
		hitLimit:               totalToolCalls >= maxToolCalls,
		skillsCalled,
		skillCalls,
		describedSkills,
		itemStatuses,
		patchProtocolFollowed,
	};
}

/**
 * Slot the LLM's new paragraph into the working draft. Reuses
 * `applyPatches` by synthesizing a single PatchBlock with the
 * orchestrator-owned id -- the same id that lives in `workItems[]`, so
 * the block always matches by construction. Ghost-IDs are impossible:
 * the writer never produced the id.
 */
function applyOneItem(
	workingDraft: string,
	item:         ReviewWorkItem,
	body:         string,
): { patchedMarkdown: string; itemStatus: WorkItemStatus } {
	const block: PatchBlock = { kind: 'patch', itemId: item.id, attrs: {}, body };
	const result = applyPatches(workingDraft, [item], [block]);
	const status = result.itemStatuses[0] ?? { id: item.id, status: 'skipped', reason: 'applier returned no status' };
	return { patchedMarkdown: result.patchedMarkdown, itemStatus: status };
}

async function runFixEnhanceItem(
	item:         ReviewWorkItem,
	workingDraft: string,
	input:        PatchSectionItemwiseInput,
): Promise<string> {
	const paragraphs = splitDraftParagraphs(workingDraft);
	const targetIdx  = resolveParagraphIdxByWhere(item.where, paragraphs);
	const targetText = targetIdx !== null && targetIdx < paragraphs.length
		? paragraphs[targetIdx]!
		: '(target paragraph could not be located; produce a fresh paragraph that addresses the reviewer\'s action)';

	const system = [
		'You are revising ONE paragraph of a code-analysis section. The reviewer flagged a specific issue and described a concrete fix.',
		'',
		'OUTPUT FORMAT: a single replacement paragraph. Plain markdown. NO fenced code blocks around your response. NO preamble ("Here is the revised paragraph"). NO transition sentence at the end ("Next, I will..."). Just the paragraph text.',
		'',
		'Preserve any clickable `[text](path:foo.ts#L1)` citations the original carried; add new ones where the action asks. Stay focused on this one action -- do not edit unrelated content.',
	].join('\n');

	const userParts: string[] = [];
	userParts.push('## Section context');
	userParts.push(`title:     ${input.action.title}`);
	userParts.push(`objective: ${input.action.objective}`);
	userParts.push('');
	userParts.push(`## Paragraph to revise (reviewer pointed to "${item.where}")`);
	userParts.push(targetText);
	userParts.push('');
	userParts.push('## Reviewer flag');
	userParts.push(`Issue:  ${item.issue}`);
	userParts.push(`Action: ${item.action}`);
	if (item.evidenceRefs !== undefined && item.evidenceRefs.length > 0) {
		userParts.push(`Evidence refs: ${item.evidenceRefs.join(', ')}`);
	}
	userParts.push('');
	if (paragraphs.length > 1) {
		userParts.push('## Surrounding paragraphs (read-only context, do NOT include in your output)');
		for (let i = 0; i < paragraphs.length; i++) {
			if (i === targetIdx) continue;
			userParts.push(`[paragraph ${i + 1}]`);
			userParts.push(paragraphs[i]!);
			userParts.push('');
		}
	}
	userParts.push('Output ONLY the replacement paragraph text.');

	const messages: LLMMessage[] = [
		{ role: 'system', content: system },
		{ role: 'user',   content: userParts.join('\n') },
	];

	input.onProgress?.(`  [${input.action.id}/patch] ${item.kind} ${item.id} (${item.where})`);

	const resp = await input.provider.complete(messages, {
		maxTokens: input.maxTokens ?? input.action.maxBudgetTokens,
	});
	return stripParagraphArtifacts(resp.text);
}

async function runAddItem(
	item:           ReviewWorkItem,
	workingDraft:   string,
	input:          PatchSectionItemwiseInput,
	describedSkills: Set<string>,
	itemBudget:     number,
): Promise<{ text: string; toolCalls: number; skillsCalled: string[]; skillCalls: CapturedSkillCall[] }> {
	const catalog    = buildAnalyzerSkillCatalog(input.repoContext);
	const paragraphs = splitDraftParagraphs(workingDraft);

	const system = [
		'You are ADDING ONE new paragraph to a code-analysis section. The reviewer flagged a missing topic; produce a single paragraph that fills the gap.',
		'',
		'You MAY make up to 2 skill calls if you need new evidence the existing section does not cover. Always call `skill_describe({ id })` before invoking a skill the first time.',
		'',
		'AFTER gathering evidence (or immediately, if no evidence is needed), end with a final assistant turn that contains ONLY the new paragraph as plain markdown. NO fenced code blocks around your response. NO preamble. NO transition sentence. Just the paragraph text.',
		'',
		formatAnalyzerSkillCatalog(catalog),
	].join('\n');

	const userParts: string[] = [];
	userParts.push('## Section context');
	userParts.push(`title:     ${input.action.title}`);
	userParts.push(`objective: ${input.action.objective}`);
	userParts.push('');
	userParts.push('## Reviewer flag (missing coverage)');
	userParts.push(`Issue:  ${item.issue}`);
	userParts.push(`Action: ${item.action}`);
	userParts.push(`Anchor: insert after "${item.where}"`);
	if (item.evidenceRefs !== undefined && item.evidenceRefs.length > 0) {
		userParts.push(`Evidence refs: ${item.evidenceRefs.join(', ')}`);
	}
	userParts.push('');
	if (paragraphs.length > 0) {
		userParts.push('## Existing section paragraphs (read-only context)');
		for (let i = 0; i < paragraphs.length; i++) {
			userParts.push(`[paragraph ${i + 1}]`);
			userParts.push(paragraphs[i]!);
			userParts.push('');
		}
	}
	userParts.push('Output your final turn as ONLY the new paragraph text.');

	const messages: LLMMessage[] = [
		{ role: 'system', content: system },
		{ role: 'user',   content: userParts.join('\n') },
	];

	const skillInvokeTool   = getTool('skill_invoke');
	const skillDescribeTool = getTool('skill_describe');
	const skillLoadPageTool = getTool('skill_load_page');
	const tools: ToolDefinition[] = [];
	if (skillInvokeTool)   tools.push({ name: skillInvokeTool.id,   description: skillInvokeTool.description,   inputSchema: skillInvokeTool.inputSchema });
	if (skillDescribeTool) tools.push({ name: skillDescribeTool.id, description: skillDescribeTool.description, inputSchema: skillDescribeTool.inputSchema });
	if (skillLoadPageTool) tools.push({ name: skillLoadPageTool.id, description: skillLoadPageTool.description, inputSchema: skillLoadPageTool.inputSchema });

	const localSkillsCalled: string[]            = [];
	const localSkillCalls:   CapturedSkillCall[] = [];
	const pendingByIteration = new Map<number, { skillId: string; args: Record<string, unknown> }>();
	let nextIteration = 0;

	input.onProgress?.(`  [${input.action.id}/patch] add ${item.id} (${item.where})`);

	const loopOpts: Parameters<typeof runToolLoop>[1] = {
		provider:               input.provider,
		tools,
		intent:                 'code-analyzer-section-patch',
		permissionMode:         'auto-accept',
		session:                input.session,
		maxTokens:              input.maxTokens ?? input.action.maxBudgetTokens,
		maxIterations:          itemBudget,
		disableTransitionNudge: true,
	};
	loopOpts.onToolCall = (call) => {
		nextIteration++;
		if (call.name === 'skill_describe' && typeof call.input['id'] === 'string') {
			describedSkills.add(call.input['id'] as string);
		}
		if (call.name === 'skill_invoke' && typeof call.input['skillId'] === 'string') {
			const skillId = call.input['skillId'] as string;
			const args    = (call.input['args'] as Record<string, unknown> | undefined) ?? {};
			localSkillsCalled.push(skillId);
			pendingByIteration.set(nextIteration, { skillId, args });
		}
	};
	loopOpts.onToolResult = (call, result) => {
		const pending = pendingByIteration.get(nextIteration);
		if (pending !== undefined && call.name === 'skill_invoke') {
			const data = (result as { data?: { rejectionReason?: string } }).data;
			const rejectionReason = data?.rejectionReason;
			localSkillCalls.push({
				skillId:    pending.skillId,
				args:       pending.args,
				resultText: result.content,
				errored:    result.isError === true,
				...(rejectionReason !== undefined ? { rejectionReason } : {}),
			});
			pendingByIteration.delete(nextIteration);
		}
	};
	loopOpts.interceptToolCall = (call) => {
		if (call.name !== 'skill_invoke') return null;
		const sid = typeof call.input['skillId'] === 'string' ? call.input['skillId'] : '';
		if (sid.length === 0) return null;
		if (describedSkills.has(sid)) return null;
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
	return {
		text:          stripParagraphArtifacts(result.response),
		toolCalls:     result.iterations,
		skillsCalled:  localSkillsCalled,
		skillCalls:    localSkillCalls,
	};
}

/**
 * Local mirror of apply-patches.ts `resolveParagraphIdx`. Kept here to
 * avoid bleeding internal exports into the public surface of the
 * applier. Accepts the same `where` shapes the reviewer produces.
 */
function resolveParagraphIdxByWhere(where: string, paragraphs: readonly string[]): number | null {
	if (paragraphs.length === 0) return null;
	const w = where.trim().toLowerCase();
	if (/^(section\s+)?(opening|start)$/.test(w)) return 0;
	if (/^(section\s+)?(closing|ending|end)$/.test(w)) return paragraphs.length - 1;
	const single = w.match(/^(?:after\s+)?paragraphs?\s+(\d+)/);
	if (single !== null) {
		const n = Number.parseInt(single[1]!, 10);
		if (Number.isFinite(n) && n >= 1 && n <= paragraphs.length) return n - 1;
	}
	return null;
}

/**
 * Strip the model's most common output preambles / wrappers when it
 * fails to follow the "ONLY the paragraph text" instruction. Cheap
 * defense-in-depth; the prompt does the heavy lifting.
 */
function stripParagraphArtifacts(text: string): string {
	let t = text.trim();
	if (t.length === 0) return t;

	// Strip surrounding triple-backtick fence (with or without info string).
	const fence = t.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/);
	if (fence) t = fence[1]!.trim();

	// Strip "Here is..." / "Here's..." opener up to the FIRST period or colon
	// (lazy match so we don't eat the actual paragraph that follows).
	t = t.replace(/^(here'?s?\b[^.\n]*?[.:]\s*)/i, '').trim();
	// Strip a leading "Revised paragraph:" / "New paragraph:" label.
	t = t.replace(/^(revised paragraph|new paragraph|paragraph|replacement)\s*[:\-]\s*/i, '').trim();

	return t;
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

export const _isProcessNarrationFramingForTest = isProcessNarrationFraming;
export const _countParagraphsForTest           = countParagraphs;
export const _countCitationsForTest            = countCitations;
export const _splitDraftParagraphsForTest      = splitDraftParagraphs;
export const _stripParagraphArtifactsForTest   = stripParagraphArtifacts;
export const _resolveParagraphIdxByWhereForTest = resolveParagraphIdxByWhere;
export const _KIND_ORDER_FOR_TEST              = KIND_ORDER;

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
