/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Quick check: probe specific class entities in the indexed Hadoop
 * workspace to verify substrate-implementation tests have real data
 * to hit (single-match success path + 2-hit ambiguity fixture).
 */

import { getDb } from '../src/insrc/db/client.js';
import { lookupRepoId } from '../src/insrc/db/repos.js';
import { findEntitiesByName } from '../src/insrc/db/entities.js';

const HADOOP = '/Users/subhagho/work/projects/insors/hadoop';

const PROBES = [
	'NameNode',
	'DataNode',
	'HdfsServerConstants',
	'FSDirectory',
	'BlockManager',
	'Configuration',
	'JobTracker',
] as const;

async function main(): Promise<void> {
	await getDb();
	const repoId = await lookupRepoId(HADOOP);
	if (repoId === undefined) {
		console.error('Hadoop repo not registered'); process.exit(1);
	}

	const db = await getDb();
	for (const name of PROBES) {
		const hits = await findEntitiesByName(db, [name], {
			kinds: ['class', 'interface'],
			repo: HADOOP,
			limit: 5,
		});
		console.log(`${name}: ${hits.length} hits`, hits.slice(0, 3).map(h => ({
			id: h.id,
			kind: h.kind,
			file: h.file,
			startLine: h.startLine,
		})));
	}
}

void main().catch((err) => {
	console.error('dump-hadoop-classes failed:', err); process.exit(1);
});
