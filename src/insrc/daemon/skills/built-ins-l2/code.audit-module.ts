/**
 * code.audit-module -- L2 pilot skill.
 *
 * Per plans/skills/code/code.audit-module.md + plans/code-analyzer-
 * migration.md §"Pilot L2 skill" (strawman: `code.audit-module`
 * before `code.answer-question`).
 *
 * Flow (per the plan doc):
 *   1. Plan -- decide which L1 sub-calls to dispatch based on `focus`.
 *   2. Dispatch -- callL1 sub-calls sequentially; runtime auto-
 *      appends each result to the working-state ledger.
 *   3. Filter -- scope repo-wide quality reports to this module's files.
 *   4. Draft -- one LLM call with the gathered evidence + a tool-call
 *      schema. Model emits { findings, summary }.
 *   5. Ground -- map each finding back to a ledger entry. Drop any
 *      finding that can't ground; emit self-ground-flagged events.
 *   6. Return SkillOutput<AuditModuleOutput> with evidence + confidence.
 *
 * Per A6: the deterministic-fake unit tests pin code-path coverage;
 * the live-local-LLM integration test pins the actual judgment
 * loop (structural assertions only -- never exact prose).
 */

import { getLogger } from '../../../shared/logger.js';

import { registerL2Skill } from '../l2/registry.js';
import type {
	BootstrapTriggerKind,
	NamespaceSpec,
	OwnerId,
} from '../../substrate/types.js';
import type {
	Evidence,
	L2Deps,
	L2Invocation,
	L2Skill,
	SkillBudget,
	SkillOutput,
} from '../l2/types.js';
import type { LedgerEntry } from '../../substrate/types.js';
import type { SkillResult } from '../types.js';
import type { LLMMessage, ToolDefinition } from '../../../shared/types.js';

const log = getLogger('skill.code.audit-module');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Focus = 'complexity' | 'duplication' | 'unused-exports' | 'cyclic-deps' | 'all';

interface AuditModuleInput {
	readonly modulePath: string;
	readonly repoPath:   string;
	readonly focus?:     Focus;
}

type FindingKind = 'complexity' | 'duplication' | 'unused-export' | 'cyclic-dep' | 'note';
type Severity   = 'info' | 'warn' | 'high';

interface AuditFinding {
	readonly kind:      FindingKind;
	readonly severity:  Severity;
	readonly summary:   string;
	readonly file?:     string;
	readonly line?:     number;
	readonly entityId?: string;
}

interface AuditModuleOutput {
	readonly module: {
		readonly path:        string;
		readonly fileCount:   number;
		readonly entityCount: number;
		readonly publicCount: number;
	};
	readonly findings: readonly AuditFinding[];
	readonly summary:  string;
}

// ---------------------------------------------------------------------------
// JSON schemas
// ---------------------------------------------------------------------------

const INPUT_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		modulePath: { type: 'string', minLength: 1 },
		repoPath:   { type: 'string', minLength: 1 },
		focus:      { type: 'string', enum: ['complexity', 'duplication', 'unused-exports', 'cyclic-deps', 'all'] },
	},
	required: ['modulePath', 'repoPath'],
	additionalProperties: false,
};

const FINDING_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		kind:     { type: 'string', enum: ['complexity', 'duplication', 'unused-export', 'cyclic-dep', 'note'] },
		severity: { type: 'string', enum: ['info', 'warn', 'high'] },
		summary:  { type: 'string', minLength: 1, maxLength: 500 },
		file:     { type: 'string' },
		line:     { type: 'number' },
		entityId: { type: 'string' },
	},
	required: ['kind', 'severity', 'summary'],
	additionalProperties: false,
};

const OUTPUT_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		evidence: { type: 'array' },
		confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
		notes:    { type: 'array', items: { type: 'string' } },
	},
	required: ['value', 'evidence', 'confidence'],
};

// The LLM emits this tool-call payload; we lift `findings` + `summary` into
// the typed AuditModuleOutput after grounding.
const SUBMIT_TOOL_NAME = 'submit_audit';
const SUBMIT_TOOL_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		findings: { type: 'array', items: FINDING_SCHEMA, maxItems: 32 },
		summary:  { type: 'string', minLength: 1, maxLength: 2000 },
	},
	required: ['findings', 'summary'],
	additionalProperties: false,
};

const DEFAULT_BUDGET: SkillBudget = {
	maxTokens:      30_000,
	maxSubCalls:    8,
	maxWallclockMs: 60_000,
	maxDepth:       2,
};

// ---------------------------------------------------------------------------
// Substrate-facing declarations (ownership only -- see plan doc)
// ---------------------------------------------------------------------------

const OWNER_ID: OwnerId = 'skill:code.audit-module';
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['repo-add', 'reindex', 'manual'];
const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   'audits',
		valueType:   'AuditModuleOutput',
		autoDistill: 'on-pin',
		indexing:    { kind: 'never' },
		ttl:         '24h',
	},
	{
		namespace:   'observations',
		valueType:   'WorkspacePatternObservation',
		autoDistill: 'never',
		indexing:    { kind: 'never' },
		ttl:         '30d',
	},
];

// ---------------------------------------------------------------------------
// Skill
// ---------------------------------------------------------------------------

const skill: L2Skill<AuditModuleInput, AuditModuleOutput> = {
	id:          'code.audit-module',
	name:        'Code: audit one module',
	description: 'Audit one module: enumerate the surface, run scoped quality probes (complexity / duplication / unused exports / cyclic deps), draft findings with cited evidence. L2 pilot skill -- plans its own sub-calls, self-grounds against the working-state ledger.',
	family:      'quality-profile',
	owner:       'code-analyzer',
	version:     1,
	inputs:      INPUT_SCHEMA,
	outputs:     OUTPUT_SCHEMA,
	defaultBudget: DEFAULT_BUDGET,

	ownerId:            OWNER_ID,
	schemaVersion:      1,
	interestedTriggers: INTERESTED_TRIGGERS,
	memorySchema:       MEMORY_SCHEMA,

	async run(invocation, deps): Promise<SkillOutput<AuditModuleOutput>> {
		const { input } = invocation;
		const focus = input.focus ?? 'all';

		// 1. Plan.
		deps.emit({
			kind:        'plan-step',
			description: `audit module=${input.modulePath} focus=${focus}; will run describe + complexity${
				focus === 'all'         ? ' + duplication + unused-exports + cyclic-deps' :
				focus === 'duplication' ? ' + duplication' :
				focus === 'unused-exports' ? ' + unused-exports' :
				focus === 'cyclic-deps' ? ' + cyclic-deps' : ''
			}`,
			at: Date.now(),
		});

		// 2. Dispatch L1 sub-calls. Sequential per CLAUDE.md.
		const moduleResult = await deps.callL1<unknown, ModuleDescribeShape>(
			'code.source.module.describe',
			{ modulePath: input.modulePath, repoPath: input.repoPath },
		);
		const moduleData = isModuleFound(moduleResult.value) ? moduleResult.value : undefined;

		// If the module isn't found, return early with a single low-confidence note.
		if (moduleData === undefined) {
			return earlyExit(input, 'module-not-found', `module ${input.modulePath} not indexed`);
		}

		const complexityResult = await deps.callL1<unknown, ComplexityReport>(
			'code.quality.complexity',
			{ repoPath: input.repoPath },
		);

		let duplicationResult:    SkillResult<DuplicationReport>    | undefined;
		let unusedExportsResult:  SkillResult<UnusedExportsReport>  | undefined;
		let cyclicDepsResult:     SkillResult<CyclicDepsReport>     | undefined;

		if (focus === 'duplication' || focus === 'all') {
			duplicationResult = await deps.callL1<unknown, DuplicationReport>(
				'code.quality.duplication',
				{ repoPath: input.repoPath },
			);
		}
		if (focus === 'unused-exports' || focus === 'all') {
			unusedExportsResult = await deps.callL1<unknown, UnusedExportsReport>(
				'code.quality.unused-exports',
				{ repoPath: input.repoPath },
			);
		}
		if (focus === 'cyclic-deps' || focus === 'all') {
			cyclicDepsResult = await deps.callL1<unknown, CyclicDepsReport>(
				'code.quality.cyclic-deps',
				{ repoPath: input.repoPath },
			);
		}

		// 3. Filter: scope repo-wide quality reports to this module's files.
		const modulePrefix = input.modulePath.endsWith('/') ? input.modulePath : input.modulePath + '/';
		const moduleFiles  = new Set(moduleData.files.map(f => f.path));
		const isInModule   = (file: string): boolean => moduleFiles.has(file) || file.startsWith(modulePrefix);

		const scopedComplexity   = complexityResult.value.entries.filter(e => isInModule(e.file));
		const scopedDuplication  = duplicationResult?.value.pairs.filter(p => isInModule(p.a.file) || isInModule(p.b.file)) ?? [];
		const scopedUnused       = unusedExportsResult?.value.unused.filter(u => isInModule(u.file)) ?? [];
		const scopedCycles       = cyclicDepsResult?.value.cycles.filter(c =>
			c.nodes.some(n => isInModule(n.file))) ?? [];

		// 4. Draft via the LLM.
		const summaryFromLlm = await draftAuditViaLlm(
			deps,
			input.modulePath,
			moduleData,
			scopedComplexity,
			scopedDuplication,
			scopedUnused,
			scopedCycles,
		);

		// 5. Ground each LLM-emitted finding back to a ledger entry.
		const grounded = groundFindings(summaryFromLlm.findings, deps.workingState.list(), deps);

		// 6. Build the output.
		const value: AuditModuleOutput = {
			module: {
				path:        moduleData.modulePath,
				fileCount:   moduleData.fileCount,
				entityCount: moduleData.entityCount,
				publicCount: moduleData.publicCount,
			},
			findings: grounded.findings,
			summary:  summaryFromLlm.summary,
		};

		// Confidence ladder:
		//   - LLM failed to emit the structured tool call -> low.
		//   - Every emitted finding grounded cleanly -> high.
		//   - Some grounded, some dropped -> medium.
		//   - Nothing grounded but model tried -> low.
		const confidence: 'high' | 'medium' | 'low' = !summaryFromLlm.draftedSuccessfully
			? 'low'
			: grounded.dropped === 0
				? 'high'
				: grounded.findings.length > 0
					? 'medium'
					: 'low';

		const notes: string[] = [];
		if (!summaryFromLlm.draftedSuccessfully) {
			notes.push('LLM did not emit the structured submit_audit tool call');
		}
		if (grounded.dropped > 0) {
			notes.push(`${grounded.dropped} finding(s) dropped: no matching ledger entry to ground`);
		}

		log.info(
			{ skillId: skill.id, modulePath: input.modulePath, focus,
			  emitted: summaryFromLlm.findings.length, grounded: grounded.findings.length },
			'code.audit-module returning',
		);

		return {
			value,
			evidence:   grounded.evidence,
			confidence,
			...(notes.length > 0 ? { notes } : {}),
		};
	},
};

// ---------------------------------------------------------------------------
// LLM draft
// ---------------------------------------------------------------------------

const SUBMIT_TOOL: ToolDefinition = {
	name:        SUBMIT_TOOL_NAME,
	description: 'Submit the audit findings + a one-paragraph summary. EVERY finding MUST cite a file (and ideally a line + entityId) from the supplied evidence; never invent paths or entities.',
	inputSchema: SUBMIT_TOOL_SCHEMA,
};

interface DraftResult {
	readonly findings: readonly AuditFinding[];
	readonly summary:  string;
	/** True when the LLM successfully emitted the structured tool-call. */
	readonly draftedSuccessfully: boolean;
}

async function draftAuditViaLlm(
	deps:        L2Deps,
	modulePath:  string,
	moduleData:  ModuleFoundShape,
	complexity:  readonly ComplexityEntry[],
	duplication: readonly DupPair[],
	unused:      readonly UnusedEntry[],
	cycles:      readonly CycleShape[],
): Promise<DraftResult> {
	const sys: LLMMessage = {
		role: 'system',
		content: [
			'You are auditing one code module. Emit a tool_use block calling',
			`\`${SUBMIT_TOOL_NAME}\` with the structured payload.`,
			'',
			'Hard rules:',
			'1. EVERY finding MUST cite a file (and entityId/line when shown in the evidence below).',
			'   Never invent file paths or entityIds.',
			'2. Use `kind` = "complexity" for high cyclomatic functions / methods,',
			'   "duplication" for duplicate-pair candidates, "unused-export" for',
			'   the unused-exports list, "cyclic-dep" for import cycles, or',
			'   "note" for anything else worth flagging.',
			'3. Use `severity`: "info" for context, "warn" for medium-risk, "high"',
			'   for things the team should fix soon.',
			'4. Keep `summary` to one short paragraph (under 800 chars).',
			'   It should give the reader the module verdict at a glance.',
		].join('\n'),
	};

	const evidenceBlock = renderEvidence(modulePath, moduleData, complexity, duplication, unused, cycles);

	const user: LLMMessage = {
		role: 'user',
		content: evidenceBlock,
	};

	const response = await deps.llm.complete([sys, user], {
		maxTokens:   2000,
		temperature: 0,
		tools:       [SUBMIT_TOOL],
		toolChoice:  { name: SUBMIT_TOOL_NAME },
	});

	const toolCall = response.toolCalls?.find(tc => tc.name === SUBMIT_TOOL_NAME);
	if (toolCall === undefined) {
		log.warn({ stopReason: response.stopReason }, 'audit-module: LLM did not emit submit_audit tool call');
		return {
			findings: [],
			summary:  'No structured audit returned by the model.',
			draftedSuccessfully: false,
		};
	}

	const input = toolCall.input as { findings?: unknown; summary?: unknown };
	const findings = Array.isArray(input.findings)
		? (input.findings.filter(isFindingShape) as AuditFinding[])
		: [];
	const summary  = typeof input.summary === 'string' ? input.summary : '';

	return { findings, summary, draftedSuccessfully: true };
}

function renderEvidence(
	modulePath:  string,
	moduleData:  ModuleFoundShape,
	complexity:  readonly ComplexityEntry[],
	duplication: readonly DupPair[],
	unused:      readonly UnusedEntry[],
	cycles:      readonly CycleShape[],
): string {
	const lines: string[] = [
		`Module: ${modulePath}`,
		`fileCount=${moduleData.fileCount} entityCount=${moduleData.entityCount} publicCount=${moduleData.publicCount}`,
		'',
	];

	if (moduleData.publicSurface.length > 0) {
		lines.push('Public surface (truncated to 20):');
		for (const e of moduleData.publicSurface.slice(0, 20)) {
			lines.push(`  - ${e.kind} \`${e.name}\` (id=${e.id}) at ${e.file}:${e.startLine}`);
		}
		lines.push('');
	}

	if (complexity.length > 0) {
		lines.push(`Cyclomatic complexity (${complexity.length} scoped entries; top 20 by score):`);
		const top = complexity.slice().sort((a, b) => b.cyclomatic - a.cyclomatic).slice(0, 20);
		for (const e of top) {
			lines.push(`  - ${e.kind} \`${e.name}\` cyclomatic=${e.cyclomatic} level=${e.level} (id=${e.id}) at ${e.file}:${e.startLine}`);
		}
		lines.push('');
	}

	if (duplication.length > 0) {
		lines.push(`Duplication pairs (${duplication.length} scoped pairs; top 10 by similarity):`);
		const top = duplication.slice().sort((a, b) => b.similarity - a.similarity).slice(0, 10);
		for (const p of top) {
			lines.push(`  - \`${p.a.name}\` (${p.a.file}:${p.a.startLine}) <-> \`${p.b.name}\` (${p.b.file}:${p.b.startLine}) similarity=${p.similarity.toFixed(2)}`);
		}
		lines.push('');
	}

	if (unused.length > 0) {
		lines.push(`Unused exports (${unused.length} scoped):`);
		for (const u of unused.slice(0, 20)) {
			lines.push(`  - ${u.kind} \`${u.name}\` (id=${u.id}) at ${u.file}:${u.startLine}`);
		}
		lines.push('');
	}

	if (cycles.length > 0) {
		lines.push(`Import cycles (${cycles.length} touching this module):`);
		for (const c of cycles.slice(0, 10)) {
			lines.push(`  - size=${c.size}: ${c.nodes.map(n => n.file).join(' -> ')}`);
		}
		lines.push('');
	}

	if (complexity.length === 0 && duplication.length === 0 && unused.length === 0 && cycles.length === 0) {
		lines.push('No quality findings under the requested focus -- module appears clean.');
	}

	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Grounding
// ---------------------------------------------------------------------------

interface GroundingResult {
	readonly findings: readonly AuditFinding[];
	readonly evidence: readonly Evidence[];
	readonly dropped:  number;
}

function groundFindings(
	findings: readonly AuditFinding[],
	ledger:   readonly LedgerEntry<unknown>[],
	deps:     L2Deps,
): GroundingResult {
	const grounded: AuditFinding[] = [];
	const evidence: Evidence[]     = [];
	let dropped = 0;

	for (const f of findings) {
		const refs = matchingLedgerRefs(f, ledger);
		if (refs.length === 0) {
			deps.emit({
				kind:  'self-ground-flagged',
				claim: f.summary,
				at:    Date.now(),
			});
			dropped++;
			continue;
		}
		grounded.push(f);
		evidence.push({ claim: f.summary, citations: refs });
	}

	return { findings: grounded, evidence, dropped };
}

/**
 * Find ledger entries whose sub-call payload contains the finding's
 * file / entityId / line. We match liberally: file substring,
 * entityId equality, or "any entry from the relevant L1 skill".
 */
function matchingLedgerRefs(
	finding: AuditFinding,
	ledger:  readonly LedgerEntry<unknown>[],
): string[] {
	const refs: string[] = [];

	for (const entry of ledger) {
		const src = entry.source;
		if (src.kind !== 'sub-call') { continue; }

		const subSkillId = src.skillId;
		const payload    = entry.payload as { value?: unknown };
		const value      = payload?.value;

		if (matchesFinding(finding, subSkillId, value)) {
			refs.push(entry.ref);
		}
	}

	return refs;
}

function matchesFinding(finding: AuditFinding, subSkillId: string, value: unknown): boolean {
	if (typeof value !== 'object' || value === null) { return false; }
	const v = value as Record<string, unknown>;

	// File substring match against any 'entries' / 'pairs' / 'unused' / 'cycles' list.
	const fileToMatch = finding.file;
	const entityIdToMatch = finding.entityId;

	if (fileToMatch === undefined && entityIdToMatch === undefined) {
		// No locator -- match by skill family.
		return /^code\.(quality|source)\./.test(subSkillId);
	}

	// Walk the candidate lists each L1 quality skill returns.
	const rawLists: unknown[] = [
		v['entries'],
		v['unused'],
		v['files'],
		v['entities'],
		v['publicSurface'],
	];
	const lists: unknown[][] = rawLists.filter((l): l is unknown[] => Array.isArray(l));

	for (const list of lists) {
		for (const item of list) {
			if (typeof item !== 'object' || item === null) { continue; }
			const it = item as { id?: string; entityId?: string; file?: string; path?: string };
			if (entityIdToMatch !== undefined) {
				if (it.id === entityIdToMatch || it.entityId === entityIdToMatch) { return true; }
			}
			if (fileToMatch !== undefined) {
				if (it.file === fileToMatch || it.path === fileToMatch) { return true; }
			}
		}
	}

	// Duplication pairs have a/b sub-objects.
	const pairs = v['pairs'] as Array<{ a: { file: string }; b: { file: string } }> | undefined;
	if (Array.isArray(pairs) && fileToMatch !== undefined) {
		for (const p of pairs) {
			if (p.a?.file === fileToMatch || p.b?.file === fileToMatch) { return true; }
		}
	}

	// Cycles have nodes[].
	const cycles = v['cycles'] as Array<{ nodes: Array<{ file: string }> }> | undefined;
	if (Array.isArray(cycles) && fileToMatch !== undefined) {
		for (const c of cycles) {
			if (c.nodes?.some(n => n.file === fileToMatch)) { return true; }
		}
	}

	return false;
}

// ---------------------------------------------------------------------------
// Early exit helper
// ---------------------------------------------------------------------------

function earlyExit(
	input:   AuditModuleInput,
	reason:  string,
	detail:  string,
): SkillOutput<AuditModuleOutput> {
	return {
		value: {
			module:    { path: input.modulePath, fileCount: 0, entityCount: 0, publicCount: 0 },
			findings:  [],
			summary:   `Audit could not run: ${detail}`,
		},
		evidence:   [],
		confidence: 'low',
		notes:      [`early-exit: ${reason}: ${detail}`],
	};
}

// ---------------------------------------------------------------------------
// Type guards / sub-call value shapes
// ---------------------------------------------------------------------------

interface ModuleFoundShape {
	readonly found:        true;
	readonly modulePath:   string;
	readonly fileCount:    number;
	readonly entityCount:  number;
	readonly publicCount:  number;
	readonly files:        readonly { path: string; entityId: string }[];
	readonly publicSurface: readonly { id: string; name: string; kind: string; file: string; startLine: number }[];
}

type ModuleDescribeShape = ModuleFoundShape | { readonly found: false; readonly reason: string };

function isModuleFound(v: unknown): v is ModuleFoundShape {
	if (typeof v !== 'object' || v === null) { return false; }
	const o = v as { found?: unknown };
	return o.found === true;
}

interface ComplexityEntry {
	readonly id:         string;
	readonly name:       string;
	readonly kind:       string;
	readonly file:       string;
	readonly startLine:  number;
	readonly cyclomatic: number;
	readonly level:      'low' | 'medium' | 'high' | 'critical';
}

interface ComplexityReport {
	readonly entries: readonly ComplexityEntry[];
}

interface DupPair {
	readonly a: { id: string; name: string; file: string; startLine: number };
	readonly b: { id: string; name: string; file: string; startLine: number };
	readonly similarity: number;
}

interface DuplicationReport {
	readonly pairs: readonly DupPair[];
}

interface UnusedEntry {
	readonly id:        string;
	readonly name:      string;
	readonly kind:      string;
	readonly file:      string;
	readonly startLine: number;
}

interface UnusedExportsReport {
	readonly unused: readonly UnusedEntry[];
}

interface CycleShape {
	readonly size:  number;
	readonly nodes: readonly { id: string; file: string }[];
}

interface CyclicDepsReport {
	readonly cycles: readonly CycleShape[];
}

function isFindingShape(v: unknown): v is AuditFinding {
	if (typeof v !== 'object' || v === null) { return false; }
	const o = v as Record<string, unknown>;
	const kindOk     = typeof o['kind'] === 'string'
		&& ['complexity', 'duplication', 'unused-export', 'cyclic-dep', 'note'].includes(o['kind']);
	const sevOk      = typeof o['severity'] === 'string'
		&& ['info', 'warn', 'high'].includes(o['severity']);
	const summaryOk  = typeof o['summary'] === 'string' && (o['summary'] as string).length > 0;
	return kindOk && sevOk && summaryOk;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerCodeAuditModuleSkill(): void {
	registerL2Skill(skill as unknown as L2Skill);
}

// Test export.
export const _codeAuditModuleSkillForTest = skill;
