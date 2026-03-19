# Chat Panel Implementation Plan

> Native chat panel in the right sidebar (auxiliary bar), replacing the webview chat.
> Connects to daemon via streaming RPC. Supports multi-turn agent conversations,
> gates, streaming, annotations, provider mentions, and session management.

## Architecture decision

The chat panel lives in the **auxiliary bar** (right sidebar), not the bottom panel.
This matches the layout: left (Explorer), center (code/agent views), right (chat).

Not using `contrib/chat` (VS Code's built-in Copilot chat) because:
- It's tightly coupled to the GitHub Copilot extension model
- Custom gate interactions (approve/reject/refine) don't fit its turn model
- We need streaming from our daemon, not from a language model API
- Session management is daemon-driven, not editor-driven

## Daemon RPC protocol

The chat uses these daemon RPCs:

### Standard (request/response)

| Method | Params | Returns | Description |
|--------|--------|---------|-------------|
| `chat.start` | `{ repo }` | `{ sessionId, repo }` | Create new session |
| `chat.reply` | `{ sessionId, gateId, action, feedback? }` | `void` | Reply to a gate |
| `chat.cancel` | `{ sessionId }` | `void` | Cancel running agent |
| `chat.inject` | `{ sessionId, role, content }` | `void` | Inject a message (directive) |
| `chat.close` | `{ sessionId }` | `void` | Close session |
| `chat.list` | `{}` | `SessionInfo[]` | List sessions |
| `chat.status` | `{ sessionId }` | `SessionStatus` | Get session status |
| `session.list` | `{}` | `SessionInfo[]` | List all sessions |
| `session.history` | `{ sessionId, limit? }` | `TurnInfo[]` | Get session turns |

### Streaming (fire events until done)

| Method | Params | Stream messages | Description |
|--------|--------|-----------------|-------------|
| `chat.send` | `{ sessionId, message }` | delta, progress, gate, tool, escalation, checkpoint, done, error | Send message + stream response |
| `chat.resume` | `{ sessionId }` | same as above | Resume a paused session |

### Stream message types

```typescript
type ChatStreamMessage =
  | { stream: 'delta'; data: { content: string } }
  | { stream: 'progress'; data: { step: string; status: string } }
  | { stream: 'gate'; data: { gateId: string; actions: string[]; prompt?: string; context?: unknown } }
  | { stream: 'tool'; data: { tool: string; input: unknown; output?: unknown } }
  | { stream: 'escalation'; data: { from: string; to: string; reason: string } }
  | { stream: 'checkpoint'; data: { sessionId: string } }
  | { stream: 'qna.update'; data: { key: string; value?: unknown } | { list: Array<{ key: string; value: unknown }> } }
  | { stream: 'context.set'; data: { key: string; value: unknown } }
  | { stream: 'context.clear'; data: { key: string } }
  | { stream: 'done'; data: {} }
  | { stream: 'error'; data: { error: string } };
```

## Layout

```
+-----------------------------+
| CHAT                    [-] |  <-- auxiliary bar (right sidebar)
+-----------------------------+
| [insrc] [repo-name v]       |  <-- header: session repo selector
+-----------------------------+
|                             |
| [progress: analyze]         |  <-- progress bar (when agent running)
|                             |
| User (10:42)                |  <-- message bubble
| "Refactor the auth..."      |
|                             |
| Agent (10:42)               |  <-- streaming response
| "I'll analyze the auth..."  |
| [code block]                |
|                             |
| --- Gate: Review ---        |  <-- gate card
| Proposed changes:           |
| [diff preview]              |
| [Approve] [Reject] [Refine] |
|                             |
+-----------------------------+
| @local Explain this func... |  <-- input area
| [Send] [Attach] [Cancel]    |  <-- action buttons
+-----------------------------+
```

## Components

### 1. ChatViewPane (main container)

```
browser/chat/chatView.ts
```

ViewPane registered in the auxiliary bar. Contains:
- Header (repo selector, session info)
- Message list (virtual scrolling)
- Gate card (when paused at a gate)
- Input area (text input + buttons)
- Progress indicator

### 2. ChatMessageList (message rendering)

```
browser/chat/chatMessageList.ts
```

Virtual-scrolling list of chat messages. Each message is:
- User message: styled bubble with timestamp
- Agent message: styled bubble with streaming content
- Tool call: collapsible card showing tool name + input/output
- Escalation notice: badge showing provider change
- System message: dim, centered

Streaming: agent messages append content as `delta` events arrive.
Uses `MarkdownRenderer` for agent responses (code blocks, links, etc.).

### 3. ChatGateCard (gate interaction)

```
browser/chat/chatGateCard.ts
```

Rendered inline in the message list when a `gate` stream message arrives.
Shows:
- Gate prompt / description
- Action buttons (from `gate.actions[]`)
- Optional diff preview (if gate includes proposed changes)
- Optional feedback textarea (for "Refine" action)

Clicking an action calls `daemonService.rpc('chat.reply', { sessionId, gateId, action, feedback })`.

### 4. ChatInputWidget (input area)

```
browser/chat/chatInputWidget.ts
```

- Text input (multi-line, Monaco-based mini editor)
- Provider @mention detection: `@local`, `@haiku`, `@sonnet`, `@opus`
- Annotation badge: shows count of pending annotations (from code selections)
- Send button: calls `chat.send` streaming RPC
- Attach button: file/image attachment (uses IFileDialogService)
- Cancel button: visible during streaming, calls `chat.cancel`
- Keyboard: Enter = send, Shift+Enter = newline, Escape = cancel

### 5. ChatSessionHeader (repo + session selector)

```
browser/chat/chatSessionHeader.ts
```

- Repo dropdown: switch active repo (from RepoService.repos)
- Session info: shows session ID, created time, agent type
- New session button
- Session history dropdown: recent sessions for this repo

### 6. ChatProgressBar (progress indicator)

```
browser/chat/chatProgressBar.ts
```

Thin bar below the header showing agent step progress.
Updates on `progress` stream messages.
Uses the insrc animated SVG as a spinner icon.

## Service: IInsrcChatService

```
common/chatService.ts
```

Manages chat state and coordinates between the view and daemon.

```typescript
export interface IInsrcChatService {
  readonly _serviceBrand: undefined;

  // State
  readonly activeSessionId: string | undefined;
  readonly activeRepo: string | undefined;
  readonly isStreaming: boolean;

  // Events
  readonly onDidChangeSession: Event<string | undefined>;
  readonly onDidReceiveMessage: Event<ChatMessage>;
  readonly onDidReceiveGate: Event<GateInfo>;
  readonly onDidProgress: Event<ProgressInfo>;
  readonly onDidStreamEnd: Event<void>;

  // Actions
  startSession(repoPath: string): Promise<string>;
  sendMessage(message: string, provider?: string): Promise<void>;
  replyToGate(gateId: string, action: string, feedback?: string): Promise<void>;
  cancelStream(): Promise<void>;
  closeSession(): Promise<void>;
  resumeSession(sessionId: string): Promise<void>;
  loadHistory(sessionId: string): Promise<ChatMessage[]>;

  // Annotation support
  attachAnnotations(annotations: CodeAnnotation[]): void;
}
```

### Implementation

```
electron-sandbox/chatServiceImpl.ts
```

- On `sendMessage()`: calls `daemonService.stream('chat.send', { sessionId, message })`
- Subscribes to stream handle events (onMessage, onDidEnd, onDidError)
- Parses stream messages into typed events
- Maintains message history in memory (not persisted -- daemon owns persistence)
- Provider override: strips `@mention` prefix from message, passes as param

## Annotation integration

When user has code annotations (from `Ctrl+Shift+A`), clicking "Send Annotations"
in the chat input compiles them into a structured message:

```
I have 3 annotation(s) across 2 file(s):

**src/auth/middleware.ts:**
- Line 42: "this validates JWT but doesn't check expiry"

**src/api/routes.ts:**
- Line 118: "this endpoint is unprotected"
```

This is sent as a regular `chat.send` message. The annotation system is separate
from the chat -- it just produces a formatted string.

## File inventory

```
src/vs/workbench/contrib/insrc/
  common/
    chatService.ts                    -- IInsrcChatService interface + types
  electron-sandbox/
    chatServiceImpl.ts                -- ChatService implementation
  browser/
    chat/
      chatView.ts                     -- ChatViewPane (auxiliary bar)
      chatMessageList.ts              -- Virtual-scrolling message list
      chatGateCard.ts                 -- Gate interaction card
      chatInputWidget.ts              -- Input area with @mention + attach
      chatSessionHeader.ts            -- Repo selector + session info
      chatProgressBar.ts              -- Step progress indicator
      chatMarkdownRenderer.ts         -- Markdown rendering for agent messages
      media/
        chat.css                      -- Chat-specific styles
```

## Registration

```typescript
// In insrc.contribution.ts

// Register chat view in auxiliary bar
const CHAT_VIEW_CONTAINER = viewContainerRegistry.registerViewContainer({
  id: 'insrc.chat',
  title: localize2('chat', 'Chat'),
  icon: chatIcon,
  order: 0,
}, ViewContainerLocation.AuxiliaryBar);

viewsRegistry.registerViews([{
  id: 'insrc.chatView',
  name: localize2('chat', 'Chat'),
  ctorDescriptor: new SyncDescriptor(ChatViewPane),
  canToggleVisibility: false,
  canMoveView: false,
  order: 0,
}], CHAT_VIEW_CONTAINER);

// Register chat service
registerSingleton(IInsrcChatService, InsrcChatServiceImpl, InstantiationType.Delayed);
```

## Commands

| Command ID | Title | Trigger |
|------------|-------|---------|
| `insrc.chat.open` | "insrc: Open Chat" | `Ctrl+Shift+C` |
| `insrc.chat.send` | "insrc: Send Message" | Enter in input |
| `insrc.chat.cancel` | "insrc: Cancel" | Escape during stream |
| `insrc.chat.newSession` | "insrc: New Chat Session" | Button in header |
| `insrc.chat.switchRepo` | "insrc: Switch Repo" | Dropdown in header |
| `insrc.chat.sendAnnotations` | "insrc: Send Annotations to Chat" | Button in input / command palette |
| `insrc.chat.history` | "insrc: Chat History" | Dropdown in header |

## Keybindings

| Binding | Command |
|---------|---------|
| `Ctrl+Shift+C` | Focus/open chat panel |
| `Enter` (in chat input) | Send message |
| `Shift+Enter` (in chat input) | New line |
| `Escape` (during stream) | Cancel stream |

## Implementation order

| # | Task | Files | Depends on |
|---|------|-------|------------|
| 1 | ChatService interface + types | `common/chatService.ts` | - |
| 2 | ChatService implementation | `electron-sandbox/chatServiceImpl.ts` | DaemonService |
| 3 | Service registration | `electron-sandbox/insrc.contribution.ts` | #1, #2 |
| 4 | Chat CSS | `browser/chat/media/chat.css` | - |
| 5 | ChatMessageList | `browser/chat/chatMessageList.ts` | #4 |
| 6 | ChatGateCard | `browser/chat/chatGateCard.ts` | #4, #5 |
| 7 | ChatInputWidget | `browser/chat/chatInputWidget.ts` | #4 |
| 8 | ChatSessionHeader | `browser/chat/chatSessionHeader.ts` | #1 |
| 9 | ChatProgressBar | `browser/chat/chatProgressBar.ts` | #4 |
| 10 | ChatViewPane | `browser/chat/chatView.ts` | #5-9 |
| 11 | ViewContainer registration | `browser/insrc.contribution.ts` | #10 |
| 12 | Commands + keybindings | `browser/chat/chatCommands.ts` | #1, #10 |
| 13 | Markdown rendering | `browser/chat/chatMarkdownRenderer.ts` | - |
| 14 | Annotation integration | `browser/chat/chatInputWidget.ts` | #7 |

## Testing approach

Manual verification:
1. Chat panel opens in auxiliary bar (right sidebar)
2. Repo selector shows indexed repos
3. New session creates and assigns sessionId
4. Typing message + Enter sends via chat.send
5. Agent response streams in as delta messages
6. Progress bar updates on progress messages
7. Gate card renders with action buttons
8. Clicking gate action sends chat.reply and resumes stream
9. Cancel button stops streaming
10. @local/@sonnet mentions override provider
11. Session history loads previous conversations
12. Annotations compile and send as formatted message
13. Multiple sessions can be switched
14. Chat survives IDE reload (session resumes from daemon)
