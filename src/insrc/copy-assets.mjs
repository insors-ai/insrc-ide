#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Post-tsc copy of non-TS runtime resources -- `assets/` and `prompts/` --
 * from src/insrc into the tsc outDir at ../../out/insrc.
 *
 * Background: tsc only emits compiled .js / .d.ts. The analyze framework's
 * boot validator + the artifact runtimes resolve prompt + asset paths
 * relative to import.meta.url, so the .md / asset trees MUST sit next to
 * the compiled .js or the daemon's startup fails with
 * AnalyzePromptValidationError.
 *
 * scripts/build.sh in the source repo handles this via rsync; the daemon's
 * autoUpdate installer just runs `npm run build` from src/insrc, so the
 * copy step has to live INSIDE npm run build. This file is wired in as
 * `tsc && node copy-assets.mjs`.
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outRoot = resolve(here, '..', '..', 'out', 'insrc');

const DIRS = ['prompts', 'assets'];

let copied = 0;
for (const dir of DIRS) {
	const src = resolve(here, dir);
	if (!existsSync(src)) {
		console.log(`[copy-assets] skipping ${dir} (not present in src)`);
		continue;
	}
	const dst = resolve(outRoot, dir);
	mkdirSync(dst, { recursive: true });
	cpSync(src, dst, { recursive: true });
	console.log(`[copy-assets] copied ${dir}/ -> ${dst}`);
	copied++;
}

if (copied === 0) {
	console.log('[copy-assets] no runtime resources to copy');
}
