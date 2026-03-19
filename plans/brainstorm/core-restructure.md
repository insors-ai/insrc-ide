# Core Brainstorm Agent Restructure

## Goal

Extract the current monolithic `BrainstormController` (1098 lines) into:
- `BrainstormControllerBase` — abstract base with shared flow + 16 abstract hooks
- `RequirementsBrainstormController` — concrete sub-controller (current behavior, pure refactor)

No behavioral changes. Requirements brainstorm works exactly as before.

## Current State

`src/daemon/controllers/brainstorm.ts` contains everything:
- State management (initState, BrainstormState)
- Flow logic (dispatch, 15 after* methods)
- Task builders (12 build* methods)
- Gate content builders (buildIdeaTabs, buildThemeTabs)
- Helpers (applyGateComments, applyIdeaReview, stripFences, etc.)
- Hardcoded prompts imports (SEED_SYSTEM, DIVERGE_SYSTEM, etc.)
- Hardcoded ID prefixes (REQ-DOC, REQ-TH)
- Hardcoded save dir (brainstorms/)

## Target File Layout

```
src/daemon/controllers/
  brainstorm/
    index.ts                   ← re-exports, resolveController
    base.ts                    ← BrainstormControllerBase (abstract)
    requirements.ts            ← RequirementsBrainstormController
    types.ts                   ← BrainstormCategory type, CategoryHooks interface
```

## Phase 1: Define types and abstract base

### `brainstorm/types.ts`

```typescript
export type BrainstormCategory =
  | 'requirements'
  | 'design'
  | 'implementation'
  | 'testing'
  | 'general';
```

### `brainstorm/base.ts`

Extract from current controller. The base class contains:

**Kept as-is (shared flow):**
- `buildInitialTasks(input)` — calls `this.getSeedPrompt()` instead of `SEED_SYSTEM`
- `next(completed, gateReply, store)` — unchanged dispatch logic
- `finalize(store)` — unchanged
- `dispatch(step, completed, gateReply)` — unchanged switch statement
- All `after*` methods — unchanged (they call `this.build*Task()` which calls hooks)
- `buildIdeaTabs()` / `buildThemeTabs()` — unchanged
- `applyGateComments()` / `applyIdeaReview()` / `acceptAllProposed()` — unchanged
- `stripFences()` / `safeStringifySummary()` / `buildQnAContext()` / `recordQnA()` — stay as module-level helpers
- `initState()` — calls `this.getDocPrefix()` instead of hardcoded `REQ-DOC`

**Converted to abstract hooks (16 total):**

| Hook | Current hardcoded value | Used in |
|------|------------------------|---------|
| `get category()` | (none) | state, routing |
| `getSeedPrompt()` | `SEED_SYSTEM` | `buildGenerateIdeasTask()` |
| `getDivergePrompt()` | `DIVERGE_SYSTEM` | `buildGenerateIdeasTask()` |
| `getReviewIdeasPrompt()` | `REVIEW_IDEAS_SYSTEM` | `buildReviewIdeasTask()` |
| `getConvergeClusterPrompt()` | `CONVERGE_CLUSTER_SYSTEM` | `buildConvergeClusterTask()` |
| `getConvergePromotePrompt()` | `CONVERGE_PROMOTE_SYSTEM` | `buildConvergePromoteTask()` |
| `getThemeSpecPrompt()` | `buildGenerateThemeSpecSystem()` | `buildGenerateThemeSpecTask()` |
| `getReviewThemeSpecPrompt()` | `REVIEW_SPEC_SYSTEM` | `buildReviewThemeSpecTask()` |
| `getAssemblePrompt()` | `buildAssembleSpecSystem()` | `buildAssembleSpecTask()` |
| `getSpecTemplate()` | `loadSpecTemplate()` | `buildAssembleSpecTask()` |
| `getThemeSpecTemplate()` | `loadThemeSpecTemplate()` | `buildGenerateThemeSpecTask()` |
| `getDocPrefix()` | `'REQ-DOC'` | `initState()` |
| `getThemePrefix()` | `'REQ-TH'` | `afterConvergeCluster()` |
| `getSaveDir()` | `'brainstorms'` | `buildPresentationTask()` |
| `getConvergenceLabel()` | `'feature area'` | convergence prompts |
| `getIdeaGateTitle()` | `'Idea Review'` | `buildIdeaReviewGate()` |
| `getConvergenceGateTitle()` | `'Convergence Review'` | `buildValidateConvergenceTask()` |

**Task builders — stay in base, call hooks:**
- `buildGenerateIdeasTask()` — line 797: `systemPrompt: isFirstRound ? this.getSeedPrompt() : this.getDivergePrompt()`
- `buildReviewIdeasTask()` — line 811: `systemPrompt: this.getReviewIdeasPrompt()`
- `buildConvergeClusterTask()` — line 879: `systemPrompt: this.getConvergeClusterPrompt()`
- `buildConvergePromoteTask()` — line 899: `systemPrompt: this.getConvergePromotePrompt()`
- `buildGenerateThemeSpecTask()` — line 992: `systemPrompt: this.getThemeSpecPrompt()`
- `buildReviewThemeSpecTask()` — line 1007: `systemPrompt: this.getReviewThemeSpecPrompt()`
- `buildAssembleSpecTask()` — line 1034: `systemPrompt: this.getAssemblePrompt()`
- `buildPresentationTask()` — uses `this.getSaveDir()`
- All other build* methods — no prompt changes, stay as-is

## Phase 2: Create RequirementsBrainstormController

### `brainstorm/requirements.ts`

```typescript
import { BrainstormControllerBase } from './base.js';
import type { BrainstormCategory } from './types.js';
import {
  SEED_SYSTEM, DIVERGE_SYSTEM,
  CONVERGE_CLUSTER_SYSTEM, CONVERGE_PROMOTE_SYSTEM,
  buildGenerateThemeSpecSystem, buildAssembleSpecSystem,
  REVIEW_IDEAS_SYSTEM, REVIEW_SPEC_SYSTEM,
} from '../../agent/tasks/brainstorm/prompts.js';
import { loadSpecTemplate, loadThemeSpecTemplate } from '../../agent/tasks/brainstorm/templates.js';

export class RequirementsBrainstormController extends BrainstormControllerBase {
  get category(): BrainstormCategory { return 'requirements'; }

  getSeedPrompt() { return SEED_SYSTEM; }
  getDivergePrompt() { return DIVERGE_SYSTEM; }
  getReviewIdeasPrompt() { return REVIEW_IDEAS_SYSTEM; }
  getConvergeClusterPrompt() { return CONVERGE_CLUSTER_SYSTEM; }
  getConvergePromotePrompt() { return CONVERGE_PROMOTE_SYSTEM; }
  getThemeSpecPrompt() { return buildGenerateThemeSpecSystem(); }
  getReviewThemeSpecPrompt() { return REVIEW_SPEC_SYSTEM; }
  getAssemblePrompt() { return buildAssembleSpecSystem(); }
  getSpecTemplate() { return loadSpecTemplate(); }
  getThemeSpecTemplate() { return loadThemeSpecTemplate(); }
  getDocPrefix() { return 'REQ-DOC'; }
  getThemePrefix() { return 'REQ-TH'; }
  getSaveDir() { return 'brainstorms'; }
  getConvergenceLabel() { return 'feature area'; }
  getIdeaGateTitle() { return 'Idea Review'; }
  getConvergenceGateTitle() { return 'Convergence Review'; }
}
```

This is the entire requirements sub-controller — ~25 lines. All logic stays in the base.

## Phase 3: Update index.ts and resolveController

### `brainstorm/index.ts`

```typescript
export { BrainstormControllerBase } from './base.js';
export { RequirementsBrainstormController } from './requirements.js';
export type { BrainstormCategory } from './types.js';

// Default export for backward compat (resolveController uses this)
export { RequirementsBrainstormController as BrainstormController } from './requirements.js';
```

### `src/daemon/task.ts` — resolveController

```typescript
case 'brainstorm': {
  const mod = await import('./controllers/brainstorm/index.js');
  // TODO: resolve category from classification when sub-controllers are added
  controller = new mod.RequirementsBrainstormController();
  break;
}
```

## Phase 4: Category detection in decomposer

Add `category` to decomposer output and `ControllerInput.classification`:

### `src/agent/classifier/decompose.ts`

Add to the decomposer prompt:
```
- For brainstorm intents, also classify the brainstorm category:
  "requirements" (user needs, specs), "design" (architecture, components),
  "implementation" (coding approach, task breakdown), "testing" (test strategy,
  scenarios), or "general" (open exploration).
  Add a "category" field to the action.
```

### `src/daemon/task.ts` — ControllerInput

```typescript
interface ControllerInput {
  message: string;
  codeContext: string;
  classification?: {
    intent: string;
    confidence: number;
    category?: BrainstormCategory;  // ← NEW
  };
}
```

### `src/daemon/task.ts` — resolveController (final version)

```typescript
case 'brainstorm': {
  const category = classification?.category ?? 'general';
  const mod = await import('./controllers/brainstorm/index.js');
  switch (category) {
    case 'requirements':    return new mod.RequirementsBrainstormController();
    case 'design':          return new mod.DesignBrainstormController();
    case 'implementation':  return new mod.ImplementationBrainstormController();
    case 'testing':         return new mod.TestingBrainstormController();
    default:                return new mod.GeneralBrainstormController();
  }
}
```

## Execution Order

1. Create `brainstorm/types.ts` (1 type)
2. Create `brainstorm/base.ts` (move current controller, replace hardcoded values with abstract calls)
3. Create `brainstorm/requirements.ts` (16 hook implementations)
4. Create `brainstorm/index.ts` (re-exports)
5. Update `src/daemon/task.ts` resolveController import path
6. Delete old `src/daemon/controllers/brainstorm.ts`
7. Add category to decomposer + ControllerInput
8. `npx tsc --noEmit` — verify no type errors
9. Test: brainstorm session should work exactly as before (requirements category is default)

## Files

| File | Action |
|------|--------|
| `src/daemon/controllers/brainstorm/types.ts` | Create — BrainstormCategory |
| `src/daemon/controllers/brainstorm/base.ts` | Create — move from brainstorm.ts, abstractify |
| `src/daemon/controllers/brainstorm/requirements.ts` | Create — 16 hook implementations |
| `src/daemon/controllers/brainstorm/index.ts` | Create — re-exports |
| `src/daemon/controllers/brainstorm.ts` | Delete |
| `src/daemon/task.ts` | Update resolveController import |
| `src/agent/classifier/decompose.ts` | Add category to brainstorm actions |

## Verification

1. Type check passes
2. Brainstorm session produces same output as before
3. `RequirementsBrainstormController` is resolved for brainstorm intent
4. All 16 hooks return the same values as the current hardcoded prompts
