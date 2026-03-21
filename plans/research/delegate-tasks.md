# Delegate Task Pattern

## Problem

Agents need to delegate work to other agents or specialized sub-flows:
- Research agent needs web search (delegate to web search sub-agent)
- Research agent needs code analysis (delegate to code-analysis)
- Brainstorm agent needs research (delegate to research agent)
- Implement agent needs test (delegate to test agent)
- Any agent needs user approval (delegate to gate)

Currently each controller handles this ad-hoc with custom gate/task creation. There's no standard pattern for:
1. Requesting delegation
2. Routing to the right sub-agent
3. Handling the response
4. Returning results to the parent

## Design: DelegateTask

A new task kind: `'delegate'` that routes execution to another controller or specialized handler.

### Task Interface Addition

```typescript
interface Task {
  // ... existing fields ...
  kind: 'shell' | 'rpc' | 'llm' | 'agent' | 'transform' | 'gate' | 'delegate';

  // Delegate-specific fields
  delegateTo?: string;           // Target controller/handler ID
  delegateInput?: unknown;       // Input for the delegate
  delegateRequiresApproval?: boolean; // Show gate before delegating
  delegateApprovalMessage?: string;   // Gate message for approval
}
```

### Delegate Handlers

Register named delegate handlers that controllers can invoke:

```typescript
interface DelegateHandler {
  id: string;
  description: string;
  requiresApproval: boolean;
  execute(input: unknown, deps: TaskOrchestratorDeps): Promise<TaskResult>;
}
```

### Built-in Delegates

| ID | Description | Approval | Handler |
|----|-------------|----------|---------|
| `web-search:brave` | Brave web search | No (free) | Call Brave API |
| `web-search:claude` | Claude web search | Yes (costs) | Call Claude with web_search tool |
| `web-search` | Auto: Brave if key available, else Claude with approval | Auto | Fallback chain |
| `code-analysis` | Deep code analysis via research agent | No | Spawn research controller |
| `test-run` | Execute tests | Yes (modifies) | Run test suite |
| `git-operation` | Git commands | Yes (modifies) | Execute git |
| `file-write` | Write/edit files | Yes (modifies) | Write via tool |

### Flow

```
Controller creates delegate task:
  { kind: 'delegate', delegateTo: 'web-search', delegateInput: { query: '...' } }
     |
     v
Task executor: executeDelegateTask()
     |
     +-- requiresApproval? --> gate to user
     |      |
     |      +-- approved --> execute handler
     |      +-- skipped --> return skip result
     |
     +-- no approval needed --> execute handler
     |
     v
Handler executes, returns TaskResult
     |
     v
Controller's next() receives result, continues flow
```

### Controller Usage

```typescript
// In ResearchController
if (currentStep === 'investigate' && needsWebSearch) {
  return [{
    index: nextIdx,
    kind: 'delegate',
    intent: 'research',
    delegateTo: 'web-search',
    delegateInput: { query: searchQuery },
    description: `Web search: ${searchQuery}`,
    stateKey: K.FINDINGS,
  }];
}
```

### Task Executor Addition

```typescript
case 'delegate':
  return executeDelegateTask(task, context, deps);

async function executeDelegateTask(task, context, deps): Promise<TaskResult> {
  const handler = delegateRegistry.get(task.delegateTo);
  if (!handler) return errorResult('Unknown delegate: ' + task.delegateTo);

  // Approval gate if needed
  if (handler.requiresApproval || task.delegateRequiresApproval) {
    const approved = await gateTask(task, context, deps);
    if (!approved.ok) return skipResult();
  }

  return handler.execute(task.delegateInput, deps);
}
```

### Implementation Order

1. Add `'delegate'` to `TaskKind` (already done)
2. Add delegate fields to `Task` interface
3. Create `DelegateHandler` interface and registry
4. Implement `executeDelegateTask` in task executor
5. Implement `web-search` delegate handler (Brave + Claude fallback)
6. Update ResearchController to use delegate tasks
7. Register other delegates as needed (code-analysis, test-run, etc.)

### Files

```
src/insrc/daemon/
  delegates/
    registry.ts          -- DelegateHandler interface + registration
    web-search.ts        -- Brave + Claude web search delegate
    code-analysis.ts     -- Research agent sub-invocation
  task.ts                -- Add delegate execution to task executor
```
