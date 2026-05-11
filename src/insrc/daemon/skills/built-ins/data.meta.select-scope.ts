/**
 * data.meta.select-scope -- Phase 7.2 of plans/analyzers/data-analyzer-skills.md.
 *
 * The second call in the planner pipeline, after meta.classify-
 * question. Takes the candidate list + question + connection roster
 * and produces concrete `{ skillId, args }` invocations the planner
 * can execute. Resolves target names ("the orders table") to real
 * connection + table refs, fills out optional skill inputs from
 * question context, and surfaces ambiguity explicitly rather than
 * silently picking a default.
 *
 * Design (from §7.2 of the plan):
 *
 *   1. **Catalog format** -- per-candidate, full inputSchema inline.
 *      The candidate list is already small (typically 3-7 from
 *      classify-question), so per-skill inputSchema (~200 chars
 *      after pruning descriptions) fits well under 4K tokens total.
 *      The LLM doesn't need skill_describe here -- everything it
 *      needs is in the prompt.
 *
 *   2. **Prompt structure** -- structured output; per-candidate the
 *      LLM fills `args` against the schema. Validation runs server-
 *      side after the LLM returns: each ScopedInvocation.args is
 *      checked against its skill's inputSchema; failures retry once.
 *      Three failures in a row degrade to confidence: low and
 *      surface unfilled candidates in `notes`.
 *
 *   3. **Model affinity** -- same cloud-small-tier as classify-
 *      question. The two meta calls per turn cost <5c on small-tier
 *      defaults.
 *
 *   4. **Connection / target resolution** -- fuzzy with explicit
 *      ambiguity surfacing. Multiple matches → one Candidate per
 *      match with `ambiguity: { kind: 'multiple-matches' }` for
 *      planner gating. Zero matches → low confidence + `ambiguity:
 *      { kind: 'no-match' }`. Codifies the 2026-04-30 lesson:
 *      never silently pick a default scope when the question is
 *      ambiguous; always surface the choice.
 *
 * v1 scope:
 *   - For target verification, this skill TRUSTS the LLM's pick from
 *     the question text. It does NOT call db_sql_describe /
 *     db_kv_list_namespaces / db_file_describe per candidate to verify
 *     the target exists -- that round-trip cost (one tool call per
 *     candidate * connection) outweighs the value when the planner
 *     will hit the same wall at execute time anyway. If the LLM picks
 *     a non-existent target, the actual skill execution fails with a
 *     structured error and the planner re-runs select-scope.
 *   - The plan's section 7.2 lists db_sql_describe / equivalents in
 *     `toolDeps`; we declare them so the precondition gate fires when
 *     they're missing, but don't call them in the v1 body.
 *
 * Family: `meta`. Owner: `data-analyzer`. Affinity: `cloud`.
 */

import { getLogger } from '../../../shared/logger.js';
import { registerSkill, getSkill } from '../registry.js';
import { validate as validateJsonSchema } from '../json-schema.js';
import type { Skill, SkillResult } from '../types.js';
import type { LLMMessage, LLMProvider } from '../../../shared/types.js';
import { stripJsonFences } from '../../../shared/json-fences.js';

const log = getLogger('skill.meta.select-scope');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MustHaveScope = 'connection' | 'connection+target' | 'connection+target+columns' | 'none';
type AmbiguityKind = 'multiple-matches' | 'no-match';

interface CandidateIn {
  readonly skillId:       string;
  readonly rationale:     string;
  readonly mustHaveScope: MustHaveScope;
}

interface ConnectionInfo {
  readonly id:     string;
  readonly family: string;
  readonly kind?:  string;
}

interface SelectScopeInput {
  readonly question:    string;
  readonly candidates:  readonly CandidateIn[];
  readonly connections: readonly ConnectionInfo[];
}

interface ResolvedScope {
  readonly connectionId: string;
  readonly target?:      string;
  readonly columns?:     readonly string[];
}

interface Ambiguity {
  readonly kind:          AmbiguityKind;
  readonly alternatives?: readonly string[];
}

interface ScopedInvocation {
  readonly skillId:       string;
  readonly args:          Record<string, unknown>;
  readonly resolvedScope: ResolvedScope;
  readonly ambiguity?:    Ambiguity;
}

interface SelectScopeOutput {
  readonly scoped: readonly ScopedInvocation[];
  readonly notes:  readonly string[];
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const CONNECTION_INFO_SCHEMA = {
  type: 'object',
  properties: {
    id:     { type: 'string' },
    family: { type: 'string' },
    kind:   { type: 'string' },
  },
  required: ['id', 'family'],
  additionalProperties: false,
} as const;

const CANDIDATE_IN_SCHEMA = {
  type: 'object',
  properties: {
    skillId:       { type: 'string' },
    rationale:     { type: 'string' },
    mustHaveScope: {
      type: 'string',
      enum: ['connection', 'connection+target', 'connection+target+columns', 'none'],
    },
  },
  required: ['skillId', 'rationale', 'mustHaveScope'],
  additionalProperties: false,
} as const;

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    question:    { type: 'string', minLength: 1, maxLength: 4000 },
    candidates:  { type: 'array', items: CANDIDATE_IN_SCHEMA, minItems: 0, maxItems: 8 },
    connections: { type: 'array', items: CONNECTION_INFO_SCHEMA, minItems: 0, maxItems: 64 },
  },
  required: ['question', 'candidates', 'connections'],
  additionalProperties: false,
} as const;

const RESOLVED_SCOPE_SCHEMA = {
  type: 'object',
  properties: {
    connectionId: { type: 'string' },
    target:       { type: 'string' },
    columns:      { type: 'array', items: { type: 'string' } },
  },
  required: ['connectionId'],
  additionalProperties: false,
} as const;

const AMBIGUITY_SCHEMA = {
  type: 'object',
  properties: {
    kind:         { type: 'string', enum: ['multiple-matches', 'no-match'] },
    alternatives: { type: 'array', items: { type: 'string' } },
  },
  required: ['kind'],
  additionalProperties: false,
} as const;

const SCOPED_INVOCATION_SCHEMA = {
  type: 'object',
  properties: {
    skillId:       { type: 'string' },
    args:          { type: 'object' },
    resolvedScope: RESOLVED_SCOPE_SCHEMA,
    ambiguity:     AMBIGUITY_SCHEMA,
  },
  required: ['skillId', 'args', 'resolvedScope'],
  additionalProperties: false,
} as const;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    scoped: { type: 'array', items: SCOPED_INVOCATION_SCHEMA, maxItems: 16 },
    notes:  { type: 'array', items: { type: 'string', maxLength: 280 }, maxItems: 8 },
  },
  required: ['scoped', 'notes'],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

interface CandidateManifest {
  readonly skillId:     string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

function buildCandidateManifests(
  candidates: readonly CandidateIn[],
): { readonly resolved: readonly CandidateManifest[]; readonly missing: readonly string[] } {
  const resolved: CandidateManifest[] = [];
  const missing: string[] = [];
  for (const c of candidates) {
    const skill = getSkill(c.skillId);
    if (skill === undefined) {
      missing.push(c.skillId);
      continue;
    }
    resolved.push({
      skillId:     c.skillId,
      description: skill.description,
      inputSchema: skill.inputs,
    });
  }
  return { resolved, missing };
}

function buildSystemPrompt(): string {
  return [
    'You are a data-analyzer scope-selector. For each candidate skill the',
    'planner picked, fill in concrete `args` (matching the skill\'s input',
    'schema) using information from the user question + connection roster.',
    'Output STRICT JSON matching this schema:',
    '',
    '```json',
    JSON.stringify(OUTPUT_SCHEMA, null, 2),
    '```',
    '',
    'Hard rules:',
    '1. EVERY entry in `scoped` MUST have `skillId` matching one of the',
    '   candidates the user message provides. Never invent a skill id.',
    '2. `args` MUST satisfy the candidate\'s declared input schema. Read',
    '   the schema in the user message; only emit properties the schema',
    '   declares; respect required fields and enum constraints.',
    '3. `resolvedScope.connectionId` MUST come from the connection roster.',
    '   Pick the connection whose `family` matches the skill\'s declared',
    '   `connection-family` precondition (if any) and whose name / role',
    '   best fits the question.',
    '4. When the question references a target ("the orders table") and',
    '   multiple connections plausibly hold it, EMIT ONE entry per',
    '   matching connection and set `ambiguity: { kind:',
    '   "multiple-matches", alternatives: [<connectionId>, ...] }`. The',
    '   planner gates on this for a user clarification.',
    '5. When the question references a target that no connection clearly',
    '   matches, emit ONE entry with the LLM\'s best guess + `ambiguity:',
    '   { kind: "no-match" }` and surface the issue in `notes`. Do NOT',
    '   silently pick a default.',
    '6. Use `notes` to flag anything ambiguous in the question that the',
    '   LLM had to guess (default sample sizes, default modes, etc.).',
    '   Empty array if every arg came directly from the question.',
    '',
    'Output ONLY the JSON object; no preamble, no fenced block.',
  ].join('\n');
}

function buildUserMessage(
  input: SelectScopeInput,
  manifests: readonly CandidateManifest[],
): string {
  const connLines = input.connections.map(c =>
    `- \`${c.id}\` family=${c.family}${c.kind !== undefined ? ` kind=${c.kind}` : ''}`,
  );
  const candidateBlocks = input.candidates.map((c, i) => {
    const manifest = manifests.find(m => m.skillId === c.skillId);
    if (manifest === undefined) {
      return [`### Candidate ${i + 1}: \`${c.skillId}\` (not in registry; skip)`].join('\n');
    }
    return [
      `### Candidate ${i + 1}: \`${c.skillId}\``,
      `mustHaveScope: ${c.mustHaveScope}`,
      `rationale (from classify-question): ${c.rationale}`,
      `description: ${manifest.description}`,
      'inputSchema:',
      '```json',
      JSON.stringify(manifest.inputSchema, null, 2),
      '```',
    ].join('\n');
  });
  return [
    `Question:`,
    input.question,
    '',
    `Available connections (${input.connections.length}):`,
    connLines.length > 0 ? connLines.join('\n') : '(none)',
    '',
    `Candidates (${input.candidates.length}):`,
    candidateBlocks.length > 0 ? candidateBlocks.join('\n\n') : '(empty)',
    '',
    'Return ONLY the JSON object matching the schema; no preamble.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Output parsing + validation
// ---------------------------------------------------------------------------

interface ParseFailure {
  readonly message: string;
}

type ParseResult =
  | { readonly ok: true;  readonly value: SelectScopeOutput }
  | { readonly ok: false; readonly failure: ParseFailure };

function parseAndValidate(
  raw: string,
  candidates: readonly CandidateIn[],
  connections: readonly ConnectionInfo[],
): ParseResult {
  const text = stripJsonFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, failure: { message: `JSON parse failed: ${(err as Error).message}` } };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, failure: { message: 'output must be a JSON object' } };
  }
  const obj = parsed as Record<string, unknown>;

  // Shape validation against the output schema.
  const shape = validateJsonSchema(obj, OUTPUT_SCHEMA as Record<string, unknown>);
  if (shape.ok !== true) {
    return { ok: false, failure: { message: `output shape rejected: ${shape.errors.join('; ')}` } };
  }

  const candidateIds   = new Set(candidates.map(c => c.skillId));
  const connectionIds  = new Set(connections.map(c => c.id));
  const scopedRaw      = obj['scoped'] as readonly unknown[];
  const scoped: ScopedInvocation[] = [];

  for (let i = 0; i < scopedRaw.length; i++) {
    const entry = scopedRaw[i] as Record<string, unknown>;
    const skillId = entry['skillId'] as string;

    if (!candidateIds.has(skillId)) {
      return { ok: false, failure: { message: `scoped[${i}].skillId='${skillId}' is not in the candidate list` } };
    }

    const skill = getSkill(skillId);
    if (skill === undefined) {
      return { ok: false, failure: { message: `scoped[${i}].skillId='${skillId}' is not a registered skill` } };
    }

    // Validate args against the candidate's inputSchema.
    const args = entry['args'] as Record<string, unknown>;
    const argResult = validateJsonSchema(args, skill.inputs);
    if (argResult.ok !== true) {
      return { ok: false, failure: { message: `scoped[${i}].args (skillId='${skillId}') failed inputSchema: ${argResult.errors.join('; ')}` } };
    }

    const resolvedScope = entry['resolvedScope'] as Record<string, unknown>;
    const connectionId  = resolvedScope['connectionId'] as string;
    if (!connectionIds.has(connectionId)) {
      return { ok: false, failure: { message: `scoped[${i}].resolvedScope.connectionId='${connectionId}' is not in the connection roster` } };
    }

    const ambiguityRaw = entry['ambiguity'] as Record<string, unknown> | undefined;

    const scope: ResolvedScope = { connectionId };
    if (typeof resolvedScope['target']  === 'string') {
      (scope as { target?: string }).target = resolvedScope['target'] as string;
    }
    if (Array.isArray(resolvedScope['columns'])) {
      (scope as { columns?: readonly string[] }).columns = resolvedScope['columns'] as readonly string[];
    }

    const inv: ScopedInvocation = ambiguityRaw === undefined
      ? { skillId, args, resolvedScope: scope }
      : {
          skillId,
          args,
          resolvedScope: scope,
          ambiguity: {
            kind:         ambiguityRaw['kind'] as AmbiguityKind,
            ...(Array.isArray(ambiguityRaw['alternatives'])
              ? { alternatives: ambiguityRaw['alternatives'] as readonly string[] }
              : {}),
          },
        };
    scoped.push(inv);
  }

  const notesRaw = obj['notes'] as readonly unknown[];
  const notes: string[] = [];
  for (const n of notesRaw) {
    if (typeof n === 'string') notes.push(n);
  }

  return { ok: true, value: { scoped, notes } };
}


// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

async function callLLM(
  provider: LLMProvider,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: userMessage },
  ];
  const response = await provider.complete(messages, {
    maxTokens: 1024,
    temperature: 0.2,
    responseFormat: { schema: OUTPUT_SCHEMA as Record<string, unknown> },
  });
  return response.text;
}

// ---------------------------------------------------------------------------
// Skill body
// ---------------------------------------------------------------------------

const skill: Skill<SelectScopeInput, SelectScopeOutput> = {
  id: 'data.meta.select-scope',
  name: 'Meta: select-scope (fill skill args from question + connection roster)',
  description:
    'Take classify-question\'s candidate list and the user question and fill ' +
    'concrete args per candidate against its inputSchema. Resolves target ' +
    'names to real (connectionId, target?, columns?) refs and surfaces ' +
    'ambiguity explicitly (multiple-matches / no-match) for the planner to ' +
    'gate on. Cloud-routed; structured JSON output validated against each ' +
    'skill\'s inputSchema before returning.',
  family: 'meta',
  owner: 'data-analyzer',
  version: 1,
  inputs:  INPUT_SCHEMA as unknown as Record<string, unknown>,
  outputs: OUTPUT_SCHEMA as unknown as Record<string, unknown>,
  toolDeps: [],
  providerAffinity: 'cloud',
  preconditions: [],

  async execute(input, deps): Promise<SkillResult<SelectScopeOutput>> {
    if (input.candidates.length === 0) {
      return {
        value: { scoped: [], notes: ['no candidates supplied; classify-question returned an empty list'] },
        confidence: 'low',
        notes: ['no candidates'],
        toolCalls: [],
      };
    }

    const { resolved, missing } = buildCandidateManifests(input.candidates);
    if (resolved.length === 0) {
      return {
        value: {
          scoped: [],
          notes: [`every candidate is missing from the registry: [${missing.join(', ')}]`],
        },
        confidence: 'low',
        notes: ['no candidates resolved against the registry'],
        toolCalls: [],
      };
    }

    const provider = deps.resolveProvider();
    const sys      = buildSystemPrompt();
    const user     = buildUserMessage(input, resolved);

    let raw: string;
    try {
      raw = await callLLM(provider, sys, user);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'select-scope LLM call failed');
      return {
        value: emptyOutput(),
        confidence: 'low',
        notes: [`LLM call failed: ${(err as Error).message}`],
        toolCalls: [],
      };
    }

    let parsed = parseAndValidate(raw, input.candidates, input.connections);
    if (parsed.ok !== true) {
      log.info({ message: parsed.failure.message }, 'select-scope first-pass rejected; retrying');
      const retryUser = `${user}\n\nThe previous attempt was rejected: ${parsed.failure.message}\nReturn ONLY a JSON object matching the schema; no other text.`;
      let retryRaw: string;
      try {
        retryRaw = await callLLM(provider, sys, retryUser);
      } catch (err) {
        return {
          value: emptyOutput(),
          confidence: 'low',
          notes: [`LLM retry failed: ${(err as Error).message}`, `first-pass rejection: ${parsed.failure.message}`],
          toolCalls: [],
        };
      }
      parsed = parseAndValidate(retryRaw, input.candidates, input.connections);
      if (parsed.ok !== true) {
        log.warn({ message: parsed.failure.message }, 'select-scope retry rejected; surfacing low confidence');
        return {
          value: emptyOutput(),
          confidence: 'low',
          notes: [`LLM output failed validation twice: ${parsed.failure.message}`],
          toolCalls: [],
        };
      }
    }

    const value = parsed.value;
    const hasAmbiguity = value.scoped.some(s => s.ambiguity !== undefined);
    const confidence =
      value.scoped.length === 0 ? 'low' :
      hasAmbiguity            ? 'medium' :
      value.notes.length > 0  ? 'medium' :
      'high';

    const result: SkillResult<SelectScopeOutput> = { value, confidence, toolCalls: [] };
    if (value.notes.length > 0 || missing.length > 0) {
      const notes = [...value.notes];
      if (missing.length > 0) {
        notes.unshift(`unresolved candidate ids dropped: [${missing.join(', ')}]`);
      }
      return { ...result, notes };
    }
    return result;
  },
};

function emptyOutput(): SelectScopeOutput {
  return { scoped: [], notes: [] };
}

export function registerDataMetaSelectScopeSkill(): void {
  registerSkill(skill as unknown as Skill);
}
