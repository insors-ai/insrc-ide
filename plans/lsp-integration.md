# LSP Integration Plan

## Overview

Expose VS Code's LSP features (diagnostics, go-to-definition, find-references, hover, code actions, document symbols) as tools for the insrc agent. The daemon can then use these to understand code structure, find errors, and suggest fixes.

## Architecture

```
┌──────────────────┐
│   insrc Daemon   │  ← Agent calls lsp/* tools
│   (Node.js)      │
└────────┬─────────┘
         │ JSON-RPC (existing socket)
         ▼
┌──────────────────────────────────┐
│ IDE Main Process (electron-main) │
│ - Routes lsp/* RPCs to sandbox   │
└──────────────────────────────────┘
         ▲
         │ ProxyChannel IPC
         │
┌──────────────────────────────────┐
│ IDE Sandbox (electron-sandbox)   │
│ - InsrcLSPToolServiceImpl        │  ← Queries VS Code services
│   @ILanguageFeaturesService      │  ← Definition, references, hover
│   @IMarkerService                │  ← Diagnostics (errors/warnings)
│   @ITextModelService             │  ← Get text models for URIs
└──────────────────────────────────┘
```

## Data flow

1. Daemon's agent tool loop calls `lsp/getDiagnostics` (via tool executor)
2. Tool executor sends RPC to IDE via daemon socket
3. IDE main process forwards to sandbox via IPC channel
4. Sandbox queries `IMarkerService.read()` and returns results
5. Results flow back to daemon as tool result
6. LLM uses diagnostics to inform its response

## Components

### 1. IInsrcLSPToolService (common/lspToolService.ts)

```typescript
interface IInsrcLSPToolService {
  getDiagnostics(filePath?: string, severity?: string): Promise<DiagnosticInfo[]>;
  getDefinitions(filePath: string, line: number, column: number): Promise<LocationInfo[]>;
  getReferences(filePath: string, line: number, column: number): Promise<LocationInfo[]>;
  getHover(filePath: string, line: number, column: number): Promise<string>;
  getDocumentSymbols(filePath: string): Promise<SymbolInfo[]>;
  getCodeActions(filePath: string, startLine: number, endLine: number): Promise<CodeActionInfo[]>;
}
```

### 2. InsrcLSPToolServiceImpl (electron-sandbox/lspToolServiceImpl.ts)

Queries VS Code services directly:
- `IMarkerService.read()` for diagnostics
- `ILanguageFeaturesService.definitionProvider` for definitions
- `ILanguageFeaturesService.referenceProvider` for references
- `ILanguageFeaturesService.hoverProvider` for hover
- `ILanguageFeaturesService.documentSymbolProvider` for symbols
- `ILanguageFeaturesService.codeActionProvider` for code actions

Key challenge: needs a `ITextModel` to query providers. Must use `ITextModelService.createModelReference(uri)` to get/create models for files not currently open in the editor.

### 3. Reverse RPC channel (IDE ← Daemon)

Currently the daemon sends stream messages to the IDE. For LSP tools, the **daemon needs to call the IDE** (reverse direction).

Approach: When a tool call arrives in the daemon for `lsp/*`, the daemon sends an RPC request back to the IDE via the existing socket:

```
Daemon → IDE: { id: N, method: "lsp.getDiagnostics", params: { filePath: "..." } }
IDE → Daemon: { id: N, result: [...diagnostics...] }
```

The `InsrcDaemonMainService` in electron-main needs to handle incoming RPC requests from the daemon (currently it only sends outgoing requests and receives responses).

### 4. Daemon tool definitions

Add to the tool registry (`agent/tools/registry.ts`):
- `lsp/getDiagnostics` — get errors/warnings for a file or workspace
- `lsp/getDefinitions` — go to definition at position
- `lsp/getReferences` — find all references to symbol at position
- `lsp/getHover` — get type info and docs at position
- `lsp/getDocumentSymbols` — list all symbols in a file
- `lsp/getCodeActions` — get available fixes for a diagnostic

### 5. Diagnostics push (proactive)

Instead of only on-demand queries, also push diagnostics to daemon proactively:
- Subscribe to `IMarkerService.onMarkerChanged`
- When diagnostics change, send a stream message to daemon
- Daemon caches current diagnostics per file
- Agent can check cached diagnostics without RPC round-trip

## Implementation order

1. **IInsrcLSPToolService interface** — service definition with types
2. **InsrcLSPToolServiceImpl** — sandbox implementation querying VS Code
3. **Reverse RPC in InsrcDaemonMainService** — handle daemon → IDE requests
4. **Daemon tool definitions** — register lsp/* tools
5. **Daemon tool executor** — route lsp/* calls to IDE RPC
6. **Diagnostics push** — proactive marker change notifications
7. **Wire into simple completion + agent steps** — add lsp tools to SIMPLE_COMPLETION_TOOLS and investigate tools

## Files to create

| File | Purpose |
|------|---------|
| `src/vs/workbench/contrib/insrc/common/lspToolService.ts` | Interface + types |
| `src/vs/workbench/contrib/insrc/electron-sandbox/lspToolServiceImpl.ts` | Implementation |

## Files to modify

| File | Change |
|------|--------|
| `src/vs/platform/insrc/electron-main/insrcDaemonMainService.ts` | Handle reverse RPC from daemon |
| `src/vs/workbench/contrib/insrc/electron-sandbox/insrc.contribution.ts` | Register service |
| `src/vs/workbench/contrib/insrc/browser/insrc.contribution.ts` | Import interface |
| `src/insrc/agent/tools/registry.ts` | Add lsp/* tool definitions |
| `src/insrc/agent/tools/executor.ts` | Route lsp/* to IDE RPC |
| `src/insrc/daemon/chat-handler.ts` | Add lsp tools to SIMPLE_COMPLETION_TOOLS |

## Key challenges

1. **Text model availability**: LSP providers need an `ITextModel`. Files not open in the editor don't have models. Must use `ITextModelService.createModelReference()` to create temporary models.

2. **Reverse RPC**: The daemon currently only receives responses, never requests. The `InsrcDaemonMainService` needs to be extended to dispatch incoming RPC requests from the daemon to the sandbox service.

3. **Async bridging**: LSP queries are async and may take time (especially if the LSP server needs to process). Tool calls need reasonable timeouts.

4. **Model lifecycle**: Created model references must be disposed after use to avoid memory leaks.

## Verification

1. Ask the agent "what errors are in src/foo.ts" — should use lsp/getDiagnostics
2. Ask "where is function X defined" — should use lsp/getDefinitions
3. Ask "what calls function X" — should use lsp/getReferences
4. Ask "what type is variable Y" — should use lsp/getHover
5. Ask "fix the error on line 42" — should use lsp/getCodeActions + lsp/getDiagnostics
