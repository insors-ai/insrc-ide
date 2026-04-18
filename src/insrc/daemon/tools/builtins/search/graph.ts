/**
 * search:graph-search and search:graph-query -- thin forwarders to the
 * legacy `graph_search` / `graph_query` LLM tools, which already go
 * through the MCP bridge into the daemon's search/graph layer.
 *
 * Keeping the new ids in the `search:` namespace gives agents a
 * consistent surface while we migrate; stage 5 future work can
 * replace the forwarders with direct searchEntities / Kuzu calls
 * once the graph API is exposed in ToolDeps.
 */

import { executeTool } from '../../executor.js';
import type { Tool, ToolInput, ToolResult } from '../../types.js';

async function forward(
  canonicalId: string,
  input: ToolInput,
  deps: Parameters<Tool['execute']>[1],
): Promise<ToolResult> {
  return executeTool(canonicalId, input, deps);
}

export const searchGraphTool: Tool = {
  id: 'search:graph',
  description: 'Semantic search over indexed code entities (vector ANN).',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      limit: { type: 'number', minimum: 1, maximum: 100 },
    },
    required: ['query'],
    additionalProperties: false,
  },
  requiresApproval: false,
  execute(input, deps) { return forward('graph_search', input, deps); },
};

export const searchGraphQueryTool: Tool = {
  id: 'search:graph-query',
  description: 'Run a Cypher query against the Kuzu code knowledge graph.',
  inputSchema: {
    type: 'object',
    properties: {
      cypher: { type: 'string', description: 'Cypher query.' },
      params: { type: 'object', description: 'Named parameters.' },
    },
    required: ['cypher'],
    additionalProperties: false,
  },
  requiresApproval: false,
  execute(input, deps) { return forward('graph_query', input, deps); },
};
