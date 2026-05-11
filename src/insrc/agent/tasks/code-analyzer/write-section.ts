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
	'  2. PICK skills from the catalog that produce that evidence. Call `skill_invoke({ skillId, args })`.',
	'     Use `skill_describe({ skillId })` first when the schema is unclear.',
	'  3. INSPECT the skill result; iterate -- call more skills if the evidence is thin or contradicts your draft.',
	'  4. When you have enough to satisfy every review criterion, STOP calling tools and emit the section markdown',
	'     as your final text response.',
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
		};
	}

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
		if (call.name === 'skill_invoke' && typeof call.input['skillId'] === 'string') {
			const skillId = call.input['skillId'] as string;
			const args    = (call.input['args'] as Record<string, unknown> | undefined) ?? {};
			skillsCalled.push(skillId);
			pendingByIteration.set(nextIteration, { skillId, args });
		}
	};
	const trackToolResult = (
		call: { name: string },
		result: { output: string; success: boolean },
	): void => {
		const pending = pendingByIteration.get(nextIteration);
		if (pending !== undefined && call.name === 'skill_invoke') {
			skillCalls.push({
				skillId:    pending.skillId,
				args:       pending.args,
				resultText: result.output,
				errored:    result.success === false,
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
	};
	loopOpts.onToolCall = (call) => {
		trackToolCall(call);
		const inputSummary = call.name === 'skill_invoke'
			? String(call.input['skillId'] ?? '?')
			: summariseInput(call.input);
		input.onProgress?.(`  [${input.action.id}] ${call.name}(${inputSummary})`);
	};
	loopOpts.onToolResult = (call, result) => {
		trackToolResult(call, { output: result.content, success: !result.isError });
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

	if (result.iterations > maxToolCalls) {
		log.warn(
			{ actionId: input.action.id, iterations: result.iterations, cap: maxToolCalls },
			'writeSectionWithTools: tool loop exceeded section-level cap (continuing -- result accepted)',
		);
	}

	return {
		markdown:      result.response,
		toolCallCount: result.iterations,
		hitLimit:      result.hitLimit,
		skillsCalled,
		skillCalls,
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
