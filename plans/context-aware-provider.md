# Plan: Context-Aware Provider (Unified Memory for All LLM Calls)

## Problem

Only 2 of ~74 LLM calls go through the context manager. Agent steps, tool loops, classifiers, decomposers, validators — all bypass the memory framework. This means:
- No conversation history in agent steps
- No cross-provider context sync (Ollama and Claude have separate views)
- Callers manually build messages, duplicating context assembly logic
- No automatic turn recording — callers must call `recordTurn()` manually

## Solution

Embed context assembly into the LLM provider itself. A `ContextAwareProvider` wraps any base provider (Ollama, Claude) and automatically:
1. Injects L1-L5 context before the caller's messages
2. Records the turn after the response
3. Uses a shared `ContextManager` per session (single source of truth)

```
Session
  └── ContextManager (shared state)
        ├── L1 system, L2 summary, L3a recent, L3b semantic, L4 code
        │
        ├── localProvider = ContextAwareProvider(OllamaProvider, ctx, 16K budget)
        └── claudeProvider = ContextAwareProvider(ClaudeProvider, ctx, 200K budget)
```

## ContextAwareProvider

### Interface

Same `LLMProvider` interface — drop-in replacement:

```typescript
class ContextAwareProvider implements LLMProvider {
  constructor(
    private base: LLMProvider,
    private ctx: ContextManager,
    private budgetTokens: number,
    private opts: {
      /** If true, auto-record turns (default true). Set false for internal calls like classification. */
      autoRecord?: boolean;
      /** If true, include L4 code context (default true). Set false for non-code queries. */
      includeCodeContext?: boolean;
      /** Label for logging ("local" or "claude") */
      label?: string;
    }
  ) {}

  async complete(messages: LLMMessage[], opts?: CompletionOpts): Promise<LLMResponse> {
    // 1. Extract user message from caller's messages
    const userMessage = extractLastUserMessage(messages);

    // 2. Assemble context (L1-L5) using the shared context manager
    const embedding = await this.ctx.embedQuery(userMessage);
    const assembled = await this.ctx.assemble(userMessage, embedding);

    // 3. Build enriched messages: context layers + caller's messages
    const enriched = this.buildEnrichedMessages(assembled, messages);

    // 4. Call base provider with enriched messages
    const response = await this.base.complete(enriched, opts);

    // 5. Auto-record turn (unless disabled)
    if (this.opts.autoRecord !== false && userMessage && response.text) {
      const turn = { userMessage, assistantResponse: response.text, entityIds: this.ctx.getLastEntityIds() };
      await this.ctx.recordTurn(turn, embedding);
    }

    return response;
  }

  // Delegate other methods
  async embed(text: string): Promise<number[]> { return this.base.embed(text); }
}
```

### Message enrichment strategy

The caller's messages are preserved as-is. Context is injected as a prefix:

```
[System: L1 system prompt + L2 summary]        ← from context manager
[User: L3a recent turn 1]                       ← from context manager
[Assistant: L3a recent turn 1 response]          ← from context manager
[User: L3a recent turn 2]                       ← from context manager
[Assistant: L3a recent turn 2 response]          ← from context manager
[User: L3b semantic match 1]                    ← from context manager
[User: L4 code entities]                        ← from context manager
--- caller's messages below ---
[System: caller's system prompt]                ← from caller (merged with L1)
[User: caller's user message]                   ← from caller
```

Key: the caller's system prompt is **merged** with L1 (appended, not replaced). If the caller has no system prompt, L1 is used as-is.

### Skip modes

Some calls should NOT get full context:

```typescript
// Classification call — needs context for accuracy but shouldn't record a turn
const classifyResponse = await provider.complete(messages, {
  __skipRecord: true,    // don't record this as a turn
});

// Summary compression — internal call, no context needed
const summaryResponse = await baseProvider.complete(messages, {
  // Uses base provider directly, not context-aware
});
```

The `__skipRecord` flag is passed through `CompletionOpts`. Alternatively, callers that need raw access use `session.ollamaProvider` (base) instead of `session.localProvider` (context-aware).

## Session changes

### Current Session fields:
```typescript
readonly ollamaProvider: OllamaProvider;
readonly claudeProvider: ClaudeProvider | null;
readonly resolver: ProviderResolver;
contextManager: ContextManager;
```

### New Session fields:
```typescript
// Base providers (raw, no context injection)
readonly rawOllamaProvider: OllamaProvider;
readonly rawClaudeProvider: ClaudeProvider | null;

// Context-aware providers (auto-inject L1-L5, auto-record turns)
readonly localProvider: ContextAwareProvider;
readonly claudeProvider: ContextAwareProvider | null;

// Shared context manager
readonly contextManager: ContextManager;

// Provider resolver returns context-aware providers
readonly resolver: ProviderResolver;
```

## What gets removed (external context building)

### chat-handler.ts
- Remove `assembled` variable and `ctx.assemble()` / `ctx.buildMessages()` calls
- Remove `persistTurn()` calls (auto-recorded by provider)
- Remove `ctx.setAttachmentContext()` — move into context manager as a setter
- `runSimpleCompletion`: just call `provider.complete(messages)` — no context assembly

### agent/index.ts (CLI REPL)
- Remove all `ctx.assemble()` / `ctx.buildMessages()` calls
- Remove `persistTurn()` calls
- Simplify to just `provider.complete(messages)`

### agent/tasks/*/steps.ts
- Steps currently build messages from `StepContext.codeContext` + their own prompts
- After refactor: steps just build their step-specific messages
- Context manager automatically adds L1-L5

### agent/tools/loop.ts
- Tool loop currently has no context
- After refactor: the provider used in the loop is context-aware
- Each tool iteration gets fresh context (but same session state)

### classifier/decompose.ts
- Currently builds raw messages with hardcoded system prompt
- After refactor: uses context-aware provider with `__skipRecord: true`
- Gets conversation history for better classification accuracy

## Internal calls that should NOT use context

These use the **raw base provider** directly (not context-aware):

| Call | Why skip context |
|------|-----------------|
| `summary.ts` eviction | Compressing old turns — adding current context would be circular |
| `validator.ts` tool validation | Security check — needs clean prompt, not session history |
| `smart-router.ts` routing classification | Internal decision — shouldn't pollute session |
| `embedder.ts` embedding calls | Just embedding text, not conversational |

## ProviderResolver changes

The resolver currently returns base providers. After refactor:

```typescript
class ProviderResolver {
  resolve(agent: string, step: string): LLMProvider {
    const base = this.doResolve(agent, step);
    // Return context-aware wrapper
    return new ContextAwareProvider(base, this.ctx, this.budgetForProvider(base));
  }

  resolveRaw(agent: string, step: string): LLMProvider {
    // For internal calls that shouldn't get context
    return this.doResolve(agent, step);
  }
}
```

## Files to modify

| File | Change |
|------|--------|
| `src/insrc/agent/context/context-aware-provider.ts` | **New** — ContextAwareProvider class |
| `src/insrc/agent/session.ts` | Create context-aware wrappers, expose raw + wrapped providers |
| `src/insrc/agent/config.ts` | ProviderResolver returns context-aware providers, add `resolveRaw()` |
| `src/insrc/agent/context/index.ts` | Add `enrichMessages()` method for provider use |
| `src/insrc/daemon/chat-handler.ts` | Remove manual context assembly, `persistTurn()` calls |
| `src/insrc/agent/index.ts` | Remove manual context assembly |
| `src/insrc/agent/classifier/decompose.ts` | Use context-aware provider with skipRecord |
| `src/insrc/agent/classifier/llm-classify.ts` | Use context-aware provider with skipRecord |
| `src/insrc/agent/tasks/pair/steps.ts` | Remove manual message building |
| `src/insrc/agent/tasks/delegate/steps.ts` | Remove manual message building |
| `src/insrc/agent/tasks/designer/*.ts` | Remove manual message building |
| `src/insrc/agent/planner/steps.ts` | Remove manual message building |
| `src/insrc/agent/tasks/shared/codegen.ts` | Remove manual message building |
| `src/insrc/agent/tasks/shared/investigate.ts` | Remove manual message building |
| `src/insrc/agent/context/summary.ts` | Use raw provider (skip context) |
| `src/insrc/agent/tools/validator.ts` | Use raw provider (skip context) |
| `src/insrc/agent/smart-router.ts` | Use raw provider (skip context) |

## Implementation order

1. **ContextAwareProvider class** — the core wrapper
2. **Session.ts** — create wrapped providers
3. **ProviderResolver** — return wrapped by default, add `resolveRaw()`
4. **chat-handler.ts** — remove context assembly, test simple chat
5. **agent/index.ts** — remove context assembly for CLI
6. **Agent steps** — remove manual message building (one agent at a time)
7. **classifier/decomposer** — use context-aware with skipRecord
8. **Internal calls** — switch to raw provider

## Verification

1. Simple chat: send 3 messages — turn 3 should reference turn 1 content
2. Agent step: pair agent propose step should have conversation history
3. Cross-provider: start with Ollama, escalate to Claude — Claude should see Ollama's turns
4. Classifier: should have conversation context for better intent detection
5. Internal calls (summary, validator) should NOT have session context
6. Check that only one `recordTurn()` happens per user message (not duplicated)

## Risk

- **Circular recording**: provider records turn → context changes → next call sees it. Need to prevent recording internal/intermediate calls.
- **Token budget**: context injection increases message size. Callers with their own large prompts (codegen, designer) may overflow. Need graceful truncation.
- **Agent step messages**: steps currently build specific prompt structures. Injecting L1-L5 before step messages might confuse the LLM. May need per-step control over which layers to include.
- **Tool loop**: each tool iteration would inject context. With 25 iterations, that's 25 context assemblies. Need caching within a turn.

## Mitigation

- Cache assembled context per turn (assemble once, reuse for tool iterations)
- Add `ContextAwareProvider.withOptions({ autoRecord: false, layers: ['L1', 'L2'] })` for per-call control
- Test each agent step individually after refactor
