/**
 * Diff / patch tools -- compute / apply / invert / three-way.
 *
 * Compute + three-way shell out to POSIX `diff` / `diff3`; apply
 * uses `git apply` (with a `patch`-based fallback path) so binary
 * hunks and rename detection work. Invert is implemented in pure
 * TS because the transformation is a well-defined line-level swap.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runShell } from '../../shell-helper.js';
import { registerTool } from '../../registry.js';
import type {
  Tool, ToolApprovalGate, ToolInput, ToolResult,
} from '../../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function str(input: ToolInput, key: string): string | undefined {
  const v = input[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function bool(input: ToolInput, key: string): boolean | undefined {
  const v = input[key];
  return typeof v === 'boolean' ? v : undefined;
}

function fail(id: string, msg: string): ToolResult {
  return { output: `[${id}] ${msg}`, format: 'text', success: false, error: msg };
}

interface SourceSpec {
  content?: string;
  path?: string;
  gitRef?: string;   // e.g. HEAD, HEAD~1, feature
  gitPath?: string;  // required when gitRef is set
}

function parseSource(raw: unknown): SourceSpec | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return undefined; }
  const o = raw as Record<string, unknown>;
  const spec: SourceSpec = {};
  if (typeof o['content'] === 'string') { spec.content = o['content']; }
  if (typeof o['path']    === 'string' && o['path'].length > 0) { spec.path = o['path']; }
  if (typeof o['gitRef']  === 'string' && o['gitRef'].length > 0) { spec.gitRef = o['gitRef']; }
  if (typeof o['gitPath'] === 'string' && o['gitPath'].length > 0) { spec.gitPath = o['gitPath']; }
  return spec;
}

/**
 * Resolve a SourceSpec into a file path we can pass to diff. When the
 * spec carries inline content, write it to a temp file; returns
 * { path, cleanup } so the caller can unlink what we created.
 */
async function materializeSource(
  spec: SourceSpec,
  label: string,
  cwd: string | undefined,
): Promise<{ path: string; cleanup?: (() => Promise<void>) | undefined; error?: string }> {
  if (spec.path) { return { path: spec.path }; }
  if (spec.gitRef) {
    if (!spec.gitPath) { return { path: '', error: 'gitRef requires gitPath' }; }
    const r = await runShell(['git', 'show', `${spec.gitRef}:${spec.gitPath}`], { cwd, timeoutMs: 30_000 });
    if (r.code !== 0) { return { path: '', error: `git show failed: ${r.stderr.trim()}` }; }
    const p = join(tmpdir(), `insrc-diff-${label}-${process.pid}-${Date.now()}.txt`);
    await fs.writeFile(p, r.stdout, 'utf8');
    return { path: p, cleanup: async () => { try { await fs.unlink(p); } catch { /* ignore */ } } };
  }
  if (typeof spec.content === 'string') {
    const p = join(tmpdir(), `insrc-diff-${label}-${process.pid}-${Date.now()}.txt`);
    await fs.writeFile(p, spec.content, 'utf8');
    return { path: p, cleanup: async () => { try { await fs.unlink(p); } catch { /* ignore */ } } };
  }
  return { path: '', error: 'source requires content, path, or gitRef+gitPath' };
}

// ---------------------------------------------------------------------------
// diff:compute
// ---------------------------------------------------------------------------

interface DiffComputeData {
  unifiedDiff: string;
  additions: number;
  deletions: number;
  hunkCount: number;
  exitCode: number | null;
}

function countDiffLines(diff: string): { additions: number; deletions: number; hunkCount: number } {
  let additions = 0;
  let deletions = 0;
  let hunkCount = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) { hunkCount += 1; continue; }
    // Skip file headers (--- / +++).
    if (line.startsWith('---') || line.startsWith('+++')) { continue; }
    if (line.startsWith('+')) { additions += 1; }
    else if (line.startsWith('-')) { deletions += 1; }
  }
  return { additions, deletions, hunkCount };
}

export const diffComputeTool: Tool = {
  id: 'diff_compute',
  description: 'Compute a unified diff between two sources (inline content, file paths, or git refs).',
  inputSchema: {
    type: 'object',
    properties: {
      a: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          path:    { type: 'string' },
          gitRef:  { type: 'string' },
          gitPath: { type: 'string' },
        },
        additionalProperties: false,
      },
      b: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          path:    { type: 'string' },
          gitRef:  { type: 'string' },
          gitPath: { type: 'string' },
        },
        additionalProperties: false,
      },
      contextLines: { type: 'number', minimum: 0, maximum: 20 },
      cwd: { type: 'string', description: 'Working directory for gitRef lookups. Defaults to process cwd.' },
      labelA: { type: 'string', description: 'Label for the first side in headers.' },
      labelB: { type: 'string', description: 'Label for the second side in headers.' },
    },
    required: ['a', 'b'],
    additionalProperties: false,
  },
  requiresApproval: false,

  async execute(input: ToolInput): Promise<ToolResult> {
    const a = parseSource(input['a']);
    const b = parseSource(input['b']);
    if (!a || !b) { return fail('diff_compute', 'a and b must be source specs'); }
    const cwd = str(input, 'cwd');
    const ma = await materializeSource(a, 'a', cwd);
    const mb = await materializeSource(b, 'b', cwd);
    try {
      if (ma.error) { return fail('diff_compute', `side a: ${ma.error}`); }
      if (mb.error) { return fail('diff_compute', `side b: ${mb.error}`); }
      const context = typeof input['contextLines'] === 'number' && Number.isFinite(input['contextLines'] as number)
        ? String(input['contextLines']) : '3';
      const labelA = str(input, 'labelA') ?? ma.path;
      const labelB = str(input, 'labelB') ?? mb.path;
      const argv = ['diff', '-u', `-U${context}`, '--label', labelA, '--label', labelB, ma.path, mb.path];
      const r = await runShell(argv, { cwd, timeoutMs: 60_000 });
      if (r.spawnError) { return fail('diff_compute', `diff not found: ${r.stderr.trim()}`); }
      // diff exit codes: 0=identical, 1=different, >1=error.
      if (r.code !== 0 && r.code !== 1) {
        return fail('diff_compute', `diff failed (exit ${r.code}): ${r.stderr.trim()}`);
      }
      const { additions, deletions, hunkCount } = countDiffLines(r.stdout);
      const data: DiffComputeData = {
        unifiedDiff: r.stdout,
        additions, deletions, hunkCount,
        exitCode: r.code,
      };
      return {
        output: r.code === 0
          ? '_(no differences)_'
          : [
              `**${additions} additions / ${deletions} deletions across ${hunkCount} hunk(s)**`,
              '',
              '```diff',
              r.stdout.length > 20_000 ? r.stdout.slice(0, 20_000) + '\n... (truncated in render)' : r.stdout,
              '```',
            ].join('\n'),
        format: 'diff',
        success: true,
        data,
      };
    } finally {
      if (ma.cleanup) { await ma.cleanup(); }
      if (mb.cleanup) { await mb.cleanup(); }
    }
  },
};

// ---------------------------------------------------------------------------
// diff:apply
// ---------------------------------------------------------------------------

interface DiffApplyData {
  backend: 'git' | 'patch';
  targetDir: string;
  dryRun: boolean;
  reverse: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

async function writePatchToTemp(patch: string): Promise<string> {
  const p = join(tmpdir(), `insrc-apply-${process.pid}-${Date.now()}.patch`);
  await fs.writeFile(p, patch.endsWith('\n') ? patch : patch + '\n', 'utf8');
  return p;
}

export const diffApplyTool: Tool = {
  id: 'diff_apply',
  description: 'Apply a unified patch. Uses `git apply`; falls back to `patch` for plain hunks when git fails.',
  inputSchema: {
    type: 'object',
    properties: {
      patch: { type: 'string', description: 'Inline patch content (unified diff).' },
      patchPath: { type: 'string', description: 'Alternative to `patch`: path to a patch file on disk.' },
      targetDir: { type: 'string', description: 'cwd for patch application. Default: process cwd.' },
      dryRun: { type: 'boolean', description: 'Check only; do not touch disk.' },
      reverse: { type: 'boolean', description: 'Apply as a reversal (undoes the patch).' },
      index: { type: 'boolean', description: 'Pass --index (stage the result too, git only).' },
      threeWay: { type: 'boolean', description: 'Pass --3way to git apply.' },
      whitespaceFix: { type: 'boolean', description: 'Pass --whitespace=fix to git apply.' },
      stripLevel: { type: 'number', minimum: 0, maximum: 5, description: '-p<N> strip level. Default 1.' },
    },
    additionalProperties: false,
  },
  requiresApproval: true,

  buildApprovalGate(input: ToolInput): ToolApprovalGate {
    const patch = str(input, 'patch');
    const patchPath = str(input, 'patchPath');
    const preview = patchPath ? `File: \`${patchPath}\`` : patch ? patch : '_no patch supplied_';
    const clamped = preview.length > 3000 ? preview.slice(0, 3000) + '\n... (truncated)' : preview;
    return {
      title: 'diff_apply',
      content: [
        `Target: \`${str(input, 'targetDir') ?? process.cwd()}\``,
        bool(input, 'reverse') === true ? 'Reverse apply (undoes the patch).' : '',
        bool(input, 'dryRun')  === true ? 'Dry-run only.' : '',
        bool(input, 'threeWay') === true ? '--3way' : '',
        bool(input, 'whitespaceFix') === true ? '--whitespace=fix' : '',
        '',
        '**Patch**',
        '```diff',
        clamped,
        '```',
      ].filter(Boolean).join('\n'),
      actions: [
        { name: 'approve', label: 'Approve' },
        { name: 'skip', label: 'Skip' },
      ],
    };
  },

  async execute(input: ToolInput): Promise<ToolResult> {
    const patch = str(input, 'patch');
    const patchPath = str(input, 'patchPath');
    if (!patch && !patchPath) { return fail('diff_apply', 'patch or patchPath required'); }

    const cwd = str(input, 'targetDir') ?? process.cwd();
    const dryRun = bool(input, 'dryRun') === true;
    const reverse = bool(input, 'reverse') === true;
    const stripLevel = typeof input['stripLevel'] === 'number' && Number.isFinite(input['stripLevel'] as number)
      ? (input['stripLevel'] as number) : 1;

    let cleanup: (() => Promise<void>) | undefined;
    let resolvedPatchPath: string;
    if (patchPath) {
      resolvedPatchPath = patchPath;
    } else {
      resolvedPatchPath = await writePatchToTemp(patch!);
      cleanup = async () => { try { await fs.unlink(resolvedPatchPath); } catch { /* ignore */ } };
    }

    try {
      // Try git apply first.
      const gitArgv = ['git', 'apply', `-p${stripLevel}`];
      if (dryRun)                         { gitArgv.push('--check'); }
      if (reverse)                        { gitArgv.push('--reverse'); }
      if (bool(input, 'index')         === true) { gitArgv.push('--index'); }
      if (bool(input, 'threeWay')      === true) { gitArgv.push('--3way'); }
      if (bool(input, 'whitespaceFix') === true) { gitArgv.push('--whitespace=fix'); }
      gitArgv.push(resolvedPatchPath);

      const gitR = await runShell(gitArgv, { cwd, timeoutMs: 5 * 60_000 });
      if (!gitR.spawnError && gitR.code === 0) {
        const data: DiffApplyData = {
          backend: 'git', targetDir: cwd, dryRun, reverse,
          exitCode: 0, stdout: gitR.stdout, stderr: gitR.stderr,
        };
        return {
          output: [
            dryRun ? 'Patch checks cleanly (git apply --check).' : 'Patch applied via git apply.',
            gitR.stdout ? '\n```\n' + gitR.stdout.replace(/\n+$/, '') + '\n```' : '',
          ].filter(Boolean).join('\n'),
          format: 'markdown', success: true, data,
        };
      }

      // Fall back to POSIX patch, but only if git's error is not a "bad input" error.
      const gitStderr = (gitR.stderr || '').trim();
      const patchArgv = ['patch', `-p${stripLevel}`];
      if (dryRun)  { patchArgv.push('--dry-run'); }
      if (reverse) { patchArgv.push('-R'); }
      patchArgv.push('-i', resolvedPatchPath);

      const patchR = await runShell(patchArgv, { cwd, timeoutMs: 5 * 60_000 });
      if (patchR.spawnError && gitR.spawnError) {
        return fail('diff_apply', `neither git nor patch is available: ${gitStderr || patchR.stderr.trim()}`);
      }
      const ok = patchR.code === 0;
      const data: DiffApplyData = {
        backend: 'patch', targetDir: cwd, dryRun, reverse,
        exitCode: patchR.code, stdout: patchR.stdout, stderr: patchR.stderr,
      };
      return {
        output: [
          ok
            ? (dryRun ? 'Patch dry-run clean (patch --dry-run).' : 'Patch applied via `patch`.')
            : `**Patch failed** (git apply exit ${gitR.code}, patch exit ${patchR.code}).`,
          patchR.stdout ? '\n```\n' + patchR.stdout.replace(/\n+$/, '') + '\n```' : '',
          patchR.stderr ? '\n**stderr**\n```\n' + patchR.stderr.replace(/\n+$/, '') + '\n```' : '',
          gitStderr     ? '\n**git apply stderr**\n```\n' + gitStderr + '\n```' : '',
        ].filter(Boolean).join('\n'),
        format: 'markdown',
        success: ok,
        ...(ok ? {} : { error: `patch exit ${patchR.code}` }),
        data,
      };
    } finally {
      if (cleanup) { await cleanup(); }
    }
  },
};

// ---------------------------------------------------------------------------
// diff:invert -- pure in-memory unified-diff swap
// ---------------------------------------------------------------------------

interface DiffInvertData {
  inverted: string;
  hunksInverted: number;
}

/**
 * Swap a `@@ -oldStart,oldCount +newStart,newCount @@` header so the
 * resulting patch applies in the opposite direction.
 */
function invertHunkHeader(line: string): string {
  const m = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/);
  if (!m) { return line; }
  const oldStart  = m[1];
  const oldCount  = m[2];
  const newStart  = m[3];
  const newCount  = m[4];
  const trailing  = m[5] ?? '';
  const swapped = `@@ -${newStart}${newCount !== undefined ? ',' + newCount : ''} +${oldStart}${oldCount !== undefined ? ',' + oldCount : ''} @@${trailing}`;
  return swapped;
}

function invertUnifiedDiff(patch: string): { inverted: string; hunks: number } {
  const out: string[] = [];
  let hunks = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('--- ')) { out.push('+++ ' + line.slice(4)); continue; }
    if (line.startsWith('+++ ')) { out.push('--- ' + line.slice(4)); continue; }
    if (line.startsWith('@@'))   { out.push(invertHunkHeader(line)); hunks += 1; continue; }
    if (line.startsWith('diff --git ')) {
      // Swap a/ and b/ on the file header pair.
      const parts = line.split(/\s+/);
      if (parts.length === 4) { out.push(`${parts[0]} ${parts[1]} ${parts[3]} ${parts[2]}`); continue; }
      out.push(line);
      continue;
    }
    if (line.length === 0) { out.push(line); continue; }
    const first = line[0];
    if (first === '+')      { out.push('-' + line.slice(1)); continue; }
    if (first === '-')      { out.push('+' + line.slice(1)); continue; }
    out.push(line);
  }
  return { inverted: out.join('\n'), hunks };
}

export const diffInvertTool: Tool = {
  id: 'diff_invert',
  description: 'Return the inverse of a unified diff (applying the result undoes the original).',
  inputSchema: {
    type: 'object',
    properties: {
      patch: { type: 'string' },
      patchPath: { type: 'string' },
    },
    additionalProperties: false,
  },
  requiresApproval: false,

  async execute(input: ToolInput): Promise<ToolResult> {
    const inline = str(input, 'patch');
    const path = str(input, 'patchPath');
    let patch: string;
    if (inline) { patch = inline; }
    else if (path) {
      try { patch = await fs.readFile(path, 'utf8'); }
      catch (err: unknown) { return fail('diff_invert', `cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`); }
    } else {
      return fail('diff_invert', 'patch or patchPath required');
    }
    const { inverted, hunks } = invertUnifiedDiff(patch);
    const data: DiffInvertData = { inverted, hunksInverted: hunks };
    return {
      output: [
        `Inverted ${hunks} hunk(s).`,
        '',
        '```diff',
        inverted.length > 20_000 ? inverted.slice(0, 20_000) + '\n... (truncated in render)' : inverted,
        '```',
      ].join('\n'),
      format: 'diff',
      success: true,
      data,
    };
  },
};

// ---------------------------------------------------------------------------
// diff:three-way  (diff3 -m)
// ---------------------------------------------------------------------------

interface DiffThreeWayData {
  base: string;
  ours: string;
  theirs: string;
  outputPath: string | undefined;
  conflict: boolean;
  merged: string;
  exitCode: number | null;
}

async function materializeForThreeWay(spec: SourceSpec | undefined, label: string, cwd: string | undefined): Promise<{ path: string; cleanup?: (() => Promise<void>) | undefined; error?: string }> {
  if (!spec) { return { path: '', error: `${label} required` }; }
  return materializeSource(spec, label, cwd);
}

export const diffThreeWayTool: Tool = {
  id: 'diff:three-way',
  description: 'Three-way merge using diff3 -m. Writes the merged file when outputPath is set; conflicts are reported.',
  inputSchema: {
    type: 'object',
    properties: {
      base:   { type: 'object', properties: { content: { type: 'string' }, path: { type: 'string' }, gitRef: { type: 'string' }, gitPath: { type: 'string' } }, additionalProperties: false },
      ours:   { type: 'object', properties: { content: { type: 'string' }, path: { type: 'string' }, gitRef: { type: 'string' }, gitPath: { type: 'string' } }, additionalProperties: false },
      theirs: { type: 'object', properties: { content: { type: 'string' }, path: { type: 'string' }, gitRef: { type: 'string' }, gitPath: { type: 'string' } }, additionalProperties: false },
      outputPath: { type: 'string', description: 'Write the merged result to this path. Omit to keep in data only.' },
      cwd: { type: 'string' },
      labelBase:   { type: 'string' },
      labelOurs:   { type: 'string' },
      labelTheirs: { type: 'string' },
    },
    required: ['base', 'ours', 'theirs'],
    additionalProperties: false,
  },
  requiresApproval: true,

  buildApprovalGate(input: ToolInput): ToolApprovalGate {
    const outputPath = str(input, 'outputPath');
    return {
      title: 'diff:three-way',
      content: [
        'Three-way merge with diff3 -m.',
        outputPath ? `Output will be written to \`${outputPath}\`.` : 'No outputPath supplied -- merged result returned in data only.',
      ].filter(Boolean).join('\n'),
      actions: [
        { name: 'approve', label: 'Approve' },
        { name: 'skip', label: 'Skip' },
      ],
    };
  },

  async execute(input: ToolInput): Promise<ToolResult> {
    const base   = parseSource(input['base']);
    const ours   = parseSource(input['ours']);
    const theirs = parseSource(input['theirs']);
    const cwd = str(input, 'cwd');
    const outputPath = str(input, 'outputPath');

    const [mb, mo, mt] = await Promise.all([
      materializeForThreeWay(base,   'base',   cwd),
      materializeForThreeWay(ours,   'ours',   cwd),
      materializeForThreeWay(theirs, 'theirs', cwd),
    ]);
    try {
      if (mb.error) { return fail('diff:three-way', `base: ${mb.error}`); }
      if (mo.error) { return fail('diff:three-way', `ours: ${mo.error}`); }
      if (mt.error) { return fail('diff:three-way', `theirs: ${mt.error}`); }
      const labelBase   = str(input, 'labelBase')   ?? 'BASE';
      const labelOurs   = str(input, 'labelOurs')   ?? 'OURS';
      const labelTheirs = str(input, 'labelTheirs') ?? 'THEIRS';
      const argv = [
        'diff3', '-m',
        '--label', labelOurs,   '--label', labelBase, '--label', labelTheirs,
        mo.path,  mb.path,  mt.path,
      ];
      const r = await runShell(argv, { cwd, timeoutMs: 60_000 });
      if (r.spawnError) { return fail('diff:three-way', `diff3 not found: ${r.stderr.trim()}`); }
      // diff3 -m exit codes: 0 clean merge, 1 conflicts, 2 error.
      if (r.code !== 0 && r.code !== 1) {
        return fail('diff:three-way', `diff3 failed (exit ${r.code}): ${r.stderr.trim()}`);
      }
      const conflict = r.code === 1;
      const merged = r.stdout;
      if (outputPath) { await fs.writeFile(outputPath, merged, 'utf8'); }

      const data: DiffThreeWayData = {
        base: mb.path, ours: mo.path, theirs: mt.path,
        outputPath, conflict, merged, exitCode: r.code,
      };
      return {
        output: [
          conflict ? '**Merge produced conflicts.**' : 'Merge clean (no conflicts).',
          outputPath ? `Wrote merged result to \`${outputPath}\`.` : 'Merged result returned in data.',
          '',
          '```',
          merged.length > 20_000 ? merged.slice(0, 20_000) + '\n... (truncated in render)' : merged,
          '```',
        ].filter(Boolean).join('\n'),
        format: 'markdown',
        success: !conflict,
        ...(conflict ? { error: 'merge conflicts present' } : {}),
        data,
      };
    } finally {
      if (mb.cleanup) { await mb.cleanup(); }
      if (mo.cleanup) { await mo.cleanup(); }
      if (mt.cleanup) { await mt.cleanup(); }
    }
  },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerDiffTools(): void {
  registerTool(diffComputeTool);
  registerTool(diffApplyTool);
  registerTool(diffInvertTool);
  registerTool(diffThreeWayTool);
}
