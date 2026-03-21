# Prompt Decomposition Refactor — Primary/Attached Intent Model

## Problem

The current decomposer produces a flat list of `DecomposedAction[]`. Each action is treated as an independent task. This fails when:

1. **Augmentation**: "find X and also check Y for comparison" — Y should inform X, not run separately
2. **Formatting**: "get logs and output as markdown" — formatting is a modifier, not a peer task
3. **Sequential dependency**: "design X then implement it" — implement needs design output
4. **Multi-angle research**: "compare A vs B, check C for reference" — one goal, multiple investigation paths

The result: only the last action's output is shown, augmenting context is lost, and the user gets a partial answer.

## Design: Primary/Attached Intent Model

### New Decomposition Output

```typescript
interface DecomposedPrompt {
  primary: DecomposedAction;
  attached: AttachedAction[];
  aggregation: 'merge' | 'sequential' | 'parallel';
}

interface AttachedAction extends DecomposedAction {
  relation: AttachedRelation;
  reason: string;  // why this is attached (shown to user)
}

type AttachedRelation =
  | 'augment'   // Enhances primary with additional context/angle
  | 'append'    // Independent result appended after primary output
  | 'format'    // Transforms primary output (markdown, table, etc.)
  | 'depends'   // Sequential: needs primary's output first
  | 'parallel'; // Independent: can run concurrently, results aggregated
```

### Relation Semantics

| Relation | Execution | Output | Example |
|----------|-----------|--------|---------|
| `augment` | Merged into primary agent's input context | Single unified output | "find X and also check Y for reference" |
| `append` | Runs after primary, independently | Primary output + separator + append output | "analyze this file and also list its dependencies" |
| `format` | Runs as transform on primary output | Formatted version of primary output | "get logs and format as markdown table" |
| `depends` | Runs after primary, receives primary output as input | Dependent output (may reference primary) | "design the API then implement it" |
| `parallel` | Runs concurrently with primary | Aggregated: both outputs combined | "check for security issues and also review performance" |

### Decomposer Prompt Changes

```
Output ONLY valid JSON:
{
  "primary": {
    "intent": "<intent>",
    "action": "<description>",
    "subject": "<what>",
    "refs": [...],
    "confidence": <0-1>
  },
  "attached": [
    {
      "intent": "<intent>",
      "action": "<description>",
      "subject": "<what>",
      "relation": "augment|append|format|depends|parallel",
      "reason": "<why this is attached to primary>",
      "refs": [...],
      "confidence": <0-1>
    }
  ]
}

Rules:
- Every prompt has exactly ONE primary intent
- Additional sub-requests are "attached" with a relation type
- "augment": information that enhances the primary goal (reference material,
  comparison points, additional angles). These are NOT separate tasks — they
  become part of the primary agent's investigation/context
- "append": truly independent questions asked in the same message. Each produces
  its own output section
- "format": output formatting requests ("as markdown", "as table", "summarize")
- "depends": sequential work where step 2 needs step 1's output ("design then implement")
- "parallel": independent work that can run concurrently ("check security AND performance")
- When in doubt between "augment" and "append", prefer "augment" — most sub-requests
  in a single message are meant to inform the primary answer
- Greetings and conversational messages: primary intent "research" with action "chat",
  no attached actions
```

### Execution Flow

```
DecomposedPrompt
  |
  v
Route by primary.intent (same as today's single-intent routing)
  |
  +-- Process attached actions by relation:
  |
  |   augment:
  |     Merge into primary's input context
  |     e.g., research agent receives: "find X" + context: "also consider Y"
  |     Single agent run, single output
  |
  |   format:
  |     Run primary first
  |     Pass output through transform task (existing pattern)
  |     Return formatted output
  |
  |   depends:
  |     Run primary first
  |     Run dependent with primary's output as input context
  |     Return dependent's output (or both)
  |
  |   append:
  |     Run primary
  |     Run attached independently
  |     Concatenate outputs with section headers
  |
  |   parallel:
  |     Run primary and attached concurrently
  |     Aggregate outputs with section headers
  |
  v
Aggregate results based on aggregation strategy
  |
  v
Stream combined output to user
```

### Implementation in chat-handler.ts

```typescript
// After decomposition
const decomposed = await decompose(message, provider, history);

// Extract primary and attached
const primary = decomposed.primary;
const attached = decomposed.attached ?? [];

// Merge augmentations into primary's context
const augmentations = attached.filter(a => a.relation === 'augment');
const enrichedMessage = augmentations.length > 0
  ? `${primary.action}\n\nAdditional context:\n${augmentations.map(a => `- ${a.action} (${a.reason})`).join('\n')}`
  : message;

// Route primary intent (with enriched message)
// ... existing routing logic, but using enrichedMessage ...

// Handle non-augment attached actions after primary completes
const formatActions = attached.filter(a => a.relation === 'format');
const dependActions = attached.filter(a => a.relation === 'depends');
const appendActions = attached.filter(a => a.relation === 'append');
const parallelActions = attached.filter(a => a.relation === 'parallel');

// Format: transform primary output
if (formatActions.length > 0) {
  primaryOutput = await transformOutput(primaryOutput, formatActions[0]);
}

// Depends: run sequentially with primary output as context
for (const dep of dependActions) {
  const depResult = await runAction(dep, primaryOutput);
  results.push(depResult);
}

// Append: run independently, concatenate
for (const app of appendActions) {
  const appResult = await runAction(app);
  results.push(appResult);
}

// Aggregate
const finalOutput = aggregateResults(primaryOutput, results, decomposed.aggregation);
```

### Backward Compatibility

The old `DecomposedAction[]` format is still supported:
- If decomposer returns `{ actions: [...] }` (old format), convert:
  - First action becomes `primary`
  - Remaining actions become `attached` with `relation: 'depends'` if they have `dependsOn`, or `'append'` otherwise
- If decomposer returns `{ primary, attached }` (new format), use directly

### Result Aggregation

```typescript
function aggregateResults(
  primary: { output: string; format: TaskFormat },
  attached: Array<{ output: string; format: TaskFormat; relation: string; action: string }>,
  strategy: 'merge' | 'sequential' | 'parallel',
): { output: string; format: TaskFormat } {
  if (attached.length === 0) return primary;

  // Build combined output with clear section headers
  let combined = primary.output;

  for (const result of attached) {
    if (result.relation === 'format') {
      // Format replaces primary output
      combined = result.output;
    } else {
      // Append with section header
      combined += `\n\n---\n\n### ${result.action}\n\n${result.output}`;
    }
  }

  return { output: combined, format: primary.format };
}
```

### Progress Streaming

```
[progress] Decomposed: primary(research) + 1 augmentation + 1 format
[progress] Research Agent: planning investigation... (includes augmentation context)
[progress] Step 1/4: Reading file...
[progress] Step 2/4: Web search...
[progress] Evaluation: goal met (85%)
[progress] Writing report...
[progress] Formatting as markdown table...
[done] Research complete
```

### Files to Modify

| File | Change |
|------|--------|
| `agent/classifier/decompose.ts` | New output format (primary/attached), updated prompt |
| `daemon/chat-handler.ts` | Handle primary/attached routing, augmentation merging, result aggregation |
| `daemon/task-builder.ts` | Convert attached actions to tasks with proper dependencies |
| `daemon/task.ts` | Support parallel execution for parallel-relation tasks |
| `shared/types.ts` | Add `DecomposedPrompt`, `AttachedAction`, `AttachedRelation` types |

### Implementation Order

1. **Types** — add `DecomposedPrompt`, `AttachedAction`, `AttachedRelation` to shared/types.ts
2. **Decomposer prompt** — update decompose.ts with new output format and rules
3. **Decomposer parser** — parse new format, fallback to old format for backward compat
4. **Chat handler** — augmentation merging, post-primary processing (format/depends/append/parallel)
5. **Result aggregation** — combine outputs with section headers
6. **Task builder** — generate task graph from attached actions
7. **Parallel execution** — run parallel-relation tasks concurrently (optional, can be sequential initially)

### Migration

The change is backward compatible:
- Old decomposer output (`{ actions: [...] }`) is auto-converted
- Single-action prompts work unchanged (primary only, no attached)
- Multi-action prompts with same intent get merged (augment)
- Multi-action prompts with different intents get proper routing (depends/append)
