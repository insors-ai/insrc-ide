#!/usr/bin/env node
/**
 * Mirror all `*.md` files from this daemon source tree (src/insrc/)
 * to the compiled output tree (out/insrc/), preserving directory
 * structure. Used as a post-tsc step for `npm run build` so prompt
 * MDs ship alongside the compiled JS.
 *
 * Why this exists: tsc only emits `.ts` -> `.js`/`.d.ts` and does NOT
 * copy arbitrary files. The code-analyzer's externalized prompts live
 * as `.md` files next to their loaders; the daemon's `loader.ts`
 * reads them at runtime via `import.meta.url`-relative paths. They
 * must exist in `out/insrc/...` for production builds (including the
 * cloned-install path at `~/.insrc/daemon/`).
 *
 * Excludes:
 *   - `node_modules/`         (third-party READMEs)
 *   - `**\/__tests__/`         (test fixtures only relevant to source)
 *
 * Invoked from:
 *   - `npm run build` (src/insrc/package.json `build` script)
 *   - `scripts/build.sh daemon` (repo-root convenience wrapper)
 *   - the daemon installer (src/vs/platform/insrc/electron-main/insrcDaemonInstaller.ts)
 *
 * Pure Node, no external deps -- runs in the cloned daemon dir with
 * just the deps tsc needs.
 */

import { mkdirSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE        = dirname(fileURLToPath(import.meta.url));
const DAEMON_SRC  = resolve(HERE, '..');                  // src/insrc
const DAEMON_OUT  = resolve(DAEMON_SRC, '..', '..', 'out', 'insrc');

const EXCLUDE_DIR_NAMES = new Set(['node_modules', '__tests__']);

function* walkMd(dir) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		if (EXCLUDE_DIR_NAMES.has(name)) continue;
		const abs = join(dir, name);
		let st;
		try { st = statSync(abs); } catch { continue; }
		if (st.isDirectory()) {
			yield* walkMd(abs);
		} else if (name.endsWith('.md')) {
			yield abs;
		}
	}
}

let count = 0;
for (const srcPath of walkMd(DAEMON_SRC)) {
	const relPath = relative(DAEMON_SRC, srcPath);
	const dstPath = join(DAEMON_OUT, relPath);
	mkdirSync(dirname(dstPath), { recursive: true });
	copyFileSync(srcPath, dstPath);
	count++;
}

console.log(`[copy-prompts] mirrored ${count} .md files: ${DAEMON_SRC} -> ${DAEMON_OUT}`);
