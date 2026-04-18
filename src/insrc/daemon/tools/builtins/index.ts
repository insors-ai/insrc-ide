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

export function registerBuiltinTools(): void {
  registerGitTools();
  registerFileTools();
  registerShellTools();
}
