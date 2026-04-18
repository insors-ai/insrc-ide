/**
 * Shared helpers for file:* tools.
 */

import { resolve } from 'node:path';
import type { ToolInput, ToolResult } from '../../types.js';

export function str(input: ToolInput, key: string): string | undefined {
  const v = input[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function resolvePath(input: ToolInput, key = 'path'): string | undefined {
  const raw = str(input, key);
  if (!raw) { return undefined; }
  return resolve(raw);
}

export function fail(id: string, msg: string): ToolResult {
  return { output: `[${id}] ${msg}`, format: 'text', success: false, error: msg };
}

/** Read + format bytes into a human string. */
export function humanBytes(n: number): string {
  if (n < 1024) { return `${n} B`; }
  if (n < 1024 * 1024) { return `${(n / 1024).toFixed(1)} KB`; }
  if (n < 1024 * 1024 * 1024) { return `${(n / (1024 * 1024)).toFixed(1)} MB`; }
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Truncate a string to `max` chars, adding an ellipsis marker if cut. */
export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `\n...[truncated ${s.length - max} chars]` : s;
}

/** Format a content preview for gate content (first N lines, backtick-fenced). */
export function previewLines(content: string, maxLines = 20): string {
  const lines = content.split('\n');
  if (lines.length <= maxLines) {
    return '```\n' + content + '\n```';
  }
  return '```\n' + lines.slice(0, maxLines).join('\n') + `\n...[${lines.length - maxLines} more lines]\n\`\`\``;
}
