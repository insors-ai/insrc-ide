/**
 * DaemonChannel — Channel implementation for daemon-hosted agent sessions.
 *
 * Bridges the agent framework's message protocol to IPC stream messages.
 * Each send() maps an AgentMessage kind to an IpcStreamMessage written to the socket.
 * gate() blocks until resolveGate() is called (from chat.reply RPC handler).
 * Socket close/error triggers AbortSignal → pending gates reject → runAgent checkpoints.
 */

import type {
  Channel,
  AgentMessage,
  GatePayload,
  ReplyPayload,
} from '../agent/framework/types.js';
import type { IpcStreamMessage } from '../shared/types.js';

export class DaemonChannel implements Channel {
  private readonly requestId: number;
  private readonly sendFn: (msg: IpcStreamMessage) => void;
  private readonly abortController: AbortController;
  private readonly gateResolvers = new Map<string, (reply: ReplyPayload) => void>();
  private readonly gateRejectors = new Map<string, (err: Error) => void>();
  private closed = false;
  private _responseText = '';

  constructor(
    requestId: number,
    sendFn: (msg: IpcStreamMessage) => void,
    abortController: AbortController,
  ) {
    this.requestId = requestId;
    this.sendFn = sendFn;
    this.abortController = abortController;

    // When aborted (socket drop), reject all pending gates
    this.abortController.signal.addEventListener('abort', () => {
      const err = new Error('connection lost');
      for (const rejector of this.gateRejectors.values()) {
        rejector(err);
      }
      this.gateResolvers.clear();
      this.gateRejectors.clear();
    }, { once: true });
  }

  /** Get the abort signal for passing to runAgent. */
  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /** Get the accumulated response text from all emitted deltas. */
  get responseText(): string {
    return this._responseText;
  }

  // ---------------------------------------------------------------------------
  // Channel interface
  // ---------------------------------------------------------------------------

  send(msg: AgentMessage): void {
    if (this.closed || this.abortController.signal.aborted) return;

    try {
      switch (msg.kind) {
        case 'emit': {
          const payload = msg.payload as { text?: string } | string;
          const text = typeof payload === 'string' ? payload : (payload.text ?? '');
          this._responseText += text;
          this.sendFn({
            id: this.requestId,
            stream: 'delta',
            data: msg.payload,
          });
          break;
        }

        case 'progress':
          this.sendFn({
            id: this.requestId,
            stream: 'progress',
            data: msg.payload,
          });
          break;

        case 'checkpoint':
          this.sendFn({
            id: this.requestId,
            stream: 'checkpoint',
            data: msg.payload,
          });
          break;

        case 'done':
          this.sendFn({
            id: this.requestId,
            stream: 'done',
            data: msg.payload,
          });
          break;

        case 'error':
          this.sendFn({
            id: this.requestId,
            stream: 'error',
            data: msg.payload,
          });
          break;

        default:
          // Gate messages are handled by gate() method, not send()
          break;
      }
    } catch {
      // Write failed (broken pipe) — trigger abort
      this.abortController.abort();
    }
  }

  async gate(msg: AgentMessage<GatePayload>): Promise<ReplyPayload> {
    if (this.abortController.signal.aborted) {
      throw new Error('connection lost');
    }

    const gateId = msg.payload.gateId;

    // Send gate message to client
    try {
      this.sendFn({
        id: this.requestId,
        stream: 'gate',
        data: msg.payload,
      });
    } catch {
      this.abortController.abort();
      throw new Error('connection lost');
    }

    // Block until resolveGate() is called or signal aborts
    return new Promise<ReplyPayload>((resolve, reject) => {
      this.gateResolvers.set(gateId, resolve);
      this.gateRejectors.set(gateId, reject);
    });
  }

  onMessage(_handler: (msg: AgentMessage) => void): void {
    // Cancel is handled via AbortSignal, not onMessage.
    // No inbound messages expected through this channel —
    // gate replies come via chat.reply RPC (separate socket).
  }

  close(): void {
    this.closed = true;
  }

  // ---------------------------------------------------------------------------
  // Gate resolution (called from chat.reply RPC handler)
  // ---------------------------------------------------------------------------

  /**
   * Resolve a pending gate with the user's reply.
   * Returns true if the gate was found and resolved, false otherwise.
   */
  /**
   * Register an external gate resolver (used outside the agent framework,
   * e.g., for command-approval gates in chat-handler).
   * The resolve/reject callbacks are stored in the same map as agent gates,
   * so resolveGate() from chat.reply will find and resolve them.
   */
  registerExternalGate(
    gateId: string,
    resolve: (reply: ReplyPayload) => void,
    reject: (err: Error) => void,
  ): void {
    this.gateResolvers.set(gateId, resolve);
    this.gateRejectors.set(gateId, reject);
  }

  resolveGate(gateId: string, reply: ReplyPayload): boolean {
    const resolver = this.gateResolvers.get(gateId);
    if (!resolver) return false;

    this.gateResolvers.delete(gateId);
    this.gateRejectors.delete(gateId);
    resolver(reply);
    return true;
  }

  /** Check if there's a pending gate. */
  get pendingGateId(): string | undefined {
    const first = this.gateResolvers.keys().next();
    return first.done ? undefined : first.value;
  }

  /** Whether the channel has been aborted (socket dropped). */
  get aborted(): boolean {
    return this.abortController.signal.aborted;
  }
}
