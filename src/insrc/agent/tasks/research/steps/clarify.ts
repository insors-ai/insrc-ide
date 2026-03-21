/**
 * Clarify step — gate that asks the user a question mid-research.
 *
 * Used when:
 * - Directory listing needs user to pick files
 * - Ambiguous query needs clarification
 * - Missing context needs user input
 */

import type { AgentStep, StepResult, StepContext } from '../../../framework/types.js';
import type { ResearchState } from '../agent-state.js';
import type { PlanStep } from '../types.js';
import { getLogger } from '../../../../shared/logger.js';

const log = getLogger('research-clarify');

export const clarifyStep: AgentStep<ResearchState> = {
  name: 'clarify',
  async run(state: ResearchState, ctx: StepContext): Promise<StepResult<ResearchState>> {

    // Find the last completed step that triggered clarification
    const lastDone = [...state.plan.steps].reverse().find(s => s.status === 'done');
    const result = lastDone?.result ?? '';

    let title: string;
    let content: string;
    let actions: string[];

    if (state.activeSubflow === 'file' && result.includes('This is a directory.')) {
      // Directory listing — extract file names for action buttons
      const fileNames = extractFileNames(result);
      title = 'Which files should I analyze?';
      content = result;
      actions = ['All files', ...fileNames.slice(0, 8)];
    } else {
      title = 'Clarification needed';
      content = state.missingInfo.length > 0
        ? `I need more information to continue:\n${state.missingInfo.map(m => `- ${m}`).join('\n')}`
        : 'I need your help to continue the investigation.';
      actions = ['Continue with best guess', 'Skip this step'];
    }

    // Send gate
    const gateActions = actions.map(a => ({
      name: a.toLowerCase().replace(/\s+/g, '-'),
      label: a,
      needsInput: false,
    }));
    // Add free-text option
    gateActions.push({ name: 'custom', label: 'Other (type below)', needsInput: true });

    const gateResponse = await ctx.gate({
      stage: 'clarify',
      title,
      content,
      actions: gateActions,
    });

    log.info({ action: gateResponse.action, feedback: gateResponse.feedback?.slice(0, 100) }, 'user clarification received');

    // Store clarification
    const clarification = {
      question: title,
      answer: gateResponse.feedback ?? gateResponse.action ?? 'no response',
    };
    const updatedClarifications = [...state.clarifications, clarification];

    // Process the response
    if (state.activeSubflow === 'file') {
      return handleFileSelection(state, gateResponse, updatedClarifications);
    }

    // Generic clarification — continue investigating
    return {
      state: {
        ...state,
        clarifications: updatedClarifications,
        activeSubflow: null,
      },
      next: 'investigate',
    };
  },
};

// ---------------------------------------------------------------------------
// File selection handler
// ---------------------------------------------------------------------------

function handleFileSelection(
  state: ResearchState,
  response: { action?: string | undefined; feedback?: string | undefined },
  clarifications: ResearchState['clarifications'],
): StepResult<ResearchState> {
  const answer = response.feedback ?? response.action ?? '';
  const lastDir = [...state.plan.steps].reverse().find(s => s.status === 'done' && s.result?.includes('This is a directory.'));
  const dirPath = lastDir?.target ?? '';

  let newSteps: PlanStep[] = [];

  if (answer === 'All files' || answer.toLowerCase().includes('all')) {
    // Add read steps for all files in the listing
    const fileNames = extractFileNames(lastDir?.result ?? '');
    newSteps = fileNames.map((name, i) => ({
      id: state.plan.steps.length + i,
      action: 'read-file' as const,
      target: `${dirPath}/${name}`,
      reason: 'User selected: all files',
      status: 'pending' as const,
    }));
  } else {
    // User specified a file or selected from actions
    const selectedFiles = answer.split(',').map(f => f.trim()).filter(f => f.length > 0);
    newSteps = selectedFiles.map((name, i) => ({
      id: state.plan.steps.length + i,
      action: 'read-file' as const,
      target: name.startsWith('/') ? name : `${dirPath}/${name}`,
      reason: `User selected: ${name}`,
      status: 'pending' as const,
    }));
  }

  // Add analyze step after the new reads
  if (newSteps.length > 0) {
    newSteps.push({
      id: state.plan.steps.length + newSteps.length,
      action: 'analyze',
      target: 'findings',
      reason: 'Synthesize after reading selected files',
      status: 'pending',
    });
  }

  return {
    state: {
      ...state,
      plan: {
        ...state.plan,
        steps: [...state.plan.steps, ...newSteps],
      },
      clarifications,
      activeSubflow: null,
    },
    next: 'investigate',
  };
}

// ---------------------------------------------------------------------------
// Extract file names from directory listing
// ---------------------------------------------------------------------------

function extractFileNames(listing: string): string[] {
  const files: string[] = [];
  for (const line of listing.split('\n')) {
    const match = line.match(/\[([^\]]+)\]\s+(\S+)/);
    if (match) {
      const sizeOrType = match[1]!.trim();
      const name = match[2]!;
      if (sizeOrType !== 'dir') {
        files.push(name);
      }
    }
  }
  return files;
}
