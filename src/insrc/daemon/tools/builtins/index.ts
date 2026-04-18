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

export function registerBuiltinTools(): void {
  registerGitTools();
  registerFileTools();
  registerShellTools();
  registerSearchTools();
  registerGhTools();
  registerSshTools();
  registerHttpTools();
}
