/**
 * Data-driver RPC handlers surfaced on the daemon IPC server.
 *
 * Phase 3 ships `db.listConnections` (read-only) so the workbench
 * pane can render connections. Setup UX (add / edit / remove /
 * test) lands with phase 2 and goes via matching handlers here.
 *
 * The list call honors the active repo; the caller passes
 * `repoRoot` when it wants a specific repo (Data Sources pane can
 * target any registered repo), otherwise we fall back to the
 * active session's repoPath discovered by the IPC server.
 */

import { getLogger } from '../shared/logger.js';
import { loadConnections } from './db/config.js';

const log = getLogger('db-rpc');

export interface ListConnectionsResult {
	readonly id: string;
	readonly kind: string;
	readonly family: 'rdbms' | 'kv' | 'file';
	readonly label?: string;
}

export async function listConnectionsRpc(
	params: { readonly repoRoot?: unknown },
): Promise<readonly ListConnectionsResult[]> {
	const repoRoot = typeof params.repoRoot === 'string' ? params.repoRoot : '';
	if (repoRoot === '') {
		log.warn('db.listConnections called without repoRoot');
		return [];
	}
	try {
		const { resolved } = await loadConnections(repoRoot);
		return resolved.map(c => {
			const base: ListConnectionsResult = {
				id: c.id,
				kind: c.kind,
				family: (c.family ?? 'rdbms') as 'rdbms' | 'kv' | 'file',
			};
			return c.label === undefined ? base : { ...base, label: c.label };
		});
	} catch (err) {
		log.warn({ repoRoot, err: (err as Error).message }, 'listConnections failed');
		return [];
	}
}
