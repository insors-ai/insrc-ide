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
// Section directive: `{{section:path/to/file}}`. The path body may contain
// literal `{{VAR_NAME}}` placeholders so callers can dispatch sections by
// variable (e.g. `{{section:coverage-angles/{{TIER}}}}` -> resolves TIER
// first, then reads `sections/coverage-angles/<tier>.md`). The path is
// either a word/slash/dash character, or a complete `{{VAR}}` placeholder.
const SECTION_RE          = /\{\{section:((?:[\w/\-]|\{\{[A-Z_][A-Z0-9_]*\}\})+)\}\}/g;
const VAR_RE              = /\{\{([A-Z_][A-Z0-9_]*)\}\}/g;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Single-folder flows (one `flow/<name>/system.md`). The patch flow
 * is per-kind -- see `loadPatchPrompt` -- and is not listed here.
 */
export type PromptFlow =
	| 'gather'
	| 'write'
	| 'review'
	// Phase gamma of plans/code-analyzer-discovery-plan-loop.md:
	// new flow MDs for the cloud-driven discovery loop.
	| 'discovery-expand'
	| 'discovery-review'
	| 'execute-step'
	| 'prose-review'
	// Phase 11.B of plans/code-analyzer-hallucination-mitigation.md:
	// dedicated reviewer that scores each claim's evidence-backing.
	| 'claim-grounding';

export type PatchKind = 'fix' | 'add';

export type PromptVars = Record<string, string>;

/**
 * Tier slug used in per-tier section file dispatch
 * (`{{section:coverage-angles/{{TIER}}}}`). The ScopeSize classifier
 * emits S / M / L / XL / XXL / XXXL / XXXXL; the per-tier MD files
 * collapse XL+ tiers to a single `xl` namespace (see plans/
 * code-analyzer-scope-tier-prompts.md: XL+ checklist serves XL,
 * XXL, XXXL, XXXXL).
 *
 * Accepts any ScopeSize-string-shape input to avoid importing the
 * ScopeSize type and creating a circular dep across loader -> classify.
 */
export function normalizeTier(tier: string): 'xl' | 'l' | 'm' | 's' {
	const u = tier.toUpperCase();
	if (u === 'XL' || u === 'XXL' || u === 'XXXL' || u === 'XXXXL') return 'xl';
	if (u === 'L') return 'l';
	if (u === 'M') return 'm';
	if (u === 'S') return 's';
	// Unknown tier -> default to 'm'. Callers should classify first;
	// this is a graceful fallback rather than a hard fail because the
	// orchestrator defaults tier to 'M' for pre-classification runs
	// (CodeAnalysisState.tier default).
	return 'm';
}

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
 * (fix / add) -- each kind has its own composition file under
 * `flow/patch/<kind>/system.md` that swaps the role + output sections
 * while sharing everything else. (`enhance` was folded into `fix`
 * during the scope-tier work -- see plans/code-analyzer-scope-tier-
 * prompts.md.)
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
	const composed = expandSections(raw, vars, 0);
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

function expandSections(text: string, vars: PromptVars, depth: number): string {
	if (depth > INCLUDE_DEPTH_LIMIT) {
		throw new Error(
			`prompt section include cycle or depth > ${INCLUDE_DEPTH_LIMIT}`,
		);
	}
	return text.replace(SECTION_RE, (_match, rawName: string) => {
		// Resolve any `{{VAR}}` placeholders inside the section path BEFORE
		// the file lookup. Lets the flow file dispatch sections by variable
		// (e.g. {{section:coverage-angles/{{TIER}}}} with TIER='xl' reads
		// sections/coverage-angles/xl.md). Missing vars throw the same loud
		// "prompt variable missing" error as a regular {{VAR}} use.
		const name = expandVars(rawName, vars);
		const sectionRaw = readPromptFile(`sections/${name}.md`);
		// Recurse so a section can itself include another section.
		return expandSections(sectionRaw, vars, depth + 1);
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
