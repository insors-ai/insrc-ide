/**
 * Investigate step — executes plan steps using tools, accumulates findings.
 *
 * Each iteration takes the next pending plan step, executes it via the
 * appropriate tool, evaluates the result, and routes to the next step.
 */

import type { AgentStep, StepResult, StepContext } from '../../../framework/types.js';
import type { ResearchState } from '../agent-state.js';
import type { PlanStep } from '../types.js';
import { executeTool } from '../../../tools/executor.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getLogger } from '../../../../shared/logger.js';

const log = getLogger('research-investigate');

const MAX_RESULT_CHARS = 8000;

const EXTRACT_SYSTEM = `You are extracting relevant findings from a tool result.
Given the research goal and a tool result, extract ONLY the parts relevant to answering the goal.

Output JSON:
{
  "findings": [{ "content": "<relevant excerpt or summary>", "relevance": "<why this matters>" }],
  "needsMore": <true if more investigation is needed based on this result>,
  "suggestedAction": "<optional: next action if needsMore is true, e.g. 'grep for X in file Y'>"
}`;

export const investigateStep: AgentStep<ResearchState> = {
  name: 'investigate',
  async run(state: ResearchState, ctx: StepContext): Promise<StepResult<ResearchState>> {

    // Guard: max iterations
    if (state.investigateIterations >= state.maxInvestigateIterations) {
      log.info({ iterations: state.investigateIterations }, 'max investigate iterations reached');
      return { state, next: 'evaluate' };
    }

    // Find next pending step
    const pendingIdx = state.plan.steps.findIndex(s => s.status === 'pending');
    if (pendingIdx === -1) {
      log.info('all plan steps done, moving to evaluate');
      return { state, next: 'evaluate' };
    }

    const planStep = state.plan.steps[pendingIdx]!;
    const stepLabel = `Step ${pendingIdx + 1}/${state.plan.steps.length}`;

    ctx.progress(`${stepLabel}: ${planStep.action} -- ${planStep.target.slice(0, 60)}`);

    log.info({ step: pendingIdx, action: planStep.action, target: planStep.target }, 'executing plan step');

    let result: string;
    let nextStep: string = 'investigate'; // default: loop back

    try {
      result = await executePlanStep(planStep, state.input.repoPath);
    } catch (err) {
      const errMsg = (err as Error).message;
      log.warn({ step: pendingIdx, error: errMsg }, 'plan step failed');
      result = `[error] ${errMsg}`;

      // Mark failed
      state.plan.steps[pendingIdx] = { ...planStep, status: 'failed', result: errMsg };
      state.investigateIterations++;

      return {
        state: { ...state, investigateIterations: state.investigateIterations },
        next: 'investigate',
      };
    }

    // Check for directory listing — route to clarify if ambiguous
    if (result.includes('This is a directory.') && planStep.action === 'read-file') {
      log.info({ target: planStep.target }, 'got directory listing, routing to clarify');
      state.plan.steps[pendingIdx] = { ...planStep, status: 'done', result };

      // Try to auto-select based on the goal
      const autoSelected = autoSelectFromListing(result, state.plan.goal);
      if (autoSelected.length > 0) {
        // Add read steps for auto-selected files
        const newSteps: PlanStep[] = autoSelected.map((file, i) => ({
          id: state.plan.steps.length + i,
          action: 'read-file' as const,
          target: `${planStep.target}/${file}`,
          reason: `Auto-selected from directory listing based on research goal`,
          status: 'pending' as const,
        }));
        state.plan.steps.push(...newSteps);
        log.info({ autoSelected }, 'auto-selected files from directory');
        state.investigateIterations++;
        return { state: { ...state, investigateIterations: state.investigateIterations }, next: 'investigate' };
      }

      // Can't auto-select — ask user
      return {
        state: {
          ...state,
          activeSubflow: 'file',
          investigateIterations: state.investigateIterations + 1,
        },
        next: 'clarify',
      };
    }

    // Truncate very large results before sending to extraction LLM
    const truncatedResult = result.length > MAX_RESULT_CHARS
      ? result.slice(0, MAX_RESULT_CHARS) + `\n\n[... truncated, ${result.length} total chars]`
      : result;

    // Extract findings from the result
    ctx.progress(`${stepLabel}: Analyzing results...`);

    const newFindings = await extractFindings(ctx, truncatedResult, state.plan.goal);

    // Mark step done
    state.plan.steps[pendingIdx] = {
      ...planStep,
      status: 'done',
      result: `${newFindings.length} finding(s) extracted`,
    };

    // Add findings
    const updatedFindings = [
      ...state.findings,
      ...newFindings.map(f => ({ source: planStep.target, ...f })),
    ];

    state.investigateIterations++;

    // Check if we should add more steps based on the extraction
    // (the extraction LLM can suggest follow-up actions)

    return {
      state: {
        ...state,
        findings: updatedFindings,
        currentPlanStep: pendingIdx + 1,
        investigateIterations: state.investigateIterations,
      },
      next: nextStep,
    };
  },
};

// ---------------------------------------------------------------------------
// Tool execution per plan step action
// ---------------------------------------------------------------------------

async function executePlanStep(step: PlanStep, repoPath: string): Promise<string> {
  const call = (name: string, input: Record<string, unknown>) =>
    executeTool({ id: 'tc_research', name, input }).then(r => r.content);

  switch (step.action) {
    case 'read-file':
    case 'list-dir':
      return call('Read', { file_path: resolvePath(step.target, repoPath) });

    case 'grep-search':
      return call('Grep', { pattern: step.target, path: repoPath });

    case 'glob-search':
      return call('Glob', { pattern: step.target, path: repoPath });

    case 'graph-search':
      return call('graph_search', { query: step.target, limit: 10 });

    case 'graph-sql':
      return call('graph_sql', { sql: step.target });

    case 'web-search':
      return call('WebSearch', { query: step.target, limit: 5 });

    case 'git-log':
      return call('Bash', { command: `cd ${repoPath} && git log --oneline -20 -- ${step.target}` });

    case 'git-blame':
      return call('Bash', { command: `cd ${repoPath} && git blame ${step.target} | head -50` });

    case 'analyze':
      return '[analyze step -- no tool execution, proceed to evaluation]';

    case 'ask-user':
      return '[ask-user -- routing to clarify gate]';

    default:
      return `[unsupported action: ${step.action}]`;
  }
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function resolvePath(target: string, repoPath: string): string {
  if (target.startsWith('/')) return target;
  if (target.startsWith('~')) return target.replace('~', homedir());
  return join(repoPath, target);
}

// ---------------------------------------------------------------------------
// Finding extraction
// ---------------------------------------------------------------------------

async function extractFindings(
  ctx: StepContext,
  toolResult: string,
  goal: string,
): Promise<Array<{ content: string; relevance: string }>> {
  try {
    const response = await ctx.providers.resolve('research', 'investigate').complete([
      { role: 'system', content: EXTRACT_SYSTEM },
      { role: 'user', content: `Research goal: ${goal}\n\nTool result:\n${toolResult}` },
    ], { maxTokens: 1000, temperature: 0 });

    const text = response.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(text) as { findings: Array<{ content: string; relevance: string }> };
    return parsed.findings ?? [];
  } catch (err) {
    log.warn({ error: (err as Error).message }, 'failed to extract findings, using raw result');
    return [{ content: toolResult.slice(0, 2000), relevance: 'raw tool output' }];
  }
}

// ---------------------------------------------------------------------------
// Auto-select files from directory listing
// ---------------------------------------------------------------------------

function autoSelectFromListing(listing: string, goal: string): string[] {
  const goalLower = goal.toLowerCase();
  const lines = listing.split('\n').filter(l => l.trim().startsWith('['));
  const files: Array<{ name: string; isDir: boolean; size: string }> = [];

  for (const line of lines) {
    const match = line.match(/\[([^\]]+)\]\s+(\S+)/);
    if (!match) continue;
    const sizeOrType = match[1]!.trim();
    const name = match[2]!;
    files.push({ name, isDir: sizeOrType === 'dir', size: sizeOrType });
  }

  // Heuristic selection based on goal
  const selected: string[] = [];

  // Log analysis — pick .log files
  if (goalLower.includes('log') || goalLower.includes('error') || goalLower.includes('debug')) {
    const logFiles = files.filter(f => !f.isDir && (f.name.endsWith('.log') || f.name.includes('log')));
    if (logFiles.length > 0 && logFiles.length <= 5) {
      selected.push(...logFiles.map(f => f.name));
    }
  }

  // Config analysis — pick config files
  if (goalLower.includes('config') || goalLower.includes('setting')) {
    const configFiles = files.filter(f => !f.isDir && (
      f.name.endsWith('.json') || f.name.endsWith('.yaml') || f.name.endsWith('.yml') ||
      f.name.endsWith('.toml') || f.name.includes('config')
    ));
    if (configFiles.length > 0 && configFiles.length <= 5) {
      selected.push(...configFiles.map(f => f.name));
    }
  }

  // If goal mentions a specific filename pattern
  for (const f of files) {
    if (!f.isDir && goalLower.includes(f.name.toLowerCase())) {
      if (!selected.includes(f.name)) selected.push(f.name);
    }
  }

  return selected;
}
