/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Standalone smoke for `code.source.module.describe` against the real
 * daemon storage. Reads only -- safe to run after killing the daemon.
 *
 *   npx tsx scripts/debug-module-describe.ts
 *
 * Reproduces the exact arg set the Devstral run sent (the one with the
 * full absolute path) and prints what the skill actually returns.
 *
 * Also lists registered repos so we can see whether the Hadoop repo
 * is actually in the daemon registry.
 */

import { listRepos } from '../src/insrc/db/repos.js';
import { registerCodeSourceModuleDescribeSkill } from '../src/insrc/daemon/skills/built-ins/code.source.module.describe.js';
import { getSkill } from '../src/insrc/daemon/skills/registry.js';
import type { DbClient } from '../src/insrc/db/client.js';
import type { SkillDeps } from '../src/insrc/daemon/skills/types.js';

// The DbClient + SkillDeps params are sentinel arguments these
// functions ignore at runtime (their signatures kept them for back-
// compat after the substrate was lazy-loaded). Casting an empty
// object is the only thing that actually compiles here -- there is
// no construct-by-default for either interface.

async function main(): Promise<void> {
	// eslint-disable-next-line local/code-no-dangerous-type-assertions
	const _db = {} as DbClient;
	const repos = await listRepos(_db);
	console.log('--- Registered repos ---');
	if (repos.length === 0) {
		console.log('  (none)');
	} else {
		for (const r of repos) {
			console.log(`  id=${r.id} path=${r.path}`);
		}
	}
	console.log();

	registerCodeSourceModuleDescribeSkill();
	const skill = getSkill('code.source.module.describe');
	if (skill === undefined) {
		console.error('skill not registered');
		process.exit(1);
	}

	const args = {
		modulePath: '/Users/subhagho/work/projects/insors/hadoop/hadoop-hdfs-project/hadoop-hdfs/src/main/java/org/apache/hadoop/hdfs/server/namenode',
		repoPath:   '/Users/subhagho/work/projects/insors/hadoop',
	};
	console.log('--- Calling code.source.module.describe with: ---');
	console.log(JSON.stringify(args, null, 2));
	console.log();

	// eslint-disable-next-line local/code-no-dangerous-type-assertions
	const deps = {} as SkillDeps;
	const result = await skill.execute(args, deps);

	console.log('--- value ---');
	const valStr = JSON.stringify(result.value, null, 2);
	console.log(valStr.length > 4000 ? valStr.slice(0, 4000) + `\n... [truncated, total ${valStr.length} chars]` : valStr);
	console.log();
	console.log('confidence:', result.confidence);
	console.log('notes:',      result.notes);

	process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
