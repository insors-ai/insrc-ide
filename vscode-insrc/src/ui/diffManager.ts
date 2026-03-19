/**
 * Inline diff display for agent proposals.
 *
 * Uses TextDocumentContentProvider to create virtual "proposed" documents,
 * then opens vscode.diff() in inline mode (single column, red/green).
 * CodeLens provides Accept / Reject / Edit buttons above the diff.
 */

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileDiff {
  filePath: string;     // absolute path to original file
  originalContent: string;
  proposedContent: string;
  diffText: string;     // unified diff for display
}

interface ActiveDiff {
  filePath: string;
  proposed: vscode.Uri;
  editor?: vscode.TextEditor;
  gateId?: string;
}

// ---------------------------------------------------------------------------
// Virtual document provider for proposed content
// ---------------------------------------------------------------------------

const SCHEME = 'insrc-proposed';

class ProposedContentProvider implements vscode.TextDocumentContentProvider {
  private contents = new Map<string, string>();
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  set(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
    this._onDidChange.fire(uri);
  }

  get(uri: vscode.Uri): string | undefined {
    return this.contents.get(uri.toString());
  }

  remove(uri: vscode.Uri): void {
    this.contents.delete(uri.toString());
  }

  clear(): void {
    this.contents.clear();
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }
}

// ---------------------------------------------------------------------------
// CodeLens provider
// ---------------------------------------------------------------------------

class DiffCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  private activeFiles = new Set<string>();

  setActive(filePath: string): void {
    this.activeFiles.add(filePath);
    this._onDidChangeCodeLenses.fire();
  }

  removeActive(filePath: string): void {
    this.activeFiles.delete(filePath);
    this._onDidChangeCodeLenses.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    // Only show on proposed (virtual) documents
    if (document.uri.scheme !== SCHEME) return [];

    // Extract the original file path from the URI
    const originalPath = decodeURIComponent(document.uri.path);
    if (!this.activeFiles.has(originalPath)) return [];

    const range = new vscode.Range(0, 0, 0, 0);

    return [
      new vscode.CodeLens(range, {
        title: '$(check) Accept',
        command: 'insrc.diffAccept',
        arguments: [originalPath],
        tooltip: 'Apply proposed changes to disk',
      }),
      new vscode.CodeLens(range, {
        title: '$(x) Reject',
        command: 'insrc.diffReject',
        arguments: [originalPath],
        tooltip: 'Discard proposed changes',
      }),
      new vscode.CodeLens(range, {
        title: '$(pencil) Edit',
        command: 'insrc.diffEdit',
        arguments: [originalPath],
        tooltip: 'Provide feedback and re-propose',
      }),
    ];
  }
}

// ---------------------------------------------------------------------------
// DiffManager
// ---------------------------------------------------------------------------

export interface DiffManager {
  /** Show inline diff for one or more files. Returns when user acts on all diffs. */
  showDiffs(diffs: FileDiff[], gateId?: string): Promise<void>;
  /** Accept a specific file diff. */
  accept(filePath: string): void;
  /** Reject a specific file diff. */
  reject(filePath: string): void;
  /** Edit (request feedback) for a specific file diff. */
  edit(filePath: string): Promise<string | undefined>;
  /** Accept all pending diffs. */
  acceptAll(): void;
  /** Reject all pending diffs. */
  rejectAll(): void;
  /** Close all diff tabs and clean up. */
  closeAll(): void;
  /** Get pending action resolution callback. */
  onAction(callback: (action: 'accept' | 'reject' | 'edit', filePath: string, feedback?: string) => void): void;
  /** Dispose all resources. */
  dispose(): void;
}

export function createDiffManager(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): DiffManager {
  const provider = new ProposedContentProvider();
  const codeLensProvider = new DiffCodeLensProvider();
  const activeDiffs = new Map<string, ActiveDiff>();
  let actionCallback: ((action: 'accept' | 'reject' | 'edit', filePath: string, feedback?: string) => void) | null = null;

  // Register providers
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
    vscode.languages.registerCodeLensProvider({ scheme: SCHEME }, codeLensProvider),
  );

  // Set inline diff mode
  const diffConfig = vscode.workspace.getConfiguration('diffEditor');
  if (diffConfig.get('renderSideBySide') !== false) {
    diffConfig.update('renderSideBySide', false, vscode.ConfigurationTarget.Workspace)
      .then(() => {}, () => { /* ignore if workspace not writable */ });
  }

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('insrc.diffAccept', (filePath: string) => {
      acceptFile(filePath);
    }),
    vscode.commands.registerCommand('insrc.diffReject', (filePath: string) => {
      rejectFile(filePath);
    }),
    vscode.commands.registerCommand('insrc.diffEdit', async (filePath: string) => {
      const feedback = await vscode.window.showInputBox({
        prompt: 'What should be changed?',
        placeHolder: 'Describe the changes you want...',
      });
      if (feedback !== undefined) {
        closeDiffTab(filePath);
        actionCallback?.('edit', filePath, feedback);
      }
    }),
    vscode.commands.registerCommand('insrc.diffAcceptAll', () => {
      acceptAllDiffs();
    }),
    vscode.commands.registerCommand('insrc.diffRejectAll', () => {
      rejectAllDiffs();
    }),
  );

  function log(msg: string): void {
    outputChannel.appendLine(`[diff] ${msg}`);
  }

  async function showDiffs(diffs: FileDiff[], gateId?: string): Promise<void> {
    for (const diff of diffs) {
      const proposedUri = vscode.Uri.parse(`${SCHEME}:${encodeURIComponent(diff.filePath)}`);
      provider.set(proposedUri, diff.proposedContent);
      codeLensProvider.setActive(diff.filePath);

      const originalUri = vscode.Uri.file(diff.filePath);
      const fileName = path.basename(diff.filePath);

      activeDiffs.set(diff.filePath, {
        filePath: diff.filePath,
        proposed: proposedUri,
        gateId,
      });

      // Open inline diff
      await vscode.commands.executeCommand('vscode.diff',
        originalUri,
        proposedUri,
        `${fileName} (proposed)`,
        { preview: false },
      );

      log(`opened diff: ${fileName}`);
    }
  }

  function acceptFile(filePath: string): void {
    const diff = activeDiffs.get(filePath);
    if (!diff) return;

    // Write proposed content to disk
    const content = provider.get(diff.proposed);
    if (content !== undefined) {
      fs.writeFileSync(filePath, content, 'utf-8');
      log(`accepted: ${path.basename(filePath)}`);
    }

    closeDiffTab(filePath);
    actionCallback?.('accept', filePath);
  }

  function rejectFile(filePath: string): void {
    log(`rejected: ${path.basename(filePath)}`);
    closeDiffTab(filePath);
    actionCallback?.('reject', filePath);
  }

  function closeDiffTab(filePath: string): void {
    const diff = activeDiffs.get(filePath);
    if (!diff) return;

    // Close the diff editor tab
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputTextDiff) {
          const modified = tab.input.modified;
          if (modified.scheme === SCHEME && decodeURIComponent(modified.path) === filePath) {
            vscode.window.tabGroups.close(tab);
          }
        }
      }
    }

    provider.remove(diff.proposed);
    codeLensProvider.removeActive(filePath);
    activeDiffs.delete(filePath);
  }

  function acceptAllDiffs(): void {
    for (const filePath of [...activeDiffs.keys()]) {
      acceptFile(filePath);
    }
  }

  function rejectAllDiffs(): void {
    for (const filePath of [...activeDiffs.keys()]) {
      rejectFile(filePath);
    }
  }

  function closeAll(): void {
    for (const filePath of [...activeDiffs.keys()]) {
      closeDiffTab(filePath);
    }
    provider.clear();
  }

  function dispose(): void {
    closeAll();
  }

  return {
    showDiffs,
    accept: acceptFile,
    reject: rejectFile,
    edit: async (filePath: string) => {
      const feedback = await vscode.window.showInputBox({
        prompt: 'What should be changed?',
        placeHolder: 'Describe the changes you want...',
      });
      if (feedback !== undefined) {
        closeDiffTab(filePath);
        actionCallback?.('edit', filePath, feedback);
      }
      return feedback;
    },
    acceptAll: acceptAllDiffs,
    rejectAll: rejectAllDiffs,
    closeAll,
    onAction: (cb) => { actionCallback = cb; },
    dispose,
  };
}

// ---------------------------------------------------------------------------
// Diff parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse a unified diff string into per-file FileDiff entries.
 * Reads original content from disk, applies the diff to produce proposed content.
 */
export function parseDiffToFileDiffs(diffText: string, repoPath: string): FileDiff[] {
  const diffs: FileDiff[] = [];

  // Split by file headers (--- a/... +++ b/...)
  const filePattern = /^---\s+a\/(.+)\n\+\+\+\s+b\/(.+)$/gm;
  let match: RegExpExecArray | null;
  const positions: Array<{ file: string; start: number }> = [];

  while ((match = filePattern.exec(diffText)) !== null) {
    positions.push({ file: match[2]!, start: match.index });
  }

  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i]!;
    const end = i + 1 < positions.length ? positions[i + 1]!.start : diffText.length;
    const fileDiffText = diffText.slice(pos.start, end);

    const absPath = path.isAbsolute(pos.file) ? pos.file : path.join(repoPath, pos.file);
    let originalContent = '';
    try {
      originalContent = fs.readFileSync(absPath, 'utf-8');
    } catch {
      // New file — no original
    }

    const proposedContent = applyUnifiedDiff(originalContent, fileDiffText);

    diffs.push({
      filePath: absPath,
      originalContent,
      proposedContent,
      diffText: fileDiffText,
    });
  }

  return diffs;
}

/**
 * Apply a unified diff to original content to produce proposed content.
 * Simple line-based application — not a full patch utility.
 */
function applyUnifiedDiff(original: string, diff: string): string {
  const lines = original.split('\n');
  const result: string[] = [];
  const hunkPattern = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  let lineIdx = 0;

  const diffLines = diff.split('\n');
  let i = 0;

  // Skip to first hunk
  while (i < diffLines.length && !hunkPattern.test(diffLines[i]!)) i++;

  while (i < diffLines.length) {
    const hunkMatch = diffLines[i]!.match(hunkPattern);
    if (!hunkMatch) { i++; continue; }

    const origStart = parseInt(hunkMatch[1]!, 10) - 1; // 0-indexed

    // Copy lines before this hunk
    while (lineIdx < origStart && lineIdx < lines.length) {
      result.push(lines[lineIdx]!);
      lineIdx++;
    }

    i++;
    while (i < diffLines.length && !hunkPattern.test(diffLines[i]!)) {
      const line = diffLines[i]!;
      if (line.startsWith('+')) {
        result.push(line.slice(1));
      } else if (line.startsWith('-')) {
        lineIdx++; // skip original line
      } else if (line.startsWith(' ')) {
        result.push(line.slice(1));
        lineIdx++;
      } else if (line === '\\ No newline at end of file') {
        // ignore
      }
      i++;
    }
  }

  // Copy remaining lines
  while (lineIdx < lines.length) {
    result.push(lines[lineIdx]!);
    lineIdx++;
  }

  return result.join('\n');
}
