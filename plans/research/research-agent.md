# Research Agent Design

## Problem

The current research path is a flat tool loop: decompose intent, call LLM with tools, return response. This fails when:

1. **File is a directory** -- LLM gets a listing but can't ask the user which file to analyze
2. **Large file** -- SmartRead picks a strategy but the LLM doesn't iterate if first attempt doesn't answer the question
3. **Multi-step research** -- "find all endpoints and their auth requirements" needs search + read + cross-reference, but the loop often stops after one tool call
4. **User clarification** -- LLM needs to ask a question mid-research but the tool loop has no user interaction
5. **Goal tracking** -- no evaluation of whether the research question was actually answered
6. **Web + local** -- some questions need both code search and web search, but the LLM doesn't plan this

## Design: Research Agent (step-based, like Pair/Brainstorm)

The research agent uses the same `AgentDefinition` framework as Pair and Brainstorm. It's a step-based state machine with gates for user interaction and goal evaluation.

### Agent Identity

```typescript
export const researchAgent: AgentDefinition<ResearchState> = {
  id: 'research',
  version: 1,
  configNamespace: 'research',
  firstStep: 'plan',
  steps: {
    'plan':           planStep,
    'investigate':    investigateStep,
    'clarify':        clarifyStep,
    'web-search':     webSearchStep,
    'synthesize':     synthesizeStep,
    'evaluate':       evaluateStep,
    'report':         reportStep,
  },
};
```

### State

```typescript
interface ResearchState {
  input: {
    question: string;           // original user question
    codeContext: string;        // assembled L3/L4 context
    repoPath: string;
    closureRepos: string[];
    fileRefs: string[];         // file paths mentioned in the question
    classification: DecomposedAction;
  };

  // Plan
  plan: ResearchPlan;           // steps to answer the question
  currentPlanStep: number;      // which plan step we're on

  // Findings
  findings: Finding[];          // accumulated evidence from each step
  clarifications: Clarification[]; // user answers to mid-research questions

  // Subflow tracking
  activeSubflow: 'local' | 'web' | 'file' | null;
  subflowIterations: number;

  // Goal evaluation
  goalMet: boolean;
  confidence: number;           // 0-1, how confident are we the question is answered
  missingInfo: string[];        // what's still needed
}

interface ResearchPlan {
  goal: string;                 // restatement of the user's question as a goal
  approach: string;             // brief strategy description
  steps: PlanStep[];            // ordered steps to reach the goal
}

interface PlanStep {
  id: number;
  action: 'read-file' | 'grep-search' | 'graph-query' | 'web-search' | 'list-dir' | 'ask-user' | 'analyze';
  target: string;              // what to act on (file path, search query, etc.)
  reason: string;              // why this step is needed
  status: 'pending' | 'done' | 'skipped' | 'failed';
  result?: string;             // what we found
}

interface Finding {
  source: string;              // file path, URL, or "graph query"
  content: string;             // extracted relevant content
  relevance: string;           // why this is relevant to the goal
}

interface Clarification {
  question: string;            // what we asked the user
  answer: string;              // what they said
}
```

### Step Flow

```
plan
  |
  v
investigate <----+
  |               |
  +-- file read --+-- (need more info) --> investigate (next plan step)
  +-- grep -------+
  +-- graph query-+
  +-- dir listing --> clarify (which file?) --> investigate
  |
  +-- (need web) --> web-search --> investigate
  |
  v
evaluate
  |
  +-- goalMet=true --> report
  +-- goalMet=false, missingInfo --> investigate (add steps to plan)
  +-- goalMet=false, stuck --> clarify (ask user for direction)
  |
  v
report --> done
```

### Step Descriptions

#### Step 1: `plan`

LLM receives the user's question + available tools + code context (from graph). Produces a `ResearchPlan`:

- **Goal**: restate the question as an achievable goal
- **Approach**: brief strategy (e.g. "search for error patterns in log files, then cross-reference with source code")
- **Steps**: ordered list of concrete actions

The plan is adaptive -- if early steps reveal new information, later steps can be added/modified in the `evaluate` step.

**Provider**: local (fast planning, doesn't need Claude)

**Example**:
```
User: "analyze /tmp/.insrc for errors"

Plan:
  Goal: Find and explain errors in the /tmp/.insrc directory
  Approach: List directory contents, identify log files, grep for errors, analyze findings
  Steps:
    1. list-dir: /tmp/.insrc (find log files)
    2. grep-search: error patterns in identified log files
    3. analyze: summarize error types and causes
```

#### Step 2: `investigate`

Executes the current plan step. This is the main work loop. Each iteration:

1. Take the next pending plan step
2. Execute it using the appropriate tool (Read, Grep, Glob, graph_query, ListDirectory)
3. Process the result through SmartRead if it's a file read
4. Add findings to `state.findings`
5. Mark step as done
6. Route to next step:
   - More plan steps pending -> `investigate` (loop)
   - Directory listing returned -> `clarify` (ask user which file)
   - Need web info -> `web-search`
   - All steps done -> `evaluate`

**Key**: each tool result goes through the **result evaluator** -- a quick LLM call that checks:
- Did this result contain relevant information? (extract findings)
- Do we need to read more files? (add plan steps)
- Is the answer obvious now? (short-circuit to report)

**Provider**: local (tool execution + result evaluation)

**Subflows within investigate**:

##### File Read Subflow
```
stat file -> is directory?
  yes -> list contents with sizes -> add to findings, route to clarify
  no -> SmartRead (strategy based on format + question)
       -> chunked if large
       -> result evaluator extracts findings
```

##### Search Subflow
```
grep/glob/graph_query -> results
  -> too many results? -> refine search (narrower pattern)
  -> relevant results -> extract findings
  -> no results -> try alternative search, or mark step as failed
```

#### Step 3: `clarify` (gate)

Pauses execution and asks the user a question. Used when:
- Directory listing: "Found 5 files in /tmp/.insrc. Which should I analyze? [all] [specific files listed]"
- Ambiguous query: "Your question could mean X or Y. Which did you mean?"
- Missing context: "I need to know which endpoint you're referring to. Can you specify?"

The gate presents action buttons for common choices + a free-text input for custom answers.

**Stream protocol**:
```typescript
{ stream: 'gate', data: {
  gateId: 'clarify-001',
  title: 'Which files should I analyze?',
  content: 'Found 5 files in /tmp/.insrc:\n- agent.1.log (1.2MB)\n- agent.2.log (342KB)\n- daemon.log (355KB)\n- tool-output/ (dir)',
  actions: ['All files', 'agent.1.log', 'agent.2.log', 'daemon.log'],
  allowFreeText: true,
}}
```

User's response (action or text) is stored in `state.clarifications` and the plan is updated accordingly. Execution returns to `investigate`.

#### Step 4: `web-search`

When the plan includes web research or the evaluate step determines web info is needed:

1. Formulate search query from the research goal + current findings
2. Call WebSearch tool
3. For top results, call WebFetch to get page content
4. Extract relevant information using LLM
5. Add to findings
6. Return to `investigate` or `evaluate`

**Provider**: local for query formulation, local for extraction

#### Step 5: `evaluate`

After all plan steps are done (or periodically after N steps), evaluate progress:

LLM receives:
- Original question/goal
- All findings so far
- Any clarifications from user

LLM outputs:
```typescript
{
  goalMet: boolean,
  confidence: number,        // 0-1
  missingInfo: string[],     // what's still needed
  additionalSteps?: PlanStep[], // new steps to add if not done
  reasoning: string,         // why we think we're done or not
}
```

Routes:
- `goalMet && confidence > 0.7` -> `report`
- `!goalMet && additionalSteps` -> add steps to plan, return to `investigate`
- `!goalMet && missingInfo && no more ideas` -> `clarify` (ask user for direction)
- Max iterations reached -> `report` with partial findings

**Provider**: local (or claude for complex evaluations)

#### Step 6: `report`

Synthesizes all findings into a coherent response:

1. LLM receives: goal, all findings, clarifications, evaluation reasoning
2. Produces a structured HTML response:
   - Summary (1-2 sentences answering the question)
   - Details (organized findings with source references)
   - Code snippets (with file paths and line numbers)
   - Recommendations (if applicable)
3. Streams the response to the user via delta messages

**Provider**: local (or claude for complex synthesis)

### Integration with Chat Handler

```typescript
// In chat-handler.ts, replace simple completion for research intent:

case 'research':
case 'code-analysis':
  // Use research agent instead of simple completion
  await runResearchAgent(session, message, action, send, requestId, signal);
  break;
```

The research agent runs within the chat session context. It uses the session's `ContextAwareProvider` for all LLM calls, so context is shared with the rest of the conversation.

### Tool Availability

The research agent has access to all read-only tools:

| Tool | Used in |
|------|---------|
| Read (via SmartRead) | investigate: file read subflow |
| Grep | investigate: search subflow |
| Glob | investigate: file discovery |
| ListDirectory | investigate: directory exploration |
| FileInfo | investigate: pre-read size/type check |
| TreeView | investigate: project structure |
| graph_search | investigate: semantic code search |
| graph_callers/callees | investigate: relationship traversal |
| graph_query | investigate: arbitrary Cypher |
| WebSearch | web-search step |
| WebFetch | web-search step |
| GitLog | investigate: history questions |
| GitBlame | investigate: authorship questions |

No write tools (Read, Write, Edit, Bash) -- research is read-only.

### Progress Streaming

Every step sends progress updates to the IDE:

```typescript
// Plan created
{ stream: 'progress', data: { message: 'Planning research: 4 steps' }}

// Each investigate iteration
{ stream: 'progress', data: { message: 'Step 1/4: Reading agent.1.log...' }}
{ stream: 'progress', data: { message: 'Step 1/4: Found 3 errors in 3084 lines' }}

// Evaluation
{ stream: 'progress', data: { message: 'Evaluating findings (confidence: 0.85)' }}

// Report
{ stream: 'delta', data: { text: '<h3>Error Analysis...</h3>', format: 'html-inline' }}
```

### Differences from Simple Completion

| Aspect | Simple Completion | Research Agent |
|--------|------------------|----------------|
| Tool iterations | Single loop, max 25 | Multi-step plan, each step can use tools |
| Goal tracking | None | Explicit goal + evaluation |
| User interaction | None mid-flow | Gates for clarification |
| Large files | SmartRead once | Chunked + re-read with refined queries |
| Directories | Returns EISDIR error | Lists contents, asks user or auto-selects |
| Web research | Single search call | Planned web subflow with extraction |
| Progress | Opaque | Per-step progress streaming |
| Adaptability | Fixed | Plan mutates based on findings |

### Configuration

```json
// config.json -> models.agents.research
{
  "plan": "local",
  "investigate": "local",
  "evaluate": "local",
  "report": "local",
  "web-search": "local"
}
```

All steps default to local. Users can route `evaluate` or `report` to Claude for higher quality synthesis.

### Implementation Order

1. **ResearchState + types** (`agent/tasks/research/types.ts`)
2. **Plan step** (`agent/tasks/research/steps/plan.ts`) -- LLM generates research plan
3. **Investigate step** (`agent/tasks/research/steps/investigate.ts`) -- tool execution loop with SmartRead
4. **Clarify step** (`agent/tasks/research/steps/clarify.ts`) -- gate for user questions
5. **Evaluate step** (`agent/tasks/research/steps/evaluate.ts`) -- goal assessment
6. **Report step** (`agent/tasks/research/steps/report.ts`) -- synthesis + streaming
7. **Web search step** (`agent/tasks/research/steps/web-search.ts`) -- web subflow
8. **Agent definition** (`agent/tasks/research/agent.ts`) -- wire steps
9. **Chat handler integration** -- route research/code-analysis intents to research agent
10. **Config defaults** -- add research namespace to config.json

### File Structure

```
src/insrc/agent/tasks/research/
  agent.ts              -- AgentDefinition
  types.ts              -- ResearchState, ResearchPlan, Finding, etc.
  agent-state.ts        -- state interface (framework convention)
  steps/
    plan.ts             -- generate research plan from question
    investigate.ts      -- execute plan steps with tools
    clarify.ts          -- gate: ask user for clarification
    web-search.ts       -- web search subflow
    evaluate.ts         -- assess if goal is met
    report.ts           -- synthesize findings into response
```
