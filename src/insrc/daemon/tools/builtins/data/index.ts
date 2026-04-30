/**
 * Data Analyzer-side built-in tools (Phase 3 of plans/analyzers/data-analyzer.md).
 *
 * Distinct from `db_*` (which lives in `daemon/tools/builtins/db/` and
 * shipped with the data-driver): the `data_*` family is analyzer-
 * native -- it exists to give the data-analyzer's runner higher-level
 * lookups that have no driver equivalent. Phase 3 ships:
 *
 *   - data_lineage       Cross-link a data target to the code that
 *                        reads / writes it via the code knowledge
 *                        graph.
 *
 * Phase 3.2 will add `data_schema-drift`; Phase 4 will register
 * cross-agent wrappers (`data:list-connections`, etc.) that route
 * the existing `db_*` builtins under the cross-agent `data:*`
 * namespace other analyzers consume.
 */

import { registerTool } from '../../registry.js';
import { dataLineageTool } from './lineage.js';

export function registerDataTools(): void {
	registerTool(dataLineageTool);
}
