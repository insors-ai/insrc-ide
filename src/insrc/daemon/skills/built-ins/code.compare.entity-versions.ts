/**
 * code.compare.entity-versions -- diff one entity across two git
 * refs (code-analyzer-skills.md Phase 4.3).
 *
 * Composite skill:
 *   1. Pull the entity's HEAD-side location via
 *      `code.entity.summary` (file + startLine + endLine).
 *   2. Run `git_diff` scoped to that file between baseRef and
 *      headRef.
 *   3. Parse unified-diff hunks; keep hunks whose new-side
 *      `@@ -X,Y +A,B @@` window overlaps the entity's HEAD line
 *      range.
 *   4. Return the scoped hunks + insertion / deletion totals.
 *
 * Limitations (honest):
 *   - If the entity didn't exist at baseRef, the relevant range is
 *     a pure insertion -- we surface that hunk as-is, the caller
 *     interprets.
 *   - If the entity was renamed / moved between refs, line ranges
 *     drift and we may miss part of the change. v1 doesn't follow
 *     renames (`-M` / `-C`); a follow-up can add it.
 *   - Whole-file diffs > 2 MB get capped by git_diff itself; we
 *     surface the truncated flag from the underlying tool.
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

interface EntityVersionsInput {
	readonly entityId: string;
	readonly baseRef:  string;
	readonly headRef?: string;
}

interface ScopedHunk {
	readonly headerLine:  number;
	readonly headerCount: number;
	readonly body:        string;
	readonly insertions:  number;
	readonly deletions:   number;
}

type EntityVersionsOutput =
	| {
		readonly found:           true;
		readonly entityId:        string;
		readonly file:            string;
		readonly startLine:       number;
		readonly endLine:         number;
		readonly baseRef:         string;
		readonly headRef:         string;
		readonly hunks:           readonly ScopedHunk[];
		readonly totalInsertions: number;
		readonly totalDeletions:  number;
		readonly truncated:       boolean;
	}
	| {
		readonly found:  false;
		readonly reason: 'entity-not-found' | 'git-diff-failed';
	};

const skill: Skill<EntityVersionsInput, EntityVersionsOutput> = {
	id: 'code.compare.entity-versions',
	name: 'Code: diff one entity across two git refs',
	description:
		'Show what changed in a single entity between two git refs. Composes code.entity.summary ' +
		'(for the entity\'s HEAD line range) + git_diff (scoped to its file). Returns the unified-' +
		'diff hunks that overlap the entity\'s line range, plus insertion / deletion totals.',
	family: 'comparison-diff',
	owner: 'code-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			entityId: { type: 'string', minLength: 32, maxLength: 32 },
			baseRef:  { type: 'string', description: 'Older revision (commit SHA / branch / tag / "HEAD~3").' },
			headRef:  { type: 'string', description: 'Newer revision. Defaults to HEAD.' },
		},
		required: ['entityId', 'baseRef'],
		additionalProperties: false,
	},
	outputs: {
		type: 'object',
		properties: { found: { type: 'boolean' } },
		required: ['found'],
		oneOf: [
			{
				type: 'object',
				properties: {
					found:           { type: 'boolean', enum: [true] },
					entityId:        { type: 'string' },
					file:            { type: 'string' },
					startLine:       { type: 'number' },
					endLine:         { type: 'number' },
					baseRef:         { type: 'string' },
					headRef:         { type: 'string' },
					hunks:           { type: 'array' },
					totalInsertions: { type: 'number' },
					totalDeletions:  { type: 'number' },
					truncated:       { type: 'boolean' },
				},
				required: ['found', 'entityId', 'file', 'startLine', 'endLine', 'baseRef', 'headRef', 'hunks', 'totalInsertions', 'totalDeletions', 'truncated'],
			},
			{
				type: 'object',
				properties: {
					found:  { type: 'boolean', enum: [false] },
					reason: { type: 'string', enum: ['entity-not-found', 'git-diff-failed'] },
				},
				required: ['found', 'reason'],
			},
		],
	},
	toolDeps:  ['git_diff'],
	skillDeps: ['code.entity.summary'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['git_diff'],
			reason: 'historical comparison rides git_diff; without it the skill cannot fetch the change set',
		},
	],

	async execute(input: EntityVersionsInput, deps: SkillDeps): Promise<SkillResult<EntityVersionsOutput>> {
		const headRef = input.headRef ?? 'HEAD';

		// Substrate: cache hit short-circuits the summary + git_diff calls.
		const cached = readCachedDiff(input, deps);
		if (cached !== undefined) {
			const r: SkillResult<EntityVersionsOutput> = {
				value: cached,
				confidence: 'high',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
			return cached.found && cached.truncated ? { ...r, truncated: true } : r;
		}

		// Step 1: locate the entity at HEAD.
		const summary = await deps.runSkill<{ entityId: string }, EntitySummaryFound>('code.entity.summary', { entityId: input.entityId });
		if (!summary.value.found) {
			return {
				value: { found: false, reason: 'entity-not-found' },
				confidence: 'low',
				notes: [`Entity '${input.entityId}' not in the graph.`],
				toolCalls: [],
			};
		}
		const E = summary.value;

		// Step 2: git diff scoped to the entity's file.
		const diffResult = await deps.runTool({
			id:    `code-compare-entity-versions:${Date.now()}`,
			name:  'git_diff',
			input: { from: input.baseRef, to: headRef, path: E.file },
		});
		if (diffResult.isError) {
			return {
				value: { found: false, reason: 'git-diff-failed' },
				confidence: 'low',
				notes: [`git_diff failed: ${diffResult.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}

		const diffText  = extractDiffText(diffResult);
		const truncated = extractTruncated(diffResult);

		// Step 3: parse + scope.
		const hunks = parseHunks(diffText);
		const overlapping = hunks.filter(h => overlaps(h.headerLine, h.headerCount, E.startLine, E.endLine));

		const scoped: ScopedHunk[] = overlapping.map(h => ({
			headerLine:  h.headerLine,
			headerCount: h.headerCount,
			body:        h.body,
			insertions:  h.insertions,
			deletions:   h.deletions,
		}));

		const totalInsertions = scoped.reduce((acc, h) => acc + h.insertions, 0);
		const totalDeletions  = scoped.reduce((acc, h) => acc + h.deletions, 0);

		const out: EntityVersionsOutput = {
			found:     true,
			entityId:  input.entityId,
			file:      E.file,
			startLine: E.startLine,
			endLine:   E.endLine,
			baseRef:   input.baseRef,
			headRef,
			hunks:           scoped,
			totalInsertions,
			totalDeletions,
			truncated,
		};
		pinDiff(input, headRef, out, deps);
		const result: SkillResult<EntityVersionsOutput> = {
			value: out,
			confidence: 'high',
			notes: scoped.length === 0
				? [`No diff hunks overlap entity range ${E.startLine}-${E.endLine} in '${E.file}' between ${input.baseRef} and ${headRef}.`]
				: [],
			toolCalls: [],
		};
		return truncated ? { ...result, truncated: true } : result;
	},
};

// ---------------------------------------------------------------------------
// Hunk parsing
// ---------------------------------------------------------------------------

interface ParsedHunk {
	readonly headerLine:  number;
	readonly headerCount: number;
	readonly body:        string;
	readonly insertions:  number;
	readonly deletions:   number;
}

const HUNK_HEADER_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

export function parseHunks(diffText: string): ParsedHunk[] {
	const out: ParsedHunk[] = [];
	const lines = diffText.split('\n');

	let i = 0;
	while (i < lines.length) {
		const m = HUNK_HEADER_RE.exec(lines[i]!);
		if (m === null) { i++; continue; }

		const newStart = parseInt(m[3]!, 10);
		const newCount = m[4] !== undefined ? parseInt(m[4], 10) : 1;
		const headerLine  = newStart;
		const headerCount = newCount;
		const headerIdx = i;

		// Walk until the next hunk header or end of file.
		let body = lines[i]! + '\n';
		let insertions = 0;
		let deletions  = 0;
		i++;
		while (i < lines.length && !HUNK_HEADER_RE.test(lines[i]!) && !lines[i]!.startsWith('diff --git')) {
			const line = lines[i]!;
			body += line + '\n';
			if (line.startsWith('+') && !line.startsWith('+++')) insertions++;
			else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
			i++;
		}

		out.push({ headerLine, headerCount, body: body.trimEnd(), insertions, deletions });
		void headerIdx;
	}
	return out;
}

function overlaps(hunkStart: number, hunkCount: number, entityStart: number, entityEnd: number): boolean {
	const hunkEnd = hunkStart + Math.max(hunkCount - 1, 0);
	return hunkStart <= entityEnd && hunkEnd >= entityStart;
}

interface EntitySummaryFound {
	readonly found:     true;
	readonly file:      string;
	readonly startLine: number;
	readonly endLine:   number;
	readonly name:      string;
	readonly kind:      string;
	readonly language:  string;
}

function extractDiffText(toolResult: { content: string; data?: unknown }): string {
	if (toolResult.data !== null && typeof toolResult.data === 'object') {
		const d = toolResult.data as Record<string, unknown>;
		if (typeof d['diff'] === 'string') return d['diff'];
	}
	// Fall back to the rendered content; strip the markdown fence if any.
	const content = toolResult.content;
	const fenceMatch = /```(?:diff)?\n([\s\S]*?)\n```/.exec(content);
	return fenceMatch !== null ? fenceMatch[1]! : content;
}

function extractTruncated(toolResult: { data?: unknown }): boolean {
	if (toolResult.data !== null && typeof toolResult.data === 'object') {
		const d = toolResult.data as Record<string, unknown>;
		if (d['truncated'] === true) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------
//
// Git history between two refs is immutable once both refs exist, so
// the diff for (entityId, baseRef, headRef) never changes. 7d TTL is
// chosen for cache hygiene rather than correctness; longer would also
// be safe. Note that we key on the resolved `headRef` value (with the
// `HEAD` default already expanded) so that two invocations of the same
// effective comparison share the entry.

const OWNER_ID: OwnerId = 'skill:code.compare.entity-versions';
const NAMESPACE = 'entity-version-diffs';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['repo-add', 'reindex', 'manual'];

function cacheKey(entityId: string, baseRef: string, headRef: string): string {
	return `${entityId}::${baseRef}::${headRef}`;
}

function inputCacheKey(input: EntityVersionsInput): string {
	return cacheKey(input.entityId, input.baseRef, input.headRef ?? 'HEAD');
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-diff',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as EntityVersionsInput;
			return { kind: 'byKey', key: inputCacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'EntityVersionsOutput',
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

function readCachedDiff(input: EntityVersionsInput, deps: SkillDeps): EntityVersionsOutput | undefined {
	const slot = deps.context?.slots.get('cached-diff');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<EntityVersionsOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== inputCacheKey(input)) { return undefined; }
	return hit.value;
}

function pinDiff(input: EntityVersionsInput, headRef: string, value: EntityVersionsOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const key = cacheKey(input.entityId, input.baseRef, headRef);
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'git_diff' },
		payload: value,
		claims:  [`entity-version-diff:${key}`],
		confidence: 0.95,
	});
	deps.workingState.pin(ref, {
		owner:     OWNER_ID,
		namespace: NAMESPACE,
		key,
		kind:      'fact',
		ttlMs:     TTL_MS,
	});
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const skillWithSubstrate = { ...skill, ...substrateExtension };

export function registerCodeCompareEntityVersionsSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
