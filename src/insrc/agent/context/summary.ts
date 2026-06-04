import type { LLMProvider } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// L2 — Rolling Summary
//
// Compressed representation of evicted conversation turns.
// Updated when L3a overflows (turn -6 evicted).
// Uses local model to compress, max 3 sentences.
// ---------------------------------------------------------------------------

export interface ConversationTurn {
  userMessage: string;
  assistantResponse: string;
  /** Entity IDs referenced in this turn (for L3b storage). */
  entityIds: string[];
}

/**
 * Compress an evicted turn into the running summary.
 *
 * Uses structured format with sections:
 * - Decisions: choices made and reasoning
 * - Files: files referenced or modified
 * - Context: key facts, patterns, entity names
 * - Open: unresolved questions
 */
export async function evictToSummary(
  currentSummary: string,
  evictedTurn: ConversationTurn,
  provider: LLMProvider,
): Promise<string> {
  const turnText = formatTurn(evictedTurn);

  const messages = [
    {
      role: 'system' as const,
      content:
        'Update the structured session summary with information from the new exchange. ' +
        'Use these sections (keep empty sections if nothing to add):\n' +
        '## Decisions\n- choices made, approaches selected, with brief reasoning\n' +
        '## Files\n- file paths referenced or modified\n' +
        '## Context\n- key facts, entity names, patterns discovered\n' +
        '## Open\n- unresolved questions, pending tasks\n\n' +
        'Be concise: max 2 bullet points per section per exchange. ' +
        'Merge duplicates with existing entries. Return only the updated summary.',
    },
    {
      role: 'user' as const,
      content: currentSummary
        ? `Current summary:\n${currentSummary}\n\nNew exchange:\n${turnText}`
        : `New exchange:\n${turnText}`,
    },
  ];

  try {
    const response = await provider.complete(messages, {
      maxTokens: 1024,
      temperature: 0,
    });
    return response.text.trim();
  } catch {
    // If local model unavailable, append a minimal structured extract
    const firstLine = evictedTurn.userMessage.split('\n')[0] ?? '';
    const fileRefs = extractFilePaths(evictedTurn.userMessage + '\n' + evictedTurn.assistantResponse);
    const fallback = fileRefs.length > 0
      ? `\n## Files\n- ${fileRefs.join('\n- ')}`
      : '';
    return currentSummary
      ? `${currentSummary}\n## Context\n- User asked: "${firstLine.slice(0, 100)}"${fallback}`
      : `## Context\n- User asked: "${firstLine.slice(0, 100)}"${fallback}`;
  }
}

/** Extract file paths from text for fallback summaries */
function extractFilePaths(text: string): string[] {
  const paths = new Set<string>();
  const pattern = /(\/[\w./-]+\.\w{1,10})/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (!match[1]!.startsWith('http')) {
      paths.add(match[1]!);
    }
  }
  return [...paths].slice(0, 5);
}

function formatTurn(turn: ConversationTurn): string {
  const user = turn.userMessage.slice(0, 800);
  const assistant = turn.assistantResponse.slice(0, 800);
  return `User: ${user}\nAssistant: ${assistant}`;
}
