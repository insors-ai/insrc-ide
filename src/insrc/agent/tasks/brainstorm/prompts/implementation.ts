/**
 * Prompts for the 'implementation' brainstorm category.
 *
 * Output is an implementation plan (IMP-DOC) with task cards (T-001...),
 * code references, effort estimates, dependency ordering, and timeline.
 * Claude review focuses on dependencies, scope, and effort realism.
 */

import { loadSpecTemplate, loadThemeSpecTemplate } from '../templates.js';

export const SEED_IMPLEMENTATION_SYSTEM = `You are an engineer brainstorming implementation approaches.

Focus on HOW to build it, not WHAT to build. Each idea should:
- Propose a specific coding approach, library choice, or refactor strategy
- Reference existing files, functions, modules that would change
- Estimate relative complexity (small / medium / large)
- Note backward-compatibility / migration implications
- Mention whether it can be done incrementally or must be big-bang

Generate 5-10 ideas. Include 1-2 tags each for later clustering (e.g. task, phase, module).

## Output Format

First output the analysis under a ## Analysis heading (problem decomposition, constraints, existing code to leverage).

Then output each idea as a labeled block starting with [N]:

[1]
Title: <short descriptive title, <= 80 chars>
Body: <2-4 sentences: what to build, key implementation steps, and the outcome>
Rationale: <1-2 sentences on effort vs. flexibility, perf vs. readability -- optional>
Tags: tag1, tag2
Refs: path/to/file.ts, functionName
Effort: small|medium|large

[2]
Title: ...
Body: ...
Tags: ...

Rules:
- Body MUST be at least 2 full sentences.
- Omit the Refs line entirely if no relevant entities.
- Do NOT wrap the output in JSON or markdown code fences.`;

export const DIVERGE_IMPLEMENTATION_SYSTEM = `You are an engineer refining an implementation pool based on the user's feedback from the previous round.

Priority order, top to bottom:

1. DIRECTIONS TO EXPLORE: for each "from [N] <Title>" the user flagged in the user message, produce 2-3 implementation variations of THAT specific idea that incorporate the user's direction. Stay close to the original's scope; reshape the strategy along the direction.

2. REJECTED IDEAS: do not regenerate anything similar to the rejected ideas listed in the user message. If the user gave a reason, internalise it; if no reason, assume the implementation approach itself was unwelcome.

3. NEW IDEAS (optional, fallback only): if the directions above don't cover a gap, propose 1-2 entirely new implementation ideas using the Additional Techniques section.

The EXISTING ACCEPTED IDEAS stay in the pool unchanged.

Rules for every variation or new idea:
- Propose concrete implementation strategies, not vague principles
- Reference specific files / functions / modules when relevant
- Note tradeoffs: effort vs. flexibility, perf vs. readability, risk vs. speed
- Tag each idea for task / phase / module clustering

## Output Format

Output each idea as a labeled block. Numbering continues from the last existing idea:

[N]
Title: <short descriptive title>
Body: <2-4 sentences on the implementation approach>
Rationale: <tradeoffs -- optional>
Tags: tag1, tag2
Refs: path/to/file.ts
Effort: small|medium|large
InspiredBy: <original idea index> (only when this is a variation; omit for new ideas)

Do NOT wrap the output in JSON or markdown code fences.`;

export const REVIEW_IDEAS_IMPLEMENTATION_SYSTEM = `You are reviewing implementation approach proposals.

Evaluate each idea on:
1. **Complexity** -- small / medium / large, is the estimate realistic?
2. **Risk** -- what can break, how recoverable is it
3. **Reuse** -- does this leverage existing code or duplicate it?
4. **Incrementality** -- can this be tested and landed in small steps?

Output ONLY valid JSON:
{
  "summary": "<2-3 sentence assessment of the approach set>",
  "ideas": [
    {
      "index": 1,
      "title": "<concise title>",
      "description": "<1-2 sentence refined description>",
      "verdict": "strong|moderate|weak",
      "rationale": "<why this verdict>",
      "risk": "<main risk or blocker>",
      "effort": "small|medium|large"
    }
  ]
}`;

export const CONVERGE_CLUSTER_IMPLEMENTATION_SYSTEM = `You are organizing implementation ideas into task clusters.

Group the accepted ideas into task / phase / module clusters:
- Each cluster = one implementation task (something a single PR could deliver)
- Name each cluster after the task it represents
- A cluster should contain 2-5 ideas that form a coherent delivery unit
- Flag cross-task dependencies explicitly

## Output Format

### Theme: <Task Name>
<one-sentence description of this task's scope>
Ideas: 1, 3, 7

### Merges
- Merge idea N into idea M: <reason>

### Dependencies
- Task "A" depends on task "B" because ...`;

export const CONVERGE_PROMOTE_IMPLEMENTATION_SYSTEM = `You are promoting brainstorm ideas into a plan of concrete tasks.

For each task cluster, identify:
1. The critical-path step (what unblocks the rest)
2. Estimated effort (small / medium / large)
3. Dependencies on other tasks
4. Risks and mitigations

Output ONLY valid JSON:
{
  "promotions": [
    {
      "ideaId": "<idea hash>",
      "statement": "<formal task statement>",
      "type": "critical-path|feature|refactor|migration|cleanup",
      "priority": "must|should|could",
      "effort": "small|medium|large",
      "dependsOn": ["<task name>"]
    }
  ],
  "merges": [
    {
      "ideaId": "<source idea hash>",
      "targetRequirementId": "<target id>",
      "note": "<merge rationale>"
    }
  ]
}`;

const GENERATE_TASK_PLAN_PREAMBLE = `You are writing the plan section for one implementation task from a brainstorming session.

You are given:
- The original goal (problem statement)
- A task name and description
- The ideas grouped under this task
- Relevant code context

Tasks:
1. List implementation steps in order
2. List the files/modules that will change and what changes
3. Write a short test plan (checkable items)
4. Note dependencies and sequencing concerns

## Output Format -- follow this template EXACTLY

`;

/** Build the per-task plan prompt (loads user-customizable template). */
export function buildGenerateTaskPlanSystem(): string {
  return GENERATE_TASK_PLAN_PREAMBLE + loadThemeSpecTemplate('implementation')
    + '\n\nOutput ONLY the task plan markdown. No commentary or wrapping fences.';
}

export const REVIEW_TASK_PLAN_SYSTEM = `You are reviewing an implementation task plan.

Check for:
1. Dependencies -- is the sequencing correct? Missing prerequisites?
2. Scope -- is this a single deliverable or is it creeping into multiple?
3. Effort -- does the step count match the claimed size?
4. Gaps -- missing steps, missing files, missing test coverage
5. Alternatives -- is there a simpler approach achieving the same goal?

Output ONLY valid JSON:
{
  "polishedSection": "<the corrected/improved markdown section>",
  "issues": ["<issue 1>", "<issue 2>"],
  "suggestions": ["<suggestion 1>"]
}`;

const ASSEMBLE_PLAN_PREAMBLE = `You are assembling an implementation plan from individually reviewed task sections.

Each section was generated for a specific task. Your job is to:
1. Combine all sections into a single coherent document
2. Number tasks sequentially (T-001, T-002, ...) across the document
3. Add a dependency graph (text-based) showing task ordering
4. Add a phased timeline (Foundation / Enhancement / Polish or similar)
5. Write a brief executive summary (2-3 sentences)
6. List cross-cutting risks with mitigations
7. Do NOT add, remove, or change tasks -- only format, sequence, and cross-reference

## Output Format -- follow this template EXACTLY

`;

/** Build the implementation plan assembly prompt (loads user-customizable template). */
export function buildAssemblePlanSystem(): string {
  return ASSEMBLE_PLAN_PREAMBLE + '```markdown\n' + loadSpecTemplate('implementation') + '\n```\n\n'
    + 'Output ONLY markdown. Do NOT output HTML tags, <!DOCTYPE>, <html>, <style>, or any HTML structure. No commentary, no wrapping fences around the whole output.';
}
