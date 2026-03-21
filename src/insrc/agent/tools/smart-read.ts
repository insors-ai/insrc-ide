/**
 * SmartRead controller — intelligent file reading based on user intent.
 *
 * For small files (<500 lines): returns full content.
 * For large files: samples format, plans extraction strategy, executes targeted read.
 *
 * Strategies:
 *   - grep: regex search (for "find errors", "search for X")
 *   - head-tail: first N + last M lines (for "overview", "what is this")
 *   - section: find headers, read specific section
 *   - structured: jq/awk for JSON/CSV
 */

import { readFile, stat, readdir } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { extname, join } from 'node:path';
import type { LLMProvider } from '../../shared/types.js';
import { getLogger } from '../../shared/logger.js';
import { splitDocument } from '../../daemon/doc-splitter.js';

const log = getLogger('smart-read');

const SMALL_FILE_THRESHOLD = 500; // lines

interface SmartReadResult {
  content: string;
  strategy: 'full' | 'grep' | 'head-tail' | 'section' | 'structured' | 'chunked' | 'directory';
  metadata: string;
}

export interface SmartReadProgressCallback {
  (message: string): void;
}

/**
 * Smart read: check file size, sample format, plan extraction, execute.
 *
 * @param filePath Absolute path to the file
 * @param userPrompt The user's original question (used to plan extraction)
 * @param contextBudgetTokens Available context budget in tokens (used to calculate max chunks)
 * @param provider Optional LLM provider for planning (falls back to heuristics)
 * @param onProgress Callback for progress updates sent to IDE
 */
export async function smartRead(
  filePath: string,
  userPrompt: string,
  contextBudgetTokens = 4000,
  provider?: LLMProvider,
  onProgress?: SmartReadProgressCallback,
): Promise<SmartReadResult> {

  // Step 1: stat — detect if directory
  const fileStat = await stat(filePath);

  if (fileStat.isDirectory()) {
    return handleDirectory(filePath, userPrompt, onProgress);
  }

  const raw = await readFile(filePath, 'utf-8');
  const lines = raw.split('\n');
  const lineCount = lines.length;
  const sizeKB = (fileStat.size / 1024).toFixed(1);

  onProgress?.(`Reading ${filePath.split('/').pop()} (${lineCount} lines, ${sizeKB} KB)`);

  // Small file: return full content
  if (lineCount <= SMALL_FILE_THRESHOLD) {
    const numbered = lines.map((line, i) => `${String(i + 1).padStart(6)}\u2192${line}`).join('\n');
    return {
      content: numbered,
      strategy: 'full',
      metadata: `[File: ${filePath} | ${lineCount} lines | ${sizeKB} KB]`,
    };
  }

  // Step 2: sample — read first 30 + last 10 lines, detect format
  const sample = [
    ...lines.slice(0, 30),
    '...',
    ...lines.slice(-10),
  ].join('\n');

  const format = detectFormat(filePath, sample);

  // Step 3: plan — decide extraction strategy based on format + prompt + budget
  const strategy = planStrategy(format, userPrompt, lineCount, contextBudgetTokens);

  log.info({ filePath, lineCount, format, strategy: strategy.type }, 'SmartRead planned');
  onProgress?.(`Strategy: ${strategy.type} (format: ${format}, ${lineCount} lines)`);

  // Step 4: execute
  let extracted: string;
  switch (strategy.type) {
    case 'grep':
      onProgress?.(`Searching for: ${strategy.pattern}`);
      extracted = await executeGrep(filePath, strategy.pattern!, strategy.maxResults ?? 50);
      break;
    case 'head-tail':
      onProgress?.(`Reading first ${strategy.headLines ?? 50} + last ${strategy.tailLines ?? 20} lines`);
      extracted = formatHeadTail(lines, strategy.headLines ?? 50, strategy.tailLines ?? 20);
      break;
    case 'section':
      onProgress?.(`Extracting section: ${strategy.sectionPattern}`);
      extracted = extractSection(lines, strategy.sectionPattern!);
      break;
    case 'structured':
      onProgress?.('Running structured extraction');
      extracted = await executeStructured(filePath, strategy.command!);
      break;
    case 'chunked':
      onProgress?.(`Chunking into sections (max ${strategy.maxChunks} chunks)`);
      extracted = executeChunked(raw, filePath, strategy.keywords ?? [], strategy.maxChunks ?? 5, onProgress);
      break;
    default:
      extracted = formatHeadTail(lines, 100, 20);
  }

  // Step 5: format with metadata
  const metadata = `[File: ${filePath} | ${lineCount} lines | ${sizeKB} KB | Format: ${format} | Strategy: ${strategy.type}]`;

  return { content: `${metadata}\n\n${extracted}`, strategy: strategy.type, metadata };
}

// ---------------------------------------------------------------------------
// Directory handling
// ---------------------------------------------------------------------------

async function handleDirectory(
  dirPath: string,
  userPrompt: string,
  onProgress?: SmartReadProgressCallback,
): Promise<SmartReadResult> {
  onProgress?.(`Listing directory: ${dirPath.split('/').pop()}`);

  const entries = await readdir(dirPath, { withFileTypes: true });
  const dirs: string[] = [];
  const files: { name: string; size: number; ext: string }[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) { continue; } // skip hidden
    if (entry.isDirectory()) {
      dirs.push(entry.name);
    } else {
      try {
        const s = await stat(join(dirPath, entry.name));
        files.push({ name: entry.name, size: s.size, ext: extname(entry.name) });
      } catch { /* skip unreadable */ }
    }
  }

  // Build directory listing
  const lines: string[] = [];
  lines.push(`[Directory: ${dirPath} | ${dirs.length} dirs, ${files.length} files]`);
  lines.push('');

  if (dirs.length > 0) {
    lines.push('Directories:');
    for (const d of dirs.sort()) {
      lines.push(`  ${d}/`);
    }
    lines.push('');
  }

  if (files.length > 0) {
    lines.push('Files:');
    for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) {
      const sizeStr = f.size < 1024 ? `${f.size}B` : `${(f.size / 1024).toFixed(1)}KB`;
      lines.push(`  ${f.name} (${sizeStr})`);
    }
    lines.push('');
  }

  // Add guidance based on user prompt
  const lower = userPrompt.toLowerCase();
  if (/all|every|each|entire/i.test(lower)) {
    lines.push('To read all files, specify each file path individually or use Grep to search across them.');
  } else {
    lines.push('This is a directory. To read a specific file, use its full path.');
    lines.push(`Example: Read "${join(dirPath, files[0]?.name ?? 'file.ts')}"`);
  }

  const content = lines.join('\n');
  return {
    content,
    strategy: 'directory',
    metadata: `[Directory: ${dirPath} | ${dirs.length} dirs, ${files.length} files]`,
  };
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

function detectFormat(filePath: string, sample: string): string {
  const ext = extname(filePath).toLowerCase();

  // Content-based detection first (more accurate than extension)
  const firstLine = sample.split('\n')[0] ?? '';
  if (firstLine.startsWith('{') && firstLine.includes('"')) return 'json-lines';
  if (firstLine.includes('\t') && sample.split('\n').slice(0, 5).every(l => l.split('\t').length > 2)) return 'csv';

  // Extension-based
  if (['.json', '.jsonl', '.ndjson'].includes(ext)) return 'json';
  if (['.csv', '.tsv'].includes(ext)) return 'csv';
  if (['.log'].includes(ext)) {
    // Check if it's actually structured JSON log (pino, bunyan, winston)
    if (/^\{.*"level"/.test(firstLine)) return 'json-lines';
    return 'log';
  }
  if (['.md'].includes(ext)) return 'markdown';
  if (['.yaml', '.yml'].includes(ext)) return 'yaml';
  if (['.xml', '.html', '.htm'].includes(ext)) return ext.replace('.', '');
  if (['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h'].includes(ext)) return 'code';
  if (['.sql'].includes(ext)) return 'sql';
  if (['.sh', '.bash', '.zsh'].includes(ext)) return 'shell';

  if (/^\[\d{2}:\d{2}:\d{2}\]|\d{4}-\d{2}-\d{2}T/.test(firstLine)) return 'log';

  return 'text';
}

// ---------------------------------------------------------------------------
// Strategy planning (heuristic — no LLM needed for common patterns)
// ---------------------------------------------------------------------------

interface Strategy {
  type: 'grep' | 'head-tail' | 'section' | 'structured' | 'chunked';
  pattern?: string;
  maxResults?: number;
  headLines?: number;
  tailLines?: number;
  sectionPattern?: string;
  command?: string;
  /** For chunked: max chunks to return */
  maxChunks?: number;
  /** For chunked: keywords to select relevant chunks */
  keywords?: string[];
}

function planStrategy(format: string, prompt: string, lineCount: number, contextBudgetTokens: number): Strategy {
  // Calculate max chunks that fit in budget (each chunk ~4000 chars = ~1333 tokens)
  const CHARS_PER_TOKEN = 3;
  const TOKENS_PER_CHUNK = 1333;
  const maxChunksByBudget = Math.max(1, Math.floor(contextBudgetTokens / TOKENS_PER_CHUNK));
  void CHARS_PER_TOKEN; // used in doc-splitter
  const lower = prompt.toLowerCase();

  // Error/warning/failure searching
  if (/error|fail|crash|exception|panic|critical|fatal/i.test(lower)) {
    if (format === 'json-lines' || format === 'json') {
      return { type: 'grep', pattern: '"level":\\s*[45]0|"level":\\s*"(error|fatal|warn)"', maxResults: 30 };
    }
    if (format === 'log') {
      // Match error markers at line start or after timestamp, not in payload content
      return { type: 'grep', pattern: '^.*\\b(ERROR|FATAL|FAIL|CRITICAL|panic)\\b.*$', maxResults: 30 };
    }
    return { type: 'grep', pattern: 'error|Error|ERROR|fail|FAIL|exception|Exception', maxResults: 30 };
  }

  // Search for specific term
  const searchMatch = lower.match(/(?:find|search|look for|where is|grep|contains?)\s+["']?(\w[\w\s]{1,30})["']?/);
  if (searchMatch) {
    return { type: 'grep', pattern: searchMatch[1]!.trim(), maxResults: 30 };
  }

  // Function/class/type definitions
  if (/function|class|interface|type|method|def\s|struct|enum/i.test(lower) && format === 'code') {
    return { type: 'grep', pattern: '^(export\\s+)?(function|class|interface|type|const|let|enum|struct|def)\\s+\\w+', maxResults: 40 };
  }

  // Summary/overview — use chunked for large files, head-tail for medium
  if (/summar|overview|what is|describe|explain|structure/i.test(lower)) {
    if (lineCount > 1000) {
      return { type: 'chunked', maxChunks: maxChunksByBudget, keywords: extractKeywords(prompt) };
    }
    return { type: 'head-tail', headLines: 60, tailLines: 20 };
  }

  // Section-based (markdown, config)
  if (/section|heading|chapter|part\s+\d|##/i.test(lower) && (format === 'markdown' || format === 'yaml')) {
    return { type: 'grep', pattern: '^#{1,3}\\s|^\\w+:', maxResults: 40 };
  }

  // Structured data queries
  if (format === 'json' || format === 'json-lines') {
    if (/count|total|how many/i.test(lower)) {
      return { type: 'structured', command: `wc -l "${'{FILE}'}"` };
    }
    return { type: 'head-tail', headLines: 40, tailLines: 10 };
  }

  if (format === 'csv') {
    return { type: 'head-tail', headLines: 30, tailLines: 5 };
  }

  // Large code/text files — use chunked with keyword selection
  if (lineCount > 1000 && (format === 'code' || format === 'text' || format === 'markdown' || format === 'html')) {
    return { type: 'chunked', maxChunks: 5, keywords: extractKeywords(prompt) };
  }

  // Default: head + tail for medium files
  return { type: 'head-tail', headLines: Math.min(100, Math.floor(lineCount * 0.3)), tailLines: 20 };
}

// ---------------------------------------------------------------------------
// Execution helpers
// ---------------------------------------------------------------------------

async function executeGrep(filePath: string, pattern: string, maxResults: number): Promise<string> {
  return new Promise((resolve) => {
    const escaped = pattern.replace(/"/g, '\\"');
    exec(`grep -n -E "${escaped}" "${filePath}" | head -${maxResults}`, {
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (stdout) {
        resolve(stdout);
      } else if (stderr) {
        resolve(`(grep error: ${stderr.slice(0, 200)})`);
      } else {
        resolve('(no matches found)');
      }
    });
  });
}

function formatHeadTail(lines: string[], head: number, tail: number): string {
  const headPart = lines.slice(0, head).map((l, i) => `${String(i + 1).padStart(6)}\u2192${l}`).join('\n');
  const tailStart = lines.length - tail;
  const tailPart = lines.slice(tailStart).map((l, i) => `${String(tailStart + i + 1).padStart(6)}\u2192${l}`).join('\n');
  const skipped = lines.length - head - tail;
  return `${headPart}\n\n... [${skipped} lines omitted] ...\n\n${tailPart}`;
}

function extractSection(lines: string[], pattern: string): string {
  const regex = new RegExp(pattern, 'i');
  let startIdx = -1;
  let endIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i]!)) {
      if (startIdx === -1) {
        startIdx = i;
      } else {
        endIdx = i;
        break;
      }
    }
  }

  if (startIdx === -1) return '(section not found)';
  if (endIdx === -1) endIdx = Math.min(startIdx + 100, lines.length);

  return lines.slice(startIdx, endIdx).map((l, i) => `${String(startIdx + i + 1).padStart(6)}\u2192${l}`).join('\n');
}

async function executeStructured(filePath: string, command: string): Promise<string> {
  const cmd = command.replace('{FILE}', filePath);
  return new Promise((resolve) => {
    exec(cmd, { timeout: 10_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve(stdout || '(no output)');
    });
  });
}

/**
 * Chunked strategy: split file using doc-splitter, select most relevant chunks.
 */
function executeChunked(content: string, filePath: string, keywords: string[], maxChunks: number, onProgress?: SmartReadProgressCallback): string {
  const split = splitDocument(content, filePath, { maxTokensPerChunk: 4000 });
  onProgress?.(`Split into ${split.chunks.length} chunks`);

  if (split.chunks.length <= maxChunks) {
    // All chunks fit — return them all
    onProgress?.(`Returning all ${split.chunks.length} chunks`);
    const parts = split.chunks.map((c, i) => {
      onProgress?.(`Processing chunk ${i + 1}/${split.chunks.length}: ${c.heading || 'section'}`);
      return `--- Chunk ${c.index + 1}/${c.total}: ${c.heading || 'section'} ---\n${c.content}`;
    });
    return `[${split.chunks.length} chunk(s), showing all]\n\n${parts.join('\n\n')}`;
  }

  // Score chunks by keyword relevance
  const scored = split.chunks.map((chunk) => {
    const lower = chunk.content.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      const kwLower = kw.toLowerCase();
      // Count occurrences
      let idx = 0;
      while ((idx = lower.indexOf(kwLower, idx)) !== -1) {
        score++;
        idx += kwLower.length;
      }
    }
    // Boost first chunk (usually has imports/overview) and last (usually has exports/summary)
    if (chunk.index === 0) score += 2;
    if (chunk.index === split.chunks.length - 1) score += 1;
    return { chunk, score };
  });

  // Sort by score descending, take top N
  scored.sort((a, b) => b.score - a.score);
  const selected = scored.slice(0, maxChunks);
  onProgress?.(`Selected ${selected.length} most relevant chunks from ${split.chunks.length}`);

  // Re-sort by original order for coherent reading
  selected.sort((a, b) => a.chunk.index - b.chunk.index);

  const parts = selected.map(({ chunk, score }) =>
    `--- Chunk ${chunk.index + 1}/${split.chunks.length}: ${chunk.heading || 'section'} (relevance: ${score}) ---\n${chunk.content}`
  );

  const skipped = split.chunks.length - selected.length;
  return `[${split.chunks.length} chunk(s), showing ${selected.length} most relevant, ${skipped} omitted]\n\n${parts.join('\n\n')}`;
}

/**
 * Extract meaningful keywords from a user prompt for chunk scoring.
 */
function extractKeywords(prompt: string): string[] {
  // Remove common stop words and extract meaningful terms
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'about', 'into', 'through', 'during',
    'before', 'after', 'above', 'below', 'between', 'and', 'or', 'but',
    'not', 'no', 'nor', 'so', 'if', 'then', 'than', 'too', 'very',
    'just', 'that', 'this', 'these', 'those', 'it', 'its', 'what', 'which',
    'who', 'whom', 'when', 'where', 'why', 'how', 'all', 'each', 'every',
    'both', 'few', 'more', 'most', 'other', 'some', 'such', 'only', 'own',
    'same', 'me', 'my', 'i', 'you', 'your', 'he', 'she', 'we', 'they',
    'tell', 'show', 'find', 'read', 'check', 'look', 'see', 'get',
    'file', 'files', 'code', 'please', 'want', 'need',
  ]);

  return prompt
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));
}
