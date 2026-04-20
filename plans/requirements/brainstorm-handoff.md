# Brainstorm handoff (stage 6)

Brainstorm's `finalize` step gains a "Hand off to Requirements" gate
action. When chosen: brainstorm saves its spec, then launches a new
chat session with the requirements agent, passing the finalized spec
as `input.brainstormSpec`. Requirements' `scope-analyze` seeds its
classification from the spec instead of asking cold.

## Files

| File | Change |
|---|---|
| `src/insrc/agent/tasks/brainstorm/steps.ts` | Finalize step: add a new `handoff-requirements` action alongside the existing save/download/exit actions. Handler writes the spec to disk then returns a `handoffRequirements` signal via state. |
| `src/insrc/agent/tasks/brainstorm/agent-state.ts` | Add optional `handoffRequest` field to `BrainstormState` so the runner can detect it at the terminal step. |
| `src/insrc/agent/framework/runner.ts` | After a run terminates, check for `state.handoffRequest`; if present, call the chat service to start a new session with the handoff payload. |
| `src/insrc/agent/framework/types.ts` | Extend `RunResult` with an optional `handoffRequest` field so the daemon / chat-service can act on it. |
| `src/insrc/daemon/chat-handler.ts` | On chat-start: accept an optional `initialPayload` that the framework runner passes to `initialState(input)`. |
| `src/vs/workbench/contrib/insrc/electron-sandbox/chatServiceImpl.ts` | When `runResult.handoffRequest` arrives over the stream, open a new session via `startSession(repoPath, { initialPayload: handoffRequest.payload })`. |

## Flow

```
brainstorm finalize step:
  EditorPane shows final spec
  User clicks "Hand off to Requirements"
    ↓
  Brainstorm writes spec to brainstorms/<spec-name>.{md,html}  (as today)
  Sets state.handoffRequest = {
    targetAgent: 'requirements',
    payload: {
      repoPath: ctx.repoPath,
      brainstormSpec: finalSpecContent,
      message: 'Continue requirements authoring from brainstorm spec',
    },
  }
  Returns next: null  (terminates)
    ↓
runner.ts detects handoffRequest; includes it in RunResult
    ↓
Daemon streams RunResult to IDE chat-service
    ↓
chatServiceImpl sees handoffRequest, calls:
  startSession(repoPath, { initialPayload: payload })
    → new chat session opened; first message auto-sent:
      "@requirements continue from brainstorm spec"
    → requirements agent's initialState(input) picks up
      input.brainstormSpec from the session's initial payload
    ↓
scope-analyze reads state.input.brainstormSpec; seeds classification
from its structure (feature count, domain keywords, enumerated
stories) rather than cold-starting.
```

## New gate action

In `brainstorm/steps.ts` finalize step, the actions array gains a
fourth entry:

```typescript
const actions: GateAction[] = [
  { name: 'save', label: 'Save spec' },
  { name: 'download', label: 'Download' },
  { name: 'handoff-requirements', label: 'Hand off to Requirements' },
  { name: 'exit', label: 'Close' },
];
```

Handler:

```typescript
if (reply.action === 'handoff-requirements') {
  // Save the spec first
  const specPath = await saveBrainstormSpec(state, ctx);

  return {
    state: {
      ...state,
      handoffRequest: {
        targetAgent: 'requirements',
        payload: {
          message: 'Continue requirements authoring from brainstorm spec',
          repoPath: ctx.repoPath,
          brainstormSpec: state.finalSpec,  // the finalized HTML/MD content
          brainstormSpecPath: specPath,     // for traceability
        },
      },
    },
    next: null,
  };
}
```

## Runner integration

`runner.ts` has a terminal branch that currently just returns the
final state. Add:

```typescript
// In runAgent, after the final step returns next: null
const result: RunResult = {
  result: finalState,
  artifacts: [...],
  // NEW:
  ...(finalState.handoffRequest
    ? { handoffRequest: finalState.handoffRequest }
    : {}),
};
```

`RunResult` type (in `framework/types.ts`) gains:

```typescript
interface RunResult {
  result: unknown;
  artifacts?: string[];
  handoffRequest?: {
    targetAgent: 'requirements' | string;  // extensible
    payload: Record<string, unknown>;
  };
}
```

Handoffs are generic by design -- no hardcoded enum. If a future
step hands off to the Planner agent, same mechanism applies.

## IDE-side: new session with initial payload

`chatService.startSession` gains an optional second parameter:

```typescript
interface IInsrcChatService {
  startSession(repoPath: string, opts?: { initialPayload?: Record<string, unknown> }): Promise<string>;
}
```

Implementation: if `opts.initialPayload` is provided, it's passed to
the daemon's `chat.start` RPC as `initialPayload`. Daemon-side, the
session pool stores it and passes it to the agent's `initialState(input)`
as part of the input object. The requirements agent's input shape
already includes `brainstormSpec` (see `agent-core.md`).

## Requirements agent -- scope-analyze seeding

In `requirements/steps.ts` `scopeAnalyze`:

```typescript
const seed = state.input.brainstormSpec
  ?? state.input.continuation
  ?? state.input.message;

// If brainstormSpec is present, the prompt is different:
const prompt = state.input.brainstormSpec
  ? buildScopeAnalyzeFromBrainstorm(state.input.brainstormSpec, relatedEntities)
  : buildScopeAnalyzeUser(state.input.message, relatedEntities);
```

`buildScopeAnalyzeFromBrainstorm` extracts the feature list from the
brainstorm spec (the spec already has a "Requirements" section with
promoted ideas), asks the LLM to decide whether the brainstorm's
feature count warrants a broad / extension / standalone classification,
and pre-populates `state.subEpics` from the brainstorm's promoted
feature list if `classification === 'broad'`.

The prompt carries the brainstorm's Problem + Requirements sections
verbatim so the LLM isn't guessing.

## Verification

- Run brainstorm end-to-end with a complex problem. At `finalize`,
  the gate shows 4 actions including "Hand off to Requirements".
- Click "Hand off to Requirements". Brainstorm saves its spec to
  `brainstorms/...` as usual, then a NEW chat session opens.
- The new session's first message reads "@requirements continue from
  brainstorm spec". The requirements agent runs.
- `scope-analyze` receives `state.input.brainstormSpec`; its prompt
  references the spec's content; `subEpics` pre-populated (bypasses
  `breakdown-draft` if the brainstorm already enumerated features).
- Round-trip: brainstorm-agent's `handoffRequest` persists through
  checkpoint/resume -- if the daemon restarts mid-handoff, the new
  session still opens on next connect.

## Commit boundary for stage 6

1. `RunResult.handoffRequest` type extension in `framework/types.ts`.
2. Runner picks up `state.handoffRequest` and surfaces in `RunResult`.
3. Daemon `chat.start` accepts `initialPayload`.
4. Session pool passes `initialPayload` into `initialState()`.
5. IDE chat-service gains `opts.initialPayload` on `startSession`.
6. Chat-service auto-opens a new session when `handoffRequest` is
   present in a completed run.
7. Brainstorm finalize step gains the fourth action + handler.
8. Requirements `scope-analyze` seeds from `input.brainstormSpec`.

## Open edge case

If the user kicks off multiple handoffs from concurrent brainstorm
sessions (unusual), each handoff creates its own requirements session.
Identify that this is fine -- sessions are independent, each writes
to its own REQ file (distinct titles -> distinct IDs). The
`requirements/_index.json` is updated atomically so interleaved
writes don't corrupt it.
