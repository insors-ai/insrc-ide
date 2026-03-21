# Prompt Notepad

## Problem

The chat input area is a single-line (expandable) text input. For complex prompts — multi-paragraph instructions, code snippets with context, file references with annotations — typing in the chat input is cramped and error-prone. Users need a full editor experience for composing prompts.

## Design

A "Prompt Notepad" button below the chat input opens a full Monaco editor tab where users compose prompts with full editor capabilities (syntax highlighting, multi-cursor, find/replace, line numbers). A Run button in the editor toolbar sends the content as a chat message.

### UX Flow

```
Chat input area
[Attach] [Intent: research v] [Send]
[Open Prompt Notepad]              <-- new button

Click "Open Prompt Notepad":
  -> Opens a new editor tab: "Prompt Notepad"
  -> Full Monaco editor with markdown language mode
  -> Editor toolbar has: [Run All] [Run Selection]
  -> User types their prompt in the editor
  -> Click "Run All" -> entire content sent as chat message
  -> Select a section, click "Run Selection" -> only selection sent
  -> Tab stays open for editing/re-running
```

### Editor Tab

```
+-- Prompt Notepad ------------------------------------------+
| [Run All] [Run Selection] [Clear] [Save as Template]      |  <- CodeLens or toolbar
|                                                             |
| Analyze the following files for security issues:            |
|                                                             |
| ## Files to check                                           |
| - src/auth/middleware.ts (JWT validation)                   |
| - src/api/routes.ts (endpoint auth)                         |
| - src/db/queries.ts (SQL injection)                         |
|                                                             |
| ## What to look for                                         |
| 1. Missing input validation                                 |
| 2. SQL injection via string concatenation                   |
| 3. JWT expiry not checked                                   |
| 4. Rate limiting absent                                     |
|                                                             |
| Report findings grouped by severity (critical/high/medium). |
+------------------------------------------------------------+
```

### Features

1. **Full Monaco editor** — markdown mode, line numbers, word wrap, all editor features
2. **Run All** — sends entire content as a chat message (equivalent to typing in chat + send)
3. **Run Selection** — sends only the selected text (useful for iterating on parts)
4. **Clear** — clears the editor content
5. **Save as Template** — saves the prompt to `~/.insrc/templates/` for reuse
6. **Persistent** — content survives tab close (stored in IStorageService)
7. **File references** — paths in the notepad are auto-resolved (same as chat input)
8. **Variables** — support `${repo}`, `${file}`, `${selection}` placeholders that expand on run
9. **Multiple notepads** — user can open multiple (Prompt Notepad 1, 2, etc.)

### Architecture

#### Virtual Document Scheme

Register a `TextDocumentContentProvider` for scheme `insrc-prompt`:

```typescript
// URI: insrc-prompt:/notepad/1
// Language: markdown
// Content stored in IStorageService (workspace scope)
```

#### CodeLens Provider

Provide Run/Clear/Save actions as CodeLens at the top of the document:

```typescript
class PromptNotepadCodeLensProvider implements CodeLensProvider {
  provideCodeLenses(document: TextDocument): CodeLens[] {
    const topRange = new Range(0, 0, 0, 0);
    return [
      new CodeLens(topRange, {
        title: '$(play) Run All',
        command: 'insrc.promptNotepad.runAll',
      }),
      new CodeLens(topRange, {
        title: '$(play) Run Selection',
        command: 'insrc.promptNotepad.runSelection',
      }),
      new CodeLens(topRange, {
        title: '$(trash) Clear',
        command: 'insrc.promptNotepad.clear',
      }),
      new CodeLens(topRange, {
        title: '$(save) Save as Template',
        command: 'insrc.promptNotepad.saveTemplate',
      }),
    ];
  }
}
```

#### Commands

| Command | Action |
|---------|--------|
| `insrc.promptNotepad.open` | Open/focus the notepad tab |
| `insrc.promptNotepad.runAll` | Send entire content to chat |
| `insrc.promptNotepad.runSelection` | Send selected text to chat |
| `insrc.promptNotepad.clear` | Clear editor content |
| `insrc.promptNotepad.saveTemplate` | Save to templates dir |

#### Run Flow

```
User clicks "Run All" (or "Run Selection")
  |
  v
Get content (full or selection)
  |
  v
Expand variables (${repo}, ${file}, ${selection})
  |
  v
chatService.sendMessage(content)
  |
  v
Focus chat panel (auxiliary bar)
  |
  v
Chat processes the message normally
(research agent, simple completion, etc.)
```

#### Chat Input Button

Add a small button below the chat input area:

```typescript
// In chatView.ts, after the input container
const notepadBtn = dom.append(this._container, dom.$('button.insrc-chat-notepad-btn'));
notepadBtn.textContent = 'Open Prompt Notepad';
notepadBtn.addEventListener('click', () => {
  this.commandService.executeCommand('insrc.promptNotepad.open');
});
```

CSS:
```css
.insrc-chat-notepad-btn {
  width: 100%;
  padding: 4px 8px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  border: 1px dashed var(--vscode-sideBarSectionHeader-border);
  border-radius: 4px;
  cursor: pointer;
  margin-top: 4px;
}
.insrc-chat-notepad-btn:hover {
  background: var(--vscode-list-hoverBackground);
}
```

### Variable Expansion

| Variable | Expands to |
|----------|------------|
| `${repo}` | Active repo path |
| `${repoName}` | Active repo name |
| `${file}` | Currently open file path |
| `${fileName}` | Currently open file name |
| `${selection}` | Currently selected text in the active editor |
| `${line}` | Current line number |
| `${clipboard}` | Clipboard contents |

Variables are expanded at run time, not in the editor. The notepad shows them as-is.

### Storage

- Content persisted in `IStorageService` under key `insrc.promptNotepad.{id}`
- Scope: `StorageScope.WORKSPACE` (per workspace)
- Saved on every edit (debounced 500ms)

### Templates

Saved templates stored as `.md` files in `~/.insrc/templates/`:
```
~/.insrc/templates/
  security-audit.md
  code-review.md
  log-analysis.md
```

A "Load Template" command shows a quick pick of available templates.

### Implementation Order

1. **Virtual document provider** (`insrc-prompt` scheme)
2. **CodeLens provider** (Run All, Run Selection, Clear, Save)
3. **Commands** (open, runAll, runSelection, clear, saveTemplate, loadTemplate)
4. **Chat input button** (in chatView.ts)
5. **Variable expansion** (${repo}, ${file}, etc.)
6. **Storage persistence** (auto-save content)
7. **Template save/load** (file system + quick pick)

### Files

```
src/vs/workbench/contrib/insrc/browser/notepad/
  promptNotepadProvider.ts    -- TextDocumentContentProvider
  promptNotepadCodeLens.ts    -- CodeLens (Run/Clear/Save)
  promptNotepadCommands.ts    -- All commands
  promptNotepadRegistration.ts -- Contribution registration
```
