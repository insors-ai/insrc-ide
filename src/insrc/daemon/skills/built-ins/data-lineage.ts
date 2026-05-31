/**
 * data.lineage.read-write-callsites -- the skill registry's first
 * migration target. Wraps the existing `data_lineage` tool from
 * `daemon/tools/builtins/data/lineage.ts` so callers can invoke
 * the same capability through the typed skill API.
 *
 * Why this skill is the proof-of-substrate:
 *
 *   - It already exists end-to-end. Picking a brand-new capability
 *     would conflate "did the substrate work?" with "did the new
 *     capability work?". Reusing data_lineage means a successful
 *     skill invocation must produce identical lineage output to a
 *     direct tool call.
 *   - It's narrow (one tool dep, one input shape, one output shape).
 *   - It has cross-agent depth handling baked in already, so the
 *     skill's preconditions can validate that path.
 *
 * Skill id: `data.lineage.read-write-callsites`. Family: `lineage`.
 * Owner: `data-analyzer`. Provider affinity: `auto` -- the body has
 * no LLM call (it's a thin tool wrapper), so affinity is irrelevant
 * here, but we don't lie by tagging it `local` either.
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import type {
  BootstrapTriggerKind,
  ContextSlotRequest,
  MemoryEntry,
  NamespaceSpec,
  OwnerId,
  SubstrateSkillExtension,
} from '../../substrate/types.js';

interface DataLineageInput {
  readonly connectionId: string;
  readonly target: string;
  readonly limit?: number;
}

/**
 * Output mirrors the `data` field of the underlying data_lineage tool
 * verbatim so a caller can swap a tool call for a skill call without
 * downstream code changes. Defining it here (vs re-exporting from the
 * tool) keeps the skill's contract self-contained and lets the tool's
 * internal shape evolve independently in the future.
 */
interface LineageHit {
  readonly entityId: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly entityName: string;
  readonly entityKind: string;
  readonly classification: 'reader' | 'writer' | 'ambiguous';
  readonly snippet: string;
}

interface DataLineageOutput {
  readonly target: string;
  readonly connectionId: string;
  readonly hits: readonly LineageHit[];
  readonly truncated: boolean;
  readonly counts: {
    readonly readers: number;
    readonly writers: number;
    readonly ambiguous: number;
  };
}

const dataLineageSkill: Skill<DataLineageInput, DataLineageOutput> = {
  id: 'data.lineage.read-write-callsites',
  name: 'Lineage: code call-sites for a data target',
  description:
    'Find code that reads or writes a given data target (RDBMS table, KV namespace, file path). ' +
    'Returns code citations classified reader / writer / ambiguous.',
  family: 'lineage',
  owner: 'data-analyzer',
  version: 1,
  inputs: {
    type: 'object',
    properties: {
      connectionId: { type: 'string', description: 'Connection the target belongs to.' },
      target:       { type: 'string', description: 'Table / namespace / path.' },
      limit:        { type: 'number', minimum: 1, maximum: 100 },
    },
    required: ['connectionId', 'target'],
    additionalProperties: false,
  },
  outputs: {
    type: 'object',
    properties: {
      target:       { type: 'string' },
      connectionId: { type: 'string' },
      hits: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            entityId:       { type: 'string' },
            path:           { type: 'string' },
            startLine:      { type: 'number' },
            endLine:        { type: 'number' },
            entityName:     { type: 'string' },
            entityKind:     { type: 'string' },
            classification: { type: 'string', enum: ['reader', 'writer', 'ambiguous'] },
            snippet:        { type: 'string' },
          },
          required: ['entityId', 'path', 'startLine', 'endLine', 'entityName', 'entityKind', 'classification', 'snippet'],
        },
      },
      truncated: { type: 'boolean' },
      counts: {
        type: 'object',
        properties: {
          readers:   { type: 'number' },
          writers:   { type: 'number' },
          ambiguous: { type: 'number' },
        },
        required: ['readers', 'writers', 'ambiguous'],
      },
    },
    required: ['target', 'connectionId', 'hits', 'truncated', 'counts'],
  },
  toolDeps: ['data_lineage'],
  providerAffinity: 'auto',
  preconditions: [
    {
      kind: 'required-tools',
      tools: ['data_lineage'],
      reason: 'data_lineage is the only tool implementing the lineage probe; without it the skill cannot run',
    },
  ],

  async execute(input: DataLineageInput, deps: SkillDeps): Promise<SkillResult<DataLineageOutput>> {
    const cached = readCachedLineage(input, deps);
    if (cached !== undefined) {
      return {
        value: cached,
        confidence: cached.hits.length > 0 ? 'high' : 'medium',
        notes: ['from cache (substrate)'],
        toolCalls: [],
      };
    }

    const callId = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const toolResult = await deps.runTool({
      id: callId,
      name: 'data_lineage',
      input: {
        connectionId: input.connectionId,
        target: input.target,
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      },
    });

    if (toolResult.isError) {
      return {
        value: emptyOutput(input),
        confidence: 'low',
        notes: [`data_lineage tool returned error: ${toolResult.content.slice(0, 200)}`],
        toolCalls: [],
      };
    }

    // The tool's `data` field carries the structured payload; the
    // markdown text in `content` is the rendered version meant for
    // direct user consumption. Skills work off the structured form.
    const data = toolResult.data;
    if (!isLineageData(data)) {
      return {
        value: emptyOutput(input),
        confidence: 'low',
        notes: ['data_lineage returned a result without the expected structured data shape'],
        toolCalls: [],
      };
    }

    const value: DataLineageOutput = {
      target: data.target,
      connectionId: data.connectionId,
      hits: data.hits,
      truncated: data.truncated,
      counts: data.counts,
    };
    // High when we got hits, medium when we got zero (the search
    // ran cleanly but found nothing -- which is itself information).
    // The runner's calibration may clamp further.
    const confidence: 'high' | 'medium' = data.hits.length > 0 ? 'high' : 'medium';
    if (confidence === 'high') {
      pinLineage(input, value, deps);
    }
    return {
      value,
      confidence,
      ...(data.truncated ? { truncated: true } : {}),
      toolCalls: [],
    };
  },
};

function emptyOutput(input: DataLineageInput): DataLineageOutput {
  return {
    target: input.target,
    connectionId: input.connectionId,
    hits: [],
    truncated: false,
    counts: { readers: 0, writers: 0, ambiguous: 0 },
  };
}

function isLineageData(v: unknown): v is DataLineageOutput {
  if (typeof v !== 'object' || v === null) { return false; }
  const o = v as Record<string, unknown>;
  return typeof o['target'] === 'string'
    && typeof o['connectionId'] === 'string'
    && Array.isArray(o['hits'])
    && typeof o['truncated'] === 'boolean'
    && typeof o['counts'] === 'object'
    && o['counts'] !== null;
}

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------
//
// Code-to-data lineage is reasonably stable: it changes when code edits
// touch callsites or when the indexer re-emits relations. 7d TTL is
// generous; a reindex trigger forces invalidation when needed.

const OWNER_ID: OwnerId = 'skill:data.lineage.read-write-callsites';
const NAMESPACE = 'lineage-callsites';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['connection-add', 'refresh', 'manual'];

function cacheKey(input: DataLineageInput): string {
  const lim = input.limit ?? '';
  return `${input.connectionId}::${input.target}::${lim}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
  {
    name:      'cached-lineage',
    fromOwner: OWNER_ID,
    namespace: NAMESPACE,
    query: (req) => {
      const task = (req.task ?? {}) as DataLineageInput;
      return { kind: 'byKey', key: cacheKey(task) };
    },
    limit: 1,
  },
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
  {
    namespace:   NAMESPACE,
    valueType:   'DataLineageOutput',
    autoDistill: 'always-on-success',
    indexing:    { kind: 'never' },
    ttl:         '7d',
  },
];

const substrateExtension: SubstrateSkillExtension = {
  ownerId:            OWNER_ID,
  schemaVersion:      1,
  interestedTriggers: INTERESTED_TRIGGERS,
  contextSlots:       CONTEXT_SLOTS,
  memorySchema:       MEMORY_SCHEMA,
  assertionInterests: [],
};

function readCachedLineage(input: DataLineageInput, deps: SkillDeps): DataLineageOutput | undefined {
  const slot = deps.context?.slots.get('cached-lineage');
  if (slot === undefined || slot.length === 0) { return undefined; }
  const hit = slot[0] as MemoryEntry<DataLineageOutput>;
  if (hit.value === undefined) { return undefined; }
  if (hit.key !== cacheKey(input)) { return undefined; }
  return hit.value;
}

function pinLineage(input: DataLineageInput, value: DataLineageOutput, deps: SkillDeps): void {
  if (deps.workingState === undefined) { return; }
  const ref = deps.workingState.append({
    source:  { kind: 'tool', toolId: 'data_lineage' },
    payload: value,
    claims:  [`lineage:${cacheKey(input)}`],
    confidence: 0.95,
  });
  deps.workingState.pin(ref, {
    owner:     OWNER_ID,
    namespace: NAMESPACE,
    key:       cacheKey(input),
    kind:      'fact',
    ttlMs:     TTL_MS,
  });
}

const skillWithSubstrate = { ...dataLineageSkill, ...substrateExtension };

export function registerDataLineageSkill(): void {
  registerSkill(skillWithSubstrate as unknown as Skill);
}
