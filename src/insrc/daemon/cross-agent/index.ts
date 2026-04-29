/**
 * Cross-agent surface barrel
 * (plans/analyzers/code-analyzer.md Phase 3).
 *
 * Aggregates the family-level cross-agent registrations. Today
 * only the Code Analyzer's `code:*` tools live here; sibling
 * families (data-analyzer, deployment-analyzer) will register
 * their own modules alongside when they ship.
 */

export {
	registerCodeAnalyzerCrossAgentTools,
	codeLocateTool,
	codeTraceTool,
	codeDescribeTool,
} from './code-tools.js';
