/**
 * Task builder — converts DecomposedAction[] from the classifier into Task[].
 *
 * Maps intents to task kinds:
 * - infra/deploy/release → shell (command resolved at execution time)
 * - document/research (post-processing) → transform (LLM formatting)
 * - implement/refactor/debug/test/design/plan → agent
 * - everything else → llm (simple completion)
 *
 * Commands are NOT baked in at build time. The decomposer provides a
 * commandHint (best guess), and resolveCommand() in task.ts refines it
 * at execution time using actual prior-task output and ContextManager memory.
 */

import type { DecomposedAction } from '../agent/classifier/decompose.js';
import type { Task, TaskKind, TaskFormat } from './task.js';

// ---------------------------------------------------------------------------
// Intent → TaskKind mapping
// ---------------------------------------------------------------------------

const SHELL_INTENTS = new Set(['infra', 'deploy', 'release']);
const AGENT_INTENTS = new Set(['implement', 'refactor', 'debug', 'test', 'design', 'plan', 'brainstorm', 'requirements', 'research', 'code-analysis']);

function resolveKind(action: DecomposedAction): TaskKind {
  // If it depends on a prior step and is a formatting intent -> transform
  // Note: research is an agent intent even with dependencies (it investigates, not formats)
  if (action.dependsOn !== undefined && action.intent === 'document') {
    return 'transform';
  }

  // Shell intents — command will be resolved at execution time
  if (SHELL_INTENTS.has(action.intent)) return 'shell';

  // Agent intents
  if (AGENT_INTENTS.has(action.intent)) return 'agent';

  // Default: LLM simple completion
  return 'llm';
}

function resolveFormat(action: DecomposedAction): TaskFormat | undefined {
  if (!action.outputFormat) return undefined;
  const fmt = action.outputFormat.toLowerCase();
  if (fmt === 'md' || fmt === 'markdown') return 'markdown';
  if (fmt === 'html') return 'html';
  if (fmt === 'json' || fmt === 'code') return 'code';
  if (fmt === 'table') return 'table';
  if (fmt === 'diff') return 'diff';
  return undefined;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export const TRANSFORM_SYSTEM_PROMPT = `You are a formatting assistant. The user will provide output from a command or process.
Your task is to format the output according to the requested format.
Do NOT add commentary, explanation, or analysis -- only format the data.
Preserve all information from the input.`;

/**
 * Convert decomposed actions into executable tasks.
 *
 * When a shell/rpc action carries an outputFormat, the builder splits it into
 * two tasks: the original command (no format) + a dependent transform task
 * that formats the output. This ensures the LLM doesn't need to produce
 * separate actions for "run X and format as Y" — the builder handles it.
 */
export function buildTasks(actions: DecomposedAction[], originalMessage: string): Task[] {
  const tasks: Task[] = [];
  // Maps original action index → assigned task index (needed for dependsOn
  // remapping when we inject extra transform tasks).
  const indexMap = new Map<number, number>();

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]!;
    const kind = resolveKind(action);
    const format = resolveFormat(action);

    // Remap dependsOn through indexMap so injected transforms don't break deps
    const rawDep = action.dependsOn;
    const mappedDep = rawDep !== undefined && rawDep !== null
      ? indexMap.get(rawDep) ?? rawDep
      : undefined;

    const taskIdx = tasks.length;
    indexMap.set(i, taskIdx);

    const task: Task = {
      index: taskIdx,
      description: action.action,
      kind,
      intent: action.intent,
      dependsOn: mappedDep,
      // Risk defaults to medium for shell tasks — resolveCommand will refine
      // it at execution time when the actual command is known.
      risk: kind === 'shell' ? 'medium' : 'low',
    };

    switch (kind) {
      case 'shell':
        // command is NOT set here — resolved at execution time by resolveCommand().
        // commandHint carries the decomposer's best guess for the resolver LLM.
        task.commandHint = action.commandHint ?? undefined;
        task.requiresGate = true;
        break;

      case 'transform':
        task.outputFormat = format;
        task.systemPrompt = TRANSFORM_SYSTEM_PROMPT;
        task.userMessage = `Format the following output as ${action.outputFormat ?? 'markdown'}:\n\n`;
        break;

      case 'llm':
        task.userMessage = action.action;
        task.outputFormat = format;
        break;

      case 'agent':
        task.agentId = action.intent; // e.g., 'design', 'implement'
        task.userMessage = originalMessage;
        task.persisted = true;
        break;
    }

    tasks.push(task);

    // Auto-inject a transform task when a shell action has outputFormat
    // but the decomposer didn't create a separate formatting step.
    if (kind === 'shell' && format) {
      const transformIdx = tasks.length;
      tasks.push({
        index: transformIdx,
        description: `Format output as ${format}`,
        kind: 'transform',
        intent: 'document',
        outputFormat: format,
        dependsOn: taskIdx,
        risk: 'low',
        systemPrompt: TRANSFORM_SYSTEM_PROMPT,
        userMessage: `Format the following output as ${format}:\n\n`,
      });
      // indexMap keeps pointing to the shell task (not the transform) so
      // downstream deps receive the raw command output, not formatted text.
    }
  }

  return tasks;
}
