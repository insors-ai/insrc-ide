# Testing Brainstorm Category — Implementation Plan

## Goal

Create `TestingBrainstormController` — a sub-controller for brainstorming test strategies, scenarios, edge cases, and coverage plans. Output is a test strategy document with test groups, test cases, coverage targets, and fixture requirements.

## Flow

```
generate-ideas (local: test scenarios, edge cases, coverage gaps)
  → review-ideas (Claude: evaluate coverage, identify blind spots)
  → Scenario Review Gate (tabbed: Summary + Scenarios)
  → [loop or converge]
converge-cluster (local: group by test type — unit/integration/e2e/performance)
  → converge-promote (Claude: prioritize by risk, suggest fixtures)
  → Test Group Review Gate (tabbed: Summary + Test Groups with priority)
  → [per-group test planning]:
      generate-test-plan (local: test cases, expected behavior, setup)
      → review-test-plan (Claude: validate assertions, spot flaky patterns)
  → assemble-strategy (local: combine, add coverage matrix)
  → Presentation Gate (Preview + Save)
```

## Prompts — `src/agent/tasks/brainstorm/prompts/testing.ts`

| Prompt | Focus |
|--------|-------|
| `SEED_TESTING_SYSTEM` | Test scenarios, boundary conditions, error paths, integration points |
| `DIVERGE_TESTING_SYSTEM` | Edge cases, negative tests, performance scenarios, security tests |
| `REVIEW_IDEAS_TESTING_SYSTEM` | Coverage assessment, blind spot identification, flaky risk |
| `CONVERGE_CLUSTER_TESTING_SYSTEM` | Group by test type (unit/integration/e2e/performance/security) |
| `CONVERGE_PROMOTE_TESTING_SYSTEM` | Risk-based prioritization, fixture suggestions |
| `GENERATE_TEST_GROUP_SYSTEM` | Test cases with input/output, setup, teardown, assertions |
| `REVIEW_TEST_GROUP_SYSTEM` | Assertion completeness, isolation, flaky patterns |
| `ASSEMBLE_STRATEGY_SYSTEM` | Combine groups, add coverage matrix, identify gaps |

### Seed prompt key differences

```
- Focus on WHAT to test, not what to build
- Identify all code paths, branches, error conditions
- Reference specific functions/modules that need coverage
- Consider: happy path, error path, boundary, concurrent, performance
- Note which scenarios require mocks vs. real dependencies
```

### Claude review key differences

```
- Check: Are negative tests included?
- Check: Are assertions specific enough (not just "should work")?
- Check: Is test isolation maintained (no shared state)?
- Check: Are there timing-dependent tests that could flake?
- Check: Is performance test baseline defined?
```

## Templates

### `testing-spec.md`

```markdown
# Test Strategy — {{doc_id}}

> **Target:** <what is being tested, one sentence>

## Executive Summary

<2–3 sentences: coverage approach, number of test groups, critical areas>

## Coverage Targets

| Area | Current | Target | Gap |
|------|---------|--------|-----|
| Unit tests | <current>% | <target>% | <gap> |
| Integration tests | <current>% | <target>% | <gap> |
| E2E tests | <current>% | <target>% | <gap> |

---

## G-001. {{theme_id}} — <Test Group Name>

> <what this group tests — one sentence>

| Aspect | Detail |
|--------|--------|
| **Type** | unit / integration / e2e / performance |
| **Priority** | high / medium / low |
| **Fixtures** | <required test fixtures> |
| **Mocks** | <what needs mocking> |

### Test Cases

| # | Scenario | Input | Expected | Status |
|---|----------|-------|----------|--------|
| 1 | <scenario name> | <input description> | <expected outcome> | pending |
| 2 | <scenario name> | <input> | <expected> | pending |

### Setup

```typescript
// test setup / fixtures
```

---

## Coverage Matrix

| Function/Module | Unit | Integration | E2E | Notes |
|----------------|------|-------------|-----|-------|
| <module> | ✓ | ✓ | — | <note> |

## Risks

- <flaky test risk>
- <environment dependency risk>
```

### `testing-theme.md`

```markdown
### Test Cases

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | <scenario> | <input> | <expected> |

### Setup

- <fixture or mock requirement>

### Assertions

- [ ] <specific assertion>
```

## Controller — `src/daemon/controllers/brainstorm/testing.ts`

```typescript
export class TestingBrainstormController extends BrainstormControllerBase {
  get category() { return 'testing' as const; }

  getSeedPrompt()              { return SEED_TESTING_SYSTEM; }
  getDivergePrompt()           { return DIVERGE_TESTING_SYSTEM; }
  getReviewIdeasPrompt()       { return REVIEW_IDEAS_TESTING_SYSTEM; }
  getConvergeClusterPrompt()   { return CONVERGE_CLUSTER_TESTING_SYSTEM; }
  getConvergePromotePrompt()   { return CONVERGE_PROMOTE_TESTING_SYSTEM; }
  getThemeSpecPrompt()         { return GENERATE_TEST_GROUP_SYSTEM; }
  getReviewThemeSpecPrompt()   { return REVIEW_TEST_GROUP_SYSTEM; }
  getAssemblePrompt()          { return ASSEMBLE_STRATEGY_SYSTEM; }
  getSpecTemplate()            { return loadSpecTemplate('testing'); }
  getThemeSpecTemplate()       { return loadThemeSpecTemplate('testing'); }
  getDocPrefix()               { return 'TST-DOC'; }
  getThemePrefix()             { return 'TST-TH'; }
  getSaveDir()                 { return 'test/plans'; }
  getConvergenceLabel()        { return 'test type'; }
  getIdeaGateTitle()           { return 'Scenario Review'; }
  getConvergenceGateTitle()    { return 'Test Group Review'; }
}
```

## Key differences

| Aspect | Requirements | Testing |
|--------|-------------|---------|
| Seed focus | User needs | Test scenarios, edge cases |
| Convergence | Feature area | Test type (unit/integration/e2e) |
| Per-theme gen | Requirement + criteria | Test cases + setup + assertions |
| Claude review | Testability | Flaky patterns, assertion quality |
| IDs | REQ-DOC / REQ-TH | TST-DOC / TST-TH |
| Save dir | brainstorms/ | test/plans/ |
| Gate titles | Idea Review | Scenario Review |
| Output items | R-001 requirements | G-001 test groups |
| Downstream | Designer agent | Tester agent |

## Verification

1. "brainstorm test strategy for X" → classified as testing
2. Ideas focus on scenarios, not features
3. Convergence groups by test type
4. Per-group plans have test cases with input/expected/assertions
5. Final output has group IDs (G-001), coverage matrix
6. Saves to test/plans/ directory
