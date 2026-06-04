/**
 * Plan step — LLM generates a research plan from the user's question.
 *
 * Analyzes the question, identifies what tools/sources are needed,
 * and produces an ordered list of concrete actions.
 */

import type { AgentStep, StepResult, StepContext } from '../../../framework/types.js';
import type { ResearchState } from '../agent-state.js';
import type { ResearchPlan, PlanStep } from '../types.js';
import { getLogger } from '../../../../shared/logger.js';

const log = getLogger('research-plan');

const PLAN_SYSTEM = `You are a research planner for a coding assistant.
Given a user's question, create a plan to find the answer.

Available actions:
- read-file: Read a specific file (use for known paths)
- grep-search: Search file contents by regex pattern
- glob-search: Find files by name pattern
- graph-search: Semantic search over indexed code entities
- graph-sql: Read-only DuckDB SQL query against the code knowledge graph (tables: entity, relation, repo, plan, plan_step; relation kinds: CALLS, DEFINES, IMPORTS, INHERITS, IMPLEMENTS, DEPENDS_ON, EXPORTS, REFERENCES, CONTAINS, STEP_DEPENDS_ON)
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
- For log analysis: list-dir first, then grep for error patterns, then read relevant sections

Output ONLY valid JSON:
{
  "goal": "<restatement of the question as an achievable goal>",
  "approach": "<1-2 sentence strategy>",
  "steps": [
    { "id": 0, "action": "<action>", "target": "<what to act on>", "reason": "<why>" }
  ]
}`;

export const planStep: AgentStep<ResearchState> = {
  name: 'plan',
  async run(state: ResearchState, ctx: StepContext): Promise<StepResult<ResearchState>> {
    const question = state.input.question;
    let fileRefs = state.input.fileRefs;

    // Extract inline file/dir paths from the question if fileRefs is empty
    if (fileRefs.length === 0) {
      const pathPattern = /(?:^|\s)((?:\/[\w./-]+|~\/[\w./-]+|\.\/[\w./-]+|[\w./-]+\/[\w./-]+)(?:\.\w+)?)/g;
      let match;
      while ((match = pathPattern.exec(question)) !== null) {
        const path = match[1]!.trim();
        if (path.includes('/') && !fileRefs.includes(path)) {
          fileRefs.push(path);
        }
      }
    }

    // Build context for the planner — prioritize explicit paths
    let context = `Question: ${question}`;
    if (fileRefs.length > 0) {
      context += `\n\nEXPLICIT FILE/DIRECTORY REFERENCES (use these paths directly in your plan):\n${fileRefs.map(r => `  - ${r}`).join('\n')}`;
    }

    ctx.progress('Planning research approach...');

    const response = await ctx.providers.resolve('research', 'plan').complete([
      { role: 'system', content: PLAN_SYSTEM },
      { role: 'user', content: context },
    ], { maxTokens: 1024, temperature: 0 });

    let plan: ResearchPlan;
    try {
      // Strip markdown fences if present
      const text = response.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(text) as { goal: string; approach: string; steps: Array<{ id: number; action: string; target: string; reason: string }> };
      plan = {
        goal: parsed.goal,
        approach: parsed.approach,
        steps: parsed.steps.map((s, i) => ({
          id: i,
          action: s.action as PlanStep['action'],
          target: s.target,
          reason: s.reason,
          status: 'pending' as const,
        })),
      };
      log.info({ goal: plan.goal, stepCount: plan.steps.length }, 'research plan created');
    } catch (err) {
      // Fallback: single-step plan
      log.warn({ error: (err as Error).message }, 'failed to parse plan, using fallback');
      plan = {
        goal: `Answer: ${question}`,
        approach: 'Direct investigation',
        steps: fileRefs.length > 0
          ? fileRefs.map((ref, i) => ({
              id: i,
              action: 'read-file' as const,
              target: ref,
              reason: 'File referenced in question',
              status: 'pending' as const,
            }))
          : [{
              id: 0,
              action: 'graph-search' as const,
              target: question,
              reason: 'Search code for relevant entities',
              status: 'pending' as const,
            }],
      };
      // Always end with analyze
      plan.steps.push({
        id: plan.steps.length,
        action: 'analyze',
        target: 'findings',
        reason: 'Synthesize results',
        status: 'pending',
      });
    }

    ctx.progress(`Research plan: ${plan.steps.length} steps -- ${plan.approach}`);

    return {
      state: {
        ...state,
        plan,
        currentPlanStep: 0,
      },
      next: 'investigate',
    };
  },
};
