import type { LLMProvider, LLMMessage } from '../../../shared/types.js';
import type { DesignerInput, ParsedRequirement } from './types.js';
import { REQ_EXTRACT_SYSTEM, REQ_ENHANCE_SYSTEM } from './prompts.js';

// ---------------------------------------------------------------------------
// Requirements Extraction — Step 1 of the Designer pipeline
//
// Stage 1: Local model extracts numbered requirements list
// Stage 2: Claude enhances — sharpens, fills gaps, deduplicates
// ---------------------------------------------------------------------------

/**
 * Extract requirements from the user's message using the local model.
 * Returns the raw numbered list text (not yet parsed).
 *
 * If docChunks are present (large reference document), runs multi-pass:
 * extracts requirements from each chunk separately, then merges.
 */
export async function extractRequirements(
  input: DesignerInput,
  localProvider: LLMProvider,
  configContext?: string,
  onProgress?: (msg: string) => void,
): Promise<string> {
  // Multi-pass: process each doc chunk separately, then merge
  if (input.docChunks && input.docChunks.length > 0) {
    return extractMultiPass(input, localProvider, configContext, onProgress);
  }

  // Single-pass: everything fits in one call
  return extractSinglePass(input, localProvider, configContext);
}

async function extractSinglePass(
  input: DesignerInput,
  localProvider: LLMProvider,
  configContext?: string,
): Promise<string> {
  const userParts: string[] = [];

  if (input.requirementsDoc) {
    userParts.push(`Requirements document:\n${input.requirementsDoc}`);
  }
  if (input.codeContext) {
    userParts.push(`Code context:\n${input.codeContext}`);
  }
  userParts.push(`User request:\n${input.message}`);
  if (configContext) {
    userParts.push(configContext);
  }

  const messages: LLMMessage[] = [
    { role: 'system', content: REQ_EXTRACT_SYSTEM },
    { role: 'user', content: userParts.join('\n\n') },
  ];

  const response = await localProvider.complete(messages, {
    maxTokens: 2000,
    temperature: 0.3,
  });

  return response.text;
}

const CHUNK_EXTRACT_SYSTEM = `You are a requirements analyst. Given a section of a design/feature document, extract ALL functional and system requirements from this section.

Rules:
- Output a numbered list of requirements (1. 2. 3. ...)
- Each requirement should start with "The system shall..." or "The module shall..."
- Be specific — include data types, operations, constraints mentioned in the section
- Include both functional requirements (what it does) and non-functional (performance, security, etc.)
- If the section has no extractable requirements (e.g., pure overview/intro), output "No requirements in this section."
- Do NOT invent requirements not supported by the section content`;

async function extractMultiPass(
  input: DesignerInput,
  localProvider: LLMProvider,
  configContext?: string,
  onProgress?: (msg: string) => void,
): Promise<string> {
  const chunks = input.docChunks!;
  const perChunkResults: string[] = [];

  onProgress?.(`Multi-pass extraction: ${chunks.length} sections`);

  for (const chunk of chunks) {
    onProgress?.(`Extracting from section ${chunk.index + 1}/${chunk.total}: ${chunk.heading.slice(0, 50)}`);

    const userParts: string[] = [
      `User request:\n${input.message}`,
      `\nDocument section (${chunk.index + 1}/${chunk.total}): ${chunk.heading}\n\n${chunk.content}`,
    ];
    if (configContext) {
      userParts.push(configContext);
    }

    const messages: LLMMessage[] = [
      { role: 'system', content: CHUNK_EXTRACT_SYSTEM },
      { role: 'user', content: userParts.join('\n\n') },
    ];

    const response = await localProvider.complete(messages, {
      maxTokens: 1500,
      temperature: 0.3,
    });

    const text = response.text.trim();
    if (text && !text.toLowerCase().includes('no requirements in this section')) {
      perChunkResults.push(`--- From: ${chunk.heading} ---\n${text}`);
    }
  }

  if (perChunkResults.length === 0) {
    // No requirements extracted from any chunk — fall back to single-pass with outline
    onProgress?.('No requirements found in chunks, falling back to single-pass');
    return extractSinglePass(input, localProvider, configContext);
  }

  // Return concatenated raw results — Claude's enhanceRequirements step
  // will handle deduplication, merging, and gap-filling
  onProgress?.(`Extracted from ${perChunkResults.length} sections, passing to Claude for merge + dedup`);
  return perChunkResults.join('\n\n');
}

/**
 * Enhance the requirements list using Claude.
 * Takes the raw list from the local model and sharpens it.
 */
export async function enhanceRequirements(
  rawList: string,
  input: DesignerInput,
  claudeProvider: LLMProvider,
  configContext?: string,
): Promise<string> {
  const userParts: string[] = [
    `Requirements list to enhance:\n\n${rawList}`,
  ];

  if (input.codeContext) {
    userParts.push(`Code context:\n${input.codeContext}`);
  }
  userParts.push(`Original user request:\n${input.message}`);
  if (configContext) {
    userParts.push(configContext);
  }

  const messages: LLMMessage[] = [
    { role: 'system', content: REQ_ENHANCE_SYSTEM },
    { role: 'user', content: userParts.join('\n\n') },
  ];

  const response = await claudeProvider.complete(messages, {
    maxTokens: 2500,
    temperature: 0.2,
  });

  return response.text;
}

/**
 * Re-run extraction with user feedback injected (for edit rounds).
 */
export async function reExtractWithFeedback(
  previousList: string,
  feedback: string,
  input: DesignerInput,
  claudeProvider: LLMProvider,
  configContext?: string,
): Promise<string> {
  const messages: LLMMessage[] = [
    { role: 'system', content: REQ_ENHANCE_SYSTEM },
    {
      role: 'user',
      content: [
        `Previous requirements list:\n\n${previousList}`,
        `User feedback:\n${feedback}`,
        input.codeContext ? `Code context:\n${input.codeContext}` : '',
        `Original request:\n${input.message}`,
        configContext ?? '',
      ].filter(Boolean).join('\n\n'),
    },
  ];

  const response = await claudeProvider.complete(messages, {
    maxTokens: 2500,
    temperature: 0.2,
  });

  return response.text;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a numbered requirements list into structured ParsedRequirement objects.
 *
 * Handles two output formats:
 *
 * Format A (inline type):
 *   1. [FUNCTIONAL] Statement text — references: entity1, entity2
 *   2. [SYSTEM] Statement text
 *
 * Format B (section headers):
 *   **[FUNCTIONAL]**
 *   1. Statement text — refs: entity1, entity2
 *   2. Statement text
 *
 *   **[SYSTEM]**
 *   3. Statement text
 */
export function parseRequirementsList(text: string): ParsedRequirement[] {
  const requirements: ParsedRequirement[] = [];
  const lines = text.split('\n');

  // Track current section type for header-grouped format
  let currentType: 'functional' | 'system' | 'clarification' = 'functional';

  for (const line of lines) {
    // Check for section header: **[FUNCTIONAL]** or [FUNCTIONAL] or **[SYSTEM]** etc.
    const headerMatch = line.match(
      /^\s*\*{0,2}\[?(FUNCTIONAL|SYSTEM|CLARIFICATION|QUESTION)\]?\*{0,2}\s*$/i,
    );
    if (headerMatch) {
      const h = headerMatch[1]!.toLowerCase();
      currentType = (h === 'question' ? 'clarification' : h) as typeof currentType;
      continue;
    }

    // Check for open questions section header (common LLM pattern)
    if (/^\s*\*{0,2}(open questions?|clarifications?|ambiguities)\*{0,2}\s*:?\s*$/i.test(line)) {
      currentType = 'clarification';
      continue;
    }

    // Format A: "1. [FUNCTIONAL] ..."
    const inlineMatch = line.match(
      /^\s*(\d+)\.\s*\[(FUNCTIONAL|SYSTEM|CLARIFICATION|QUESTION)\]\s*(.+)$/i,
    );
    if (inlineMatch) {
      const index = parseInt(inlineMatch[1]!, 10);
      const rawType = inlineMatch[2]!.toLowerCase();
      const type = (rawType === 'question' ? 'clarification' : rawType) as 'functional' | 'system' | 'clarification';
      const rest = inlineMatch[3]!;
      const { statement, references } = extractReferences(rest);
      requirements.push({ index, statement, type, references });
      continue;
    }

    // Format B: "1. Statement text ..." (uses currentType from section header)
    const numberedMatch = line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (numberedMatch) {
      const index = parseInt(numberedMatch[1]!, 10);
      const rest = numberedMatch[2]!;
      const { statement, references } = extractReferences(rest);
      // Auto-detect clarifications: statements that are questions
      const type = isClarification(rest) ? 'clarification' : currentType;
      requirements.push({ index, statement, type, references });
      continue;
    }
  }

  // Re-index if parsing produced gaps
  return requirements.map((r, i) => ({ ...r, index: i + 1 }));
}

/**
 * Detect whether a requirement statement is actually a clarifying question.
 * Matches patterns like "Should X...?", "What X...?", "Does X...?" etc.
 */
function isClarification(text: string): boolean {
  const trimmed = text.trim();
  // Ends with a question mark (after stripping refs)
  const withoutRefs = trimmed.replace(/\s*—\s*(?:references?|refs?):\s*.+$/i, '');
  if (withoutRefs.trimEnd().endsWith('?')) return true;
  // Starts with a question word
  if (/^(should|what|which|how|does|do|is|are|can|will|would)\s/i.test(withoutRefs)) return true;
  return false;
}

/**
 * Extract statement and references from the text after the number/type prefix.
 * Accepts both "— references: ..." and "— refs: ..." patterns.
 */
function extractReferences(rest: string): { statement: string; references: string[] } {
  const refMatch = rest.match(/^(.+?)\s*—\s*(?:references?|refs?):\s*(.+)$/i);
  const statement = refMatch ? refMatch[1]!.trim() : rest.trim();
  const references = refMatch
    ? refMatch[2]!.split(',').map(r => r.trim()).filter(Boolean)
    : [];
  return { statement, references };
}

/**
 * Format a parsed requirements list back into display text.
 */
export function formatRequirementsList(reqs: ParsedRequirement[]): string {
  return reqs.map(r => {
    const refs = r.references.length > 0
      ? ` — references: ${r.references.join(', ')}`
      : '';
    return `${r.index}. [${r.type.toUpperCase()}] ${r.statement}${refs}`;
  }).join('\n');
}
