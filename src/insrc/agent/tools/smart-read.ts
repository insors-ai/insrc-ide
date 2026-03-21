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

import { readFile, stat } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { extname } from 'node:path';
import type { LLMProvider } from '../../shared/types.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('smart-read');

const SMALL_FILE_THRESHOLD = 500; // lines

interface SmartReadResult {
  content: string;
  strategy: string;
  metadata: string;
}

/**
 * Smart read: check file size, sample format, plan extraction, execute.
 *
 * @param filePath Absolute path to the file
 * @param userPrompt The user's original question (used to plan extraction)
 * @param provider Optional LLM provider for planning (falls back to heuristics)
 */
export async function smartRead(
  filePath: string,
  userPrompt: string,
  provider?: LLMProvider,
): Promise<SmartReadResult> {

  // Step 1: stat
  const fileStat = await stat(filePath);
  const raw = await readFile(filePath, 'utf-8');
  const lines = raw.split('\n');
  const lineCount = lines.length;
  const sizeKB = (fileStat.size / 1024).toFixed(1);

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

  // Step 3: plan — decide extraction strategy based on format + prompt
  const strategy = planStrategy(format, userPrompt, lineCount);

  log.info({ filePath, lineCount, format, strategy: strategy.type }, 'SmartRead planned');

  // Step 4: execute
  let extracted: string;
  switch (strategy.type) {
    case 'grep':
      extracted = await executeGrep(filePath, strategy.pattern!, strategy.maxResults ?? 50);
      break;
    case 'head-tail':
      extracted = formatHeadTail(lines, strategy.headLines ?? 50, strategy.tailLines ?? 20);
      break;
    case 'section':
      extracted = extractSection(lines, strategy.sectionPattern!);
      break;
    case 'structured':
      extracted = await executeStructured(filePath, strategy.command!);
      break;
    default:
      extracted = formatHeadTail(lines, 100, 20);
  }

  // Step 5: format with metadata
  const metadata = `[File: ${filePath} | ${lineCount} lines | ${sizeKB} KB | Format: ${format} | Strategy: ${strategy.type}]`;

  return { content: `${metadata}\n\n${extracted}`, strategy: strategy.type, metadata };
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

function detectFormat(filePath: string, sample: string): string {
  const ext = extname(filePath).toLowerCase();

  // Extension-based
  if (['.json', '.jsonl', '.ndjson'].includes(ext)) return 'json';
  if (['.csv', '.tsv'].includes(ext)) return 'csv';
  if (['.log'].includes(ext)) return 'log';
  if (['.md'].includes(ext)) return 'markdown';
  if (['.yaml', '.yml'].includes(ext)) return 'yaml';
  if (['.xml', '.html', '.htm'].includes(ext)) return ext.replace('.', '');
  if (['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h'].includes(ext)) return 'code';
  if (['.sql'].includes(ext)) return 'sql';
  if (['.sh', '.bash', '.zsh'].includes(ext)) return 'shell';

  // Content-based
  const firstLine = sample.split('\n')[0] ?? '';
  if (firstLine.startsWith('{') && firstLine.includes('"')) return 'json-lines';
  if (firstLine.includes('\t') && sample.split('\n').slice(0, 5).every(l => l.split('\t').length > 2)) return 'csv';
  if (/^\[\d{2}:\d{2}:\d{2}\]|\d{4}-\d{2}-\d{2}T/.test(firstLine)) return 'log';

  return 'text';
}

// ---------------------------------------------------------------------------
// Strategy planning (heuristic — no LLM needed for common patterns)
// ---------------------------------------------------------------------------

interface Strategy {
  type: 'grep' | 'head-tail' | 'section' | 'structured';
  pattern?: string;
  maxResults?: number;
  headLines?: number;
  tailLines?: number;
  sectionPattern?: string;
  command?: string;
}

function planStrategy(format: string, prompt: string, lineCount: number): Strategy {
  const lower = prompt.toLowerCase();

  // Error/warning/failure searching
  if (/error|fail|crash|exception|panic|critical|fatal/i.test(lower)) {
    if (format === 'json-lines' || format === 'json') {
      return { type: 'grep', pattern: '"level":\\s*[45]0|"level":\\s*"(error|fatal|warn)"', maxResults: 30 };
    }
    if (format === 'log') {
      return { type: 'grep', pattern: 'ERROR|FATAL|FAIL|Exception|panic|CRITICAL', maxResults: 30 };
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

  // Summary/overview
  if (/summar|overview|what is|describe|explain|structure/i.test(lower)) {
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

  // Default: head + tail
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
