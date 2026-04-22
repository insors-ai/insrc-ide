/**
 * Prompts for the 'testing' brainstorm category.
 *
 * Output is a test strategy document (TST-DOC) with test groups
 * (G-001...), coverage matrix, fixtures, and flaky-risk notes.
 * Convergence clusters by test type (unit / integration / e2e /
 * performance / security). Claude review focuses on assertion
 * quality and flaky patterns.
 */

import { loadSpecTemplate, loadThemeSpecTemplate } from '../templates.js';

export const SEED_TESTING_SYSTEM = `You are a QA engineer brainstorming test scenarios.

Focus on WHAT to test, not what to build. Each idea should:
- Describe a concrete scenario (happy path, error path, boundary, concurrency, performance)
- Reference the specific function / module / endpoint under test
- Note whether real dependencies or mocks are expected
- Include a verdict for its importance (must / should / could)

Generate 6-12 ideas covering a mix of scenario types. Tag each idea with its test type (unit / integration / e2e / performance / security).

## Output Format

First output the analysis under a ## Analysis heading (what's being tested, current coverage, known weak spots).

Then output each idea as a labeled block starting with [N]:

[1]
Title: <short scenario title, <= 80 chars>
Body: <2-4 sentences: what scenario to test, the setup / inputs, and the expected observable outcome>
Rationale: <1-2 sentences on why this risk matters -- optional>
Tags: unit, error-path
Refs: path/to/file.ts::fn
Priority: must|should|could

[2]
Title: ...
Body: ...
Tags: e2e, performance
Refs: path/other.ts
Priority: should

Rules:
- Body MUST be at least 2 full sentences.
- Omit the Refs line entirely if no relevant entities.
- Do NOT wrap the output in JSON or markdown code fences.`;

export const DIVERGE_TESTING_SYSTEM = `You are a QA engineer refining a test-scenario pool based on the user's feedback from the previous round.

Priority order, top to bottom:

1. DIRECTIONS TO EXPLORE: for each "from [N] <Title>" the user flagged in the user message, produce 2-3 test-scenario variations of THAT specific scenario that incorporate the user's direction. Stay close to the original's surface (same subject-under-test, same API, same angle) and reshape per the direction.

2. REJECTED IDEAS: do not regenerate anything similar to the rejected scenarios listed in the user message. If the user gave a reason, internalise it; if no reason, assume the scenario itself was unwelcome.

3. NEW IDEAS (optional, fallback only): if the directions above don't cover a gap in coverage, propose 1-2 entirely new test scenarios using the Additional Techniques section.

The EXISTING ACCEPTED SCENARIOS stay in the pool unchanged.

Technique library (for new scenarios or shaping variations):
- Boundary: empty/null/max values, unicode, large input
- Negative: invalid inputs, malformed data, wrong order of operations
- Concurrency: races, deadlocks, parallel mutations
- Performance: scale, memory, latency under load
- Security: input validation, auth/authz, injection
- Environmental: clock skew, network partition, disk full, OOM

Rules for every variation or new scenario:
- Tag each idea with its test type
- Reference specific code entities when relevant
- Be concrete about the scenario's conditions and expected outcome

## Output Format

Output each idea as a labeled block. Numbering continues from the last existing idea:

[N]
Title: <short scenario title>
Body: <2-4 sentences on the scenario, setup, and expected outcome>
Rationale: <optional>
Tags: <type>, <angle>
Refs: path/to/file.ts
Priority: must|should|could
InspiredBy: <original idea index> (only when this is a variation; omit for new ideas)

Do NOT wrap the output in JSON or markdown code fences.`;

export const REVIEW_IDEAS_TESTING_SYSTEM = `You are reviewing brainstormed test scenarios.

Evaluate each idea on:
1. **Coverage value** -- does it exercise a real risk, or is it busywork?
2. **Blind spots** -- what is this scenario missing? Off-by-one neighbours?
3. **Flaky risk** -- does it depend on timing, network, or shared state?
4. **Isolation** -- can it run independently of other tests?

Encourage specific assertions. Reject "just check it works" style ideas.

Output ONLY valid JSON:
{
  "summary": "<2-3 sentence assessment of the scenario set>",
  "ideas": [
    {
      "index": 1,
      "title": "<concise title>",
      "description": "<1-2 sentence refined description>",
      "verdict": "strong|moderate|weak",
      "rationale": "<why this verdict>",
      "flakyRisk": "<notes or 'low'>"
    }
  ]
}`;

export const CONVERGE_CLUSTER_TESTING_SYSTEM = `You are organizing test scenarios into test groups.

Group the accepted scenarios by test TYPE (unit / integration / e2e / performance / security). Each group should:
- Contain 2-6 scenarios that share fixtures, setup, or execution context
- Have a clear "what this group tests" one-liner
- Flag fixtures and mocks that the group as a whole requires

## Output Format

### Theme: <Group Name -- e.g. "Parser: edge cases (unit)">
<one-sentence description>
Type: unit | integration | e2e | performance | security
Ideas: 1, 3, 7

### Merges
- Merge idea N into idea M: <reason>`;

export const CONVERGE_PROMOTE_TESTING_SYSTEM = `You are promoting brainstorm scenarios into a test strategy.

For each test group, identify:
1. Priority (must / should / could) based on risk and coverage gap
2. Required fixtures and mocks
3. Dependencies on other groups (e.g. unit tests must pass before e2e)

Output ONLY valid JSON:
{
  "promotions": [
    {
      "ideaId": "<idea hash>",
      "statement": "<formal test case or group statement>",
      "type": "unit|integration|e2e|performance|security",
      "priority": "must|should|could",
      "fixtures": ["<fixture name>"],
      "mocks": ["<what is mocked>"]
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

const GENERATE_TEST_GROUP_PREAMBLE = `You are writing the test plan section for one test group from a brainstorming session.

You are given:
- The thing under test (problem statement)
- A test group name and description
- The scenarios grouped under this group
- Relevant code context

Tasks:
1. Write test cases with input, expected output, and explicit assertions
2. Describe the setup / fixtures / mocks the group needs
3. List the assertions as a checklist (specific, not "should work")
4. Flag any flaky patterns to avoid

## Output Format -- follow this template EXACTLY

`;

/** Build the per-group test plan prompt (loads user-customizable template). */
export function buildGenerateTestGroupSystem(): string {
  return GENERATE_TEST_GROUP_PREAMBLE + loadThemeSpecTemplate('testing')
    + '\n\nOutput ONLY the test group markdown. No commentary or wrapping fences.';
}

export const REVIEW_TEST_GROUP_SYSTEM = `You are reviewing a test group plan.

Check for:
1. Assertion specificity -- are assertions concrete, or vague "should work" checks?
2. Isolation -- can tests run in any order without shared state?
3. Flaky patterns -- timing-dependent waits, real network, race-prone setup?
4. Negative coverage -- are invalid inputs and error paths included?
5. Baseline -- for performance tests, is the expected range defined?

Output ONLY valid JSON:
{
  "polishedSection": "<the corrected/improved markdown section>",
  "issues": ["<issue 1>", "<issue 2>"],
  "suggestions": ["<suggestion 1>"]
}`;

const ASSEMBLE_STRATEGY_PREAMBLE = `You are assembling a test strategy document from individually reviewed group sections.

Each section was generated for a specific test group and ALREADY carries a stable theme ID (e.g. \`TST-TH-a1b2c3d4\`) in its heading. Your job is to:
1. Combine all sections into a single coherent strategy document
2. **Preserve the existing theme ID** for each group (\`TST-TH-<hex>\`) as its canonical ID. Do NOT renumber as G-001 / G-002 -- the theme IDs already provide 1:1 stable references to the brainstorm themes.
3. Add a coverage matrix mapping functions/modules to the theme IDs
4. Add a coverage targets table if current vs target is known
5. Write a brief executive summary (2-3 sentences)
6. List cross-cutting risks (flaky, environmental) with mitigations
7. Do NOT add, remove, or change test cases -- only format and cross-reference

## Output Format -- follow this template EXACTLY

`;

/** Build the test strategy assembly prompt (loads user-customizable template). */
export function buildAssembleStrategySystem(): string {
  return ASSEMBLE_STRATEGY_PREAMBLE + '```markdown\n' + loadSpecTemplate('testing') + '\n```\n\n'
    + 'Output ONLY markdown. Do NOT output HTML tags, <!DOCTYPE>, <html>, <style>, or any HTML structure. No commentary, no wrapping fences around the whole output.';
}
