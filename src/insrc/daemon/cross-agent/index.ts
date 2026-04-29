/**
 * Cross-agent surface barrel
 * (plans/analyzers/code-analyzer.md Phase 3).
 *
 * Aggregates the family-level cross-agent registrations. Today
 * only the Code Analyzer's `code:*` tools live here; sibling
 * families (data-analyzer, deployment-analyzer) will register
 * their own modules alongside when they ship.
 */

import { registerCodeAnalyzerCrossAgentTools as registerLookups } from './code-tools.js';
import { registerCodeAnalyzeFlow2Tool } from './code-analyze.js';

export {
	codeLocateTool,
	codeTraceTool,
	codeDescribeTool,
} from './code-tools.js';
export { codeAnalyzeTool } from './code-analyze.js';

/**
 * Register the full Code Analyzer cross-agent surface:
 *   - lookup tools (code:locate / code:trace / code:describe)
 *   - Flow-2 dispatch entry (code:analyze)
 *
 * Called from the daemon bootstrap after `registerBuiltinTools()`.
 * Sibling families (data-analyzer, deployment-analyzer) will export
 * their own register helpers and call alongside when they ship.
 */
export function registerCodeAnalyzerCrossAgentTools(): void {
	registerLookups();
	registerCodeAnalyzeFlow2Tool();
}
