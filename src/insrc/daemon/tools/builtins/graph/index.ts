/**
 * Graph tools -- entity / search / callers / callees / query.
 *
 * Calls into the Kuzu + LanceDB layers directly; no legacy MCP
 * round-trip. Session.closureRepos scopes every search to the
 * active repo's dependency closure so results stay relevant.
 */

import { getDb } from '../../../../db/client.js';
import { searchEntities, findCallers, findCallees } from '../../../../db/search.js';
import { getEntity } from '../../../../db/entities.js';
import { embedQuery } from '../../../../indexer/embedder.js';
import { registerTool } from '../../registry.js';
import type { Entity } from '../../../../shared/types.js';
import type { Tool, ToolDeps, ToolInput, ToolResult } from '../../types.js';

function str(input: ToolInput, key: string): string | undefined {
  const v = input[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(input: ToolInput, key: string): number | undefined {
  const v = input[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function bool(input: ToolInput, key: string): boolean | undefined {
  const v = input[key];
  return typeof v === 'boolean' ? v : undefined;
}

function fail(id: string, msg: string): ToolResult {
  return { output: `[${id}] ${msg}`, format: 'text', success: false, error: msg };
}

function shortEntity(e: Entity): Record<string, unknown> {
  return {
    id: e.id,
    name: e.name,
    kind: e.kind,
    file: e.file,
    startLine: e.startLine,
    endLine: e.endLine,
    repo: e.repo,
    signature: e.signature,
  };
}

function renderEntity(e: Entity, includeBody: boolean): string {
  const loc = `${e.file}:${e.startLine}${e.endLine > e.startLine ? '-' + e.endLine : ''}`;
  const header = `**${e.kind}** \`${e.name}\`  (${loc})`;
  if (!includeBody) { return header + (e.signature ? `\n  \`${e.signature}\`` : ''); }
  return [
    header,
    e.signature ? `  \`${e.signature}\`` : '',
    e.body ? '```\n' + e.body.slice(0, 2000) + (e.body.length > 2000 ? '\n... (truncated)' : '') + '\n```' : '',
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// graph:entity -- getEntity(id)
// ---------------------------------------------------------------------------

interface GraphEntityData { entity: Entity | null }

export const graphEntityTool: Tool = {
  id: 'graph_entity',
  description: 'Fetch a single entity by ID from the code knowledge graph.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Entity ID (sha256 hex).' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  requiresApproval: false,

  async execute(input: ToolInput): Promise<ToolResult> {
    const id = str(input, 'id');
    if (!id) { return fail('graph_entity', 'id required'); }
    const db = await getDb();
    const entity = await getEntity(db, id);
    const data: GraphEntityData = { entity };
    if (!entity) {
      return { output: `No entity with id \`${id}\`.`, format: 'markdown', success: false, error: 'not found', data };
    }
    return {
      output: renderEntity(entity, true),
      format: 'markdown', success: true, data,
    };
  },
};

// ---------------------------------------------------------------------------
// graph:search -- vector ANN over closure repos
// ---------------------------------------------------------------------------

interface GraphSearchData {
  query: string;
  limit: number;
  closureRepos: readonly string[];
  results: ReturnType<typeof shortEntity>[];
}

export const graphSearchTool: Tool = {
  id: 'graph_search',
  description: 'Vector similarity search over indexed code entities, scoped to the session repo closure.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      limit: { type: 'number', minimum: 1, maximum: 100 },
      kind: { type: 'string', description: 'Restrict to entity kind (e.g. function, class). Currently informational only.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  requiresApproval: false,

  async execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
    const query = str(input, 'query');
    if (!query) { return fail('graph_search', 'query required'); }
    const limit = num(input, 'limit') ?? 10;
    const closure = deps.session.closureRepos;
    if (closure.length === 0) {
      return fail('graph_search', 'session has no closure repos initialized');
    }
    const db = await getDb();
    const vec = await embedQuery(query);
    if (vec.length === 0) {
      return fail('graph_search', 'failed to embed query (Ollama unavailable?)');
    }
    const hits = await searchEntities(db, vec, closure, limit);
    const data: GraphSearchData = {
      query, limit,
      closureRepos: closure,
      results: hits.map(shortEntity),
    };
    const rendered = hits.length === 0
      ? '_no matches_'
      : hits.map((e, i) => `${i + 1}. ${renderEntity(e, false)}`).join('\n\n');
    return {
      output: `**${hits.length}** hit(s) for \`${query}\` across ${closure.length} repo(s).\n\n${rendered}`,
      format: 'markdown', success: true, data,
    };
  },
};

// ---------------------------------------------------------------------------
// graph_callers / graph_callees
// ---------------------------------------------------------------------------

interface GraphNeighborsData {
  entityId: string;
  direction: 'callers' | 'callees';
  results: ReturnType<typeof shortEntity>[];
}

function buildNeighborsTool(direction: 'callers' | 'callees'): Tool {
  const id = `graph_${direction}`;
  const label = direction === 'callers' ? 'Entities that call' : 'Entities called by';
  const fn = direction === 'callers' ? findCallers : findCallees;
  return {
    id,
    description: `${label} a given entity (1-hop).`,
    inputSchema: {
      type: 'object',
      properties: {
        entityId: { type: 'string' },
        fullBody: { type: 'boolean', description: 'Include full body text in output (default false -- signatures only).' },
      },
      required: ['entityId'],
      additionalProperties: false,
    },
    requiresApproval: false,

    async execute(input: ToolInput): Promise<ToolResult> {
      const entityId = str(input, 'entityId');
      if (!entityId) { return fail(id, 'entityId required'); }
      const includeBody = bool(input, 'fullBody') === true;
      const db = await getDb();
      const results = await fn(db, entityId);
      const data: GraphNeighborsData = { entityId, direction, results: results.map(shortEntity) };
      const rendered = results.length === 0
        ? '_none_'
        : results.map(e => renderEntity(e, includeBody)).join('\n\n');
      return {
        output: `**${results.length}** ${direction} of \`${entityId}\`.\n\n${rendered}`,
        format: 'markdown', success: true, data,
      };
    },
  };
}

export const graphCallersTool = buildNeighborsTool('callers');
export const graphCalleesTool = buildNeighborsTool('callees');

// ---------------------------------------------------------------------------
// graph:query -- arbitrary Cypher
// ---------------------------------------------------------------------------

interface GraphQueryData {
  cypher: string;
  rowCount: number;
  rows: readonly Record<string, unknown>[];
}

const MAX_QUERY_ROWS = 500;

export const graphQueryTool: Tool = {
  id: 'graph_query',
  description: 'Run an arbitrary Cypher query against the Kuzu code knowledge graph. Read-only usage expected.',
  inputSchema: {
    type: 'object',
    properties: {
      cypher: { type: 'string' },
    },
    required: ['cypher'],
    additionalProperties: false,
  },
  requiresApproval: false,

  async execute(input: ToolInput): Promise<ToolResult> {
    const cypher = str(input, 'cypher');
    if (!cypher) { return fail('graph_query', 'cypher required'); }
    const db = await getDb();
    try {
      const result = await db.graph.query(cypher);
      const qr = Array.isArray(result) ? result[0] : result;
      const rows = (qr as { getAll(): unknown }).getAll() as Record<string, unknown>[];
      const capped = rows.slice(0, MAX_QUERY_ROWS);
      const data: GraphQueryData = { cypher, rowCount: rows.length, rows: capped };
      return {
        output: [
          `Cypher returned **${rows.length}** row(s)${rows.length > MAX_QUERY_ROWS ? ` (showing first ${MAX_QUERY_ROWS})` : ''}.`,
          '```json',
          JSON.stringify(capped, null, 2).slice(0, 12_000),
          '```',
        ].join('\n'),
        format: 'markdown', success: true, data,
      };
    } catch (err: unknown) {
      return fail('graph_query', `cypher failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerGraphTools(): void {
  registerTool(graphEntityTool);
  registerTool(graphSearchTool);
  registerTool(graphCallersTool);
  registerTool(graphCalleesTool);
  registerTool(graphQueryTool);
}
