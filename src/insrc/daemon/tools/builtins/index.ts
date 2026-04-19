/**
 * Builtin tools -- registration aggregator.
 *
 * One entry point for daemon/index.ts. Each domain plugs in via its
 * `registerXTools()` call. The set of domains that actually register
 * is gated by `insrc.tools.enabledCategories` (pushed from the IDE
 * via `tools.config.set`); categories not in the whitelist are
 * skipped at startup so the agent cannot invoke them.
 */

import { getLogger } from '../../../shared/logger.js';
import { getToolSettings } from '../config.js';
import { registerGitTools } from './git/index.js';
import { registerFileTools } from './file/index.js';
import { registerShellTools } from './shell/index.js';
import { registerSearchTools } from './search/index.js';
import { registerGhTools } from './gh/index.js';
import { registerSshTools } from './ssh/index.js';
import { registerHttpTools } from './http/index.js';
import { registerK8sTools } from './k8s/index.js';
import { registerCloudTools } from './cloud/index.js';
import { registerDiffTools } from './diff/index.js';
import { registerNotifyTools } from './notify/index.js';
import { registerTestTools } from './test/index.js';
import { registerPkgTools } from './pkg/index.js';
import { registerWebTools } from './web/index.js';
import { registerGraphTools } from './graph/index.js';
import { registerPlanTools } from './plan/index.js';
import { registerLlmAliases } from './llm-aliases.js';

const log = getLogger('tools-builtins');

const CATEGORIES: Readonly<Record<string, () => void>> = {
  git:    registerGitTools,
  file:   registerFileTools,
  shell:  registerShellTools,
  search: registerSearchTools,
  gh:     registerGhTools,
  ssh:    registerSshTools,
  http:   registerHttpTools,
  k8s:    registerK8sTools,
  cloud:  registerCloudTools,
  diff:   registerDiffTools,
  notify: registerNotifyTools,
  test:   registerTestTools,
  pkg:    registerPkgTools,
  web:    registerWebTools,
  graph:  registerGraphTools,
  plan:   registerPlanTools,
};

export function registerBuiltinTools(): void {
  const enabled = new Set(getToolSettings().enabledCategories);
  const skipped: string[] = [];
  for (const [category, register] of Object.entries(CATEGORIES)) {
    if (enabled.has(category)) {
      register();
    } else {
      skipped.push(category);
    }
  }
  if (skipped.length > 0) {
    log.info({ skipped }, 'tool categories disabled by insrc.tools.enabledCategories');
  }

  // Legacy LLM-name aliases always run; they no-op against categories
  // whose canonical ids weren't registered because registerToolAlias
  // refuses aliases for missing tools.
  registerLlmAliases();
}
