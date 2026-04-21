/**
 * Canonical list of intent classes fed to the primary-intent classifier.
 * Mirrors the `Intent` union in `types.ts` -- adding a new intent member
 * without adding an entry here will fail the `asIntentClasses` check
 * below at build time.
 *
 * Descriptions are copied from the historical classifier prompts so the
 * LLM gets the same guidance the old per-classifier prompts provided.
 */

import type { Intent } from './types.js';
import type { ClassChoice } from './classify.js';

export interface IntentClass extends ClassChoice {
  readonly id: Intent;
}

export const INTENT_CLASSES: readonly IntentClass[] = [
  { id: 'requirements', description: 'user wants to define what needs to be built (specs, user stories, acceptance criteria)' },
  { id: 'design',       description: 'user wants to reason about architecture, API shape, module boundaries, tradeoffs' },
  { id: 'plan',         description: 'user wants an ordered implementation checklist or task breakdown' },
  { id: 'implement',    description: 'user wants code written, a function added, a feature built' },
  { id: 'refactor',     description: 'user wants existing code restructured without changing behaviour' },
  { id: 'test',         description: 'user wants tests written, run, or coverage improved' },
  { id: 'debug',        description: 'user wants to find and fix a bug, crash, or error' },
  { id: 'review',       description: 'user wants a code review, audit, or critique of existing code' },
  { id: 'document',     description: 'user wants documentation, docstrings, READMEs, changelogs, or ADRs' },
  { id: 'research',     description: 'user wants an explanation, trace, or exploration of how something works (informational questions about existing code / services / endpoints go here)' },
  { id: 'code-analysis', description: 'user wants a structural query about code relationships (callers, callees, dependencies — no prose, just data)' },
  { id: 'brainstorm',   description: 'user wants to explore ideas, generate alternatives, or iterate on a creative / architectural problem' },
  { id: 'deploy',       description: 'user wants to deploy, rollout, or push to an environment' },
  { id: 'release',      description: 'user wants to cut a release, bump a version, publish a package, or generate a changelog' },
  { id: 'infra',        description: 'user wants to query infrastructure status, logs, pods, scaling, or resource utilisation (live commands against running infra)' },
];

// Exhaustiveness check: force the compiler to confirm every Intent has
// a class entry. If you add a new Intent member without an entry here,
// this assignment fails at build time.
const _exhaustivenessCheck: Record<Intent, true> = {
  requirements: true, design: true, plan: true, implement: true,
  refactor: true, test: true, debug: true, review: true, document: true,
  research: true, 'code-analysis': true, brainstorm: true,
  deploy: true, release: true, infra: true,
};
void _exhaustivenessCheck;
