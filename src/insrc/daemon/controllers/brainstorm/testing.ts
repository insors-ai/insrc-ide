/**
 * TestingBrainstormController -- brainstorm for test strategy.
 *
 * Produces a test strategy document (TST-DOC) with test groups
 * (G-001...), coverage matrix, fixtures, and flaky-risk notes.
 * Convergence clusters by test type. Saves to test/plans/ so it
 * flows naturally into the tester agent.
 */

import { BrainstormControllerBase } from './base.js';
import type { BrainstormCategory } from './types.js';

import {
  SEED_TESTING_SYSTEM, DIVERGE_TESTING_SYSTEM,
  REVIEW_IDEAS_TESTING_SYSTEM,
  CONVERGE_CLUSTER_TESTING_SYSTEM, CONVERGE_PROMOTE_TESTING_SYSTEM,
  REVIEW_TEST_GROUP_SYSTEM,
  buildGenerateTestGroupSystem, buildAssembleStrategySystem,
} from '../../../agent/tasks/brainstorm/prompts/testing.js';
import {
  registerSpecTemplate, registerThemeSpecTemplate,
} from '../../../agent/tasks/brainstorm/templates.js';

const TESTING_SPEC_TEMPLATE = `# Test Strategy -- {{doc_id}}

> **Target:** <what is being tested, one sentence>

## Executive Summary

<2-3 sentences: coverage approach, number of test groups, critical areas>

## Coverage Targets

| Area | Current | Target | Gap |
|------|---------|--------|-----|
| Unit tests | <current>% | <target>% | <gap> |
| Integration tests | <current>% | <target>% | <gap> |
| E2E tests | <current>% | <target>% | <gap> |

---

## G-001. <Test Group Name>

> <what this group tests -- one sentence>

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

\`\`\`typescript
// test setup / fixtures
\`\`\`

---

## Coverage Matrix

| Function/Module | Unit | Integration | E2E | Notes |
|----------------|------|-------------|-----|-------|
| <module> | yes | yes | -- | <note> |

## Risks

- <flaky test risk>
- <environment dependency risk>
`;

const TESTING_THEME_TEMPLATE = `### Test Cases

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | <scenario> | <input> | <expected> |

### Setup

- <fixture or mock requirement>

### Assertions

- [ ] <specific assertion>
`;

registerSpecTemplate('testing', TESTING_SPEC_TEMPLATE);
registerThemeSpecTemplate('testing', TESTING_THEME_TEMPLATE);

export class TestingBrainstormController extends BrainstormControllerBase {
  get category(): BrainstormCategory { return 'testing'; }

  getSeedPrompt(): string              { return SEED_TESTING_SYSTEM; }
  getDivergePrompt(): string           { return DIVERGE_TESTING_SYSTEM; }
  getReviewIdeasPrompt(): string       { return REVIEW_IDEAS_TESTING_SYSTEM; }
  getConvergeClusterPrompt(): string   { return CONVERGE_CLUSTER_TESTING_SYSTEM; }
  getConvergePromotePrompt(): string   { return CONVERGE_PROMOTE_TESTING_SYSTEM; }
  getThemeSpecPrompt(): string         { return buildGenerateTestGroupSystem(); }
  getReviewThemeSpecPrompt(): string   { return REVIEW_TEST_GROUP_SYSTEM; }
  getAssemblePrompt(): string          { return buildAssembleStrategySystem(); }
  getDocPrefix(): string               { return 'TST-DOC'; }
  getThemePrefix(): string             { return 'TST-TH'; }
  getSaveDir(): string                 { return 'test/plans'; }
  getConvergenceLabel(): string        { return 'test type'; }
  getIdeaGateTitle(): string           { return 'Scenario Review'; }
  getConvergenceGateTitle(): string    { return 'Test Group Review'; }
}
