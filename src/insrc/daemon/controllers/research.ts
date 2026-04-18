/**
 * ResearchController — TaskController for the research agent flow.
 *
 * Flow:
 *   plan (llm: create research plan from question)
 *   → investigate (llm+tool: execute plan steps, accumulate findings)
 *   → evaluate (llm: assess if goal is met)
 *   → report (llm: synthesize findings into response)
 *
 * investigate loops back until all plan steps are done or max iterations.
 * evaluate can add more steps and loop back to investigate.
 * clarify gates pause for user input (directory selection, ambiguous queries).
 */

import type {
  TaskController, ControllerInput, GateReply,
  Task, TaskResult, TaskStateStore, FinalizeResult, TaskFormat,
} from '../task.js';
import { renderMarkdown } from '../task.js';
import { getLogger } from '../../shared/logger.js';

// ---------------------------------------------------------------------------
// System prompts (embedded from step definitions)
// ---------------------------------------------------------------------------

const PLAN_PROMPT = `You are a research planner for a coding assistant.
Given a user's question, create a plan to find the answer.

Available actions:
- read-file: Read a specific file (use for known paths)
- grep-search: Search file contents by regex pattern
- glob-search: Find files by name pattern
- graph-search: Semantic search over indexed code entities
- graph-query: Cypher query against the code knowledge graph
- list-dir: List directory contents (use when path might be a directory)
- web-search: Search the web for documentation/answers
- git-log: Check git history for a file or repo
- git-blame: Check line-by-line authorship
- ask-user: Ask the user for clarification (use sparingly)
- analyze: Synthesize findings from previous steps (no tool needed)

CRITICAL RULES:
- If the user mentions EXPLICIT file or directory paths, your FIRST steps MUST use those exact paths
- For directories: use list-dir on the exact path, then read-file on relevant files inside
- For files: use read-file on the exact path
- Do NOT ignore user-specified paths in favor of graph searches or web searches
- Do NOT substitute different paths than what the user specified
- Start with the most direct action based on the user's exact words
- Use grep-search for patterns across files, read-file for specific files
- Use graph-search ONLY when the user asks about code concepts without specifying paths
- Add ask-user ONLY when truly ambiguous (prefer making a reasonable choice)
- End with an analyze step to synthesize findings
- Keep plans short (3-7 steps). Add more later if needed.
- IMPORTANT: For questions about external tools, libraries, frameworks, comparisons, "what's available",
  current best practices, or anything that changes over time — ALWAYS include a web-search step.
  Your training data may be outdated. Web search gives current information.
- Do NOT answer from knowledge alone for factual/comparison questions. Use tools first.

Output ONLY valid JSON:
{
  "goal": "<restatement of the question as an achievable goal>",
  "approach": "<1-2 sentence strategy>",
  "steps": [
    { "id": 0, "action": "<action>", "target": "<what to act on>", "reason": "<why>" }
  ]
}`;

const INVESTIGATE_PROMPT = `You are a research investigator for a coding assistant.
You have access to tools: Read, Grep, Glob, ListDirectory, Bash, graph_search, graph_query, WebSearch, WebFetch.

Given a research plan step and the research goal, execute the step using the appropriate tool.
After getting results, extract the relevant findings.

CRITICAL: You MUST use tools to gather information. Do NOT answer from your training knowledge alone.
If the task requires reading files, use Read. If it requires searching, use Grep or WebSearch.
ALWAYS call at least one tool before responding.

Rules:
- Use the EXACT paths specified in the plan step
- For directories: use Read (it will return a listing)
- For large files: use Grep with targeted patterns instead of reading the whole file
- For external libraries/tools/comparisons: use WebSearch
- Extract only the parts relevant to the research goal
- If a step fails, note the error and move on`;

const EVALUATE_PROMPT = `You are evaluating whether a research goal has been met.
Given the goal, findings so far, and any clarifications, assess progress.

Output ONLY valid JSON:
{
  "goalMet": <true if the question can be answered from the findings>,
  "confidence": <0.0-1.0>,
  "missingInfo": ["<what's still needed>"],
  "additionalSteps": [],
  "reasoning": "<1-2 sentences>"
}`;

const REPORT_PROMPT = `You are writing a research report for a coding assistant.
Given the research goal, findings, and evaluation, write a clear structured response in Markdown.

Format:
- Use ### for section headers
- Use code fences for code snippets (include file path and line numbers)
- Use bullet lists for findings
- Use **bold** for emphasis
- Reference file paths with backtick-wrapped paths
- Keep it concise -- answer the question directly, then supporting details
- Output Markdown only`;

const log = getLogger('research-controller');

// ---------------------------------------------------------------------------
// State keys
// ---------------------------------------------------------------------------

const K = {
  PLAN:              'researchPlan',
  FINDINGS:          'findings',
  CLARIFICATIONS:    'clarifications',
  CURRENT_STEP:      'currentPlanStep',
  INVESTIGATE_ITERS: 'investigateIterations',
  GOAL_MET:          'goalMet',
  CONFIDENCE:        'confidence',
  MISSING_INFO:      'missingInfo',
  REPORT:            'report',
  LAST_STEP:         'lastStep',
  PENDING_CLARIFY:   'pendingClarify',
  USER_QUESTION:     'userQuestion',
} as const;

const MAX_INVESTIGATE_ITERATIONS = 20;

// ---------------------------------------------------------------------------
// Task factories
// ---------------------------------------------------------------------------

function makePlanTask(userQuestion: string): Task {
  return {
    index: 0,
    description: 'Planning research approach...',
    kind: 'llm',
    intent: 'research',
    stateKey: K.PLAN,
    systemPrompt: PLAN_PROMPT,
    userMessage: userQuestion,
    searchHint: userQuestion,
    temperature: 0,
    maxTokens: 1000,
  };
}

function makeInvestigateTask(index: number, userQuestion: string): Task {
  return {
    index,
    description: 'Investigating...',
    kind: 'llm',
    intent: 'research',
    stateKey: K.FINDINGS,
    systemPrompt: INVESTIGATE_PROMPT,
    userMessage: userQuestion,
    searchHint: userQuestion,
    maxTokens: 4096,
    useToolLoop: true,
  };
}

function makeClarifyTask(index: number, title: string, content: string, actions: string[]): Task {
  return {
    index,
    description: title,
    kind: 'gate',
    intent: 'research',
    stateKey: K.PENDING_CLARIFY,
    gateActions: actions.map(a => ({
      name: a.toLowerCase().replace(/\s+/g, '-'),
      label: a,
    })),
    gateTitle: title,
    userMessage: content,
  };
}

function makeEvaluateTask(index: number, userQuestion: string): Task {
  return {
    index,
    description: 'Evaluating research progress...',
    kind: 'llm',
    intent: 'research',
    stateKey: K.GOAL_MET,
    systemPrompt: EVALUATE_PROMPT,
    userMessage: `Goal: ${userQuestion}`,
    searchHint: userQuestion,
    temperature: 0,
    maxTokens: 800,
  };
}

function makeWebSearchTask(index: number, query: string): Task {
  // plans/tools.md stage 4: emit kind: 'tool' + toolId / toolInput.
  // Routes through the unified tools executor; approval gate + schema
  // validation are shared with the LLM tool-call path.
  const hasBraveKey = !!process.env['BRAVE_API_KEY'];
  return {
    index,
    description: `Web search: ${query.slice(0, 50)}`,
    kind: 'tool',
    intent: 'research',
    stateKey: K.FINDINGS,
    // With a Brave key we can skip the approval gate; without it, the
    // Claude-flavored tool gates per query. Both target the same
    // underlying capability in the unified registry.
    toolId: hasBraveKey ? 'web-search' : 'web-search:claude',
    toolInput: { query },
  };
}

function makeReportTask(index: number, userQuestion: string): Task {
  return {
    index,
    description: 'Writing research report...',
    kind: 'llm',
    intent: 'research',
    stateKey: K.REPORT,
    systemPrompt: REPORT_PROMPT,
    userMessage: `Research goal: ${userQuestion}`,
    searchHint: userQuestion,
    persisted: true,
    maxTokens: 4096,
  };
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class ResearchController implements TaskController {
  readonly id = 'research';

  private _userQuestion = '';

  buildInitialTasks(input: ControllerInput): Task[] {
    this._userQuestion = input.message;
    return [makePlanTask(input.message)];
  }

  next(
    completed: TaskResult,
    gateReply: GateReply | undefined,
    state: TaskStateStore,
  ): Task[] | null {
    // Store user question in state on first call
    if (!state.get(K.USER_QUESTION) && this._userQuestion) {
      state.set(K.USER_QUESTION, this._userQuestion);
    }
    const q = (state.get(K.USER_QUESTION) as string) ?? this._userQuestion;
    // Track current step via the stateKey of the completed task's description
    const nextIdx = completed.index + 1;
    // Determine which step just completed from the LAST_STEP we set before returning the task
    const currentStep = state.get(K.LAST_STEP) as string | undefined ?? 'plan';

    log.debug({ currentStep, success: completed.success, outputLen: completed.output?.length }, 'research next()');

    // After plan -> investigate
    if (currentStep === 'plan') {
      state.set(K.INVESTIGATE_ITERS, 0);
      if (!state.get(K.FINDINGS)) state.set(K.FINDINGS, []);
      if (!state.get(K.CLARIFICATIONS)) state.set(K.CLARIFICATIONS, []);
      state.set(K.LAST_STEP, 'investigate');
      return [makeInvestigateTask(nextIdx, q)];
    }

    // After investigate -> check if more steps or evaluate
    if (currentStep === 'investigate') {
      const iters = ((state.get(K.INVESTIGATE_ITERS) as number) ?? 0) + 1;
      state.set(K.INVESTIGATE_ITERS, iters);

      const resultText = typeof completed.output === 'string' ? completed.output : '';

      // Check if web search was attempted but unavailable (no Brave key)
      // The LLM gets a message that web search requires the research agent delegate
      if (resultText.includes('No BRAVE_API_KEY') || resultText.includes('[WebSearch]')) {
        // Extract the query the LLM was trying to search for
        const queryMatch = resultText.match(/search.*?["""]([^"""]+)["""]/i)
          ?? resultText.match(/query[=:]\s*(.+)/i);
        const searchQuery = queryMatch?.[1]?.trim();
        if (searchQuery) {
          // Create a delegate web search task (handles approval internally)
          state.set(K.LAST_STEP, 'web-search');
          return [makeWebSearchTask(nextIdx, searchQuery)];
        }
      }

      // Check if the result indicates a directory (needs clarification)
      if (resultText.includes('[CLARIFY]')) {
        const lines = resultText.split('\n');
        const title = lines.find(l => l.startsWith('[CLARIFY_TITLE]'))?.replace('[CLARIFY_TITLE]', '').trim() ?? 'Which files should I analyze?';
        const content = lines.find(l => l.startsWith('[CLARIFY_CONTENT]'))?.replace('[CLARIFY_CONTENT]', '').trim() ?? resultText;
        const actions = lines.filter(l => l.startsWith('[CLARIFY_ACTION]')).map(l => l.replace('[CLARIFY_ACTION]', '').trim());
        if (actions.length === 0) actions.push('All files', 'Skip');
        state.set(K.LAST_STEP, 'clarify');
        return [makeClarifyTask(nextIdx, title, content, actions)];
      }

      // Check if we have more plan steps or should evaluate
      const plan = state.get(K.PLAN) as { steps?: Array<{ status: string }> } | undefined;
      const pendingSteps = plan?.steps?.filter(s => s.status === 'pending') ?? [];

      if (pendingSteps.length > 0 && iters < MAX_INVESTIGATE_ITERATIONS) {
        // Stay in investigate
        return [makeInvestigateTask(nextIdx, q)];
      }

      // All steps done or max iterations -> evaluate
      state.set(K.LAST_STEP, 'evaluate');
      return [makeEvaluateTask(nextIdx, q)];
    }

    // After web search delegate -> back to investigate
    if (currentStep === 'web-search') {
      // Web search result is in completed.output, add as finding
      if (completed.success && completed.output) {
        const findings = (state.get(K.FINDINGS) as unknown[]) ?? [];
        findings.push({ source: 'web search', content: completed.output.slice(0, 4000), relevance: 'Web search results' });
        state.set(K.FINDINGS, findings);
      }
      state.set(K.LAST_STEP, 'investigate');
      return [makeInvestigateTask(nextIdx, q)];
    }

    // After clarify gate -> back to investigate
    if (currentStep === 'clarify') {
      if (gateReply) {
        const clarifications = (state.get(K.CLARIFICATIONS) as Array<{ question: string; answer: string }>) ?? [];
        clarifications.push({
          question: completed.description,
          answer: gateReply.feedback ?? gateReply.action ?? 'no response',
        });
        state.set(K.CLARIFICATIONS, clarifications);
      }
      state.set(K.LAST_STEP, 'investigate');
      return [makeInvestigateTask(nextIdx, q)];
    }

    // After evaluate -> report or more investigation
    if (currentStep === 'evaluate') {
      const goalMet = state.get(K.GOAL_MET);
      const confidence = (state.get(K.CONFIDENCE) as number) ?? 0;

      if (goalMet || confidence >= 0.5 || ((state.get(K.INVESTIGATE_ITERS) as number) ?? 0) >= MAX_INVESTIGATE_ITERATIONS) {
        state.set(K.LAST_STEP, 'report');
        return [makeReportTask(nextIdx, q)];
      }

      // More investigation needed
      state.set(K.LAST_STEP, 'investigate');
      return [makeInvestigateTask(nextIdx, q)];
    }

    // After report -> done
    if (currentStep === 'report') {
      return null;
    }

    return null;
  }

  finalize(state: TaskStateStore): FinalizeResult {
    const report = state.get(K.REPORT) as string | undefined;
    const findings = (state.get(K.FINDINGS) as unknown[]) ?? [];

    log.info({ findings: findings.length, hasReport: !!report }, 'research finalized');

    if (!report) {
      return {
        output: 'Research completed but no report was generated.',
        format: 'text' as TaskFormat,
      };
    }

    // LLM outputs markdown — convert to HTML for the chat view
    const rendered = renderMarkdown(report);
    return {
      output: rendered.text,
      format: rendered.format,
    };
  }
}
