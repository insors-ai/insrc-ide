/**
 * Code annotations — select text, add notes, send to chat.
 *
 * Select text → Ctrl+Shift+A (or context menu) → input box for note →
 * amber highlight + gutter icon on range → CodeLens preview above range.
 * Accumulate across files. "Send to chat" compiles structured message.
 */

import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Annotation {
  id: string;
  file: string;
  range: vscode.Range;
  text: string;       // the selected code
  note: string;       // user's annotation
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Decoration types
// ---------------------------------------------------------------------------

const highlightDecoration = vscode.window.createTextEditorDecorationType({
  backgroundColor: 'rgba(255, 191, 0, 0.15)',
  borderColor: 'rgba(255, 191, 0, 0.4)',
  borderWidth: '1px',
  borderStyle: 'solid',
  borderRadius: '2px',
  gutterIconPath: undefined, // set dynamically per instance
  gutterIconSize: 'contain',
  overviewRulerColor: 'rgba(255, 191, 0, 0.6)',
  overviewRulerLane: vscode.OverviewRulerLane.Right,
});

// ---------------------------------------------------------------------------
// CodeLens provider
// ---------------------------------------------------------------------------

class AnnotationCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;

  private annotations: Annotation[] = [];

  update(annotations: Annotation[]): void {
    this.annotations = annotations;
    this._onDidChange.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];
    for (const ann of this.annotations) {
      if (ann.file !== document.uri.fsPath) continue;
      lenses.push(
        new vscode.CodeLens(ann.range, {
          title: `📌 ${ann.note.slice(0, 60)}${ann.note.length > 60 ? '...' : ''}`,
          command: 'insrc.editAnnotation',
          arguments: [ann.id],
          tooltip: ann.note,
        }),
      );
    }
    return lenses;
  }
}

// ---------------------------------------------------------------------------
// AnnotationManager
// ---------------------------------------------------------------------------

export interface AnnotationManager {
  /** Add annotation for current selection. Prompts for note. */
  addAnnotation(): Promise<void>;
  /** Edit an existing annotation's note. */
  editAnnotation(id: string): Promise<void>;
  /** Remove an annotation. */
  removeAnnotation(id: string): void;
  /** Get all annotations. */
  getAll(): Annotation[];
  /** Get count. */
  count(): number;
  /** Compile all annotations into a structured message for chat. */
  compileForChat(): string;
  /** Clear all annotations after sending. */
  clearAll(): void;
  /** Dispose all resources. */
  dispose(): void;
}

export function createAnnotationManager(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): AnnotationManager {
  const annotations: Annotation[] = [];
  const codeLensProvider = new AnnotationCodeLensProvider();
  let nextId = 1;

  // Register CodeLens provider for all files
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLensProvider),
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('insrc.addAnnotation', () => addAnnotation()),
    vscode.commands.registerCommand('insrc.editAnnotation', (id: string) => editAnnotation(id)),
    vscode.commands.registerCommand('insrc.removeAnnotation', (id: string) => removeAnnotation(id)),
    vscode.commands.registerCommand('insrc.sendAnnotations', () => sendAnnotations()),
  );

  function refreshDecorations(): void {
    // Group annotations by file and apply decorations
    const byFile = new Map<string, Annotation[]>();
    for (const ann of annotations) {
      const list = byFile.get(ann.file) ?? [];
      list.push(ann);
      byFile.set(ann.file, list);
    }

    for (const editor of vscode.window.visibleTextEditors) {
      const fileAnns = byFile.get(editor.document.uri.fsPath) ?? [];
      editor.setDecorations(
        highlightDecoration,
        fileAnns.map(a => ({
          range: a.range,
          hoverMessage: new vscode.MarkdownString(`**📌 Annotation:** ${a.note}\n\n[Remove](command:insrc.removeAnnotation?${encodeURIComponent(JSON.stringify(a.id))})`),
        })),
      );
    }

    codeLensProvider.update(annotations);
  }

  // Refresh decorations when editors change
  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(() => refreshDecorations()),
    vscode.window.onDidChangeActiveTextEditor(() => refreshDecorations()),
  );

  async function addAnnotation(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('No active editor. Select some code first.');
      return;
    }

    const selection = editor.selection;
    if (selection.isEmpty) {
      vscode.window.showInformationMessage('Select some code to annotate.');
      return;
    }

    const note = await vscode.window.showInputBox({
      prompt: 'Add annotation note',
      placeHolder: 'What should the agent know about this code?',
    });

    if (!note) return;

    const ann: Annotation = {
      id: String(nextId++),
      file: editor.document.uri.fsPath,
      range: new vscode.Range(selection.start, selection.end),
      text: editor.document.getText(selection),
      note,
      createdAt: new Date().toISOString(),
    };

    annotations.push(ann);
    refreshDecorations();
    outputChannel.appendLine(`[annotation] added: ${ann.file}:${ann.range.start.line + 1} — ${note.slice(0, 50)}`);
  }

  async function editAnnotation(id: string): Promise<void> {
    const ann = annotations.find(a => a.id === id);
    if (!ann) return;

    const note = await vscode.window.showInputBox({
      prompt: 'Edit annotation',
      value: ann.note,
    });

    if (note !== undefined) {
      ann.note = note;
      refreshDecorations();
    }
  }

  function removeAnnotation(id: string): void {
    const idx = annotations.findIndex(a => a.id === id);
    if (idx >= 0) {
      annotations.splice(idx, 1);
      refreshDecorations();
    }
  }

  function compileForChat(): string {
    if (annotations.length === 0) return '';

    const byFile = new Map<string, Annotation[]>();
    for (const ann of annotations) {
      const list = byFile.get(ann.file) ?? [];
      list.push(ann);
      byFile.set(ann.file, list);
    }

    let msg = `I have ${annotations.length} annotation(s) across ${byFile.size} file(s):\n\n`;

    for (const [file, anns] of byFile) {
      const fileName = file.split('/').pop() ?? file;
      msg += `**${fileName}:**\n`;
      for (const ann of anns) {
        msg += `- Line ${ann.range.start.line + 1}: "${ann.note}"\n`;
        msg += `  \`\`\`\n  ${ann.text.split('\n').slice(0, 5).join('\n  ')}\n  \`\`\`\n`;
      }
      msg += '\n';
    }

    return msg;
  }

  function sendAnnotations(): void {
    // This is called by the extension command — the chat panel handles the actual sending
  }

  function clearAll(): void {
    annotations.length = 0;
    refreshDecorations();
  }

  function dispose(): void {
    clearAll();
  }

  return {
    addAnnotation,
    editAnnotation,
    removeAnnotation,
    getAll: () => [...annotations],
    count: () => annotations.length,
    compileForChat,
    clearAll,
    dispose,
  };
}
