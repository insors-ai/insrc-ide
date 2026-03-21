import type { ToolDefinition } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Tool backend types
// ---------------------------------------------------------------------------

export type ToolBackend = 'builtin' | 'mcp';

export interface RegisteredTool {
  definition: ToolDefinition;
  backend: ToolBackend;
}

// ---------------------------------------------------------------------------
// Tool definitions — schemas for all tools the LLM can call
// ---------------------------------------------------------------------------

const BUILTIN_TOOLS: ToolDefinition[] = [
  {
    name: 'Read',
    description: 'Read a file from disk. Returns the file contents.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to read' },
        offset: { type: 'number', description: 'Line number to start reading from (optional)' },
        limit: { type: 'number', description: 'Number of lines to read (optional)' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'Write',
    description: 'Write content to a file, creating it if it does not exist.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to write' },
        content: { type: 'string', description: 'The content to write' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'Edit',
    description: 'Replace a string in a file. The old_string must match exactly.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to edit' },
        old_string: { type: 'string', description: 'The exact text to find and replace' },
        new_string: { type: 'string', description: 'The replacement text' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences (default false)' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'Glob',
    description: 'Search for files by glob pattern. Returns matching file paths.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g. "src/**/*.ts")' },
        path: { type: 'string', description: 'Base directory to search in (optional)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Grep',
    description: 'Search file contents by regex pattern. Returns matching lines or file paths.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'File or directory to search in (optional)' },
        glob: { type: 'string', description: 'Glob to filter files (e.g. "*.ts") (optional)' },
        include_context: { type: 'number', description: 'Lines of context around matches (optional)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Bash',
    description: 'Execute a shell command and return its output.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default 120000)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'WebSearch',
    description: 'Search the web and return results.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'WebFetch',
    description: 'Fetch the content of a URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
      },
      required: ['url'],
    },
  },
  {
    name: 'ListDirectory',
    description: 'List files and directories at a path. Returns names with type (file/dir).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list' },
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
    description: 'Show directory tree structure with configurable depth. Useful for project layout.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Root directory path' },
        depth: { type: 'number', description: 'Max depth (default 3)' },
        pattern: { type: 'string', description: 'Filter pattern (e.g. "*.ts") (optional)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'Diff',
    description: 'Show differences between two files, or git diff for a file.',
    inputSchema: {
      type: 'object',
      properties: {
        file_a: { type: 'string', description: 'First file path (or file for git diff)' },
        file_b: { type: 'string', description: 'Second file path (optional)' },
        context: { type: 'number', description: 'Lines of context (default 3)' },
      },
      required: ['file_a'],
    },
  },
  {
    name: 'GitLog',
    description: 'Show git commit history for a file or repo.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path or repo directory' },
        limit: { type: 'number', description: 'Max commits (default 10)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'GitBlame',
    description: 'Show line-by-line git blame (author, date, commit) for a file.',
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
];

const MCP_TOOLS: ToolDefinition[] = [
  {
    name: 'graph_entity',
    description: 'Fetch a single entity by ID. Returns body, signature, file, line range, metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Entity ID (SHA256 hex)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'graph_search',
    description: 'Vector similarity search over entity embeddings. Returns ranked entities with scores.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query' },
        limit: { type: 'number', description: 'Max results (default 10)' },
        kind: { type: 'string', description: 'Filter by entity kind (optional)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'graph_callers',
    description: 'Return entities that call a given entity, up to N hops.',
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name or ID' },
        hops: { type: 'number', description: 'Max hop depth (default 1)' },
        full_body: { type: 'boolean', description: 'Include full body text (default false — signatures only)' },
      },
      required: ['entity'],
    },
  },
  {
    name: 'graph_callees',
    description: 'Return entities called by a given entity, up to N hops.',
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name or ID' },
        hops: { type: 'number', description: 'Max hop depth (default 1)' },
        full_body: { type: 'boolean', description: 'Include full body text (default false — signatures only)' },
      },
      required: ['entity'],
    },
  },
  {
    name: 'graph_query',
    description: 'Execute an arbitrary Cypher query against the knowledge graph.',
    inputSchema: {
      type: 'object',
      properties: {
        cypher: { type: 'string', description: 'Cypher query string' },
      },
      required: ['cypher'],
    },
  },
  {
    name: 'plan_get',
    description: 'Fetch the active plan and its steps with current state for a repo.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo path (optional — uses session repo if omitted)' },
      },
      required: [],
    },
  },
  {
    name: 'plan_step_update',
    description: 'Transition a plan step state (pending → in_progress → done/failed/skipped).',
    inputSchema: {
      type: 'object',
      properties: {
        step_id: { type: 'string', description: 'Plan step ID' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'failed', 'skipped'], description: 'New status' },
        note: { type: 'string', description: 'Optional note about the transition' },
      },
      required: ['step_id', 'status'],
    },
  },
  {
    name: 'plan_next_step',
    description: 'Get the next unblocked step for a plan (first pending step with all dependencies satisfied).',
    inputSchema: {
      type: 'object',
      properties: {
        planId: { type: 'string', description: 'Plan ID' },
      },
      required: ['planId'],
    },
  },
];

const LSP_TOOLS: ToolDefinition[] = [
  {
    name: 'lsp_diagnostics',
    description: 'Get compiler/linter diagnostics (errors, warnings) for a file.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file (optional: omit for all files)' },
        severity: { type: 'string', description: 'Filter: "error", "warning", "info", "hint" (optional)' },
      },
      required: [],
    },
  },
  {
    name: 'lsp_definitions',
    description: 'Go to definition: find where a symbol at a given position is defined.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file' },
        line: { type: 'number', description: 'Line number (1-based)' },
        column: { type: 'number', description: 'Column number (1-based)' },
      },
      required: ['file_path', 'line', 'column'],
    },
  },
  {
    name: 'lsp_references',
    description: 'Find all references to a symbol at a given position.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file' },
        line: { type: 'number', description: 'Line number (1-based)' },
        column: { type: 'number', description: 'Column number (1-based)' },
      },
      required: ['file_path', 'line', 'column'],
    },
  },
  {
    name: 'lsp_hover',
    description: 'Get type information and documentation for a symbol at a given position.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file' },
        line: { type: 'number', description: 'Line number (1-based)' },
        column: { type: 'number', description: 'Column number (1-based)' },
      },
      required: ['file_path', 'line', 'column'],
    },
  },
  {
    name: 'lsp_symbols',
    description: 'List all symbols (functions, classes, variables) in a file.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file' },
      },
      required: ['file_path'],
    },
  },
];

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const REGISTRY: RegisteredTool[] = [
  ...BUILTIN_TOOLS.map(d => ({ definition: d, backend: 'builtin' as const })),
  ...MCP_TOOLS.map(d => ({ definition: d, backend: 'mcp' as const })),
  ...LSP_TOOLS.map(d => ({ definition: d, backend: 'builtin' as const })),
];

const REGISTRY_MAP = new Map<string, RegisteredTool>(
  REGISTRY.map(t => [t.definition.name, t]),
);

/**
 * Get all tool definitions for injection into LLM prompts.
 * Optionally filter to only tools whose backend is available.
 */
export function getToolDefinitions(opts?: { mcpAvailable?: boolean }): ToolDefinition[] {
  if (opts?.mcpAvailable === false) {
    return REGISTRY
      .filter(t => t.backend === 'builtin')
      .map(t => t.definition);
  }
  return REGISTRY.map(t => t.definition);
}

/**
 * Look up a registered tool by name.
 */
export function getTool(name: string): RegisteredTool | undefined {
  return REGISTRY_MAP.get(name);
}

/**
 * Get just the builtin tool definitions.
 */
export function getBuiltinTools(): ToolDefinition[] {
  return BUILTIN_TOOLS;
}

/**
 * Get just the MCP (daemon) tool definitions.
 */
export function getMcpTools(): ToolDefinition[] {
  return MCP_TOOLS;
}
