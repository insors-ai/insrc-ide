# Smart Read: Controller-Based File Reading

## Problem

When the LLM calls `Read` on a large file, it blindly reads the entire content, blowing the context window. The LLM doesn't have the intelligence to:
- Check file size first
- Sample the file to understand format
- Use Grep/Bash for targeted extraction based on the user's question
- Chunk large files and process iteratively

## Solution

Replace the dumb `Read` builtin with a **SmartRead controller** that uses a multi-step control flow:

```
SmartRead(file_path, prompt) →
  1. Stat: check file size
  2. If small (<500 lines): return full content
  3. If large: read first 30 lines to understand format
  4. Plan: based on format + user prompt, decide extraction strategy
  5. Execute: grep, awk, head/tail, or chunked read
  6. Return: targeted content with metadata
```

## Controller Framework

Each controller is a state machine with typed steps:

```typescript
interface Controller<S> {
  name: string;
  initialState(input: unknown): S;
  steps: Record<string, ControllerStep<S>>;
  firstStep: string;
}

interface ControllerStep<S> {
  run(state: S, ctx: StepContext): Promise<{ state: S; next: string | null }>;
}

interface StepContext {
  /** Call a tool (Read, Grep, Bash) */
  callTool(name: string, input: Record<string, unknown>): Promise<string>;
  /** Call the LLM for analysis/planning */
  think(prompt: string, maxTokens?: number): Promise<string>;
}
```

## SmartRead Controller

### State

```typescript
interface SmartReadState {
  filePath: string;
  userPrompt: string;      // what the user wants from this file
  fileSize: number;         // bytes
  lineCount: number;
  format: string;           // detected: 'json-lines', 'log', 'code', 'markdown', 'csv', 'text'
  strategy: string;         // chosen: 'full', 'grep', 'head-tail', 'section', 'chunked'
  result: string;           // final extracted content
}
```

### Steps

1. **stat** — Check file size and line count
   - `< 500 lines` → next: `read-full`
   - `>= 500 lines` → next: `sample`

2. **sample** — Read first 30 + last 10 lines, detect format
   - Detect: JSON lines, log format (pino/winston), code, markdown, CSV, plain text
   - Set `state.format`
   - next: `plan`

3. **plan** — Use LLM to decide extraction strategy based on format + prompt
   - Input: file format, size, sample, user's question
   - LLM outputs: strategy + command/pattern
   - Strategies:
     - `grep` — use Grep tool with regex pattern (for: "find errors", "search for X")
     - `head-tail` — first N + last M lines (for: "overview", "what is this file")
     - `section` — grep for section headers, read specific section (for: "show the config section")
     - `chunked` — process N lines at a time with LLM summary (for: "summarize this file")
     - `structured` — jq/awk for structured data (for: JSON/CSV queries)
   - next: `execute`

4. **execute** — Run the chosen strategy
   - `grep`: call Grep tool with the planned pattern
   - `head-tail`: call Read with offset/limit
   - `section`: grep for headers, then read the matching section
   - `chunked`: iterate through chunks, summarize each
   - `structured`: bash with jq/awk
   - next: `format`

5. **format** — Add metadata header to result
   ```
   [File: /path/to/file.log | 12,450 lines | 364KB | Format: pino JSON logs]
   [Strategy: grep for level>=50 (errors) | 23 matches]

   <extracted content>
   ```
   - next: null (done)

### read-full — Direct read for small files
   - Read entire file
   - Add line count header
   - next: null (done)

## Integration

### Replace Read tool

The `Read` builtin in `executor.ts` calls the SmartRead controller instead of raw `readFile`:

```typescript
case 'Read': {
  if (call.input['smart'] !== false) {
    return smartRead(call.input, userPrompt);
  }
  return builtinRead(call.input);  // raw fallback
}
```

The `userPrompt` is passed from the tool loop context — it's the original user message that triggered the tool call.

### Tool loop integration

The tool loop needs to pass the user's original prompt to the tool executor so SmartRead knows what the user wants:

```typescript
// In runToolLoop, pass context to executeTool
const result = await executeTool(call, { userPrompt: messages[messages.length - 1]?.content });
```

### LLM planning prompt (step 3)

```
You are analyzing a large file to decide the best extraction strategy.

File: {filePath}
Size: {lineCount} lines, {fileSize} bytes
Format: {format}
Sample (first 30 lines):
{sample}

User wants: {userPrompt}

Choose ONE strategy and provide the extraction parameters:
1. grep: { pattern: "<regex>", context: <lines>, maxResults: <n> }
2. head-tail: { headLines: <n>, tailLines: <n> }
3. section: { headerPattern: "<regex>", sectionIndex: <n> }
4. chunked: { chunkSize: <lines>, summarize: true }
5. structured: { command: "<jq/awk command>" }

Output JSON only: { "strategy": "...", "params": { ... }, "reasoning": "..." }
```

## Files to create

| File | Purpose |
|------|---------|
| `src/insrc/agent/tools/smart-read.ts` | SmartRead controller |

## Files to modify

| File | Change |
|------|--------|
| `src/insrc/agent/tools/executor.ts` | Route Read to SmartRead |
| `src/insrc/agent/tools/loop.ts` | Pass userPrompt to executor |

## Examples

### "Check for errors in the daemon log"
```
stat → 12,450 lines, 364KB
sample → format: pino JSON lines
plan → strategy: grep, pattern: '"level":50' (pino error level)
execute → grep returns 23 error lines
format → [File: daemon.log | 12,450 lines | grep: 23 errors]
```

### "What does this config file do?"
```
stat → 85 lines, 2KB
→ read-full (small file)
```

### "Summarize the test results"
```
stat → 3,200 lines, 180KB
sample → format: text (test runner output)
plan → strategy: grep, pattern: 'FAIL|PASS|ERROR|✓|✗'
execute → grep returns summary lines
format → [File: test-output.txt | 3,200 lines | grep: 45 result lines]
```

### "Show me the database schema"
```
stat → 800 lines, 25KB
sample → format: SQL
plan → strategy: grep, pattern: 'CREATE TABLE|CREATE INDEX'
execute → grep returns DDL statements
format → [File: schema.sql | 800 lines | grep: 12 DDL statements]
```

## Additional Tools for Simple Chat

Beyond SmartRead, these tools should be added to the simple completion tool set:

### New tools to create

| Tool | Description | Implementation |
|------|-------------|----------------|
| `ListDirectory` | List files/dirs at a path with metadata (size, type) | `readdir` + `stat` |
| `FileInfo` | Get file metadata: size, lines, type, modified, permissions | `stat` + line count |
| `TreeView` | Directory tree with configurable depth (default 3) | Recursive `readdir` with depth limit |
| `Diff` | Compare two files, or show `git diff` for a file | `git diff` or line-by-line diff |
| `GitLog` | Git history for a file or repo (last N commits) | `git log --oneline -N` |
| `GitBlame` | Line-by-line authorship for a file range | `git blame -L start,end` |

### Existing tools to add to simple chat

| Tool | Currently | Add to simple chat? | Notes |
|------|-----------|---------------------|-------|
| `WebSearch` | Agent steps only | Yes | Research questions |
| `WebFetch` | Agent steps only | Yes | Fetch documentation |
| `graph_query` | Agent steps only | Yes | Cypher queries on knowledge graph |
| `Bash` | Agent steps only | **No** | Too dangerous without validation |
| `Write` | Agent steps only | **No** | Mutating — needs agent gates |
| `Edit` | Agent steps only | **No** | Mutating — needs agent gates |

### Tool definitions

```typescript
{
  name: 'ListDirectory',
  description: 'List files and directories at a path. Returns names with type (file/dir) and size.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path to list' },
      recursive: { type: 'boolean', description: 'List recursively (default false)' },
    },
    required: ['path'],
  },
},
{
  name: 'FileInfo',
  description: 'Get file metadata: size in bytes, line count, file type, last modified time.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the file' },
    },
    required: ['file_path'],
  },
},
{
  name: 'TreeView',
  description: 'Show directory tree structure with configurable depth. Useful for understanding project layout.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Root directory path' },
      depth: { type: 'number', description: 'Max depth (default 3)' },
      pattern: { type: 'string', description: 'Glob pattern to filter (e.g. "*.ts") (optional)' },
    },
    required: ['path'],
  },
},
{
  name: 'Diff',
  description: 'Show differences between two files, or git diff for a file. Returns unified diff format.',
  inputSchema: {
    type: 'object',
    properties: {
      file_a: { type: 'string', description: 'First file path (or file for git diff)' },
      file_b: { type: 'string', description: 'Second file path (optional — if omitted, shows git diff)' },
      context: { type: 'number', description: 'Lines of context around changes (default 3)' },
    },
    required: ['file_a'],
  },
},
{
  name: 'GitLog',
  description: 'Show git commit history for a file or repository.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path or repo directory' },
      limit: { type: 'number', description: 'Max commits to show (default 10)' },
      oneline: { type: 'boolean', description: 'One-line format (default true)' },
    },
    required: ['path'],
  },
},
{
  name: 'GitBlame',
  description: 'Show line-by-line git blame (author, date, commit) for a file range.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the file' },
      start_line: { type: 'number', description: 'Start line (optional)' },
      end_line: { type: 'number', description: 'End line (optional)' },
    },
    required: ['file_path'],
  },
},
```

### Implementation in executor.ts

All new tools use shell commands under the hood:
- `ListDirectory`: `readdir` + `stat` (no shell)
- `FileInfo`: `stat` + `wc -l`
- `TreeView`: recursive `readdir` with depth tracking
- `Diff`: `git diff file` or `diff file_a file_b`
- `GitLog`: `git log --oneline -N path`
- `GitBlame`: `git blame -L start,end file`

## Verification

1. Ask "check errors in /tmp/.insrc/daemon.log" — should grep for error level, not read 364KB
2. Read a small file (<500 lines) — should return full content (no overhead)
3. Ask "what functions are in src/agent/index.ts" — should grep for function declarations
4. Ask "summarize this CSV" — should use head-tail or structured extraction
