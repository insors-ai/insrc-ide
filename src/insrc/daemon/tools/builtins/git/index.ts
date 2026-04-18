/**
 * Git tools -- registration entry point.
 *
 * Each tool lives in its own file. This module imports them and hands
 * them to registerTool() so daemon/index.ts only has to call
 * registerGitTools() once at startup.
 */

import { registerTool } from '../../registry.js';
import { gitStatusTool } from './status.js';

export function registerGitTools(): void {
  registerTool(gitStatusTool);
}
