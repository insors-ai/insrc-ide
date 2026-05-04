/**
 * runSkillIsolated -- daemon-free test driver for registered skills.
 *
 * plans/analyzers/skills-core.md Phase 8.1.
 *
 * Lets a developer (or the smoke-test gate from Phase 8.2) run any
 * registered skill end-to-end without spinning up the daemon, opening
 * a chat session, attaching to a real DB, or holding an LLM provider.
 *
 * The harness:
 *
 *   1. constructs a synthetic Session with just the fields the runner
 *      and the skill body actually touch (skillAudit + the access
 *      stubs). Skills that need richer session state pass an
 *      `extraSessionFields` overlay.
 *   2. routes deps.runTool through a `fakeTools` map keyed on toolId.
 *      Calls to unmapped tools return `isError: true` with a clear
 *      message so the test surfaces the missing stub instead of
 *      hanging on a real registry lookup.
 *   3. routes deps.resolveProvider to a stub provider that throws on
 *      any chat / embed / tool call -- if a skill needs an LLM call
 *      its fixture must supply a `fakeProvider`.
 *
 * Returns the SkillResult plus the captured SkillEvent stream so
 * callers can assert on telemetry shape too. The events array IS the
 * session.skillAudit ring buffer; the harness just exposes it.
 */

import type { LLMProvider, ToolCall } from '../../shared/types.js';
import type { Session } from '../../agent/session.js';
import { runSkill, type SkillRunnerDeps } from './invoke.js';
import { DefaultSkillAuditLog } from './audit.js';
import {
  DefaultAccessStore,
  DefaultAccessAuditLog,
  type AccessStore,
  type AccessAuditLog,
} from '../../shared/access.js';
import { getTool, registerTool } from '../tools/registry.js';
import type { Tool } from '../tools/types.js';
import { validate } from './json-schema.js';
import type {
  ProviderAffinity,
  RunSkillOpts,
  SkillEvent,
  SkillResult,
  SkillToolResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Map of toolId -> fake handler. The handler can return a literal
 * SkillToolResult or compute one from the call's arguments.
 */
export interface FakeToolMap {
  readonly [toolId: string]:
    | SkillToolResult
    | ((call: ToolCall) => SkillToolResult | Promise<SkillToolResult>);
}

/** A minimal LLMProvider stand-in. Override one method per fixture as needed. */
export type FakeProvider = Partial<LLMProvider>;

export interface RunSkillIsolatedOpts {
  /** Map keyed on toolId. Calls to unmapped tools return isError: true. */
  readonly fakeTools?: FakeToolMap;
  /** Optional fake LLM provider; default throws on any call. */
  readonly fakeProvider?: FakeProvider;
  /**
   * Extra Session fields the skill body reads (e.g. connectionRoster,
   * config). Merged onto the synthetic Session before runSkill is
   * called. Cast through `unknown as Session` so the test author
   * doesn't have to satisfy the full Session class shape.
   */
  readonly extraSessionFields?: Record<string, unknown>;
  /** Forwarded to runSkill (version pin, callerOwner, sample-size, ...). */
  readonly runOpts?: RunSkillOpts;
}

export interface RunSkillIsolatedResult<O = unknown> {
  readonly result: SkillResult<O>;
  readonly events: readonly SkillEvent[];
}

/**
 * Run a registered skill against a synthetic SkillRunnerDeps. The skill
 * must already be registered (the test entry point typically calls
 * `registerAllSkills()` once at module load). Returns the result and
 * the captured event stream.
 */
export async function runSkillIsolated<I = unknown, O = unknown>(
  id: string,
  input: I,
  opts: RunSkillIsolatedOpts = {},
): Promise<RunSkillIsolatedResult<O>> {
  const session = makeFakeSession(opts.extraSessionFields);
  const provider = makeFakeProvider(opts.fakeProvider);
  const fakeTools = opts.fakeTools ?? {};

  // Register placeholder tools for every faked tool id so the
  // `required-tools` precondition (feasibility.ts:67-77) passes. The
  // placeholders' execute() body should never run -- runToolForSkill
  // takes the runTool override path. Idempotent: skip if already
  // registered (smoke tests run many skills back-to-back).
  for (const toolId of Object.keys(fakeTools)) {
    if (getTool(toolId) === undefined) {
      registerTool(makePlaceholderTool(toolId));
    }
  }

  const runnerDeps: SkillRunnerDeps = {
    session,
    resolveProvider: (_affinity: ProviderAffinity) => provider,
    runTool: async (call) => dispatchFakeTool(call, fakeTools),
  };

  const result = await runSkill<I, O>(id, input, runnerDeps, opts.runOpts);
  // The runner pushed events into session.skillAudit; expose them
  // verbatim so the smoke test can assert on the ordering.
  return { result, events: session.skillAudit.list() };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Build a placeholder Tool with the given id. Its execute() body
 * returns a clear error if it ever runs, which would mean runSkill's
 * runTool override path was bypassed -- a real bug worth surfacing
 * loudly rather than silently passing.
 */
function makePlaceholderTool(id: string): Tool {
  return {
    id,
    description: `[runSkillIsolated placeholder for ${id}]`,
    inputSchema: { type: 'object', additionalProperties: true },
    requiresApproval: false,
    async execute() {
      return {
        output: `[runSkillIsolated] placeholder for ${id} should never execute`,
        format: 'text',
        success: false,
        error: 'placeholder tool reached execute() -- runTool override missing in test harness',
      };
    },
  };
}

async function dispatchFakeTool(
  call: ToolCall,
  fakeTools: FakeToolMap,
): Promise<SkillToolResult> {
  const handler = fakeTools[call.name];
  if (handler === undefined) {
    return {
      content: `[runSkillIsolated] no fake handler registered for tool '${call.name}'`,
      isError: true,
    };
  }

  // Validate the call's input against the registered tool's
  // inputSchema when a real tool definition is available. This catches
  // skills that pass schema-invalid inputs to tools (e.g. an extra
  // `where` field on a tool whose schema is `additionalProperties:
  // false`) -- the production tool-call layer would reject these at
  // input-validation time but the harness used to relay everything
  // through to the fake handler. The placeholder tools the harness
  // auto-registers have a permissive schema (`additionalProperties:
  // true`), so this only kicks in when the test setup imported the
  // real tool registry first.
  const tool = getTool(call.name);
  if (tool !== undefined && !looksLikePlaceholder(tool)) {
    const result = validate(call.input, tool.inputSchema as Record<string, unknown>);
    if (!result.ok) {
      return {
        content: `[runSkillIsolated] tool '${call.name}' input schema rejected the call: ${result.errors.join('; ')}`,
        isError: true,
      };
    }
  }

  if (typeof handler === 'function') {
    return Promise.resolve(handler(call));
  }
  return handler;
}

function looksLikePlaceholder(tool: Tool): boolean {
  return tool.description.startsWith('[runSkillIsolated placeholder for ');
}

/**
 * Synthesise a Session-shaped object with the bare-minimum fields the
 * runner reads (skillAudit) plus the access stubs that any skill body
 * referencing the access gate would need. Anything else is left
 * undefined; tests requiring more pay-as-you-go via extraSessionFields.
 */
function makeFakeSession(extra?: Record<string, unknown>): Session {
  const skillAudit = new DefaultSkillAuditLog();
  const access: AccessStore = new DefaultAccessStore();
  const accessAudit: AccessAuditLog = new DefaultAccessAuditLog();
  const stub: Record<string, unknown> = {
    id: 'isolated-test-session',
    repoPath: '',
    startedAt: Date.now(),
    skillAudit,
    access,
    accessAudit,
    ...extra,
  };
  return stub as unknown as Session;
}

/**
 * Build a provider that throws on any method call unless the fixture
 * supplied a real implementation. The thrown error is caught by the
 * runner's execute() try/catch and surfaces as `execute-threw` in the
 * SkillResult notes -- so missing-fakeProvider failures are visible
 * without hanging the test.
 *
 * LLMProvider's surface (complete / stream / embed / supportsTools)
 * is intentionally narrow; the harness mirrors it exactly so a fixture
 * can override one method without filling in stubs for the others.
 */
function makeFakeProvider(overlay?: FakeProvider): LLMProvider {
  const throwing = (method: string) => () => {
    throw new Error(
      `[runSkillIsolated] fakeProvider.${method} not provided. ` +
      `Add it to the fixture if the skill body calls it.`,
    );
  };
  const base: Record<string, unknown> = {
    complete: overlay?.complete ?? throwing('complete'),
    stream:   overlay?.stream   ?? (() => { throwing('stream')(); return (async function* (): AsyncIterable<string> {})(); }),
    embed:    overlay?.embed    ?? throwing('embed'),
    supportsTools: overlay?.supportsTools ?? false,
  };
  return base as unknown as LLMProvider;
}
