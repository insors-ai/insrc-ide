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
 * Parse ideas from LLM output. Supports two formats:
 *
 *  Rich multi-line (preferred, per Item 10):
 *    [N] Title: <short descriptive title>
 *        Body: <2-4 sentence description of the concept, approach, and outcome>
 *        Rationale: <1-2 sentences on motivation / tradeoffs>   (optional)
 *        Tags: tag1, tag2
 *        Refs: entity1, entity2
 *
 *  Legacy single-line (kept for backwards-compat):
 *    [N] Idea text -- tags: tag1, tag2 -- refs: entity1, entity2
 *
 * When `entityIndex` is provided, each ref name is resolved to a concrete
 * file path (and line) via the index. Refs that don't resolve are dropped
 * (TODO: Item 9 will change this to emit unresolved chips).
 */
export function parseIdeaList(
  text: string,
  round: number,
  startIndex: number,
  repoPath: string,
  entityIndex?: EntityIndex,
): Idea[] {
  const ideas: Idea[] = [];
  const lines = text.split('\n');
  let currentIndex = startIndex;

  const source: IdeaSource = round === 1 ? 'seed' : 'diverge';

  // First, group lines into per-idea blocks keyed by the leading [N] marker.
  // A block consists of the marker line plus all subsequent continuation
  // lines until the next marker line (or end of input). Blank lines inside
  // a block are preserved because they're harmless for the parser.
  const blocks: string[] = [];
  let current: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    const isMarker = /^\s*\[\d+\]\s*/.test(line);
    if (isMarker) {
      if (inBlock) blocks.push(current.join('\n'));
      current = [line];
      inBlock = true;
    } else if (inBlock) {
      current.push(line);
    }
  }
  if (inBlock) blocks.push(current.join('\n'));

  for (const block of blocks) {
    const markerMatch = block.match(/^\s*\[(\d+)\]\s*([\s\S]*)$/);
    if (!markerMatch) continue;
    const raw = markerMatch[2]!.trim();
    const parts = parseIdeaParts(raw);

    const { title, summary, rationale, tags, refs } = parts;
    const body = summary || title;

    if (body.length < 5 && title.length < 5) continue; // Skip empty/tiny entries

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
      ...(summary ? { summary } : {}),
      ...(rationale ? { rationale } : {}),
      status: 'proposed',
      source,
      round,
      tags,
      references,
      feedback: [],
    });

    currentIndex++;
  }

  return ideas;
}

/**
 * Resolve raw ref names from LLM output into concrete IdeaRefs via the
 * entity index.
 *
 * - Names that resolve: emit as `type: 'code'` with a file path + optional line.
 * - Names that look like URLs: emit as `type: 'url'` (no entity lookup needed).
 * - Names that don't resolve: emit as `type: 'code'` with an EMPTY path so
 *   the UI can render them as a greyed-out non-clickable chip with a
 *   tooltip. Prior behaviour of silently dropping them hid the LLM's intent
 *   from the user (Item 9).
 */
function resolveRefs(refs: string[], entityIndex: EntityIndex | undefined): IdeaRef[] {
  const out: IdeaRef[] = [];
  for (const raw of refs) {
    const cleaned = raw.replace(/^["'`]|["'`]$/g, '').trim();
    if (!cleaned) continue;

    // URLs bypass the entity index entirely.
    if (/^https?:\/\//i.test(cleaned)) {
      out.push({ type: 'url', path: cleaned, label: cleaned });
      continue;
    }

    if (entityIndex) {
      // LLMs sometimes produce `ClassName.method`, `file_line`, or stray
      // qualifiers. Match on the exact name first, then fall back to the
      // last segment.
      const direct = entityIndex[cleaned];
      const tail = !direct ? entityIndex[cleaned.split(/[.:/]/).pop() ?? ''] : undefined;
      const hit = direct ?? tail;
      if (hit) {
        out.push({
          type: 'code',
          path: hit.path,
          label: cleaned,
          ...(hit.line !== undefined ? { line: hit.line } : {}),
        });
        continue;
      }
    }

    // Unresolved entity name -- keep it so the UI can render a greyed chip
    // "couldn't resolve this entity" rather than dropping silently.
    out.push({ type: 'code', path: '', label: cleaned });
  }
  return out;
}

interface IdeaParts {
  title: string;
  summary: string;
  rationale: string;
  tags: string[];
  refs: string[];
}

/**
 * Parse a single idea block's text content into structured parts.
 *
 * Handles the rich multi-line format ("Title:", "Body:", "Rationale:",
 * "Tags:", "Refs:" lines). Falls back to the legacy single-line
 * "text -- tags: ... -- refs: ..." format when no labels are found.
 */
function parseIdeaParts(raw: string): IdeaParts {
  const KEY_RE = /^\s*(title|body|summary|description|rationale|motivation|tags?|refs?|refer(?:ences?)?)\s*:\s*(.*)$/i;
  const lines = raw.split('\n');

  // Detect rich format by scanning for any labeled line.
  const hasLabels = lines.some(l => KEY_RE.test(l));

  if (hasLabels) {
    // Collect by label; accumulate continuation lines into the last-seen
    // label so a multi-line Body: paragraph parses cleanly.
    let currentKey: string | null = null;
    const buckets: Record<string, string[]> = {};
    for (const line of lines) {
      const m = line.match(KEY_RE);
      if (m) {
        currentKey = m[1]!.toLowerCase();
        const rest = (m[2] ?? '').trim();
        if (!buckets[currentKey]) buckets[currentKey] = [];
        if (rest) buckets[currentKey]!.push(rest);
      } else if (currentKey) {
        const trimmed = line.trim();
        if (trimmed) buckets[currentKey]!.push(trimmed);
      }
    }
    const get = (...keys: string[]): string => {
      for (const k of keys) {
        const arr = buckets[k];
        if (arr && arr.length > 0) return arr.join(' ').trim();
      }
      return '';
    };
    const getList = (...keys: string[]): string[] => {
      const joined = get(...keys);
      return joined ? joined.split(',').map(s => s.trim()).filter(Boolean) : [];
    };

    const title = get('title');
    const summary = get('body', 'summary', 'description');
    const rationale = get('rationale', 'motivation');
    const tags = getList('tags', 'tag');
    const refs = getList('refs', 'ref', 'reference', 'references', 'refer');

    // If we somehow found labels but no title, fall back to first sentence
    // of summary (rare — keeps the parser robust to partial outputs).
    const resolvedTitle = title || deriveTitleFromText(summary);
    return { title: resolvedTitle, summary, rationale, tags, refs };
  }

  // Legacy format fallback: "text -- tags: ... -- refs: ..."
  let text = raw;
  let tags: string[] = [];
  let refs: string[] = [];

  // Match "—" (em-dash) OR "--" (double hyphen).
  const refsMatch = text.match(/\s*(?:—|--)\s*refs?:\s*(.+?)$/i);
  if (refsMatch) {
    refs = refsMatch[1]!.split(',').map(s => s.trim()).filter(Boolean);
    text = text.slice(0, refsMatch.index);
  }
  const tagsMatch = text.match(/\s*(?:—|--)\s*tags?:\s*(.+?)$/i);
  if (tagsMatch) {
    tags = tagsMatch[1]!.split(',').map(s => s.trim()).filter(Boolean);
    text = text.slice(0, tagsMatch.index);
  }
  const trimmed = text.trim();
  const title = deriveTitleFromText(trimmed);
  // In legacy format there's no separate summary, so treat the whole
  // text as summary.
  return { title, summary: trimmed, rationale: '', tags, refs };
}

function deriveTitleFromText(text: string): string {
  const periodIdx = text.indexOf('.');
  if (periodIdx > 0 && periodIdx <= 80) return text.slice(0, periodIdx).trim();
  if (text.length <= 80) return text.trim();
  // Cut at the last word boundary within 80 chars rather than mid-word.
  const chunk = text.slice(0, 80);
  const lastSpace = chunk.lastIndexOf(' ');
  return (lastSpace > 40 ? chunk.slice(0, lastSpace) : chunk).trim();
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
      feedback: [],
    });
    idx++;
  }

  return { ideas: updated, newIdeas };
}
