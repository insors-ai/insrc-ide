/**
 * Cross-agent surface barrel
 * (plans/analyzers/code-analyzer.md Phase 3,
 *  plans/analyzers/data-analyzer.md Phase 4).
 *
 * Aggregates the family-level cross-agent registrations. Each family
 * exposes its own `register<Family>CrossAgentTools()` helper; the
 * daemon bootstrap calls them after the built-ins are registered so
 * the registry contains every non-cross-agent tool first.
 */

import { registerCodeAnalyzerCrossAgentTools as registerCodeLookups } from './code-tools.js';
import { registerCodeAnalyzeFlow2Tool } from './code-analyze.js';
import { registerDataAnalyzerCrossAgentTools as registerDataLookups } from './data-tools.js';

export {
	codeLocateTool,
	codeTraceTool,
	codeDescribeTool,
} from './code-tools.js';
export { codeAnalyzeTool } from './code-analyze.js';
export {
	dataListConnectionsTool,
	dataDescribeTool,
	dataSampleTool,
	dataScanTool,
	dataGetTool,
	dataSampleShapeTool,
	dataExplainTool,
} from './data-tools.js';

/**
 * Register the full Code Analyzer cross-agent surface:
 *   - lookup tools (code_locate / code_trace / code_describe)
 *   - Flow-2 dispatch entry (code_analyze)
 *
 * Called from the daemon bootstrap after `registerBuiltinTools()`.
 */
export function registerCodeAnalyzerCrossAgentTools(): void {
	registerCodeLookups();
	registerCodeAnalyzeFlow2Tool();
}

/**
 * Register the Data Analyzer cross-agent surface (Phase 4.1 of
 * plans/analyzers/data-analyzer.md):
 *
 *   - Pure-namespace wrappers over `db_*` builtins
 *     (data_list_connections / data_scan / data_get / data_explain).
 *   - Family-dispatch wrappers that route on connection family
 *     (data_describe / data_sample / data_sample_shape).
 *
 * `data_lineage` and `data_schema-drift` are NOT re-registered here
 * -- they live in `daemon/tools/builtins/data/` already and got
 * their depth checks added inline. Cross-agent callers use the same
 * canonical ids as the analyzer's own runner.
 *
 * Phase 4.3's `data_analyze` Flow-2 entry will land alongside this
 * module in a follow-up slice (mirrors `code_analyze`).
 */
export function registerDataAnalyzerCrossAgentTools(): void {
	registerDataLookups();
}
