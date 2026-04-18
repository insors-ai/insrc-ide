/**
 * Unified tool registry.
 *
 * One place to register, look up, and list tools. Both the LLM
 * tool-call path and the controller task path read from this registry.
 *
 * During migration (stage 2-3) the legacy LLM-tools registry
 * (agent/tools/registry.ts) and the delegates registry
 * (daemon/delegates/registry.ts) become thin shims over this one.
 */

import { getLogger } from '../../shared/logger.js';
import type { Tool } from './types.js';

const log = getLogger('tools-registry');

const byId = new Map<string, Tool>();
/** Reverse lookup from alias -> canonical id. */
const aliasToId = new Map<string, string>();

export function registerTool(tool: Tool): void {
  if (byId.has(tool.id)) {
    log.warn({ id: tool.id }, 'overwriting tool registration');
  }
  byId.set(tool.id, tool);

  if (tool.aliases) {
    for (const alias of tool.aliases) {
      if (byId.has(alias)) {
        log.warn({ alias, canonical: tool.id }, 'alias collides with an existing tool id');
        continue;
      }
      const existingAlias = aliasToId.get(alias);
      if (existingAlias && existingAlias !== tool.id) {
        log.warn({ alias, from: existingAlias, to: tool.id }, 'alias reassigned');
      }
      aliasToId.set(alias, tool.id);
    }
  }

  log.info({ id: tool.id, aliases: tool.aliases ?? [] }, 'tool registered');
}

/** Resolve a name to a canonical Tool. Honors aliases. */
export function getTool(name: string): Tool | undefined {
  const direct = byId.get(name);
  if (direct) { return direct; }
  const canonical = aliasToId.get(name);
  return canonical ? byId.get(canonical) : undefined;
}

export function listTools(): Tool[] {
  return Array.from(byId.values());
}

/**
 * Reset for tests. Do not call from production code -- registrations
 * happen once at daemon startup.
 */
export function _resetRegistryForTests(): void {
  byId.clear();
  aliasToId.clear();
}
