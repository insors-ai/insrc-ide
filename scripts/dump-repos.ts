/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * One-shot: dump the registered repos from the daemon's LMDB graph.
 * Used to look up the Hadoop repo path + entity-graph state for
 * substrate-implementation tests.
 */

import { listRepos } from '../src/insrc/db/repos.js';
import { getDb } from '../src/insrc/db/client.js';

async function main(): Promise<void> {
	const db = await getDb();
	const repos = await listRepos(db);
	for (const r of repos) {
		console.log(JSON.stringify(r, null, 2));
	}
}

void main().catch((err) => {
	console.error('dump-repos failed:', err);
	process.exit(1);
});
