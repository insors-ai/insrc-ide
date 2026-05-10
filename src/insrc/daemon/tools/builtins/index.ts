/**
 * Builtin tools -- registration aggregator.
 *
 * One entry point for daemon/index.ts. Each domain plugs in via its
 * `registerXTools()` call; every domain registers unconditionally.
 * Per-action permission gates (approval, fs-access, cross-agent
 * depth) handle authorisation; we don't double-gate at registry
 * lookup time.
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
import { registerArtifactTools } from './artifact/index.js';
import { registerDbTools } from './db/index.js';
import { registerDataTools } from './data/index.js';
import { registerCodeTools } from './code/index.js';
import { registerSkillTools } from './skills/invoke-skill.js';
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
  registerArtifactTools();
  registerDbTools();
  registerDataTools();
  registerCodeTools();
  registerSkillTools();

  // Legacy LLM-name aliases (Read / Grep / Bash / WebSearch / ...)
  // run last; they're alias-only and no-op against tools whose
  // canonical id wasn't registered.
  registerLlmAliases();
}
