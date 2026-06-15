/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * HTTP transport for the insrc MCP server (Phase 6 fallback path).
 *
 * Some sandboxed environments (containers, web-style runners, the
 * Codex remote runner) can't spawn the stdio MCP subprocess but
 * can issue HTTP requests against a localhost server. This module
 * is the entry point for that mode.
 *
 * Architecture:
 *
 *   - One `http.Server` binds 127.0.0.1:<port>.
 *   - Each unique session id gets its own MCP server + transport
 *     pair (kept in {@link HttpMcpGateway._sessions}). The first
 *     request for a session creates the pair; subsequent requests
 *     reuse it. Sessions GC themselves when the underlying
 *     transport closes.
 *   - Every request is authenticated by a bearer token in the
 *     `Authorization: Bearer <token>` header. The token resolves
 *     to a sessionId via `validateSessionToken`. A request without
 *     a token, or with an unknown / expired token, receives 401.
 *   - We bind to 127.0.0.1 by default so the server is not
 *     reachable from other hosts. A `host` option exists for
 *     tests / dev only; production callers never set it.
 *
 * Threat model:
 *
 *   - Local-only host binding. Any cross-host attacker has no
 *     reachability at all; the bearer-token check is a defense in
 *     depth, not the primary boundary.
 *   - Bearer tokens are per-session, short-lived (default 1h
 *     TTL), unique per spawn, and never logged. Token leakage
 *     (e.g. via screenshot, copy-paste) at worst exposes the
 *     user's own session artifacts on their own host.
 *   - The MCP request stream is plain HTTP, not HTTPS: the host-
 *     local boundary is the trust boundary. We do not attempt to
 *     defend against a malicious user on the same host -- they
 *     already own the daemon socket.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:http';

import { validateSessionToken } from '../session-token.js';
import { registerAllTools } from '../tool-registry.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('mcp:http');

const DEFAULT_HOST = '127.0.0.1';

export interface HttpGatewayOptions {
	/**
	 * Port to bind. Default `0` -- the OS picks a free port and we
	 * report it via {@link HttpMcpGateway.port} after listen.
	 */
	readonly port?:           number | undefined;
	/**
	 * Host to bind. Defaults to localhost; tests may set
	 * `'127.0.0.1'` explicitly. NEVER `'0.0.0.0'` in production.
	 */
	readonly host?:           string | undefined;
	/**
	 * Test seam: swap the token validator. Production uses the
	 * shared in-memory store from `session-token.ts`.
	 */
	readonly validateToken?:  ((token: string) => string | undefined) | undefined;
	/**
	 * Test seam: factory for constructing a fresh McpServer per
	 * session. Production uses the default factory (insrc tools
	 * registered, default server info).
	 */
	readonly mcpServerFactory?: (() => McpServer) | undefined;
}

interface SessionEntry {
	readonly server:    McpServer;
	readonly transport: StreamableHTTPServerTransport;
}

/**
 * HTTP MCP gateway. Wraps a Node HTTP server and dispatches each
 * authenticated request to a per-sessionId MCP transport.
 *
 * Lifecycle:
 *
 *   1. `new HttpMcpGateway(opts)` -- constructs but does not bind.
 *   2. `await gateway.listen()` -- binds to <host>:<port>. After
 *      it returns, `port` is the resolved port (useful when the
 *      caller passed 0).
 *   3. Requests arrive on `/mcp`. Other paths get 404.
 *   4. `await gateway.close()` -- closes the HTTP server and tears
 *      down every per-session transport.
 */
export class HttpMcpGateway {

	private readonly _httpServer: Server;
	private readonly _validateToken: (token: string) => string | undefined;
	private readonly _mcpServerFactory: () => McpServer;
	private readonly _port: number | undefined;
	private readonly _host: string | undefined;
	private readonly _sessions = new Map<string, SessionEntry>();
	private _boundPort: number | undefined;
	private _boundHost: string | undefined;

	constructor(options: HttpGatewayOptions = {}) {
		this._validateToken    = options.validateToken    ?? validateSessionToken;
		this._mcpServerFactory = options.mcpServerFactory ?? defaultMcpServerFactory;
		this._port             = options.port;
		this._host             = options.host;
		this._httpServer = createServer((req, res) => {
			this._handle(req, res).catch(err => {
				log.error({ err: (err as Error).message }, 'unhandled error in HTTP request');
				safeWriteJson(res, 500, { error: 'internal' });
			});
		});
	}

	get port(): number {
		if (this._boundPort === undefined) {
			throw new Error('HttpMcpGateway: port read before listen()');
		}
		return this._boundPort;
	}

	get host(): string {
		return this._boundHost ?? this._host ?? DEFAULT_HOST;
	}

	/** Bind + start accepting. Resolves once the OS has assigned the port. */
	listen(): Promise<void> {
		return new Promise((resolve, reject) => {
			const host = this._host ?? DEFAULT_HOST;
			const port = this._port ?? 0;
			this._httpServer.once('error', reject);
			this._httpServer.listen(port, host, () => {
				this._httpServer.off('error', reject);
				const addr = this._httpServer.address();
				if (addr === null || typeof addr === 'string') {
					reject(new Error('HttpMcpGateway: unexpected address type'));
					return;
				}
				this._boundPort = addr.port;
				this._boundHost = addr.address;
				log.info({ host: this._boundHost, port: this._boundPort }, 'MCP HTTP gateway listening');
				resolve();
			});
		});
	}

	async close(): Promise<void> {
		// Tear down every per-session transport. The SDK transport
		// owns its xterm-style cleanup; we just await it.
		for (const [, entry] of this._sessions) {
			try { await entry.transport.close(); } catch { /* swallow */ }
		}
		this._sessions.clear();
		await new Promise<void>(resolve => this._httpServer.close(() => resolve()));
	}

	// -- Request dispatch ----------------------------------------------------

	private async _handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		// Path filter: only `/mcp` is the MCP endpoint; anything else
		// is a 404 (no health endpoint, no version probe -- those
		// belong to a separate diagnostic surface if we add one).
		const url = req.url ?? '';
		if (!url.startsWith('/mcp')) {
			safeWriteJson(res, 404, { error: 'not found' });
			return;
		}

		// Auth: bearer token in the Authorization header.
		const token = extractBearerToken(req);
		if (token === undefined) {
			res.setHeader('WWW-Authenticate', 'Bearer realm="insrc-mcp"');
			safeWriteJson(res, 401, { error: 'missing bearer token' });
			return;
		}
		const sessionId = this._validateToken(token);
		if (sessionId === undefined) {
			res.setHeader('WWW-Authenticate', 'Bearer realm="insrc-mcp", error="invalid_token"');
			safeWriteJson(res, 401, { error: 'invalid or expired bearer token' });
			return;
		}

		// Resolve / create the per-session MCP transport.
		const entry = this._getOrCreateSession(sessionId);

		// Parse the body. POST + DELETE bodies are JSON-RPC payloads;
		// GET (SSE) doesn't have one.
		let body: unknown;
		if (req.method === 'POST' || req.method === 'DELETE') {
			try {
				body = await readJsonBody(req);
			} catch (err) {
				safeWriteJson(res, 400, { error: 'invalid JSON body', detail: (err as Error).message });
				return;
			}
		}

		// The SDK transport types `auth?: AuthInfo` on the request;
		// we don't supply one (our auth is the bearer check above)
		// so cast through `unknown` to match the SDK signature.
		await entry.transport.handleRequest(req as unknown as Parameters<typeof entry.transport.handleRequest>[0], res, body);
	}

	private _getOrCreateSession(sessionId: string): SessionEntry {
		const existing = this._sessions.get(sessionId);
		if (existing !== undefined) {
			return existing;
		}
		const server = this._mcpServerFactory();
		// Stateless from the SDK's POV -- our session id (the
		// bearer-token-derived value) is the real key; the SDK
		// doesn't need its own.
		const transport = new StreamableHTTPServerTransport({} as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);
		const entry: SessionEntry = { server, transport };
		this._sessions.set(sessionId, entry);

		// Wire transport <-> server. The cast is needed because the
		// SDK's `connect` parameter is typed against an internal
		// `Transport` interface whose optional fields don't
		// round-trip under `exactOptionalPropertyTypes`.
		void server.connect(transport as Parameters<typeof server.connect>[0]).catch(err => {
			log.warn({ sessionId, err: (err as Error).message }, 'MCP server connect failed; dropping session');
			this._sessions.delete(sessionId);
		});
		transport.onclose = () => {
			this._sessions.delete(sessionId);
			log.info({ sessionId }, 'MCP HTTP session closed');
		};
		log.info({ sessionId }, 'MCP HTTP session created');
		return entry;
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultMcpServerFactory(): McpServer {
	const server = new McpServer(
		{ name: 'insrc', version: '0.1.0' },
		{
			instructions:
				'insrc exposes its knowledge graph, session memory, and cross-repo ' +
				'closure via a small set of `insrc_*` tools. Use these to discover ' +
				"code and context at execution time; insrc deliberately doesn't pre-" +
				'fetch entity content into the spec.',
		},
	);
	registerAllTools(server);
	return server;
}

function extractBearerToken(req: IncomingMessage): string | undefined {
	const header = req.headers['authorization'] ?? req.headers['Authorization' as 'authorization'];
	if (typeof header !== 'string') return undefined;
	const m = /^Bearer\s+(\S+)$/i.exec(header);
	return m ? m[1]! : undefined;
}

function readJsonBody(req: IncomingMessage, limitBytes = 4 * 1024 * 1024): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let received = 0;
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => {
			received += chunk.length;
			if (received > limitBytes) {
				reject(new Error(`request body exceeds ${limitBytes} bytes`));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			if (chunks.length === 0) {
				resolve(undefined);
				return;
			}
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			} catch (err) {
				reject(err);
			}
		});
		req.on('error', reject);
	});
}

function safeWriteJson(res: ServerResponse, status: number, body: unknown): void {
	if (res.headersSent) return;
	res.statusCode = status;
	res.setHeader('content-type', 'application/json');
	try {
		res.end(JSON.stringify(body));
	} catch {
		res.end('{}');
	}
}
