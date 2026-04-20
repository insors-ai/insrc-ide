/**
 * Idea generation, technique selection, and parsing.
 */

import { createHash } from 'node:crypto';
import type { LLMProvider, AgentConfig } from '../../../shared/types.js';
import type { BrainstormState } from './agent-state.js';
import type { BrainstormInput, EntityIndex, Idea, IdeaRef, IdeaSource, IdeaStatus } from './types.js';
import { buildStepContext } from './context-builder.js';
import { SEED_SYSTEM } from './prompts.js';

// ---------------------------------------------------------------------------
// Seed ideas
// ---------------------------------------------------------------------------

/**
 * Generate the initial idea burst from the problem statement.
 * Returns the problem analysis and 5–10 seed ideas.
 */
export async function generateSeedIdeas(
  input: BrainstormInput,
  codebaseFindings: string,
  provider: LLMProvider,
  configContext?: string,
  entityIndex?: EntityIndex,
): Promise<{ analysis: string; ideas: Idea[] }> {
  const userParts = ['## Problem Statement', input.message];

  if (input.codeContext) {
    userParts.push('', '## Code Context', input.codeContext);
  }
  if (codebaseFindings) {
    userParts.push('', '## Codebase Findings', codebaseFindings);
  }
  if (input.existingSpec) {
    userParts.push('', '## Existing Spec (Continue From)', input.existingSpec);
  }
  if (configContext) {
    userParts.push('', configContext);
  }

  const response = await provider.complete(
    [
      { role: 'system', content: SEED_SYSTEM },
      { role: 'user', content: userParts.join('\n') },
    ],
    { maxTokens: 3000, temperature: 0.5 },
  );

  return parseSeedOutput(response.text, input.session.repoPath, entityIndex);
}

export function parseSeedOutput(
  text: string,
  repoPath: string,
  entityIndex?: EntityIndex,
): { analysis: string; ideas: Idea[] } {
  // Split at ## Analysis if present
  const analysisSplit = text.split(/^##\s*Analysis/im);
  let analysis: string;
  let ideaText: string;

  if (analysisSplit.length >= 2) {
    // Find where ideas start
    const afterAnalysis = analysisSplit.slice(1).join('## Analysis');
    const ideaSplit = afterAnalysis.split(/\n\[1\]/);
    analysis = ideaSplit[0]?.trim() ?? '';
    ideaText = ideaSplit.length >= 2 ? '[1]' + ideaSplit.slice(1).join('\n[1]') : afterAnalysis;
  } else {
    analysis = '';
    ideaText = text;
  }

  const ideas = parseIdeaList(ideaText, 1, 1, repoPath, entityIndex);
  return { analysis, ideas };
}

// ---------------------------------------------------------------------------
// Diverge ideas
// ---------------------------------------------------------------------------

/** Provocation techniques for divergent thinking. */
const TECHNIQUES = [
  { name: 'What-if inversion', prompt: 'Flip a core assumption: "what if we didn\'t have X?"' },
  { name: 'Edge case mining', prompt: 'Explore boundaries: "what happens when input is empty / huge / malformed?"' },
  { name: 'Analogy transfer', prompt: 'Borrow from a similar domain: "how does X solve this in their context?"' },
  { name: 'Stakeholder lens', prompt: 'View from different users: "what does the admin / new user / API consumer need?"' },
  { name: 'Constraint relaxation', prompt: 'Remove a constraint: "if performance didn\'t matter, what would we build?"' },
  { name: 'Failure mode analysis', prompt: 'Anticipate failures: "how could this go wrong in production?"' },
  { name: 'Decomposition', prompt: 'Break a large idea into smaller, independently implementable pieces.' },
] as const;

/**
 * Select 2–3 provocation techniques based on the current idea landscape.
 * Avoids repeating techniques used in the immediately prior round.
 */
export function selectTechniques(state: BrainstormState): Array<{ name: string; prompt: string }> {
  // Rotate through techniques based on round number
  const offset = ((state.round - 1) * 2) % TECHNIQUES.length;
  const count = state.round <= 2 ? 3 : 2;
  const selected: Array<{ name: string; prompt: string }> = [];

  for (let i = 0; i < count; i++) {
    selected.push(TECHNIQUES[(offset + i) % TECHNIQUES.length]!);
  }
  return selected;
}

/**
 * Generate new ideas via divergent provocation techniques.
 */
export async function generateDivergeIdeas(
  state: BrainstormState,
  provider: LLMProvider,
  config: AgentConfig,
  entityIndex?: EntityIndex,
): Promise<Idea[]> {
  const techniques = selectTechniques(state);
  const techniqueBlock = techniques
    .map(t => `### ${t.name}\n${t.prompt}`)
    .join('\n\n');

  const messages = buildStepContext(state, 'diverge', provider, config);

  // Append technique instructions to the user message
  const lastMsg = messages[messages.length - 1];
  if (lastMsg && lastMsg.role === 'user') {
    lastMsg.content += `\n\n## Techniques to Apply\n${techniqueBlock}`;
  }

  const response = await provider.complete(messages, {
    maxTokens: 2500,
    temperature: 0.8,
  });

  return parseIdeaList(
    response.text,
    state.round,
    state.nextIdeaIndex,
    state.input.repoPath,
    entityIndex,
  );
}

// ---------------------------------------------------------------------------
// Idea parsing
// ---------------------------------------------------------------------------

/**
 * Parse ideas from LLM output.
 * Format: [N] Text — tags: tag1, tag2 — refs: entity1, entity2
 *
 * When `entityIndex` is provided, each ref name is resolved to a concrete
 * file path (and line) via the index. Refs that don't resolve are dropped
 * to avoid rendering broken links in the UI. When `entityIndex` is not
 * provided, refs are dropped entirely — callers that have entity context
 * (e.g. after a codebase search) should pass it.
 */
export function parseIdeaList(
  text: string,
  round: number,
  startIndex: number,
  repoPath: string,
  entityIndex?: EntityIndex,
): Idea[] {
  const ideas: Idea[] = [];
  // Match lines like [N] or [N] at start of line
  const lines = text.split('\n');
  let currentIndex = startIndex;

  const source: IdeaSource = round === 1 ? 'seed' : 'diverge';

  for (const line of lines) {
    const match = line.match(/^\s*\[(\d+)\]\s*(.+)$/);
    if (!match) continue;

    const rawText = match[2]!.trim();
    const { title, body, tags, refs } = parseIdeaParts(rawText);

    if (body.length < 5) continue; // Skip empty/tiny ideas

    const id = createHash('sha256')
      .update(`${repoPath}:${round}:${currentIndex}`)
      .digest('hex')
      .slice(0, 32);

    const references: IdeaRef[] = resolveRefs(refs, entityIndex);

    ideas.push({
      id,
      index: currentIndex,
      title,
      body,
      status: 'proposed',
      source,
      round,
      tags,
      references,
    });

    currentIndex++;
  }

  return ideas;
}

/**
 * Resolve raw ref names from LLM output into concrete IdeaRefs via the
 * entity index. Names that don't appear in the index are dropped — we'd
 * rather show no reference than a link that 404s on click.
 */
function resolveRefs(refs: string[], entityIndex: EntityIndex | undefined): IdeaRef[] {
  if (!entityIndex) return [];
  const out: IdeaRef[] = [];
  for (const raw of refs) {
    // LLMs sometimes produce `ClassName.method`, `file:line`, or stray quotes.
    // Match on the exact name first, then fall back to the last segment.
    const cleaned = raw.replace(/^["'`]|["'`]$/g, '').trim();
    const direct = entityIndex[cleaned];
    const tail = !direct ? entityIndex[cleaned.split(/[.:/]/).pop() ?? ''] : undefined;
    const hit = direct ?? tail;
    if (!hit) continue;
    out.push({
      type: 'code',
      path: hit.path,
      label: cleaned,
      ...(hit.line !== undefined ? { line: hit.line } : {}),
    });
  }
  return out;
}

function parseIdeaParts(raw: string): { title: string; body: string; tags: string[]; refs: string[] } {
  let text = raw;
  let tags: string[] = [];
  let refs: string[] = [];

  // Extract refs: entity1, entity2
  const refsMatch = text.match(/\s*—\s*refs?:\s*(.+?)$/i);
  if (refsMatch) {
    refs = refsMatch[1]!.split(',').map(s => s.trim()).filter(Boolean);
    text = text.slice(0, refsMatch.index);
  }

  // Extract tags: tag1, tag2
  const tagsMatch = text.match(/\s*—\s*tags?:\s*(.+?)$/i);
  if (tagsMatch) {
    tags = tagsMatch[1]!.split(',').map(s => s.trim()).filter(Boolean);
    text = text.slice(0, tagsMatch.index);
  }

  const trimmed = text.trim();

  // Split: title = first sentence (up to first period or 80 chars), body = everything
  const periodIdx = trimmed.indexOf('.');
  const title = periodIdx > 0 && periodIdx <= 80
    ? trimmed.slice(0, periodIdx + 1).trim()
    : trimmed.slice(0, 80).trim();
  const body = trimmed;

  return { title, body, tags, refs };
}

// ---------------------------------------------------------------------------
// User idea selection
// ---------------------------------------------------------------------------

/**
 * Apply user's per-idea selections from gate feedback.
 *
 * Supports formats:
 *   "accept 1,3,5 reject 2 park 4"
 *   "1,3,5" (accept these, reject rest)
 *   Free text → treated as new user ideas
 */
export function applyIdeaSelections(
  ideas: Idea[],
  feedback: string,
  round: number,
  nextIndex: number,
  repoPath: string,
): { ideas: Idea[]; newIdeas: Idea[] } {
  const lower = feedback.toLowerCase().trim();

  // Parse explicit accept/reject/park commands
  const acceptMatch = lower.match(/accept\s+([\d,\s]+)/);
  const rejectMatch = lower.match(/reject\s+([\d,\s]+)/);
  const parkMatch = lower.match(/park\s+([\d,\s]+)/);

  const parseIndices = (m: RegExpMatchArray | null): Set<number> => {
    if (!m) return new Set();
    return new Set(m[1]!.split(/[,\s]+/).map(Number).filter(n => !isNaN(n)));
  };

  const acceptSet = parseIndices(acceptMatch);
  const rejectSet = parseIndices(rejectMatch);
  const parkSet = parseIndices(parkMatch);

  const hasExplicitCommands = acceptSet.size > 0 || rejectSet.size > 0 || parkSet.size > 0;

  // If just numbers with no commands, treat as accept list
  if (!hasExplicitCommands && /^[\d,\s]+$/.test(lower)) {
    const indices = lower.split(/[,\s]+/).map(Number).filter(n => !isNaN(n));
    for (const idx of indices) acceptSet.add(idx);
  }

  const updated = ideas.map(idea => {
    if (idea.status !== 'proposed') return idea;

    let newStatus: IdeaStatus = idea.status;
    if (acceptSet.has(idea.index)) newStatus = 'accepted';
    else if (rejectSet.has(idea.index)) newStatus = 'rejected';
    else if (parkSet.has(idea.index)) newStatus = 'parked';
    else if (hasExplicitCommands) newStatus = idea.status; // Leave unmentioned as-is

    return newStatus !== idea.status ? { ...idea, status: newStatus } : idea;
  });

  // Parse new user ideas from free text lines (not matching command patterns)
  const newIdeas: Idea[] = [];
  const commandPattern = /^(accept|reject|park)\s+[\d,\s]+/;
  const numberPattern = /^[\d,\s]+$/;
  const lines = feedback.split('\n').filter(l => {
    const trimmed = l.trim();
    return trimmed.length > 10
      && !commandPattern.test(trimmed.toLowerCase())
      && !numberPattern.test(trimmed);
  });

  let idx = nextIndex;
  for (const line of lines) {
    const id = createHash('sha256')
      .update(`${repoPath}:${round}:user:${idx}`)
      .digest('hex')
      .slice(0, 32);
    const userText = line.trim();
    const periodIdx = userText.indexOf('.');
    const userTitle = periodIdx > 0 && periodIdx <= 80
      ? userText.slice(0, periodIdx + 1).trim()
      : userText.slice(0, 80).trim();

    newIdeas.push({
      id,
      index: idx,
      title: userTitle,
      body: userText,
      status: 'accepted',
      source: 'user',
      round,
      tags: [],
      references: [],
    });
    idx++;
  }

  return { ideas: updated, newIdeas };
}
