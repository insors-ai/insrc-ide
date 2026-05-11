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
import { runToolLoop, type ToolLoopResult } from '../../tools/loop.js';
import { getTool } from '../../../daemon/tools/registry.js';
import { buildAnalyzerSkillCatalog, formatAnalyzerSkillCatalog, type AnalyzerRepoContext } from './skill-catalog.js';
import { formatRepoSizeSummary } from '../../../daemon/repo-summary.js';
import { getLogger } from '../../../shared/logger.js';

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
	/** The section markdown the LLM produced as its final turn. */
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
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT_INTRO = [
	'You write ONE section of a code-analysis report.',
	'',
	'You will receive:',
	'  - The user\'s ORIGINAL REQUEST (for orientation; do NOT answer the whole request, only this section).',
	'  - The SECTION to draft: title + objective + review criteria.',
	'  - A REPO SUMMARY (file counts, top modules, languages) -- use this for repo-shape claims, NOT speculation.',
	'  - A SKILL CATALOG of read-only skills you may invoke via `skill_invoke`.',
	'',
	'## How to work',
	'  1. READ the section objective + review criteria. Decide what evidence you need.',
	'  2. For each skill you intend to use, FIRST call `skill_describe({ id: <skillId> })` to fetch its',
	'     input/output schema. The tool loop ENFORCES this -- `skill_invoke` for a skill you have not',
	'     described returns a protocol-error and DOES NOT execute the skill. Describe once per skill per',
	'     section; subsequent invocations of the same skill do not need to re-describe.',
	'  3. PICK skills from the catalog that produce the evidence you need. Call',
	'     `skill_invoke({ skillId, args })` with `args` matching the schema you just learned.',
	'  4. INSPECT the skill result; iterate -- call more skills if the evidence is thin or contradicts your draft.',
	'  5. When you have enough to satisfy every review criterion, STOP calling tools and emit the section markdown',
	'     as your final text response.',
	'',
	'## Final-turn shape (CRITICAL)',
	'Your final turn -- the turn where you stop calling tools -- MUST be the COMPLETE section body. Specifically:',
	'  - NO meta-narration. Do not write "Let me examine...", "I need to check...", "Now I will summarise..." or any',
	'    other turn-by-turn commentary. The reader sees only the final body.',
	'  - NO internal markers. Never emit strings like `[tool calls executed]`, `<!-- ... -->`, or `[tool_result ...]`.',
	'    Those are conversation scaffolding, not section content.',
	'  - SUBSTANTIVE PROSE. Target multiple paragraphs (or paragraphs + lists/tables) grounded in the skill evidence',
	'    you actually fetched. A one-sentence section is a failed section -- if you have nothing to say, call more skills.',
	'  - SELF-CONTAINED. The body must stand on its own when stitched into the report; no references to "above" or',
	'    "the previous step".',
	'',
	'## Output rules',
	'  1. Final text response is the SECTION BODY ONLY -- no leading `## <title>` heading (the orchestrator stitches headings).',
	'  2. Use ONLY evidence from skill_invoke returns + the repo summary block. Do NOT fabricate entities or paths.',
	'  3. CLICKABLE CITATIONS. Whenever you mention an entity / class / function / file / module and the skill returns',
	'     its `file` (and optionally `startLine` / `endLine`), render it as a Markdown link the IDE recognises:',
	'',
	'       [`HdfsServerConstants`](path:hadoop-hdfs/.../HdfsServerConstants.java#L42-L58)',
	'       [`startCommonServices`](path:hadoop-hdfs/.../NameNode.java#L432)',
	'       [`src/auth/`](path:src/auth/)',
	'',
	'     URI shape: `path:<workspace-relative-file-or-dir>(#L<startLine>(-L<endLine>)?)?`.',
	'     Bare backticks (`identifierName` with no link) are OK only for entities the skill gives you NO file for,',
	'     or for inline keywords / language tokens. NEVER mention an entity as plain text when the evidence carries',
	'     its file.',
	'  4. Prefer PRODUCTION-source citations over test-source citations. When a `file` path is under `test/`,',
	'     `__tests__/`, `*.test.*`, or `*.spec.*`, frame the claim as "tested" rather than "implemented" -- and',
	'     cite the production source the test exercises when possible.',
	'  5. USE THE REPO\'S OWN VOCABULARY. If the repo has modules like `insors/ocr/` or classes like',
	'     `CaseExtractionAgent`, reference them by name. A generic "Python data extraction toolkit" framing is a',
	'     code smell -- there are thousands. What makes THIS repo specific is what the section should lead with.',
	'  6. Each tool call costs latency. Prefer 2-4 well-aimed calls over 8 scattershot ones.',
	'  7. Lists, tables, and short callouts are welcome where they aid clarity.',
	'',
	'STOP calling tools and emit the section when the review criteria are addressed. Concise + complete beats long + meandering.',
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
		userParts.push('Your previous draft was rejected by the reviewer. Address this directly:');
		userParts.push('');
		userParts.push(input.refineHint.trim());
		userParts.push('');
		userParts.push('Gather any additional evidence you need, then emit the COMPLETE section body. Do not echo this hint or refer to "the previous draft" in the section text.');
	}
	userParts.push('');
	userParts.push('Begin by analysing the section\'s objective + criteria, then call `skill_invoke` to gather evidence. When the criteria are satisfied, emit the section markdown.');
	const userPrompt = userParts.join('\n');

	const messages: LLMMessage[] = [
		{ role: 'system', content: systemPrompt },
		{ role: 'user',   content: userPrompt },
	];

	const skillInvokeTool   = getTool('skill_invoke');
	const skillDescribeTool = getTool('skill_describe');
	const tools: ToolDefinition[] = [];
	if (skillInvokeTool)   tools.push({ name: skillInvokeTool.id,   description: skillInvokeTool.description,   inputSchema: skillInvokeTool.inputSchema });
	if (skillDescribeTool) tools.push({ name: skillDescribeTool.id, description: skillDescribeTool.description, inputSchema: skillDescribeTool.inputSchema });

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

	log.info(
		{
			actionId:      input.action.id,
			toolCallCount: result.iterations,
			hitLimit:      result.hitLimit,
			skillsCalled,
			textLength:    result.response.length,
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
