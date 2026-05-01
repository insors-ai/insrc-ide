/**
 * skill_invoke -- the LLM-facing meta-tool for skill dispatch.
 *
 * Plans/analyzers/skills-core.md, Phase 3.3. Analyzers that want
 * LLM-driven skill dispatch advertise THIS single tool to the model
 * (instead of advertising every registered skill as its own tool,
 * which costs ~3000+ tokens for a 30-skill set). The closed list of
 * skill ids the model is allowed to pick from is rendered into the
 * analyzer's system prompt; the LLM picks an id, calls
 * `skill_invoke({skillId, args})`, and gets the typed SkillResult
 * rendered back.
 *
 * Tool id: `skill_invoke`. The first underscore-segment is `skill`,
 * which gets added to `ALL_CATEGORIES` in tools/config.ts so the
 * registry's category gate doesn't silently blackhole the tool
 * (mirrors the 2026-04-30 cross-agent-tool oversight fix).
 */

import { getLogger } from '../../../../shared/logger.js';
import { registerTool } from '../../registry.js';
import type { Tool, ToolDeps, ToolInput, ToolResult } from '../../types.js';
import { runSkill, type SkillRunnerDeps } from '../../../skills/invoke.js';
import { getSkill } from '../../../skills/registry.js';
import type { LLMProvider } from '../../../../shared/types.js';
import type { ProviderAffinity, SkillResult } from '../../../skills/types.js';

const log = getLogger('skill-invoke-tool');

const skillInvokeTool: Tool = {
  id: 'skill_invoke',
  description:
    'Invoke a registered skill by id. Pass `args` matching the skill\'s declared input schema. ' +
    'Returns the skill\'s typed value, confidence (high|medium|low), and any notes from the runner. ' +
    'The set of allowed skill ids is provided in the system prompt as a closed list -- skill ids ' +
    'are dotted-lowercase (e.g. data.lineage.read-write-callsites), not underscored like tool ids.',
  inputSchema: {
    type: 'object',
    properties: {
      skillId: {
        type: 'string',
        description: 'The skill\'s canonical id, e.g. \'data.lineage.read-write-callsites\'.',
      },
      args: {
        type: 'object',
        description: 'Arguments matching the skill\'s input schema. Required, even if empty.',
      },
      version: {
        type: 'number',
        description: 'Optional version pin. Defaults to the highest registered.',
        minimum: 1,
      },
    },
    required: ['skillId', 'args'],
    additionalProperties: false,
  },
  requiresApproval: false,

  async execute(input: ToolInput, deps: ToolDeps): Promise<ToolResult> {
    const skillId = typeof input['skillId'] === 'string' ? input['skillId'] : '';
    if (skillId.length === 0) {
      return {
        output: '[skill_invoke] skillId required',
        format: 'text',
        success: false,
        error: 'skillId required',
      };
    }
    const args = (input['args'] ?? {}) as Record<string, unknown>;
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return {
        output: '[skill_invoke] args must be a JSON object',
        format: 'text',
        success: false,
        error: 'args must be an object',
      };
    }
    const version = typeof input['version'] === 'number' ? input['version'] : undefined;

    // We don't pre-check feasibility / family-gate here; runSkill does
    // the lookup and emits a structured low-confidence result on miss.
    // The reason: keeping the meta-tool's body small means the
    // confidence-clamping logic lives in exactly one place (the runner).
    const runnerDeps: SkillRunnerDeps = {
      session: deps.session,
      resolveProvider: (affinity) => resolveProviderForAffinity(affinity, deps),
      toolExecCtx: {
        ...(deps.send !== undefined ? { send: deps.send } : {}),
        ...(deps.channel !== undefined ? { channel: deps.channel } : {}),
        ...(deps.requestId !== undefined ? { requestId: deps.requestId } : {}),
      },
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    };

    const result = await runSkill(skillId, args, runnerDeps, {
      ...(version !== undefined ? { version } : {}),
    });

    return renderSkillResultAsToolResult(skillId, result);
  },
};

/**
 * Resolve a provider for the given affinity.
 *
 *   local  -> session.ollamaProvider (always present)
 *   cloud  -> session.claudeProvider, falling back to ollama when
 *             no cloud provider is configured
 *   auto   -> session.resolver.resolve('skill', '<no-step>'), which
 *             falls through ProviderResolver's active-provider default
 *             (cloud when configured, local otherwise)
 *
 * The per-skill resolver-binding override flagged in skills-core
 * Phase 6.2 is a follow-up that needs ProviderResolver to grow a
 * skill-aware lookup; for now the affinity is honored directly.
 */
function resolveProviderForAffinity(
  affinity: ProviderAffinity,
  deps: ToolDeps,
): LLMProvider {
  const session = deps.session;
  switch (affinity) {
    case 'local': return session.ollamaProvider;
    case 'cloud': return session.claudeProvider ?? session.ollamaProvider;
    case 'auto':  return session.resolver.resolve('skill', 'default');
  }
}

/**
 * Render a SkillResult into a ToolResult the LLM tool-loop can consume.
 *
 * The rendered text is markdown so reviewers / synthesise passes can
 * read it directly; the structured `data` field carries the typed
 * value + confidence + notes for downstream callers that want to
 * post-process without re-parsing the markdown.
 */
function renderSkillResultAsToolResult(skillId: string, result: SkillResult): ToolResult {
  const skill = getSkill(skillId);
  const headline = skill !== undefined
    ? `**skill:${skillId}** (${skill.family} / ${skill.owner}) -- confidence: \`${result.confidence}\``
    : `**skill:${skillId}** -- confidence: \`${result.confidence}\``;

  const lines: string[] = [headline, ''];

  if (result.notes !== undefined && result.notes.length > 0) {
    lines.push('**Notes:**');
    for (const n of result.notes) { lines.push(`- ${n}`); }
    lines.push('');
  }

  if (result.toolCalls.length > 0) {
    lines.push('**Tool calls:**');
    for (const c of result.toolCalls) {
      const errSuffix = c.error !== undefined ? ` -- error: ${c.error}` : '';
      lines.push(`- \`${c.toolId}\` ${c.durationMs}ms${errSuffix}`);
    }
    lines.push('');
  }

  if (result.subSkillCalls !== undefined && result.subSkillCalls.length > 0) {
    lines.push('**Sub-skill calls:**');
    for (const s of result.subSkillCalls) {
      lines.push(`- \`${s.skillId}\` -- confidence: \`${s.confidence}\``);
    }
    lines.push('');
  }

  // Compact preview of the value. Full payload available in `data`.
  lines.push('**Value:**');
  lines.push('```json');
  lines.push(safePreview(result.value));
  lines.push('```');

  log.info(
    {
      skillId,
      confidence: result.confidence,
      toolCalls: result.toolCalls.length,
      hasNotes: (result.notes?.length ?? 0) > 0,
    },
    'skill_invoke completed',
  );

  return {
    output: lines.join('\n'),
    format: 'markdown',
    success: result.confidence !== 'low',
    data: {
      skillId,
      confidence: result.confidence,
      value: result.value,
      notes: result.notes ?? [],
      toolCalls: result.toolCalls,
      subSkillCalls: result.subSkillCalls ?? [],
      truncated: result.truncated === true,
    },
  };
}

/**
 * Render a value as a fenced JSON block, capping at 4 KB so a giant
 * sub-skill payload doesn't blow up the tool-result content for the
 * LLM. The structured `data` field always carries the full value;
 * the markdown preview is just a hint.
 */
function safePreview(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value, null, 2);
  } catch {
    return '<unserializable value>';
  }
  if (json.length <= 4096) { return json; }
  return json.slice(0, 4096) + '\n... <truncated>';
}

export function registerSkillTools(): void {
  registerTool(skillInvokeTool);
}
