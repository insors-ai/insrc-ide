# Web Search Fallback — Anthropic Server-Side Tool

## Problem

WebSearch currently requires a `BRAVE_API_KEY`. Most users won't have this configured. When the research agent needs web results and no Brave key is available, the search silently fails.

## Solution: Anthropic Web Search as Fallback

The Anthropic API supports `web_search_20250305` as a server-side tool. Claude performs the search and returns results. This requires only the existing `ANTHROPIC_API_KEY` — no additional API key.

### Flow

```
Research agent requests WebSearch
  |
  v
Check BRAVE_API_KEY?
  |
  +-- Yes --> Brave API (existing, fast, no approval needed)
  |
  +-- No --> Anthropic web search (requires user approval)
              |
              v
          Send gate to user:
            "The research agent wants to search the web for:
             '<query>'
             This will use Claude (costs apply).
             [Approve] [Skip] [Edit query]"
              |
              +-- Approve --> call Claude with web_search tool
              +-- Skip --> return "web search skipped by user"
              +-- Edit --> user modifies query, then approve/skip
```

### User Approval

Every web search through Claude requires explicit user approval because:
1. **Cost** — Claude API calls cost money, Brave is free-tier
2. **Privacy** — search queries are sent to Anthropic
3. **Transparency** — user should know when external services are used

The gate card shows:
- The exact search query
- Which provider will be used (Claude)
- Action buttons: Approve / Skip / Edit query

### Implementation

#### 1. Claude Provider — Add web_search tool support

```typescript
// In providers/claude.ts
async webSearch(query: string): Promise<WebSearchResult> {
  const response = await this.client.messages.create({
    model: this.config.models.tiers.fast, // Use cheapest Claude model
    max_tokens: 1024,
    tools: [{
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 3, // limit searches per call
    }],
    messages: [{
      role: 'user',
      content: `Search the web for: ${query}. Return the most relevant results with URLs and summaries.`,
    }],
  });
  // Extract search results from tool_use blocks in the response
  return parseWebSearchResponse(response);
}
```

#### 2. WebSearch Tool — Fallback chain

```typescript
// In tools/executor.ts, builtinWebSearch()
async function builtinWebSearch(input: Record<string, unknown>): Promise<string> {
  const query = input['query'] as string;

  // Try Brave first (free, no approval needed)
  const braveKey = process.env['BRAVE_API_KEY'];
  if (braveKey) {
    return braveSearch(query, braveKey);
  }

  // Fallback: Anthropic web search (needs approval)
  if (!claudeProvider) {
    return '[WebSearch] No search provider available. Set BRAVE_API_KEY or ANTHROPIC_API_KEY.';
  }

  // Return a marker that the controller/tool-loop should gate
  return `[NEEDS_APPROVAL:web_search] query=${query}`;
}
```

#### 3. Tool Loop — Gate on approval markers

When the tool loop sees `[NEEDS_APPROVAL:web_search]` in a tool result:
1. Send a gate to the user with the query
2. Wait for approval
3. If approved, execute via Claude web search
4. If skipped, return "search skipped"

```typescript
// In tools/loop.ts, after executing a tool
if (result.startsWith('[NEEDS_APPROVAL:web_search]')) {
  const query = result.match(/query=(.+)/)?.[1] ?? '';
  // Emit gate via progress channel (tool loop doesn't have gate access)
  // Instead: return the marker, let the controller handle gating
}
```

#### 4. Research Controller — Handle web search gate

The research controller's `next()` method already handles clarify gates. Add web search gate handling:

When investigate step returns output containing `[NEEDS_APPROVAL:web_search]`:
- Create a gate task with the query
- On approve: re-run investigate with the Claude web search result injected
- On skip: mark the web search plan step as skipped, continue

#### 5. Web Search Result Format

```typescript
interface WebSearchResult {
  query: string;
  results: Array<{
    url: string;
    title: string;
    snippet: string;
    content?: string; // fetched page content if available
  }>;
  provider: 'brave' | 'claude';
}
```

### Configuration

```json
// config.json
{
  "webSearch": {
    "provider": "auto",       // "brave" | "claude" | "auto" (brave first, claude fallback)
    "requireApproval": true,  // always true for Claude, can be false for Brave
    "maxResultsPerQuery": 5
  }
}
```

### Files to Modify

| File | Change |
|------|--------|
| `agent/providers/claude.ts` | Add `webSearch()` method using `web_search_20250305` tool |
| `agent/tools/executor.ts` | Add Brave/Claude fallback chain in `builtinWebSearch()` |
| `daemon/controllers/research.ts` | Handle `[NEEDS_APPROVAL:web_search]` in investigate output |
| `shared/types.ts` | Add `WebSearchResult` type |
| `agent/tools/registry.ts` | Update WebSearch tool description to mention approval |

### Implementation Order

1. Add `webSearch()` to Claude provider
2. Update `builtinWebSearch()` with fallback chain
3. Add approval marker detection in research controller
4. Add gate task for web search approval
5. Wire Claude web search execution on approval
6. Add config options
