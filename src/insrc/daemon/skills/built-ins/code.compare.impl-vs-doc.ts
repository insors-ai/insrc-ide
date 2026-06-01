/**
 * code.compare.impl-vs-doc -- class implementation vs Markdown doc
 * (code-analyzer-skills.md Phase 4.2).
 *
 * Composite skill:
 *   1. Pull the class's actual fields via
 *      `code.class.extract-fields` (Phase 3.1).
 *   2. Read the doc file via the `file_read` tool.
 *   3. Parse markdown tables out of the doc; extract documented
 *      field names from the first column.
 *   4. Diff: { onlyInImpl, onlyInDoc, both }.
 *
 * The Markdown parser is intentionally simple: it scans for
 * pipe-delimited tables with a `| --- |` separator row, then
 * harvests the first non-empty cell of each data row as a field
 * name. The first column is canonical-by-convention -- our own
 * `data.synth.field-table` and Phase 6 renderers all use it. Code
 * fences are skipped to avoid harvesting from nested examples.
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

interface ImplVsDocInput {
	readonly className: string;
	readonly repoPath:  string;
	readonly docPath:   string;
}

type ImplVsDocOutput =
	| {
		readonly found:          true;
		readonly className:      string;
		readonly docPath:        string;
		readonly implFieldCount: number;
		readonly docFieldCount:  number;
		readonly onlyInImpl:     readonly string[];
		readonly onlyInDoc:      readonly string[];
		readonly both:           readonly string[];
		readonly drift:          boolean;
	}
	| {
		readonly found:  false;
		readonly reason: 'class-not-found' | 'doc-read-failed' | 'no-doc-tables';
		readonly nearest?: readonly { readonly className: string; readonly score: number }[];
	};

const skill: Skill<ImplVsDocInput, ImplVsDocOutput> = {
	id: 'code.compare.impl-vs-doc',
	name: 'Code: impl vs doc field-set drift',
	description:
		'Compare a class\'s actual fields (via code.class.extract-fields) to the documented fields ' +
		'parsed out of a Markdown doc file. Surfaces { onlyInImpl, onlyInDoc, both, drift } so ' +
		'callers can flag undocumented fields and stale doc rows.',
	family: 'comparison-diff',
	owner: 'code-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			className: { type: 'string' },
			repoPath:  { type: 'string' },
			docPath:   { type: 'string', description: 'Absolute path to the markdown doc.' },
		},
		required: ['className', 'repoPath', 'docPath'],
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
					found:          { type: 'boolean', enum: [true] },
					className:      { type: 'string' },
					docPath:        { type: 'string' },
					implFieldCount: { type: 'number' },
					docFieldCount:  { type: 'number' },
					onlyInImpl:     { type: 'array' },
					onlyInDoc:      { type: 'array' },
					both:           { type: 'array' },
					drift:          { type: 'boolean' },
				},
				required: ['found', 'className', 'docPath', 'implFieldCount', 'docFieldCount', 'onlyInImpl', 'onlyInDoc', 'both', 'drift'],
			},
			{
				type: 'object',
				properties: {
					found:   { type: 'boolean', enum: [false] },
					reason:  { type: 'string', enum: ['class-not-found', 'doc-read-failed', 'no-doc-tables'] },
					nearest: { type: 'array' },
				},
				required: ['found', 'reason'],
			},
		],
	},
	toolDeps:  ['file_read'],
	skillDeps: ['code.class.extract-fields'],
	providerAffinity: 'auto',
	preconditions: [
		{
			kind: 'required-tools',
			tools: ['file_read'],
			reason: 'doc body comes from the filesystem; without file_read the skill cannot read it',
		},
	],

	async execute(input: ImplVsDocInput, deps: SkillDeps): Promise<SkillResult<ImplVsDocOutput>> {
		// Substrate: cache hit short-circuits the field extract + file read.
		const cached = readCachedDrift(input, deps);
		if (cached !== undefined) {
			return {
				value: cached,
				confidence: 'high',
				notes: ['from cache (substrate)'],
				toolCalls: [],
			};
		}

		// Step 1: actual fields.
		const fields = await deps.runSkill<unknown, ExtractFields>('code.class.extract-fields', {
			className: input.className,
			repoPath:  input.repoPath,
		});
		if (!fields.value.found) {
			const refusal: ImplVsDocOutput = fields.value.nearest !== undefined
				? { found: false, reason: 'class-not-found', nearest: fields.value.nearest.map(n => ({ className: n.className, score: n.score })) }
				: { found: false, reason: 'class-not-found' };
			return {
				value: refusal,
				confidence: 'low',
				notes: [`Class '${input.className}' not found in the graph.`],
				toolCalls: [],
			};
		}

		const implFields = fields.value.fields ?? [];
		const implNames = new Set(implFields.map(f => f.name));

		// Step 2: read the doc.
		const fileResult = await deps.runTool({
			id:    `code-compare-impl-vs-doc:${Date.now()}`,
			name:  'file_read',
			input: { path: input.docPath },
		});
		if (fileResult.isError) {
			return {
				value: { found: false, reason: 'doc-read-failed' },
				confidence: 'low',
				notes: [`file_read failed: ${fileResult.content.slice(0, 200)}`],
				toolCalls: [],
			};
		}
		const docText = extractFileContent(fileResult);
		if (docText === null) {
			return {
				value: { found: false, reason: 'doc-read-failed' },
				confidence: 'low',
				notes: ['file_read returned a payload without parseable content.'],
				toolCalls: [],
			};
		}

		// Step 3: parse markdown tables.
		const docNames = new Set(parseMarkdownFirstColumns(docText));
		if (docNames.size === 0) {
			return {
				value: { found: false, reason: 'no-doc-tables' },
				confidence: 'low',
				notes: [`No markdown tables found in '${input.docPath}'. Documented fields are usually in a pipe-delimited table; if the doc uses a different format, drift can't be computed automatically.`],
				toolCalls: [],
			};
		}

		// Step 4: diff.
		const onlyInImpl: string[] = [];
		const onlyInDoc:  string[] = [];
		const both:       string[] = [];
		for (const n of implNames) {
			if (docNames.has(n)) both.push(n);
			else onlyInImpl.push(n);
		}
		for (const n of docNames) {
			if (!implNames.has(n)) onlyInDoc.push(n);
		}
		onlyInImpl.sort();
		onlyInDoc.sort();
		both.sort();

		const drift = onlyInImpl.length > 0 || onlyInDoc.length > 0;
		const out: ImplVsDocOutput = {
			found:          true,
			className:      input.className,
			docPath:        input.docPath,
			implFieldCount: implFields.length,
			docFieldCount:  docNames.size,
			onlyInImpl,
			onlyInDoc,
			both,
			drift,
		};
		pinDrift(input, out, deps);
		return {
			value: out,
			confidence: 'high',
			notes: drift
				? [`${onlyInImpl.length} undocumented impl field(s); ${onlyInDoc.length} stale doc field(s).`]
				: ['Implementation and doc field sets agree.'],
			toolCalls: [],
		};
	},
};

// ---------------------------------------------------------------------------
// Type guards / helpers
// ---------------------------------------------------------------------------

interface ExtractFields {
	readonly found:    boolean;
	readonly fields?:  readonly { readonly name: string }[];
	readonly nearest?: readonly { readonly className: string; readonly score: number }[];
}

function extractFileContent(toolResult: { content: string; data?: unknown }): string | null {
	// `file_read` exposes the raw text via `data.content` (preferred)
	// or fenced inside `content` markdown. Try data first.
	if (toolResult.data !== null && typeof toolResult.data === 'object') {
		const d = toolResult.data as Record<string, unknown>;
		if (typeof d['content'] === 'string') return d['content'];
		if (typeof d['text']    === 'string') return d['text'];
	}
	return toolResult.content.length > 0 ? toolResult.content : null;
}

/**
 * Parse markdown tables and return the first cell of every data row.
 * Skips:
 *   - rows inside fenced code blocks (```...```)
 *   - the table header + the `--- | ---` separator row
 *   - empty cells / cells composed only of `--`
 *
 * Returns lower-cased trimmed names; the caller's diff is name-only.
 */
export function parseMarkdownFirstColumns(text: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	let inFence = false;
	let pendingHeader = false;
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i]!;
		if (/^\s*```/.test(raw)) { inFence = !inFence; continue; }
		if (inFence) continue;

		const trimmed = raw.trim();
		if (!isTableRow(trimmed)) {
			pendingHeader = false;
			continue;
		}

		if (isSeparatorRow(trimmed)) {
			pendingHeader = false; // the row before us was the header; data rows follow
			continue;
		}

		if (pendingHeader) {
			// Two consecutive table rows without a separator means we're
			// in a misformatted block; treat both as data and emit names.
		}

		// Look ahead: if next non-blank line is a separator row, this is
		// the header -- skip.
		const nextLine = lines[i + 1]?.trim() ?? '';
		if (isSeparatorRow(nextLine)) {
			pendingHeader = true;
			continue;
		}

		const firstCell = firstCellOf(trimmed);
		if (firstCell.length > 0 && !seen.has(firstCell)) {
			seen.add(firstCell);
			out.push(firstCell);
		}
	}
	return out;
}

function isTableRow(line: string): boolean {
	return line.startsWith('|') && line.endsWith('|') && line.length >= 3;
}

function isSeparatorRow(line: string): boolean {
	if (!isTableRow(line)) return false;
	// `| --- | --- |` shape: every cell between pipes is dashes/colons/whitespace.
	const cells = line.slice(1, -1).split('|');
	return cells.length > 0 && cells.every(c => /^\s*:?-+:?\s*$/.test(c));
}

function firstCellOf(line: string): string {
	const cells = line.slice(1, -1).split('|');
	if (cells.length === 0) return '';
	const cell = cells[0]!.trim();
	// Strip backticks / bold markers / italics that decorate the name.
	const cleaned = cell.replace(/^`|`$|^\*\*|\*\*$|^_|_$/g, '').trim();
	if (cleaned === '' || /^-+$/.test(cleaned)) return '';
	return cleaned;
}

// ---------------------------------------------------------------------------
// Substrate-facing declarations (cache wiring)
// ---------------------------------------------------------------------------
//
// Drift between impl + doc shifts on either side: field edits, doc
// rewrites, repo reindex. 24h TTL matches the parent code.class.extract-
// fields cache rhythm; reindex triggers force a refresh sooner.

const OWNER_ID: OwnerId = 'skill:code.compare.impl-vs-doc';
const NAMESPACE = 'impl-vs-doc-drift';
const TTL_MS = 24 * 60 * 60 * 1000;
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['repo-add', 'reindex', 'manual'];

function cacheKey(input: ImplVsDocInput): string {
	return `${input.className}::${input.repoPath}::${input.docPath}`;
}

const CONTEXT_SLOTS: readonly ContextSlotRequest[] = [
	{
		name:      'cached-drift',
		fromOwner: OWNER_ID,
		namespace: NAMESPACE,
		query: (req) => {
			const task = (req.task ?? {}) as ImplVsDocInput;
			return { kind: 'byKey', key: cacheKey(task) };
		},
		limit: 1,
	},
];

const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   NAMESPACE,
		valueType:   'ImplVsDocOutput',
		autoDistill: 'always-on-success',
		indexing:    { kind: 'never' },
		ttl:         '24h',
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

function readCachedDrift(input: ImplVsDocInput, deps: SkillDeps): ImplVsDocOutput | undefined {
	const slot = deps.context?.slots.get('cached-drift');
	if (slot === undefined || slot.length === 0) { return undefined; }
	const hit = slot[0] as MemoryEntry<ImplVsDocOutput>;
	if (hit.value === undefined) { return undefined; }
	if (hit.key !== cacheKey(input)) { return undefined; }
	return hit.value;
}

function pinDrift(input: ImplVsDocInput, value: ImplVsDocOutput, deps: SkillDeps): void {
	if (deps.workingState === undefined) { return; }
	const ref = deps.workingState.append({
		source:  { kind: 'tool', toolId: 'file_read' },
		payload: value,
		claims:  [`impl-vs-doc:${cacheKey(input)}`],
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

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const skillWithSubstrate = { ...skill, ...substrateExtension };

export function registerCodeCompareImplVsDocSkill(): void {
	registerSkill(skillWithSubstrate as unknown as Skill);
}
