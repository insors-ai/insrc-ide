# Integrate Task Model into Brainstorm Controller with Typed State

## Context

The BrainstormController (`src/daemon/controllers/brainstorm.ts`) has two problems:
1. **No `userMessage`** on tasks — `executeLlmTask` falls back to `task.description` ("Seed Ideas Review") as the embedding query for ContextManager, retrieving irrelevant code context. The LLM explains brainstorm source code instead of brainstorming.
2. **Generic `TaskStateStore`** — the controller uses untyped `Map<string, unknown>` instead of the rich `BrainstormState` with typed `Idea[]`, `Theme[]`, `SpecRequirement[]`.

Meanwhile, the brainstorm agent steps (`src/agent/tasks/brainstorm/steps.ts`) have rich implementations with dedicated prompts, structured parsing, and typed state — but are **dead code** because the chat handler routes through the controller pipeline, not `runAgent()`.

**Design:** Steps emit Task objects for execution. The controller manages flow, uses `BrainstormState` internally, and delegates LLM execution to the existing task pipeline (which uses ContextManager for memory/context assembly). The controller is embedded in the agent — classification output flows in, the controller drives the step→task→execute→parse→next cycle.

## Approach

### 1. Extend `Task` interface — `src/daemon/task.ts`

Add three fields to support brainstorm (and future controller) needs:

```typescript
// In Task interface:
gateActions?: GateActionDef[] | undefined;  // custom gate actions (override approve/reject/edit)
gateTitle?: string | undefined;             // custom gate title (override task.description)
providerHint?: 'local' | 'claude' | undefined;  // which LLM provider to use
```

Add `GateActionDef` type:
```typescript
interface GateActionDef { name: string; label: string; hint?: string; needsInput?: boolean }
```

### 2. Update `gateTaskResult` — `src/daemon/task.ts:605`

Use `task.gateActions` if present instead of hardcoded approve/reject/edit:
```typescript
const actions = task.gateActions ?? [
  { name: 'approve', label: 'Approve' },
  { name: 'reject', label: 'Reject' },
  ...(task.cyclic ? [{ name: 'edit', label: 'Edit', needsInput: true }] : []),
];
const title = task.gateTitle ?? task.description;
```

### 3. Update `executeLlmTask` — `src/daemon/task.ts:1077`

Use `task.providerHint` to select provider:
```typescript
const provider = task.providerHint === 'claude' && session.claudeProvider
  ? session.claudeProvider
  : session.ollamaProvider;
const response = await provider.complete(messages, { maxTokens: 4096 });
```

### 4. Rewrite `BrainstormController` — `src/daemon/controllers/brainstorm.ts`

**Internal typed state:** Controller maintains `private state: BrainstormState` alongside the `TaskStateStore`. Syncs to store via `store.set('brainstormState', this.state)` for checkpointing.

**`buildInitialTasks(input)`:** Initializes `BrainstormState` from `ControllerInput`, returns seed task with:
- `userMessage`: the actual user prompt (from `input.message`)
- `systemPrompt`: `SEED_SYSTEM` from `prompts.ts`
- `kind: 'llm'` — lets `executeLlmTask` use ContextManager for full L1-L5 context assembly

**`next(completed, gateReply, store)`:**
1. Parses `completed.output` into typed data using existing parsers from `ideas.ts` (`parseIdeaList`), `convergence.ts` (`parseClusterOutput`), `spec-builder.ts`
2. Merges parsed data into `this.state`
3. Records QnA entry for the completed step (and gate reply if present)
4. Flow decision (same state machine as current controller)
5. Builds next Task(s) with proper `userMessage`, `systemPrompt`, `gateActions`, `providerHint`

**Task building per step:**

| Step | kind | systemPrompt | userMessage | gate |
|------|------|-------------|-------------|------|
| seed | llm | `SEED_SYSTEM` | `input.message` | — |
| validate-seed | transform | — | formatted ideas from `this.state` | approve/select/reframe |
| diverge | llm | `DIVERGE_SYSTEM` | user prompt + technique instructions + QnA context | — |
| react | transform | — | formatted round ideas | approve/select/focus/converge |
| converge-cluster | llm | `CONVERGE_CLUSTER_SYSTEM` | accepted ideas summary | — |
| converge-promote | llm (claude) | `CONVERGE_PROMOTE_SYSTEM` | ideas + themes | — |
| validate-convergence | transform | — | formatted themes + proposals | approve/edit/diverge |
| update-spec | llm | `UPDATE_SPEC_SYSTEM` | current spec + promotions | — |
| review-spec | transform | — | rendered spec markdown | approve/edit/continue |
| finalize | transform | `FINALIZE_SYSTEM` | full state summary | save gate |

- **`llm` tasks** → `executeLlmTask` runs ContextManager assembly (L1-L5) using `userMessage` as embedding query, overrides system prompt
- **`transform` tasks** → `executeLlmTask` skips ContextManager, uses content directly (for gates that display formatted state)
- **`providerHint: 'claude'`** on converge-promote and optionally update-spec

**Reuse from `src/agent/tasks/brainstorm/`:**
- `prompts.ts` — all system prompts (`SEED_SYSTEM`, `DIVERGE_SYSTEM`, etc.)
- `ideas.ts:parseIdeaList()` — parse seed/diverge LLM output into `Idea[]`
- `ideas.ts:selectTechniques()` — creativity techniques for diverge userMessage
- `convergence.ts` — `parseClusterOutput()`, `parsePromotionOutput()`
- `spec-builder.ts` — `parseSpecUpdate()`, `renderSpecMarkdown()`, `detectConflicts()`
- `context-builder.ts:formatIdeasForContext()`, `formatThemesForContext()`, `formatGaps()`, `compressRound()` — for building gate content from typed state
- `assembly.ts:assembleDocument()` — finalize output

### 5. Pass classification to controller — `src/daemon/chat-handler.ts`

Extend `ControllerInput` (task.ts:176) with optional classification:
```typescript
interface ControllerInput {
  message: string;
  codeContext: string;
  classification?: { intent: string; confidence: number; keywords?: string[] };
}
```

In `executeAgentTask` (task.ts:1141), pass the classification from the chat handler through to the controller input. The controller stores it in `BrainstormState.input.classification` for the seed step to use in search planning.

### 6. Add QnA tracking to `BrainstormState` — `src/agent/tasks/brainstorm/agent-state.ts`

Track semantic QnA pairs across the session — what the system asked/showed the user and what the user responded. This gives subsequent steps (diverge, converge, spec) full context of user intent and direction.

```typescript
interface BrainstormQnA {
  step: string;
  round: number;
  /** Who initiated — 'user' if user asked/directed, 'system' if system presented for review. */
  source: 'user' | 'system';
  question: string;
  answer: string;
  timestamp: string;
}
```

Add to `BrainstormState`:
```typescript
/** Semantic QnA pairs — tracks all user interactions across the session. */
qna: BrainstormQnA[];
```

**Recording points** (in `next()` when processing gate replies, LLM results, and user input):
- **User questions/input**: Q = user's message or gate feedback text, A = system's response (LLM output or gate content shown). Captured when gate feedback contains substantive text beyond just an action name.
- **Gate exchanges**: Q = gate content shown to user (seed ideas, themes, spec), A = user's action + feedback (e.g., "reframe: focus on performance", "select: accept 1,3 reject 2")
- **LLM results**: Q = what prompted the LLM (step description + key context), A = key output summary (e.g., "5 seed ideas generated", "3 themes identified")

**Usage in subsequent tasks**: The controller includes relevant QnA entries in `userMessage` for LLM tasks so the model has context on user preferences, questions, direction changes, and prior feedback. For example, the diverge task includes prior user questions and gate feedback to steer idea generation. This replaces the ad-hoc `recentFeedback` field.

### 7. Update `BrainstormState` and types

Add `classification` to `BrainstormState.input` (`agent-state.ts`) and `BrainstormInput` (`types.ts`).

Add `lastStep: string` to `BrainstormState` to track flow (currently tracked via `TaskStateStore` key `K.LAST_STEP`).

## Files

| File | Change |
|------|--------|
| `src/daemon/task.ts` | Add `gateActions`, `gateTitle`, `providerHint`, `GateActionDef` to Task. Update `gateTaskResult` and `executeLlmTask`. Add `classification?` to `ControllerInput`. |
| `src/daemon/controllers/brainstorm.ts` | Full rewrite — typed `BrainstormState`, rich task builders using `prompts.ts`, result parsing using `ideas.ts`/`convergence.ts`/`spec-builder.ts`, QnA tracking |
| `src/agent/tasks/brainstorm/types.ts` | Add `classification?` to `BrainstormInput` |
| `src/agent/tasks/brainstorm/agent-state.ts` | Add `classification?` to input, add `lastStep`, add `qna: BrainstormQnA[]`, add `BrainstormQnA` interface |
| `src/agent/tasks/brainstorm/ideas.ts` | Export `parseIdeaList` if not already exported |
| `src/agent/tasks/brainstorm/convergence.ts` | Export parsing functions if not already exported |

## Key details

- **ContextManager IS the memory** — `executeLlmTask` already runs full L1-L5 assembly for `kind: 'llm'` tasks (session summary, semantic history, code graph). No ad-hoc prompts needed.
- **The fix is `userMessage`** — setting it to the actual user prompt means ContextManager's embedding query retrieves relevant code entities, not brainstorm controller source
- **`transform` tasks bypass ContextManager** — used for gate display tasks that show formatted state (ideas list, spec markdown)
- **Parsing stays in agent modules** — controller imports from `ideas.ts`, `convergence.ts`, `spec-builder.ts` rather than reimplementing
- **`steps.ts` stays as-is** — kept for potential CLI-only agent framework path, but not the primary execution path
- **QnA history** feeds into LLM tasks — the controller appends relevant QnA entries to `userMessage` so LLM steps have context on user preferences, direction changes, and prior feedback. This replaces the ad-hoc `recentFeedback` field.

## Verification

1. `npx tsc --noEmit` — no type errors
2. Start daemon, send brainstorm prompt via VS Code chat
3. Daemon logs: verify `controlled pipeline starting` with `controller: brainstorm`
4. Verify seed task uses actual user message (not "Searching codebase..."): check `ollama request` log for correct `userMessage`
5. Verify gate appears with custom actions (approve/select/reframe, not generic approve/reject)
6. Verify full diverge→converge flow with typed state (ideas parsed, themes clustered)
7. Verify QnA entries accumulate across steps and feed into subsequent LLM task userMessages
8. Verify final document rendered and turn persisted
