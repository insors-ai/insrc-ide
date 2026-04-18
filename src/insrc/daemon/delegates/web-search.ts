/**
 * Web search delegate handler.
 *
 * Fallback chain:
 * 1. Brave Search API (free, no approval) — if BRAVE_API_KEY is set
 * 2. Claude web search (paid, requires approval) — via Anthropic server-side tool
 */

import type { DelegateHandler, DelegateInput, DelegateResult } from './registry.js';
import type { TaskOrchestratorDeps, TaskFormat } from '../task.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('delegate-web-search');

// ---------------------------------------------------------------------------
// Brave Search (free tier)
// ---------------------------------------------------------------------------

async function braveSearch(query: string, limit: number): Promise<DelegateResult> {
  const braveKey = process.env['BRAVE_API_KEY'];
  if (!braveKey) return { output: '', format: 'text', success: false, error: 'No BRAVE_API_KEY' };

  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;
  const res = await fetch(url, {
    headers: { 'X-Subscription-Token': braveKey, 'Accept': 'application/json' },
  });

  if (!res.ok) {
    return { output: '', format: 'text', success: false, error: `Brave API: ${res.status}` };
  }

  const data = await res.json() as { web?: { results?: Array<{ title: string; url: string; description: string }> } };
  const results = data.web?.results ?? [];

  if (results.length === 0) {
    return { output: 'No web results found.', format: 'text', success: true };
  }

  const formatted = results
    .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description}`)
    .join('\n\n');

  return { output: formatted, format: 'markdown' as TaskFormat, success: true };
}

// ---------------------------------------------------------------------------
// Claude Web Search (via Anthropic server-side tool)
// ---------------------------------------------------------------------------

async function claudeWebSearch(query: string, deps: TaskOrchestratorDeps): Promise<DelegateResult> {
  const { session } = deps;
  if (!session.claudeProvider) {
    return { output: '', format: 'text', success: false, error: 'No Claude provider available' };
  }

  try {
    deps.send({ id: deps.requestId, stream: 'progress', data: {
      message: `Claude web search: "${query.slice(0, 50)}"`,
    }});

    const result = await (session.claudeProvider as { webSearch(q: string, n?: number): Promise<{ results: Array<{ title: string; url: string; snippet: string }>; summary: string }> }).webSearch(query, 5);

    if (result.results.length > 0) {
      const formatted = result.results
        .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`)
        .join('\n\n');
      return { output: formatted, format: 'markdown' as TaskFormat, success: true };
    }

    if (result.summary) {
      return { output: result.summary, format: 'text', success: true };
    }

    return { output: 'No web results found.', format: 'text', success: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error({ query, error: errMsg }, 'claude web search failed');
    return { output: '', format: 'text', success: false, error: errMsg };
  }
}

// ---------------------------------------------------------------------------
// Handler: auto-fallback (Brave -> Claude)
// ---------------------------------------------------------------------------

export const webSearchDelegate: DelegateHandler = {
  id: 'web-search',
  description: 'Web search (Brave free tier, or Claude with approval)',
  requiresApproval: false, // Brave is free; Claude fallback gates itself via the registry
  async execute(input: DelegateInput, deps: TaskOrchestratorDeps): Promise<DelegateResult> {
    const query = String(input['query'] ?? '');
    const limit = typeof input['limit'] === 'number' ? input['limit'] : 5;

    if (!query) {
      return { output: 'No search query provided.', format: 'text', success: false, error: 'Empty query' };
    }

    log.info({ query, limit }, 'web search delegate');

    // Try Brave first (free, no approval)
    const braveResult = await braveSearch(query, limit);
    if (braveResult.success && braveResult.output) {
      log.info({ query, provider: 'brave' }, 'web search complete');
      return braveResult;
    }

    // Fallback to Claude -- re-enter the registry so the approval gate fires.
    // The 'web-search:claude' delegate is registered with requiresApproval=true
    // and supplies its own buildApprovalGate / applyEdit hooks.
    log.info({ query, provider: 'claude' }, 'falling back to Claude web search (with approval)');
    const { executeDelegate } = await import('./registry.js');
    const result = await executeDelegate(
      'web-search:claude',
      { query, limit },
      deps,
      -1,
      'Web search via Claude',
    );
    return {
      output: result.output,
      format: result.format,
      success: result.success,
      error: result.error,
    };
  },
};

// ---------------------------------------------------------------------------
// Handler: Claude-only (always requires approval)
// ---------------------------------------------------------------------------

export const claudeWebSearchDelegate: DelegateHandler = {
  id: 'web-search:claude',
  description: 'Web search via Claude (costs apply)',
  requiresApproval: true,
  buildApprovalGate(input) {
    const query = String(input['query'] ?? '');
    return {
      title: 'Approve Claude web search',
      content:
        `The research agent wants to search the web via Claude:\n\n> ${query}\n\n` +
        `This uses the Anthropic API (costs apply) and sends the query to Anthropic.`,
      actions: [
        { name: 'approve', label: 'Approve' },
        { name: 'skip', label: 'Skip' },
        { name: 'edit', label: 'Edit query', needsInput: true },
      ],
    };
  },
  applyEdit(input, feedback) {
    return { ...input, query: feedback };
  },
  async execute(input: DelegateInput, deps: TaskOrchestratorDeps): Promise<DelegateResult> {
    const query = String(input['query'] ?? '');
    if (!query) {
      return { output: 'No search query provided.', format: 'text', success: false, error: 'Empty query' };
    }
    return claudeWebSearch(query, deps);
  },
};

// ---------------------------------------------------------------------------
// Handler: Brave-only (no approval)
// ---------------------------------------------------------------------------

export const braveWebSearchDelegate: DelegateHandler = {
  id: 'web-search:brave',
  description: 'Web search via Brave (free)',
  requiresApproval: false,
  async execute(input: DelegateInput): Promise<DelegateResult> {
    const query = String(input['query'] ?? '');
    const limit = typeof input['limit'] === 'number' ? input['limit'] : 5;
    if (!query) {
      return { output: 'No search query provided.', format: 'text', success: false, error: 'Empty query' };
    }
    return braveSearch(query, limit);
  },
};
