/**
 * loadActiveConnections -- shared helper to discover registered DB
 * connections at the start of a data-analyzer run.
 *
 * Originally lived as a private method on
 * DataAnalyzerOrchestratorController (`_loadConnections`). Extracted
 * so the cross-agent flow-2 entry point
 * (`daemon/cross-agent/data-analyze.ts`) can build the connections
 * list the same way before invoking `runDataDiscoveryPipeline`.
 *
 * Returns an empty list (not null / throw) when discovery fails, so
 * the caller can short-circuit with a structured no-connections
 * outcome instead of crashing.
 */

import type { Session } from '../../session.js';
import { executeTool } from '../../tools/executor.js';
import { getLogger } from '../../../shared/logger.js';
import type { ConnectionSummary } from './types.js';

const log = getLogger('data-analyzer:load-connections');

/**
 * Discover the active connection set by invoking the
 * `db_list_connections` data-driver tool. Same logic the orchestrator
 * uses at run-start; extracted here so non-orchestrator callers
 * (cross-agent flow) can share it.
 */
export async function loadActiveConnections(session: Session): Promise<readonly ConnectionSummary[]> {
	try {
		const r = await executeTool(
			{ id: 'discover', name: 'db_list_connections', input: {} },
			{ session },
		);
		if (r.isError) {
			log.warn({ content: r.content.slice(0, 200) }, 'loadActiveConnections: db_list_connections failed');
			return [];
		}
		const rawRows = (r as { metadata?: { rows?: unknown } }).metadata?.rows;
		const rows = Array.isArray(rawRows) ? rawRows : [];
		return rows.map((row): ConnectionSummary => {
			const r2 = row as Record<string, unknown>;
			const family = (typeof r2['family'] === 'string' ? r2['family'] : 'other') as ConnectionSummary['family'];
			return {
				id:          typeof r2['id'] === 'string' ? r2['id'] : '',
				family,
				kind:        typeof r2['kind'] === 'string' ? r2['kind'] : '',
				...(typeof r2['label'] === 'string' ? { label: r2['label'] as string } : {}),
				prod:        r2['prod'] === true,
				hasPiiConfig: r2['hasPiiConfig'] === true,
			};
		}).filter(c => c.id.length > 0);
	} catch (err) {
		log.warn({ err: (err as Error).message }, 'loadActiveConnections: threw');
		return [];
	}
}
