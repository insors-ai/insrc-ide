/**
 * shell:cwd -- get or set a session-scoped working directory.
 *
 * Other shell / git / file tools accept an explicit `cwd` input. This
 * tool persists a default cwd per session so the caller can set it
 * once and stop repeating it. Individual tool calls still win --
 * shell:cwd is a session-level default, not a lock.
 *
 * Session-keying uses the session object's identity; if no session is
 * present the daemon's process cwd is returned unchanged and set is a
 * no-op.
 */

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Session } from '../../../../agent/session.js';
import type { Tool, ToolDeps, ToolInput, ToolResult } from '../../types.js';

export interface ShellCwdData {
  cwd: string;
  /** True when a session-scoped override is active. */
  sessionScoped: boolean;
}

// Per-session cwd overrides. Sessions are few (one per chat) and
// short-lived; a WeakMap ties storage to the session's lifetime.
const sessionCwd = new WeakMap<Session, string>();

export function getSessionCwd(session: Session | null | undefined): string {
  if (session && sessionCwd.has(session)) {
    return sessionCwd.get(session)!;
  }
  return process.cwd();
}

export const shellCwdTool: Tool = {
  id: 'shell_cwd',
  description: 'Get or set the session-scoped working directory. op=get is read-only; op=set updates the session default.',
  inputSchema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['get', 'set'], description: 'Default: get.' },
      path: { type: 'string', description: 'For op=set: the new cwd (absolute or relative to current).' },
    },
    additionalProperties: false,
  },
  requiresApproval: false,

  async execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
    const op = typeof input['op'] === 'string' ? input['op'] : 'get';
    const session = deps.session as Session | null | undefined;

    if (op === 'set') {
      const raw = typeof input['path'] === 'string' ? input['path'] : '';
      if (!raw) { return { output: '[shell:cwd] set requires path', format: 'text', success: false, error: 'missing path' }; }
      const target = resolve(raw);
      if (!existsSync(target)) { return { output: `[shell:cwd] ${target} does not exist`, format: 'text', success: false, error: 'enoent' }; }
      if (!statSync(target).isDirectory()) { return { output: `[shell:cwd] ${target} is not a directory`, format: 'text', success: false, error: 'not a dir' }; }
      if (!session) {
        return { output: `[shell:cwd] no session attached -- cwd changes are session-scoped and can\'t persist here`, format: 'text', success: false, error: 'no session' };
      }
      sessionCwd.set(session, target);
      const data: ShellCwdData = { cwd: target, sessionScoped: true };
      return { output: `Session cwd -> \`${target}\`.`, format: 'markdown', success: true, data };
    }

    // get
    const cwd = getSessionCwd(session);
    const scoped = !!(session && sessionCwd.has(session));
    const data: ShellCwdData = { cwd, sessionScoped: scoped };
    return {
      output: scoped
        ? `Session cwd (override): \`${cwd}\``
        : `Daemon cwd (no session override): \`${cwd}\``,
      format: 'markdown',
      success: true,
      data,
    };
  },
};
