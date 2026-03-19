/**
 * Intelligent document splitting for multi-pass LLM processing.
 *
 * Splits documents on semantic boundaries (headings, sections, top-level
 * declarations) rather than arbitrary character limits. Each chunk includes
 * a document header for context continuity.
 *
 * Used by: file reference injection, designer requirements extraction,
 * planner context loading, brainstorm reference analysis.
 */

import { extname } from 'node:path';
import { getLogger } from '../shared/logger.js';

const log = getLogger('doc-splitter');

// Approximate chars-per-token
const CHARS_PER_TOKEN = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DocChunk {
  /** Section heading/title */
  heading: string;
  /** Full content of this chunk (includes header if prepended) */
  content: string;
  /** Zero-based index in the document */
  index: number;
  /** Total chunks in the document */
  total: number;
  /** Source section path: "Feature Overview > Chat Panel > Input Area" */
  path: string;
  /** Heading level (1-6 for html/md, 0 for code) */
  level: number;
}

export interface SplitOptions {
  /** Max tokens per chunk (default 4000 — leaves room for system prompt + output) */
  maxTokensPerChunk?: number | undefined;
  /** Whether to prepend document header to each chunk (default true) */
  includeHeader?: boolean | undefined;
  /** Max tokens for the header prefix (default 500) */
  headerBudget?: number | undefined;
}

export interface SplitResult {
  /** The document header (title, overview, preamble) */
  header: string;
  /** Individual chunks */
  chunks: DocChunk[];
  /** Total character count of original document */
  originalSize: number;
  /** File type used for splitting strategy */
  strategy: 'html' | 'markdown' | 'code' | 'yaml' | 'text';
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function splitDocument(
  content: string,
  filePath: string,
  options?: SplitOptions,
): SplitResult {
  const ext = extname(filePath).toLowerCase();
  const maxCharsPerChunk = (options?.maxTokensPerChunk ?? 4000) * CHARS_PER_TOKEN;
  const headerBudgetChars = (options?.headerBudget ?? 500) * CHARS_PER_TOKEN;
  const includeHeader = options?.includeHeader ?? true;

  let result: SplitResult;

  if (ext === '.html' || ext === '.htm') {
    result = splitHtml(content, maxCharsPerChunk, headerBudgetChars);
  } else if (ext === '.md') {
    result = splitMarkdown(content, maxCharsPerChunk, headerBudgetChars);
  } else if (['.yaml', '.yml'].includes(ext)) {
    result = splitYaml(content, maxCharsPerChunk, headerBudgetChars);
  } else if (['.json'].includes(ext)) {
    result = splitJson(content, maxCharsPerChunk, headerBudgetChars);
  } else if (['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs'].includes(ext)) {
    result = splitCode(content, maxCharsPerChunk, headerBudgetChars);
  } else {
    result = splitPlainText(content, maxCharsPerChunk, headerBudgetChars);
  }

  // Prepend header to each chunk if requested
  if (includeHeader && result.header) {
    const headerPrefix = `--- Document: ${filePath} ---\n${result.header}\n--- Section ${'{IDX}'} of ${result.chunks.length} ---\n\n`;
    for (const chunk of result.chunks) {
      const prefix = headerPrefix.replace('{IDX}', String(chunk.index + 1));
      chunk.content = `${prefix}${chunk.content}`;
    }
  }

  // If any chunk still exceeds budget, sub-split
  const finalChunks: DocChunk[] = [];
  for (const chunk of result.chunks) {
    if (chunk.content.length > maxCharsPerChunk * 1.2) {
      // Sub-split by paragraphs
      const subChunks = subSplitChunk(chunk, maxCharsPerChunk);
      finalChunks.push(...subChunks);
    } else {
      finalChunks.push(chunk);
    }
  }

  // Re-index
  for (let i = 0; i < finalChunks.length; i++) {
    finalChunks[i]!.index = i;
    finalChunks[i]!.total = finalChunks.length;
  }

  result.chunks = finalChunks;

  log.info({
    file: filePath,
    strategy: result.strategy,
    originalSize: result.originalSize,
    chunks: result.chunks.length,
    headerSize: result.header.length,
  }, 'document split');

  return result;
}

// ---------------------------------------------------------------------------
// HTML splitting
// ---------------------------------------------------------------------------

function splitHtml(content: string, maxChars: number, headerBudget: number): SplitResult {
  const stripped = stripHtml(content);
  const originalSize = content.length;

  // Extract title
  const titleMatch = content.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1]!.trim() : '';

  // Split on h2 sections (major features/chapters)
  const sections = extractHtmlSections(content, 2);

  if (sections.length === 0) {
    // No h2s — try h3
    const h3Sections = extractHtmlSections(content, 3);
    if (h3Sections.length > 0) {
      return buildResult(title, h3Sections, originalSize, 'html', headerBudget);
    }
    // No structure — return as single chunk
    return {
      header: title,
      chunks: [{ heading: title || 'Document', content: stripped, index: 0, total: 1, path: title, level: 1 }],
      originalSize,
      strategy: 'html',
    };
  }

  return buildResult(title, sections, originalSize, 'html', headerBudget);
}

interface RawSection {
  heading: string;
  content: string;
  level: number;
  path: string;
}

function extractHtmlSections(content: string, splitLevel: number): RawSection[] {
  const sections: RawSection[] = [];
  const pattern = new RegExp(`<h(${splitLevel})[^>]*>([\\s\\S]*?)<\\/h\\1>`, 'gi');
  const allPositions: Array<{ heading: string; level: number; startIdx: number }> = [];

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    allPositions.push({
      heading: stripHtml(match[2]!).trim(),
      level: parseInt(match[1]!, 10),
      startIdx: match.index,
    });
  }

  for (let i = 0; i < allPositions.length; i++) {
    const current = allPositions[i]!;
    const nextStart = i + 1 < allPositions.length ? allPositions[i + 1]!.startIdx : content.length;
    const sectionHtml = content.slice(current.startIdx, nextStart);
    const sectionText = stripHtml(sectionHtml).trim();

    if (sectionText.length > 0) {
      sections.push({
        heading: current.heading,
        content: sectionText,
        level: current.level,
        path: current.heading,
      });
    }
  }

  return sections;
}

// ---------------------------------------------------------------------------
// Markdown splitting
// ---------------------------------------------------------------------------

function splitMarkdown(content: string, maxChars: number, headerBudget: number): SplitResult {
  const originalSize = content.length;
  const lines = content.split('\n');

  // Find the title (first h1)
  const titleLine = lines.find(l => /^#\s/.test(l));
  const title = titleLine ? titleLine.replace(/^#\s+/, '').trim() : '';

  // Split on ## headings
  const sections: RawSection[] = [];
  let currentHeading = '';
  let currentLevel = 2;
  let currentPath = '';
  const currentContent: string[] = [];
  let foundFirstH2 = false;

  for (const line of lines) {
    const h2Match = line.match(/^##\s+(.+)/);
    const h3Match = line.match(/^###\s+(.+)/);

    if (h2Match) {
      if (foundFirstH2 && currentContent.length > 0) {
        sections.push({
          heading: currentHeading,
          content: currentContent.join('\n').trim(),
          level: currentLevel,
          path: currentPath,
        });
      }
      currentHeading = h2Match[1]!.trim();
      currentLevel = 2;
      currentPath = currentHeading;
      currentContent.length = 0;
      foundFirstH2 = true;
    } else if (h3Match && foundFirstH2) {
      // h3 becomes part of the current h2 section
      currentContent.push(line);
    } else {
      currentContent.push(line);
    }
  }

  // Last section
  if (currentContent.length > 0 && foundFirstH2) {
    sections.push({
      heading: currentHeading,
      content: currentContent.join('\n').trim(),
      level: currentLevel,
      path: currentPath,
    });
  }

  if (sections.length === 0) {
    return {
      header: title,
      chunks: [{ heading: title || 'Document', content, index: 0, total: 1, path: title, level: 1 }],
      originalSize,
      strategy: 'markdown',
    };
  }

  return buildResult(title, sections, originalSize, 'markdown', headerBudget);
}

// ---------------------------------------------------------------------------
// Code splitting
// ---------------------------------------------------------------------------

function splitCode(content: string, maxChars: number, headerBudget: number): SplitResult {
  const originalSize = content.length;

  // Split on top-level declarations
  const blocks = content.split(/\n(?=(?:export |function |class |interface |type |const |async function |def |func ))/);

  const sections: RawSection[] = blocks
    .filter(b => b.trim().length > 0)
    .map(block => {
      const firstLine = block.split('\n')[0] ?? '';
      return {
        heading: firstLine.slice(0, 80).trim(),
        content: block.trim(),
        level: 0,
        path: firstLine.slice(0, 40).trim(),
      };
    });

  if (sections.length === 0) {
    return {
      header: '',
      chunks: [{ heading: 'Code', content, index: 0, total: 1, path: 'Code', level: 0 }],
      originalSize,
      strategy: 'code',
    };
  }

  return buildResult('', sections, originalSize, 'code', headerBudget);
}

// ---------------------------------------------------------------------------
// YAML splitting
// ---------------------------------------------------------------------------

function splitYaml(content: string, maxChars: number, headerBudget: number): SplitResult {
  const originalSize = content.length;
  const lines = content.split('\n');

  // Split on top-level keys (lines starting with a word, no indentation)
  const sections: RawSection[] = [];
  let currentKey = '';
  const currentLines: string[] = [];

  for (const line of lines) {
    const topKeyMatch = line.match(/^(\w[\w-]*)\s*:/);
    if (topKeyMatch && !line.startsWith(' ') && !line.startsWith('\t')) {
      if (currentKey && currentLines.length > 0) {
        sections.push({
          heading: currentKey,
          content: currentLines.join('\n').trim(),
          level: 1,
          path: currentKey,
        });
      }
      currentKey = topKeyMatch[1]!;
      currentLines.length = 0;
    }
    currentLines.push(line);
  }
  if (currentKey && currentLines.length > 0) {
    sections.push({
      heading: currentKey,
      content: currentLines.join('\n').trim(),
      level: 1,
      path: currentKey,
    });
  }

  return buildResult('', sections, originalSize, 'yaml', headerBudget);
}

// ---------------------------------------------------------------------------
// JSON splitting
// ---------------------------------------------------------------------------

function splitJson(content: string, maxChars: number, headerBudget: number): SplitResult {
  const originalSize = content.length;

  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const sections: RawSection[] = Object.entries(parsed).map(([key, value]) => ({
      heading: key,
      content: JSON.stringify(value, null, 2),
      level: 1,
      path: key,
    }));

    return buildResult('', sections, originalSize, 'yaml', headerBudget);
  } catch {
    return splitPlainText(content, maxChars, headerBudget);
  }
}

// ---------------------------------------------------------------------------
// Plain text fallback
// ---------------------------------------------------------------------------

function splitPlainText(content: string, maxChars: number, headerBudget: number): SplitResult {
  const originalSize = content.length;

  if (content.length <= maxChars) {
    return {
      header: '',
      chunks: [{ heading: 'Document', content, index: 0, total: 1, path: 'Document', level: 0 }],
      originalSize,
      strategy: 'text',
    };
  }

  // Split by double newlines (paragraphs)
  const paragraphs = content.split(/\n\n+/);
  const sections: RawSection[] = [];
  let batch: string[] = [];
  let batchSize = 0;
  let batchIdx = 0;

  for (const para of paragraphs) {
    if (batchSize + para.length > maxChars && batch.length > 0) {
      sections.push({
        heading: `Part ${batchIdx + 1}`,
        content: batch.join('\n\n'),
        level: 0,
        path: `Part ${batchIdx + 1}`,
      });
      batch = [];
      batchSize = 0;
      batchIdx++;
    }
    batch.push(para);
    batchSize += para.length;
  }
  if (batch.length > 0) {
    sections.push({
      heading: `Part ${batchIdx + 1}`,
      content: batch.join('\n\n'),
      level: 0,
      path: `Part ${batchIdx + 1}`,
    });
  }

  return buildResult('', sections, originalSize, 'text', headerBudget);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function buildResult(
  title: string,
  sections: RawSection[],
  originalSize: number,
  strategy: SplitResult['strategy'],
  _headerBudget: number,
): SplitResult {
  // Build header: title + first section if it looks like an overview
  let header = title;
  if (sections.length > 0) {
    const first = sections[0]!;
    const isOverview = /overview|intro|summary|about|background/i.test(first.heading);
    if (isOverview && first.content.length < 2000) {
      header = `${title}\n\n${first.heading}: ${first.content.slice(0, 500)}`;
    }
  }

  const chunks: DocChunk[] = sections.map((s, i) => ({
    heading: s.heading,
    content: `### ${s.heading}\n\n${s.content}`,
    index: i,
    total: sections.length,
    path: s.path,
    level: s.level,
  }));

  return { header, chunks, originalSize, strategy };
}

function subSplitChunk(chunk: DocChunk, maxChars: number): DocChunk[] {
  const paragraphs = chunk.content.split(/\n\n+/);
  const subChunks: DocChunk[] = [];
  let batch: string[] = [];
  let batchSize = 0;
  let partIdx = 0;

  for (const para of paragraphs) {
    if (batchSize + para.length > maxChars && batch.length > 0) {
      subChunks.push({
        ...chunk,
        heading: `${chunk.heading} (part ${partIdx + 1})`,
        content: batch.join('\n\n'),
        path: `${chunk.path} > part ${partIdx + 1}`,
      });
      batch = [];
      batchSize = 0;
      partIdx++;
    }
    batch.push(para);
    batchSize += para.length;
  }
  if (batch.length > 0) {
    subChunks.push({
      ...chunk,
      heading: partIdx > 0 ? `${chunk.heading} (part ${partIdx + 1})` : chunk.heading,
      content: batch.join('\n\n'),
      path: partIdx > 0 ? `${chunk.path} > part ${partIdx + 1}` : chunk.path,
    });
  }

  return subChunks;
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
