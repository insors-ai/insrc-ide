# Diff Manager Implementation Plan

## Overview

The diff manager displays agent-proposed code changes as inline diffs in the editor, with CodeLens buttons to accept/reject/edit. It bridges the gate system (from chat streaming) to the VS Code diff editor.

## Lifecycle

1. Agent proposes code changes via `stream: 'gate'` message
2. Gate content contains unified diff in markdown fences
3. Chat view detects diff in gate → calls DiffManager
4. DiffManager parses unified diff into per-file diffs
5. Opens VS Code diff editor (original vs proposed) for each file
6. CodeLens provides Accept/Reject/Edit buttons at top of each diff
7. User action → DiffManager writes file (accept) or discards (reject)
8. Action callback fires → ChatService sends `chat.reply` to daemon
9. Agent continues or iterates based on action

## Components

### 1. IDiffService (common/diffService.ts)
```typescript
interface IInsrcDiffService {
    readonly onDidAction: Event<DiffAction>;
    showDiffs(diffs: FileDiff[], gateId: string): Promise<void>;
    acceptFile(filePath: string): void;
    rejectFile(filePath: string): void;
    editFile(filePath: string): Promise<string | undefined>;
    acceptAll(): void;
    rejectAll(): void;
    closeAll(): void;
    readonly activeDiffCount: number;
}

interface FileDiff {
    filePath: string;
    originalContent: string;
    proposedContent: string;
    diffText: string;
}

interface DiffAction {
    type: 'accept' | 'reject' | 'edit';
    filePath: string;
    gateId: string;
    feedback?: string;
}
```

### 2. ProposedContentProvider (browser/diff/proposedContentProvider.ts)
- `TextDocumentContentProvider` for scheme `insrc-proposed`
- Stores proposed content in memory, keyed by URI
- Fires `onDidChange` when content updates

### 3. DiffCodeLensProvider (browser/diff/diffCodeLens.ts)
- CodeLens at top of `insrc-proposed` documents
- Three buttons: Accept, Reject, Edit
- Tracks active files, triggers refresh on change

### 4. DiffServiceImpl (electron-sandbox/diffServiceImpl.ts)
- Opens diff tabs via `editorService.openEditor()` with DiffEditorInput
- Manages active diffs map
- Accept: writes proposed content to disk via `fileService`
- Reject: closes tab, removes from map
- Edit: shows quick input for feedback
- Fires `onDidAction` for chat integration

### 5. Chat integration (in chatView.ts / chatServiceImpl.ts)
- Detect diff in gate content: check for `--- a/` or `+++ b/`
- Parse unified diff → FileDiff[]
- Call `diffService.showDiffs(diffs, gateId)`
- Subscribe to `diffService.onDidAction` → send `chat.reply`

### 6. Commands
- `insrc.diffAccept` — accept single file
- `insrc.diffReject` — reject single file
- `insrc.diffEdit` — edit with feedback
- `insrc.diffAcceptAll` — accept all pending
- `insrc.diffRejectAll` — reject all pending

## Implementation order

1. `common/diffService.ts` — interface + types
2. `browser/diff/proposedContentProvider.ts` — virtual doc scheme
3. `browser/diff/diffCodeLens.ts` — CodeLens provider
4. `electron-sandbox/diffServiceImpl.ts` — service implementation
5. Wire into `insrc.contribution.ts` — register scheme, CodeLens, commands
6. Wire into chat — detect diffs in gates, call diffService

## Diff parsing

The daemon sends diffs as unified diff format inside gate content markdown. Parser needs to:
1. Extract diff block from markdown (between ```diff fences)
2. Split by file headers (`--- a/path`, `+++ b/path`)
3. For each file: read original from disk, apply hunks to get proposed content
4. Return FileDiff[] array

Reuse existing `applyUnifiedDiff()` logic from daemon's `agent/tasks/diff-utils.ts`.
