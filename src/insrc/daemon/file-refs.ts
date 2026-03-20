/**
 * File reference detection and content injection.
 *
 * Scans a user prompt for file paths, reads referenced files, chunks
 * large files to fit within context budget, and returns structured
 * context for injection into agent inputs.
 *
 * Chunking strategy:
 * - Small (<4K tokens): include whole file
 * - Medium (4-16K): extract sections by heading/structure, rank by
 *   relevance to the prompt, include top sections up to budget
 * - Large (>16K): extract structure (headings/outline) + top relevant sections
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, isAbsolute, extname } from 'node:path';
import { getLogger } from '../shared/logger.js';
import { splitDocument, type DocChunk } from './doc-splitter.js';

const log = getLogger('file-refs');

// Approximate chars-per-token for budget calculations
const CHARS_PER_TOKEN = 3;

export type { DocChunk } from './doc-splitter.js';

export interface FileRefResult {
  /** Original file path as referenced in the prompt */
  ref: string;
  /** Resolved absolute path */
  path: string;
  /** Content (full or chunked) */
  content: string;
  /** Whether content was truncated */
  truncated: boolean;
  /** Original file size in bytes */
  originalSize: number;
  /** Document chunks for multi-pass processing (only if multiPass=true and file is large) */
  chunks?: DocChunk[] | undefined;
  /** Document header from splitter (prepended to each chunk for context) */
  docHeader?: string | undefined;
}

export interface ResolveOptions {
  /** Working directory for relative paths */
  cwd: string;
  /** Max tokens budget for ALL file references combined (for single-pass summary) */
  maxTokens?: number | undefined;
  /** The user's prompt text (for relevance scoring) */
  prompt?: string | undefined;
  /** If true, return doc chunks for multi-pass processing instead of single summary */
  multiPass?: boolean | undefined;
  /** Max tokens per chunk for multi-pass mode (default 4000) */
  chunkTokens?: number | undefined;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect file references in a message.
 * Matches:
 * - Absolute paths: /home/user/file.ts
 * - Relative paths: design/vscode-plugin.html, ./src/foo.ts, ../bar.py
 * - Quoted paths: "path/to/file"
 * Does NOT match:
 * - URLs (http://, https://)
 * - Package names (no extension or starts with @)
 */
export function detectFileRefs(message: string): string[] {
  const refs = new Set<string>();

  // Quoted paths: "path/to/file.ext" or 'path/to/file.ext'
  const quotedPattern = /["']([./~][^"']+\.\w{1,10})["']/g;
  let match: RegExpExecArray | null;
  while ((match = quotedPattern.exec(message)) !== null) {
    refs.add(match[1]!);
  }

  // Unquoted paths with known extensions
  const knownExts = /\.(html|md|ts|tsx|js|jsx|py|go|rs|yaml|yml|json|toml|sql|sh|css|xml|proto|graphql)$/;
  const pathPattern = /(?:^|\s)((?:\.{0,2}\/)?[\w./-]+\.\w{1,10})(?:\s|$|,|;)/g;
  while ((match = pathPattern.exec(message)) !== null) {
    const p = match[1]!;
    if (knownExts.test(p) && !p.startsWith('http')) {
      refs.add(p);
    }
  }

  // Absolute paths
  const absPattern = /(\/[\w./-]+\.\w{1,10})/g;
  while ((match = absPattern.exec(message)) !== null) {
    const p = match[1]!;
    if (!p.startsWith('http') && knownExts.test(p)) {
      refs.add(p);
    }
  }

  return [...refs];
}

// ---------------------------------------------------------------------------
// Resolution + reading + chunking
// ---------------------------------------------------------------------------

/**
 * Resolve file references: detect paths in message, read files,
 * chunk if needed, return structured content.
 */
export async function resolveFileRefs(
  message: string,
  options: ResolveOptions,
): Promise<FileRefResult[]> {
  const refs = detectFileRefs(message);
  if (refs.length === 0) return [];

  const maxTokens = options.maxTokens ?? 6000;
  const maxCharsTotal = maxTokens * CHARS_PER_TOKEN;
  const results: FileRefResult[] = [];
  let charsRemaining = maxCharsTotal;

  log.info({ refs, maxTokens }, 'detected file references');

  // Per-file budget: distribute evenly, then re-distribute unused
  const perFileBudget = Math.floor(maxCharsTotal / refs.length);

  for (const ref of refs) {
    const absPath = isAbsolute(ref) ? ref : resolve(options.cwd, ref);

    if (!existsSync(absPath)) {
      log.debug({ ref, absPath }, 'file reference not found, skipping');
      continue;
    }

    const stat = statSync(absPath);
    if (stat.isDirectory()) continue;
    if (stat.size > 5 * 1024 * 1024) {
      log.debug({ ref, size: stat.size }, 'file too large (>5MB), skipping');
      continue;
    }

    try {
      const raw = readFileSync(absPath, 'utf-8');
      const budget = Math.min(perFileBudget, charsRemaining);
      const chunkTokens = options.chunkTokens ?? 4000;

      if (raw.length <= budget) {
        // Small file — include whole
        results.push({ ref, path: absPath, content: raw, truncated: false, originalSize: stat.size });
        charsRemaining -= raw.length;
      } else if (options.multiPass) {
        // Large file + multi-pass mode — split into chunks for iterative processing
        const split = splitDocument(raw, absPath, { maxTokensPerChunk: chunkTokens });
        // For multi-pass, content is the header/outline (small), chunks are separate
        const outlineContent = `[Large document: ${split.chunks.length} sections]\n\n${split.header}`;
        results.push({
          ref, path: absPath,
          content: outlineContent,
          truncated: true,
          originalSize: stat.size,
          chunks: split.chunks,
          docHeader: split.header,
        });
        charsRemaining -= outlineContent.length;
      } else {
        // Large file + single-pass mode — use old chunking (best-effort summary)
        const chunked = chunkFile(raw, absPath, budget, options.prompt);
        results.push({ ref, path: absPath, content: chunked, truncated: true, originalSize: stat.size });
        charsRemaining -= chunked.length;
      }

      const last = results[results.length - 1]!;
      log.info({
        ref,
        originalSize: stat.size,
        contentSize: last.content.length,
        truncated: last.truncated,
        chunks: last.chunks?.length,
      }, 'file reference resolved');
    } catch (err) {
      log.debug({ ref, err }, 'failed to read file reference');
    }

    if (charsRemaining <= 0) break;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

interface Section {
  heading: string;
  content: string;
  level: number;
  score: number;
}

function chunkFile(
  content: string,
  filePath: string,
  budgetChars: number,
  prompt?: string,
): string {
  const ext = extname(filePath).toLowerCase();

  // HTML: extract by heading tags
  if (ext === '.html' || ext === '.htm') {
    return chunkByHtmlHeadings(content, budgetChars, prompt);
  }

  // Markdown: extract by # headings
  if (ext === '.md') {
    return chunkByMarkdownHeadings(content, budgetChars, prompt);
  }

  // Code files: extract by top-level declarations
  if (['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs'].includes(ext)) {
    return chunkByCodeStructure(content, budgetChars, prompt);
  }

  // Fallback: head + tail
  return chunkHeadTail(content, budgetChars);
}

function chunkByHtmlHeadings(
  content: string,
  budgetChars: number,
  prompt?: string,
): string {
  // Strip HTML tags for text extraction, but keep structure for sectioning
  const sections: Section[] = [];
  const headingPattern = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = headingPattern.exec(content)) !== null) {
    if (sections.length > 0) {
      const lastSection = sections[sections.length - 1]!;
      lastSection.content = stripHtml(content.slice(lastIdx, match.index)).trim();
    }
    sections.push({
      heading: stripHtml(match[2]!).trim(),
      content: '',
      level: parseInt(match[1]!, 10),
      score: 0,
    });
    lastIdx = match.index + match[0].length;
  }
  // Last section
  if (sections.length > 0) {
    const lastSection = sections[sections.length - 1]!;
    lastSection.content = stripHtml(content.slice(lastIdx)).trim();
  }

  if (sections.length === 0) {
    return chunkHeadTail(stripHtml(content), budgetChars);
  }

  return assembleSections(sections, budgetChars, prompt);
}

function chunkByMarkdownHeadings(
  content: string,
  budgetChars: number,
  prompt?: string,
): string {
  const sections: Section[] = [];
  const lines = content.split('\n');
  let currentSection: Section | null = null;
  const contentLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      if (currentSection) {
        currentSection.content = contentLines.join('\n').trim();
      }
      currentSection = {
        heading: headingMatch[2]!,
        content: '',
        level: headingMatch[1]!.length,
        score: 0,
      };
      sections.push(currentSection);
      contentLines.length = 0;
    } else {
      contentLines.push(line);
    }
  }
  if (currentSection) {
    currentSection.content = contentLines.join('\n').trim();
  }

  if (sections.length === 0) {
    return chunkHeadTail(content, budgetChars);
  }

  return assembleSections(sections, budgetChars, prompt);
}

function chunkByCodeStructure(
  content: string,
  budgetChars: number,
  prompt?: string,
): string {
  // Simple heuristic: split by blank lines between top-level declarations
  const sections: Section[] = [];
  const blocks = content.split(/\n(?=(?:export |function |class |interface |type |const |async function ))/);

  for (const block of blocks) {
    const firstLine = block.split('\n')[0] ?? '';
    sections.push({
      heading: firstLine.slice(0, 80),
      content: block.trim(),
      level: 1,
      score: 0,
    });
  }

  if (sections.length === 0) {
    return chunkHeadTail(content, budgetChars);
  }

  return assembleSections(sections, budgetChars, prompt);
}

// ---------------------------------------------------------------------------
// Section assembly with relevance scoring
// ---------------------------------------------------------------------------

function assembleSections(
  sections: Section[],
  budgetChars: number,
  prompt?: string,
): string {
  // Score sections by relevance to prompt
  if (prompt) {
    const keywords = extractKeywords(prompt);
    for (const section of sections) {
      const text = `${section.heading} ${section.content}`.toLowerCase();
      section.score = keywords.reduce((acc, kw) => acc + (text.includes(kw) ? 1 : 0), 0);
      // Boost h1/h2 sections (structural importance)
      if (section.level <= 2) section.score += 0.5;
    }
  }

  // Always include: outline (all headings)
  const outline = sections.map(s => `${'  '.repeat(s.level - 1)}${s.heading}`).join('\n');
  let assembled = `--- Document Outline ---\n${outline}\n\n--- Relevant Sections ---\n`;
  let charsUsed = assembled.length;

  // Sort sections by score (descending), then by order (ascending) for tie-breaking
  const ranked = sections
    .map((s, i) => ({ ...s, idx: i }))
    .sort((a, b) => b.score - a.score || a.idx - b.idx);

  for (const section of ranked) {
    const sectionText = `### ${section.heading}\n${section.content}\n\n`;
    if (charsUsed + sectionText.length > budgetChars) {
      // Try truncating this section's content
      const remaining = budgetChars - charsUsed - `### ${section.heading}\n...\n\n`.length;
      if (remaining > 200) {
        assembled += `### ${section.heading}\n${section.content.slice(0, remaining)}...\n\n`;
        charsUsed = budgetChars;
      }
      break;
    }
    assembled += sectionText;
    charsUsed += sectionText.length;
  }

  return assembled;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chunkHeadTail(content: string, budgetChars: number): string {
  if (content.length <= budgetChars) return content;
  const headSize = Math.floor(budgetChars * 0.7);
  const tailSize = budgetChars - headSize - 30;
  return `${content.slice(0, headSize)}\n\n... [truncated ${content.length - headSize - tailSize} chars] ...\n\n${content.slice(-tailSize)}`;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractKeywords(prompt: string): string[] {
  const stopWords = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been',
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for', 'on', 'with',
    'at', 'by', 'from', 'as', 'into', 'about', 'that', 'this', 'it', 'and', 'or',
    'but', 'if', 'not', 'no', 'all', 'each', 'every', 'using', 'design', 'create',
    'make', 'build', 'add', 'implement', 'write', 'generate']);
  return prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));
}

// ---------------------------------------------------------------------------
// Format for injection
// ---------------------------------------------------------------------------

/**
 * Format resolved file refs as context string for LLM injection.
 */
export function formatFileContext(results: FileRefResult[]): string {
  if (results.length === 0) return '';

  const parts: string[] = ['--- Referenced Files ---\n'];
  for (const r of results) {
    const label = r.truncated
      ? `[${r.ref}] (${Math.round(r.originalSize / 1024)}KB, chunked to fit context)`
      : `[${r.ref}] (${Math.round(r.originalSize / 1024)}KB)`;
    parts.push(`${label}\n${r.content}\n`);
  }
  parts.push('--- End Referenced Files ---');
  return parts.join('\n');
}
