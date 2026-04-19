/**
 * Builtin tools -- registration aggregator.
 *
 * One entry point for daemon/index.ts so each new domain (git, gh,
 * file, shell, ssh, http, k8s, cloud, diff, notifications, lsp, test,
 * pkg) plugs in by adding its registerXTools() call below.
 */

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

export function registerBuiltinTools(): void {
  registerGitTools();
  registerFileTools();
  registerShellTools();
  registerSearchTools();
  registerGhTools();
  registerSshTools();
  registerHttpTools();
  registerK8sTools();
  registerCloudTools();
  registerDiffTools();
  registerNotifyTools();
  registerTestTools();
  registerPkgTools();
  registerWebTools();
  registerGraphTools();
  registerPlanTools();
  registerLlmAliases();
}
