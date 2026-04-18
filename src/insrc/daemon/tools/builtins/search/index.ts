/**
 * Search tools -- registration entry point.
 */

import { registerTool } from '../../registry.js';
import { searchGlobTool } from './glob.js';
import { searchGrepTool } from './grep.js';
import { searchListDirTool } from './list-dir.js';
import { searchGraphTool, searchGraphQueryTool } from './graph.js';
import { searchRecentTool } from './recent.js';

export function registerSearchTools(): void {
  registerTool(searchGlobTool);
  registerTool(searchGrepTool);
  registerTool(searchListDirTool);
  registerTool(searchGraphTool);
  registerTool(searchGraphQueryTool);
  registerTool(searchRecentTool);
}
