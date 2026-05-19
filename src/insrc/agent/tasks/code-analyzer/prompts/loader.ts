/**
 * Phase 1 of plans/code-analyzer-externalize-prompts.md.
 *
 * Composable Markdown prompt loader. Resolves two layers in order:
 *
 *   1. `{{section:path/to/file}}` includes -- splice in the contents of
 *      `sections/path/to/file.md`. Sections can include other sections;
 *      cycle-safe via depth limit.
 *
 *   2. `{{VAR_NAME}}` variable substitution -- replaced from a caller-
 *      supplied dictionary. A missing variable THROWS (loud failure
 *      beats a silent `undefined` in a prompt).
 *
 * Reads from the directory next to the compiled loader.js (or .ts when
 * running under tsx in tests). Caches reads per file so a daemon
 * process pays I/O exactly once per prompt-file lifetime.
 *
 * Build.sh mirrors all `*.md` from src/insrc to out/insrc preserving
 * paths, so production reads and dev/test reads resolve the same names.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROMPTS_ROOT = dirname(fileURLToPath(import.meta.url));
const fileCache    = new Map<string, string>();

const INCLUDE_DEPTH_LIMIT = 8;
const SECTION_RE          = /\{\{section:([\w/\-]+)\}\}/g;
const VAR_RE              = /\{\{([A-Z_][A-Z0-9_]*)\}\}/g;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Single-folder flows (one `flow/<name>/system.md`). The patch flow
 * is per-kind -- see `loadPatchPrompt` -- and is not listed here.
 */
export type PromptFlow = 'gather' | 'write' | 'review';

export type PatchKind = 'fix' | 'enhance' | 'add';

export type PromptVars = Record<string, string>;

/**
 * Compose a flow-level system prompt. Reads `flow/<flow>/system.md`,
 * recursively expands `{{section:...}}` includes, then substitutes
 * `{{VAR}}` placeholders from `vars`. Returns the composed string,
 * trimmed.
 *
 * Throws on:
 *   - Missing file (flow or any included section).
 *   - Section include cycle (depth > INCLUDE_DEPTH_LIMIT).
 *   - Unresolved `{{VAR}}` placeholder (no entry in `vars`).
 */
export function loadFlowPrompt(flow: PromptFlow, vars: PromptVars): string {
	return loadPromptFile(`flow/${flow}/system.md`, vars);
}

/**
 * Patch-flow specialization. The patch loop dispatches by kind
 * (fix / enhance / add) -- each kind has its own composition file
 * under `flow/patch/<kind>/system.md` that swaps the role + output
 * sections while sharing everything else.
 */
export function loadPatchPrompt(kind: PatchKind, vars: PromptVars): string {
	return loadPromptFile(`flow/patch/${kind}/system.md`, vars);
}

/**
 * Lower-level helper: compose an arbitrary MD file the same way as
 * `loadFlowPrompt` but from an explicit path under the prompts root.
 */
export function loadPromptFile(relPath: string, vars: PromptVars): string {
	const raw      = readPromptFile(relPath);
	const composed = expandSections(raw, 0);
	return expandVars(composed, vars).trim();
}

/**
 * Read a section file directly (no section expansion, no var
 * substitution). Used by tests and by callers that want a raw block.
 */
export function readSection(name: string): string {
	return readPromptFile(`sections/${name}.md`);
}

/**
 * Test-only: clear the file cache. Allows a test to mutate an MD file
 * on disk between reads and verify the new content is picked up. In
 * production the cache is monotonic for the daemon lifetime.
 */
export function _clearCacheForTest(): void {
	fileCache.clear();
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function readPromptFile(relPath: string): string {
	let cached = fileCache.get(relPath);
	if (cached === undefined) {
		const absPath = join(PROMPTS_ROOT, relPath);
		cached = readFileSync(absPath, 'utf8');
		fileCache.set(relPath, cached);
	}
	return cached;
}

function expandSections(text: string, depth: number): string {
	if (depth > INCLUDE_DEPTH_LIMIT) {
		throw new Error(
			`prompt section include cycle or depth > ${INCLUDE_DEPTH_LIMIT}`,
		);
	}
	return text.replace(SECTION_RE, (_match, name: string) => {
		const sectionRaw = readPromptFile(`sections/${name}.md`);
		// Recurse so a section can itself include another section.
		return expandSections(sectionRaw, depth + 1);
	});
}

function expandVars(text: string, vars: PromptVars): string {
	return text.replace(VAR_RE, (_match, key: string) => {
		const value = vars[key];
		if (value === undefined) {
			throw new Error(`prompt variable missing: ${key}`);
		}
		return value;
	});
}
