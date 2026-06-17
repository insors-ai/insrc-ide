/**
 * Config management module — barrel exports.
 *
 * @deprecated since 2026-06-17. The memory substrate (`src/insrc/daemon/substrate/`)
 * is the canonical memory + preference system. See
 * [`design/memory-context.html`](../../../design/memory-context.html) for the
 * consolidation path. This module retires when its remaining consumers migrate:
 *   - agent/planner/         -> retires with /plan template M4.b
 *   - agent/tasks/delegate/  -> retires when Delegate migrates
 *   - agent/tasks/brainstorm/
 *   - agent/tasks/designer/
 *   - agent/tasks/pair/
 *   - agent/tasks/tester/
 * Tracking in `plans/TODO.md`. **No new code should consume this module.**
 */

// Store
export { ConfigStore } from './store.js';

// Search
export { searchConfig, resolveTemplate } from './search.js';

// Frontmatter
export { parseConfigFrontmatter, stripFrontmatter } from './frontmatter.js';
export type { ConfigFrontmatter } from './frontmatter.js';

// Paths
export {
  globalConfigDirs,
  projectConfigDirs,
  projectConfigBase,
  inferNamespaceFromPath,
  classifyConfigPath,
  configEntryId,
  formatScope,
  parseScope,
} from './paths.js';

// Loader
export { loadProjectConfig, resolveConfig, deepMerge } from './loader.js';

// Feedback
export { recordFeedback, classifyFeedbackScope } from './feedback.js';

// Templates
export { bootstrapTemplates } from './templates.js';
