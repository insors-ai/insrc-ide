/**
 * data.meta.classify-question -- Phase 7.1 of plans/analyzers/data-analyzer-skills.md.
 *
 * The first call in the planner pipeline. Maps a free-form user
 * question + connection roster → an ordered list of candidate skill
 * ids the planner should invoke, plus a coarse question type for
 * downstream routing.
 *
 * Design (from §7.1 of the plan):
 *
 *   1. **Catalog format** -- server-side prefilter by connection-family
 *      (drops skills whose connection-family precondition can't be
 *      satisfied by the current roster) + 1-line catalog of survivors
 *      + on-demand `skill_describe` tool for detail. Target: <2K
 *      tokens for the catalog on typical questions.
 *
 *   2. **Prompt structure** -- structured-output JSON, schema-
 *      validated, with 5-7 few-shot examples in the *system* slot
 *      (cacheable on Anthropic + OpenAI). One retry on rejection.
 *
 *   3. **Model affinity** -- cloud, smallest tier per active
 *      provider. The LLMProvider session resolver picks the active
 *      cloud provider's small/fast model for the `meta` step.
 *
 *   4. **Preconditions** -- server-side prefilter via the shipped
 *      meta.feasibility-check (skills-plan §7.3). The LLM only sees
 *      skills whose static-context preconditions can be satisfied.
 *      Execute-time preconditions (min-sample-size, etc.) re-check
 *      after meta.select-scope populates concrete inputs.
 *
 * Out of catalog scope:
 *   - `meta.*` skills (we don't recurse-classify into the meta layer).
 *   - `synthesis` family (renderers, not analyzers; planner picks
 *     synth renderers based on the analyzer skill's output shape,
 *     not the question type).
 *   - skills owned by other analyzers (data-analyzer doesn't route
 *     into code-analyzer / deploy-analyzer; cross-owner skill calls
 *     happen inside data-analyzer's own composite skills, not from
 *     the planner).
 *
 * Family: `meta`. Owner: `data-analyzer`. Affinity: `cloud`.
 */

import { getLogger } from '../../../shared/logger.js';
import { registerSkill } from '../registry.js';
import { listSkills } from '../registry.js';
import type { Skill, SkillContext, SkillResult } from '../types.js';
import type { LLMMessage, LLMProvider, ToolDefinition } from '../../../shared/types.js';

/**
 * Tool name the model emits to submit its classification. Drives the
 * provider via tool-calling (not JSON-as-text) so the payload is
 * structurally well-formed by construction.
 */
const SUBMIT_TOOL_NAME = 'submit_classification';

const log = getLogger('skill.meta.classify-question');

// ---------------------------------------------------------------------------
// Input / output shapes
// ---------------------------------------------------------------------------

type MustHaveScope = 'connection' | 'connection+target' | 'connection+target+columns' | 'none';

type QuestionType =
  | 'describe-schema'
  | 'sample-data'
  | 'profile-quality'
  | 'compare-shapes'
  | 'drift-analysis'
  | 'lineage'
  | 'sensitivity'
  | 'timeseries'
  | 'free-form';

interface ConnectionInfo {
  readonly id:     string;
  readonly family: string;          // 'rdbms' | 'kv' | 'file' | ...
  readonly kind?:  string;          // 'postgres' | 'mongodb' | 'csv' | ...
  readonly label?: string;
  readonly path?:  string;
}

interface PriorContext {
  readonly repoPath?:    string;
  readonly sessionTags?: readonly string[];
}

interface ClassifyInput {
  readonly question:      string;
  readonly connections:   readonly ConnectionInfo[];
  readonly priorContext?: PriorContext;
}

interface Candidate {
  readonly skillId:       string;
  readonly rationale:     string;
  readonly mustHaveScope: MustHaveScope;
}

interface ClassifyOutput {
  readonly questionType:     QuestionType;
  readonly candidates:       readonly Candidate[];
  readonly fallbacks:        readonly string[];
  readonly uncertaintyNotes: readonly string[];
}

// ---------------------------------------------------------------------------
// JSON schemas (input + output)
// ---------------------------------------------------------------------------

const CONNECTION_INFO_SCHEMA = {
  type: 'object',
  properties: {
    id:     { type: 'string' },
    family: { type: 'string' },
    kind:   { type: 'string' },
    // `label` and `path` mirror the select-scope schema -- both meta-
    // skills see the same connection-roster projection so the LLM can
    // pick candidates based on path/label, not just opaque ids.
    label:  { type: 'string' },
    path:   { type: 'string' },
  },
  required: ['id', 'family'],
  additionalProperties: false,
} as const;

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    question: { type: 'string', minLength: 1, maxLength: 4000 },
    connections: {
      type: 'array',
      items: CONNECTION_INFO_SCHEMA,
      minItems: 0,
      maxItems: 64,
    },
    priorContext: {
      type: 'object',
      properties: {
        repoPath:    { type: 'string' },
        sessionTags: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
  },
  required: ['question', 'connections'],
  additionalProperties: false,
} as const;

const QUESTION_TYPES: readonly QuestionType[] = [
  'describe-schema', 'sample-data', 'profile-quality', 'compare-shapes',
  'drift-analysis', 'lineage', 'sensitivity', 'timeseries', 'free-form',
] as const;

const MUST_HAVE_SCOPES: readonly MustHaveScope[] = [
  'connection', 'connection+target', 'connection+target+columns', 'none',
] as const;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    questionType: { type: 'string', enum: QUESTION_TYPES },
    candidates: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        properties: {
          skillId:       { type: 'string' },
          rationale:     { type: 'string', maxLength: 280 },
          mustHaveScope: { type: 'string', enum: MUST_HAVE_SCOPES },
        },
        required: ['skillId', 'rationale', 'mustHaveScope'],
        additionalProperties: false,
      },
    },
    fallbacks:        { type: 'array', items: { type: 'string' }, maxItems: 8 },
    uncertaintyNotes: { type: 'array', items: { type: 'string', maxLength: 280 }, maxItems: 6 },
  },
  required: ['questionType', 'candidates', 'fallbacks', 'uncertaintyNotes'],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Catalog: prefilter + render
// ---------------------------------------------------------------------------

interface CatalogEntry {
  readonly id:      string;
  readonly family:  string;
  readonly summary: string;
}

const CATALOG_SUMMARY_MAX = 120;

/**
 * Walk the skill registry and emit only the skills classify-question
 * is allowed to surface to the LLM:
 *   - data-analyzer-owned (no cross-owner recursion at this layer)
 *   - non-meta family (don't recurse-classify into meta)
 *   - non-synthesis family (renderers, not analyzers)
 *   - **connection-family precondition matches the input roster** --
 *     a KV-only roster drops every *.rdbms skill, an RDBMS-only roster
 *     drops every *.kv / *.file skill, etc.
 *
 * Other precondition kinds (`required-tools`, `min-sample-size`,
 * `cross-owner-allowed`, `connection-property`) are NOT prefiltered
 * here -- they're runtime-context concerns the planner re-checks via
 * `meta.feasibility-check` after `meta.select-scope` populates
 * concrete inputs. Surfacing those skills in the catalog is correct:
 * if the LLM picks one whose runtime precondition fails, the planner
 * gates on it cleanly with a structured rejection.
 *
 * Synchronous; no I/O. Output is sorted by `family` then `id` so the
 * prompt is deterministic across calls (better cache locality on
 * Anthropic + OpenAI).
 */
function buildCatalog(
  input: ClassifyInput,
  _ctx: SkillContext,
): readonly CatalogEntry[] {
  const rosterFamilies = new Set(input.connections.map(c => c.family));
  const out: CatalogEntry[] = [];
  for (const skill of listSkills()) {
    if (skill.owner !== 'data-analyzer')   continue;
    if (skill.family === 'meta')           continue;
    if (skill.family === 'synthesis')      continue;
    if (!matchesConnectionFamily(skill, rosterFamilies)) continue;

    out.push({
      id:      skill.id,
      family:  skill.family,
      summary: truncate(skill.description, CATALOG_SUMMARY_MAX),
    });
  }
  out.sort((a, b) =>
    a.family !== b.family ? a.family.localeCompare(b.family) : a.id.localeCompare(b.id),
  );
  return out;
}

/**
 * True when the skill either has no `connection-family` precondition
 * (any roster works) OR the roster contains at least one connection
 * whose family the skill accepts. Empty roster fails any skill that
 * declares a `connection-family` precondition -- this is the intended
 * "no connections registered" UX.
 */
function matchesConnectionFamily(
  skill: Skill,
  rosterFamilies: ReadonlySet<string>,
): boolean {
  const fams = (skill.preconditions ?? [])
    .filter((p): p is Extract<typeof p, { kind: 'connection-family' }> =>
      p.kind === 'connection-family')
    .flatMap(p => [...p.families]);
  if (fams.length === 0) { return true; }
  return fams.some(f => rosterFamilies.has(f));
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + '…';
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const FEW_SHOT = `
EXAMPLES:

Question: "Describe the schema of the orders table on connection prod-db."
Connections: [{ id: prod-db, family: rdbms, kind: postgres }]
Output:
{
  "questionType": "describe-schema",
  "candidates": [
    { "skillId": "data.source.rdbms.describe-table", "rationale": "RDBMS schema introspection over a single named target.", "mustHaveScope": "connection+target" }
  ],
  "fallbacks": ["data.source.rdbms.list-tables"],
  "uncertaintyNotes": []
}

Question: "Pull 20 rows from users where status='active'."
Connections: [{ id: prod-db, family: rdbms, kind: mysql }]
Output:
{
  "questionType": "sample-data",
  "candidates": [
    { "skillId": "data.source.rdbms.sample-rows", "rationale": "Row sampling with structured WHERE.", "mustHaveScope": "connection+target" }
  ],
  "fallbacks": ["data.source.rdbms.describe-table"],
  "uncertaintyNotes": []
}

Question: "Audit data quality on orders -- completeness, uniqueness, validity."
Connections: [{ id: warehouse, family: rdbms, kind: postgres }]
Output:
{
  "questionType": "profile-quality",
  "candidates": [
    { "skillId": "data.quality.scorecard.rdbms", "rationale": "Composite that runs completeness + uniqueness + validity dimensions.", "mustHaveScope": "connection+target" },
    { "skillId": "data.profile.auto.rdbms", "rationale": "Per-column type-aware profile to find the right validity patterns.", "mustHaveScope": "connection+target" }
  ],
  "fallbacks": ["data.quality.completeness.rdbms", "data.quality.uniqueness.rdbms"],
  "uncertaintyNotes": ["The user did not name validity patterns; scorecard runs without validity unless caller supplies validityPatterns."]
}

Question: "Find PII-looking columns in users."
Connections: [{ id: prod-db, family: rdbms, kind: postgres }]
Output:
{
  "questionType": "sensitivity",
  "candidates": [
    { "skillId": "data.pii.column-classifier.rdbms", "rationale": "Per-column PII verdict with both pattern and column-name evidence.", "mustHaveScope": "connection+target" }
  ],
  "fallbacks": ["data.pii.detect-patterns.rdbms"],
  "uncertaintyNotes": []
}

Question: "Where in the codebase do we read the orders table?"
Connections: [{ id: prod-db, family: rdbms, kind: postgres }]
Output:
{
  "questionType": "lineage",
  "candidates": [
    { "skillId": "data.lineage.read-write-callsites", "rationale": "Cross-link a DB target to its read/write call sites.", "mustHaveScope": "connection+target" }
  ],
  "fallbacks": [],
  "uncertaintyNotes": []
}

Question: "Has request volume changed since last week?"
Connections: [{ id: events, family: rdbms, kind: postgres }]
Output:
{
  "questionType": "drift-analysis",
  "candidates": [
    { "skillId": "data.drift.volume.rdbms", "rationale": "Volume comparison between two windows; caller supplies WHERE filters.", "mustHaveScope": "connection+target" }
  ],
  "fallbacks": ["data.timeseries.trend.rdbms"],
  "uncertaintyNotes": ["Window boundaries are not specified; planner / select-scope must derive from the question text."]
}

Question: "Plot the trend of daily signups over the last 30 days."
Connections: [{ id: prod-db, family: rdbms, kind: postgres }]
Output:
{
  "questionType": "timeseries",
  "candidates": [
    { "skillId": "data.timeseries.trend.rdbms", "rationale": "OLS regression on (timestamp, value) pairs to surface slope + R².", "mustHaveScope": "connection+target+columns" }
  ],
  "fallbacks": ["data.timeseries.gap-analysis.rdbms"],
  "uncertaintyNotes": []
}
`.trim();

function buildSystemPrompt(): string {
  return [
    'You are a data-analyzer skill router. Map the user question to one or',
    'more candidate skill ids from the closed catalog the user message',
    'provides.',
    '',
    `Emit your output by calling the \`${SUBMIT_TOOL_NAME}\` tool exactly once`,
    'with the structured payload as its `input`. Do NOT emit prose, do NOT',
    'restate the payload as JSON in the message body -- the tool call IS the',
    'output. The tool\'s inputSchema (visible to you on every call) is the',
    'authoritative shape contract.',
    '',
    'Hard rules:',
    '1. EVERY skillId in `candidates` and `fallbacks` MUST appear in the',
    '   catalog the user message provides. Do not invent skill ids.',
    '2. Pick at most 4 candidates. Order by likelihood of being the',
    '   correct first call.',
    '3. `mustHaveScope` declares the smallest scope the candidate needs:',
    '   "connection" / "connection+target" / "connection+target+columns" /',
    '   "none". select-scope (the next pipeline step) will fill the args.',
    '4. `uncertaintyNotes` should surface anything the user message did',
    '   not specify (windows, validity patterns, sampling sizes). Empty',
    '   array if the question is fully scoped.',
    '5. Use `fallbacks` for second-choice skills the planner can pivot to',
    '   if the first candidates fail their preconditions or return',
    '   confidence: low.',
    '6. Set `questionType` to the closest fit; "free-form" only when no',
    '   other type matches.',
    '',
    FEW_SHOT,
  ].join('\n');
}

function buildUserMessage(
  input: ClassifyInput,
  catalog: readonly CatalogEntry[],
): string {
  const catalogLines = catalog.map(e => `- \`${e.id}\` [${e.family}] -- ${e.summary}`);
  const connLines    = input.connections.map(c => {
    const parts = [`- \`${c.id}\` family=${c.family}`];
    if (c.kind  !== undefined) parts.push(`kind=${c.kind}`);
    if (c.label !== undefined && c.label.length > 0) parts.push(`label="${c.label}"`);
    if (c.path  !== undefined && c.path.length > 0)  parts.push(`path=${c.path}`);
    return parts.join(' ');
  });
  // Catalog sits at the trailing end of the prompt so it stays
  // fresh in the model's attention when it emits the tool_use
  // payload. Smaller / local models otherwise hallucinate skill ids
  // when the catalog is buried in the middle and the action
  // instruction is the most-recent token.
  return [
    `Question:`,
    input.question,
    '',
    `Available connections (${input.connections.length}):`,
    connLines.length > 0 ? connLines.join('\n') : '(none)',
    '',
    'Use `skill_describe` to pull a full input/output schema for any',
    'skill before picking it if the one-line summary is ambiguous.',
    '',
    'EVERY skillId you emit in `candidates` or `fallbacks` MUST come',
    'verbatim from the catalog below. Hallucinated ids are rejected',
    'and the call retried, so just don\'t.',
    '',
    `Skill catalog (${catalog.length} skills, pre-filtered for connection feasibility):`,
    catalog.length > 0 ? catalogLines.join('\n') : '(empty)',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Output parsing + validation
// ---------------------------------------------------------------------------

interface ParseFailure {
  readonly kind: 'parse' | 'validation';
  readonly message: string;
}

type ParseResult =
  | { readonly ok: true;  readonly value: ClassifyOutput }
  | { readonly ok: false; readonly failure: ParseFailure };

function parseAndValidate(
  parsed: unknown,
  catalog: readonly CatalogEntry[],
): ParseResult {
  // Input is the tool-call's `input` payload -- already a parsed
  // object via the provider's wire protocol. No JSON.parse / fence
  // stripping needed; the truncation-mid-string class of failure
  // can't happen on this protocol.
  if (parsed === undefined || parsed === null) {
    return {
      ok: false,
      failure: { kind: 'parse', message: 'no tool_use payload returned by provider' },
    };
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, failure: { kind: 'validation', message: 'tool_use payload must be a JSON object' } };
  }
  const obj = parsed as Record<string, unknown>;

  const questionType = obj['questionType'];
  if (typeof questionType !== 'string' || !QUESTION_TYPES.includes(questionType as QuestionType)) {
    return { ok: false, failure: { kind: 'validation', message: `questionType must be one of: ${QUESTION_TYPES.join(', ')}` } };
  }

  const candidatesRaw = obj['candidates'];
  if (!Array.isArray(candidatesRaw)) {
    return { ok: false, failure: { kind: 'validation', message: 'candidates must be an array' } };
  }
  const knownIds = new Set(catalog.map(e => e.id));
  const candidates: Candidate[] = [];
  for (let i = 0; i < candidatesRaw.length; i++) {
    const c = candidatesRaw[i];
    if (typeof c !== 'object' || c === null) {
      return { ok: false, failure: { kind: 'validation', message: `candidates[${i}] must be an object` } };
    }
    const cc = c as Record<string, unknown>;
    const skillId   = cc['skillId'];
    const rationale = cc['rationale'];
    const scope     = cc['mustHaveScope'];
    if (typeof skillId !== 'string' || !knownIds.has(skillId)) {
      return { ok: false, failure: { kind: 'validation', message: `candidates[${i}].skillId='${skillId}' not in the catalog` } };
    }
    if (typeof rationale !== 'string') {
      return { ok: false, failure: { kind: 'validation', message: `candidates[${i}].rationale must be a string` } };
    }
    if (typeof scope !== 'string' || !MUST_HAVE_SCOPES.includes(scope as MustHaveScope)) {
      return { ok: false, failure: { kind: 'validation', message: `candidates[${i}].mustHaveScope must be one of: ${MUST_HAVE_SCOPES.join(', ')}` } };
    }
    candidates.push({ skillId, rationale, mustHaveScope: scope as MustHaveScope });
  }

  const fallbacksRaw = obj['fallbacks'];
  if (!Array.isArray(fallbacksRaw)) {
    return { ok: false, failure: { kind: 'validation', message: 'fallbacks must be an array' } };
  }
  const fallbacks: string[] = [];
  for (let i = 0; i < fallbacksRaw.length; i++) {
    const f = fallbacksRaw[i];
    if (typeof f !== 'string' || !knownIds.has(f)) {
      return { ok: false, failure: { kind: 'validation', message: `fallbacks[${i}]='${f}' not in the catalog` } };
    }
    fallbacks.push(f);
  }

  const notesRaw = obj['uncertaintyNotes'];
  if (!Array.isArray(notesRaw)) {
    return { ok: false, failure: { kind: 'validation', message: 'uncertaintyNotes must be an array' } };
  }
  const uncertaintyNotes: string[] = [];
  for (let i = 0; i < notesRaw.length; i++) {
    const n = notesRaw[i];
    if (typeof n !== 'string') {
      return { ok: false, failure: { kind: 'validation', message: `uncertaintyNotes[${i}] must be a string` } };
    }
    uncertaintyNotes.push(n);
  }

  return {
    ok: true,
    value: {
      questionType: questionType as QuestionType,
      candidates,
      fallbacks,
      uncertaintyNotes,
    },
  };
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

/**
 * Submission tool. The model emits ONE tool_use block whose `input`
 * carries the structured classify-question output. The inputSchema
 * mirrors `OUTPUT_SCHEMA` so the provider's tool-call validation
 * enforces shape -- truncation mid-payload simply can't happen
 * (provider serializes after token selection, not before).
 */
const SUBMIT_TOOL: ToolDefinition = {
  name:        SUBMIT_TOOL_NAME,
  description: 'Submit the classify-question output: questionType + ordered candidate skill ids + fallbacks + uncertainty notes.',
  inputSchema: OUTPUT_SCHEMA as unknown as Record<string, unknown>,
};

async function callLLM(
  provider: LLMProvider,
  systemPrompt: string,
  userMessage: string,
  signal?: AbortSignal | undefined,
): Promise<unknown | undefined> {
  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: userMessage },
  ];
  void signal;  // provider.complete signature doesn't take signal directly;
                // cancellation lives at the outer SkillDeps.signal level.
  const response = await provider.complete(messages, {
    // 3000 tokens of structured-output budget. Higher than the 1024
    // the old responseFormat path used because catalog summaries +
    // few-shot examples + the candidate list grow with the registry
    // size. Tool-call protocol prevents the *parse* failure mode
    // entirely; this cap just stops the model running indefinitely.
    maxTokens:   3000,
    temperature: 0.2,
    tools:       [SUBMIT_TOOL],
    toolChoice:  { name: SUBMIT_TOOL_NAME },
  });
  const toolCall = response.toolCalls?.find(tc => tc.name === SUBMIT_TOOL_NAME);
  return toolCall?.input;
}

// ---------------------------------------------------------------------------
// Skill body
// ---------------------------------------------------------------------------

const skill: Skill<ClassifyInput, ClassifyOutput> = {
  id: 'data.meta.classify-question',
  name: 'Meta: classify-question (data-analyzer router)',
  description:
    'Map a user question + connection roster to an ordered list of candidate ' +
    'data-analyzer skill ids the planner should invoke. First call in the ' +
    'planner pipeline. Cloud-routed; smallest active provider tier; structured ' +
    'JSON output validated against the closed catalog.',
  family: 'meta',
  owner: 'data-analyzer',
  version: 1,
  inputs:  INPUT_SCHEMA as unknown as Record<string, unknown>,
  outputs: OUTPUT_SCHEMA as unknown as Record<string, unknown>,
  toolDeps: ['skill_describe'],
  providerAffinity: 'local',
  preconditions: [
    {
      kind: 'required-tools',
      tools: ['skill_describe'],
      reason: 'classify-question references skill_describe in its system prompt; the LLM may call it for catalog detail.',
    },
  ],

  async execute(input, deps): Promise<SkillResult<ClassifyOutput>> {
    const ctx: SkillContext = { session: deps.session };
    const catalog = buildCatalog(input, ctx);

    if (catalog.length === 0) {
      return {
        value: {
          questionType: 'free-form',
          candidates: [],
          fallbacks: [],
          uncertaintyNotes: [
            'no skills survived the connection-family prefilter; check that at least one connection is registered and its family is supported',
          ],
        },
        confidence: 'low',
        notes: ['empty catalog after prefilter'],
        toolCalls: [],
      };
    }

    const provider = deps.resolveProvider();
    const sys      = buildSystemPrompt();
    const user     = buildUserMessage(input, catalog);

    let rawPayload: unknown;
    try {
      rawPayload = await callLLM(provider, sys, user, deps.signal);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'classify-question LLM call failed');
      return {
        value:      emptyOutput(),
        confidence: 'low',
        notes:      [`LLM call failed: ${(err as Error).message}`],
        toolCalls:  [],
      };
    }

    let parsed = parseAndValidate(rawPayload, catalog);
    if (parsed.ok !== true) {
      // One retry with the rejection text appended to the user
      // message. Per the design: structured-output validation
      // failures get exactly one retry; further failures degrade to
      // confidence: low with the unfilled output surfaced in notes.
      log.info({ kind: parsed.failure.kind, message: parsed.failure.message }, 'classify-question first-pass rejected; retrying');
      const retryUser = `${user}\n\nThe previous attempt was rejected: ${parsed.failure.message}\nRe-emit a corrected \`${SUBMIT_TOOL_NAME}\` tool call.`;
      let retryPayload: unknown;
      try {
        retryPayload = await callLLM(provider, sys, retryUser, deps.signal);
      } catch (err) {
        return {
          value:      emptyOutput(),
          confidence: 'low',
          notes:      [`LLM retry failed: ${(err as Error).message}`, `first-pass rejection: ${parsed.failure.message}`],
          toolCalls:  [],
        };
      }
      parsed = parseAndValidate(retryPayload, catalog);
      if (parsed.ok !== true) {
        log.warn({ kind: parsed.failure.kind, message: parsed.failure.message }, 'classify-question retry rejected; surfacing low confidence');
        return {
          value:      emptyOutput(),
          confidence: 'low',
          notes:      [`tool_use payload failed validation twice: ${parsed.failure.message}`],
          toolCalls:  [],
        };
      }
    }

    const value = parsed.value;
    const confidence =
      value.candidates.length === 0 ? 'low' :
      value.uncertaintyNotes.length > 0 ? 'medium' :
      'high';

    const result: SkillResult<ClassifyOutput> = { value, confidence, toolCalls: [] };
    if (value.uncertaintyNotes.length > 0) {
      return { ...result, notes: [...value.uncertaintyNotes] };
    }
    return result;
  },
};

function emptyOutput(): ClassifyOutput {
  return {
    questionType:     'free-form',
    candidates:       [],
    fallbacks:        [],
    uncertaintyNotes: [],
  };
}

export function registerDataMetaClassifyQuestionSkill(): void {
  registerSkill(skill as unknown as Skill);
}
