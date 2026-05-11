/**
 * Skills meta-tools: `skill_invoke` + `skill_describe`.
 *
 * `skill_invoke` (skills-core §3.3): the LLM-facing meta-tool for
 * skill dispatch. Analyzers advertise THIS single tool to the model
 * (instead of advertising every registered skill as its own tool,
 * which costs ~3000+ tokens for a 30-skill set). The closed list of
 * skill ids the model is allowed to pick from is rendered into the
 * analyzer's system prompt; the LLM picks an id, calls
 * `skill_invoke({skillId, args})`, and gets the typed SkillResult
 * rendered back.
 *
 * `skill_describe` (data-analyzer-skills §7.1): the on-demand
 * catalog-detail tool used by `meta.classify-question`. Returns a
 * stripped `SkillManifest` -- `{ id, name, family, owner, version,
 * description, inputs, outputs, preconditions, providerAffinity }` --
 * so the classifier prompt stays small (one-line catalog) and the LLM
 * pulls the full schema only when ambiguous. (The plan referred to
 * this as `describe_skill`; renamed to `skill_describe` so its
 * first-underscore-segment is `skill`, matching the existing meta
 * category and avoiding the category-gate's silent blackhole.)
 *
 * Both tools live under the `skill` first-underscore-segment which is
 * registered in `ALL_CATEGORIES` (tools/config.ts) so the registry's
 * category gate doesn't silently blackhole them (mirrors the
 * 2026-04-30 cross-agent-tool oversight fix).
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
  const rejectionSuffix = result.rejectionReason !== undefined
    ? ` -- rejection: \`${result.rejectionReason}\``
    : '';
  const headline = skill !== undefined
    ? `**skill:${skillId}** (${skill.family} / ${skill.owner}) -- confidence: \`${result.confidence}\`${rejectionSuffix}`
    : `**skill:${skillId}** -- confidence: \`${result.confidence}\`${rejectionSuffix}`;

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
      ...(result.rejectionReason !== undefined ? { rejectionReason: result.rejectionReason } : {}),
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

// ---------------------------------------------------------------------------
// skill_describe -- catalog-detail tool used by meta.classify-question
// ---------------------------------------------------------------------------

const skillDescribeTool: Tool = {
  id: 'skill_describe',
  description:
    'Look up a registered skill\'s manifest by id. Returns the skill\'s ' +
    'description, family, owner, version, input / output JSON schemas, ' +
    'preconditions, and provider affinity. Used by meta.classify-question ' +
    'and meta.select-scope to pull full schema detail on demand when the ' +
    'one-line catalog summary isn\'t enough. Pure registry read; no side ' +
    'effects, no approval gate.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description:
          'The skill\'s canonical dotted-lowercase id, e.g. ' +
          '\'data.profile.numeric.rdbms\'.',
      },
      version: {
        type: 'number',
        description:
          'Optional version pin. Defaults to the highest registered ' +
          'version that respects the family-enabled gate.',
        minimum: 1,
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
  requiresApproval: false,

  async execute(input: ToolInput, _deps: ToolDeps): Promise<ToolResult> {
    const id = typeof input['id'] === 'string' ? input['id'] : '';
    if (id.length === 0) {
      return {
        output: '[skill_describe] id required',
        format: 'text',
        success: false,
        error: 'id required',
      };
    }
    const version = typeof input['version'] === 'number' ? input['version'] : undefined;

    // Use the family-gate-respecting lookup. A skill whose family is
    // disabled in the active settings is treated as not-registered
    // here -- matches the contract every other public skill API
    // observes (registry.getSkill / listSkills / runSkill).
    const skill = getSkill(id, version);
    if (skill === undefined) {
      const where = version === undefined ? id : `${id}@${version}`;
      return {
        output: `[skill_describe] no skill registered with id '${where}'`,
        format: 'text',
        success: false,
        error: `unknown skill: ${where}`,
      };
    }

    const manifest = {
      id:               skill.id,
      name:             skill.name,
      family:           skill.family,
      owner:            skill.owner,
      version:          skill.version,
      description:      skill.description,
      inputs:           skill.inputs,
      outputs:          skill.outputs,
      providerAffinity: skill.providerAffinity,
      preconditions:    skill.preconditions ?? [],
      toolDeps:         skill.toolDeps,
      ...(skill.skillDeps !== undefined ? { skillDeps: skill.skillDeps } : {}),
    };

    const output =
      `**skill:${skill.id}** v${skill.version} (${skill.family} / ${skill.owner})\n\n` +
      `${skill.description}\n\n` +
      `\`\`\`json\n${safePreview(manifest)}\n\`\`\``;

    return {
      output,
      format: 'markdown',
      success: true,
      data: manifest,
    };
  },
};

export function registerSkillTools(): void {
  registerTool(skillInvokeTool);
  registerTool(skillDescribeTool);
}
