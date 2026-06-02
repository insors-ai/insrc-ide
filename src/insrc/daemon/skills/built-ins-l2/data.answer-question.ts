/**
 * data.answer-question -- L2 open-ended Q&A pilot for the data-analyzer.
 *
 * Mirrors `code.answer-question` (shipped P9; cutover P10; quality
 * fixes P11) but routed against the data-analyzer's meta-skills +
 * data-side L1 skill catalog. Replaces the legacy writer + grounding-
 * review pingpong (`data-analyzer/discovery-pipeline.ts` ->
 * `write-from-evidence.ts` -> `claim-grounding-reviewer.ts`) with
 * single-pass L2 self-grounding (A1).
 *
 * Flow:
 *   1. PLAN     -- callL1 data.meta.classify-question(question, connections)
 *      Returns candidates [{ skillId, goal, mustHaveScope, ... }] via A5.
 *   2. SCOPE    -- callL1 data.meta.select-scope(question, candidates, connections)
 *      Returns scoped invocations [{ skillId, args, resolvedScope }].
 *   3. DISPATCH -- for each scoped invocation, callL1(skillId, args).
 *      Each result auto-appends to the working state per the L2 runtime.
 *   4. DRAFT    -- one LLM tool-call with all evidence in the prompt.
 *      Tool: submit_answer({ sections: [{ title, body, citationRefs }] }).
 *   5. GROUND   -- map citationRefs to ledger entries; drop sections
 *      that don't ground (self-ground-flagged events).
 *
 * P11 fixes baked in from day 1:
 *   - Tool-call protocol on classify + select-scope (already in place
 *     on the data side -- the upgrade we mirrored to the code side in
 *     P11 originated here).
 *   - maxSubCalls: 32 (the post-P11 cloud-LLM target).
 *   - Compact rendering for the broad-context data L1 skills
 *     (`data.source.rdbms.list-tables`, `data.source.kv.list-namespaces`,
 *     `data.source.rdbms.list-indexes`) -- these produce per-connection
 *     listings that risk being reframed as per-table / per-namespace
 *     claims if dumped verbatim into the draft prompt.
 *   - Scope-discipline prompt rules: NEVER attribute connection-wide
 *     totals to a single table / namespace / file; no "Connection
 *     Context" / "Database Overview" tail sub-section padding.
 *
 * Per A6: deterministic-fake unit tests pin code-path coverage; the
 * live-local-LLM integration test (in ./__tests__/live/) pins the
 * actual judgment loop with structural assertions only.
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
	L2Skill,
	SkillBudget,
	SkillOutput,
} from '../l2/types.js';
import type { LedgerEntry } from '../../substrate/types.js';
import type { LLMMessage, ToolDefinition } from '../../../shared/types.js';

const log = getLogger('skill.data.answer-question');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConnectionInfo {
	readonly id:     string;
	readonly family: string;
	readonly kind?:  string;
	readonly label?: string;
	readonly path?:  string;
}

interface PriorContext {
	readonly repoPath?:    string;
	readonly sessionTags?: readonly string[];
}

interface AnswerQuestionInput {
	readonly question:      string;
	readonly connections:   readonly ConnectionInfo[];
	readonly priorContext?: PriorContext;
}

interface AnswerSection {
	readonly title:    string;
	readonly body:     string;
	readonly details?: unknown;
}

interface DispatchTrace {
	readonly skillId: string;
	readonly goal:    string;
}

interface AnswerOutput {
	readonly question:     string;
	readonly questionType: string;
	readonly sections:     readonly AnswerSection[];
	readonly dispatched:   readonly DispatchTrace[];
}

// ---------------------------------------------------------------------------
// JSON schemas
// ---------------------------------------------------------------------------

const CONNECTION_INFO_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		id:     { type: 'string' },
		family: { type: 'string' },
		kind:   { type: 'string' },
		label:  { type: 'string' },
		path:   { type: 'string' },
	},
	required: ['id', 'family'],
	additionalProperties: false,
};

const INPUT_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		question:    { type: 'string', minLength: 1, maxLength: 4000 },
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
};

const OUTPUT_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		evidence:   { type: 'array' },
		confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
		notes:      { type: 'array', items: { type: 'string' } },
	},
	required: ['value', 'evidence', 'confidence'],
};

const SUBMIT_TOOL_NAME = 'submit_answer';
const SUBMIT_TOOL_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		sections: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					title:        { type: 'string', minLength: 1, maxLength: 200 },
					body:         { type: 'string', minLength: 1, maxLength: 4000 },
					citationRefs: { type: 'array', items: { type: 'string' }, maxItems: 32 },
					details:      {},   // freeform structured payload (table rows etc.)
				},
				required: ['title', 'body', 'citationRefs'],
				additionalProperties: false,
			},
			minItems: 1,
			maxItems: 16,
		},
	},
	required: ['sections'],
	additionalProperties: false,
};

const DEFAULT_BUDGET: SkillBudget = {
	maxTokens:      80_000,
	// 32 sub-calls. Matches the post-P11 code-side default (bumped from
	// 16 after the 2026-06-02 Hadoop run tripped the cap on an XL-tier
	// section). Data sections likewise can expand to 8-14 scoped L1
	// calls when classify picks 4 candidates and select-scope unrolls
	// across multiple targets per candidate.
	maxSubCalls:    32,
	maxWallclockMs: 300_000,
	maxDepth:       3,
};

// ---------------------------------------------------------------------------
// Substrate-facing declarations (ownership only)
// ---------------------------------------------------------------------------

const OWNER_ID: OwnerId = 'skill:data.answer-question';
const INTERESTED_TRIGGERS: readonly BootstrapTriggerKind[] = ['repo-add', 'reindex', 'manual'];
const MEMORY_SCHEMA: readonly NamespaceSpec[] = [
	{
		namespace:   'observations',
		valueType:   'WorkspacePatternObservation',
		autoDistill: 'never',
		indexing:    { kind: 'never' },
		ttl:         '30d',
	},
];

// L1 skills that produce broad, per-connection listings whose
// payloads should render as one-line summaries (not full JSON) in the
// draft prompt. Same defensive pattern P11 added for
// `code.source.repo.describe`: keeps the LLM from lifting connection-
// wide counts and reframing them as per-table / per-namespace claims.
const BROAD_CONTEXT_SKILLS: ReadonlySet<string> = new Set([
	'data.source.rdbms.list-tables',
	'data.source.rdbms.list-indexes',
	'data.source.kv.list-namespaces',
]);

// ---------------------------------------------------------------------------
// Skill body
// ---------------------------------------------------------------------------

const skill: L2Skill<AnswerQuestionInput, AnswerOutput> = {
	id:          'data.answer-question',
	name:        'Data: answer a question',
	description: 'Open-ended Q&A pilot for the data-analyzer. Plans its own discovery via data.meta.classify-question + data.meta.select-scope, dispatches L1 data sub-calls, drafts a section-shaped answer, self-grounds every claim against the working-state ledger.',
	family:      'meta',
	owner:       'data-analyzer',
	version:     1,
	inputs:      INPUT_SCHEMA,
	outputs:     OUTPUT_SCHEMA,
	defaultBudget: DEFAULT_BUDGET,

	ownerId:            OWNER_ID,
	schemaVersion:      1,
	interestedTriggers: INTERESTED_TRIGGERS,
	memorySchema:       MEMORY_SCHEMA,

	async run(invocation, deps): Promise<SkillOutput<AnswerOutput>> {
		const { input } = invocation;

		deps.emit({
			kind:        'plan-step',
			description: `data.answer-question: classify -> select-scope -> dispatch -> draft -> ground (question="${input.question.slice(0, 80)}")`,
			at:          Date.now(),
		});

		// 1. PLAN: callL1 classify-question.
		const classifyInput: Record<string, unknown> = {
			question:    input.question,
			connections: input.connections,
		};
		if (input.priorContext !== undefined) {
			classifyInput['priorContext'] = input.priorContext;
		}

		let classifyResult: { value: ClassifyShape; confidence: 'high' | 'medium' | 'low' };
		try {
			classifyResult = await deps.callL1<unknown, ClassifyShape>(
				'data.meta.classify-question',
				classifyInput,
			);
		} catch (err) {
			return shortcut(input,
				`classify-question failed: ${(err as Error).message}`,
				'classify-failed');
		}

		const candidates = classifyResult.value?.candidates ?? [];
		const questionType = classifyResult.value?.questionType ?? 'free-form';

		if (candidates.length === 0) {
			return shortcut(input,
				'classify-question returned no candidates -- the question doesn\'t match any known data-analyzer skill family. ' +
					'Either the connection roster is empty / no compatible skills, or the question doesn\'t fit data-analyzer scope.',
				'no-candidates', questionType);
		}

		// 2. SCOPE: callL1 select-scope.
		// NOTE: select-scope's input schema is additionalProperties: false
		// and accepts ONLY { question, candidates, connections }. Per the
		// P11 scopeTier-leak fix on the code side, do NOT propagate
		// priorContext or other extras here -- it'll trip input
		// validation, the dispatch loop will see empty `scoped`, and
		// the section will degrade to the no-scoped shortcut.
		let scopeResult: { value: SelectScopeShape; confidence: 'high' | 'medium' | 'low' };
		try {
			scopeResult = await deps.callL1<unknown, SelectScopeShape>(
				'data.meta.select-scope',
				{
					question:    input.question,
					candidates,
					connections: input.connections,
				},
			);
		} catch (err) {
			return shortcut(input,
				`select-scope failed: ${(err as Error).message}`,
				'select-scope-failed', questionType);
		}

		const scoped = scopeResult.value?.scoped ?? [];
		if (scoped.length === 0) {
			// dispatched stays empty here: select-scope short-circuited
			// before any L1 sub-call fired. Matches the code-side
			// contract: `AnswerOutput.dispatched` is "skills that ran",
			// not "skills we considered".
			return shortcut(input,
				'select-scope returned no scoped invocations -- either every candidate was unresolvable against the connection roster or the question lacks the target/columns it needs.',
				'no-scoped', questionType);
		}

		// 3. DISPATCH: callL1 each scoped invocation. Sequential per
		//    CLAUDE.md no-parallel-LLM. Failures noted in the trace; we
		//    still produce a draft from the surviving evidence.
		const dispatched: DispatchTrace[] = [];
		const dispatchFailures: string[] = [];
		for (const inv of scoped) {
			const goal = candidates.find(c => c.skillId === inv.skillId)?.goal ?? '';
			try {
				await deps.callL1(inv.skillId, inv.args);
				dispatched.push({ skillId: inv.skillId, goal });
			} catch (err) {
				const msg = (err as Error).message ?? String(err);
				dispatchFailures.push(`${inv.skillId}: ${msg}`);
				log.warn({ skillId: inv.skillId, err: msg }, 'data.answer-question: sub-call failed');
			}
		}

		// 4. DRAFT.
		const draft = await draftViaLlm(deps, input, dispatched);

		// 5. GROUND.
		const grounded = groundSections(draft.sections, deps.workingState.list(), deps);

		// Build the output.
		const value: AnswerOutput = {
			question:     input.question,
			questionType,
			sections:     grounded.sections,
			dispatched,
		};

		const notes: string[] = [];
		if (dispatchFailures.length > 0) {
			notes.push(`${dispatchFailures.length} dispatch failure(s): ${dispatchFailures.slice(0, 3).join(' | ')}`);
		}
		if (!draft.draftedSuccessfully) {
			notes.push('LLM did not emit the structured submit_answer tool call');
		}
		if (grounded.dropped > 0) {
			notes.push(`${grounded.dropped} section(s) dropped: citationRefs did not resolve to ledger entries`);
		}

		const confidence: 'high' | 'medium' | 'low' = !draft.draftedSuccessfully
			? 'low'
			: grounded.sections.length === 0
				? 'low'
				: grounded.dropped === 0 && dispatchFailures.length === 0
					? 'high'
					: 'medium';

		log.info(
			{ skillId: skill.id, question: input.question.slice(0, 80), questionType,
			  candidates: candidates.length, scoped: scoped.length,
			  dispatched: dispatched.length, dispatchFailures: dispatchFailures.length,
			  sectionsEmitted: draft.sections.length, sectionsGrounded: grounded.sections.length,
			  confidence },
			'data.answer-question returning',
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
// Drafting
// ---------------------------------------------------------------------------

const SUBMIT_TOOL: ToolDefinition = {
	name:        SUBMIT_TOOL_NAME,
	description: 'Submit the structured answer: an ordered list of sections, each with a title, a markdown body, and an explicit list of citationRefs naming the ledger entries that support the claims in that section.',
	inputSchema: SUBMIT_TOOL_SCHEMA,
};

interface DraftResult {
	readonly sections: readonly DraftedSection[];
	readonly draftedSuccessfully: boolean;
}

interface DraftedSection {
	readonly title:        string;
	readonly body:         string;
	readonly citationRefs: readonly string[];
	readonly details?:     unknown;
}

async function draftViaLlm(
	deps:       L2Deps,
	input:      AnswerQuestionInput,
	dispatched: readonly DispatchTrace[],
): Promise<DraftResult> {
	const sys: LLMMessage = {
		role: 'system',
		content: [
			'You are answering a data question for an analyst. Read the evidence below and emit',
			`a tool_use block calling \`${SUBMIT_TOOL_NAME}\` with the structured payload.`,
			'',
			'Hard rules:',
			'1. EVERY section MUST include `citationRefs` -- a non-empty list of ledger',
			'   refs naming the evidence entries that support the claims in that section.',
			'2. Use ONLY refs from the evidence list below -- NEVER invent refs.',
			'3. If the evidence is insufficient to answer some part of the question, include',
			'   a section titled "Gap:" explaining WHAT cannot be answered + WHY. Even gap',
			'   sections need citationRefs (cite the evidence that DID arrive so the reader',
			'   sees what was actually inspected).',
			'4. Keep section bodies concise (markdown shape; bullet lists encouraged for',
			'   structured facts -- column lists, profile percentiles, etc.). Aim for 1-4',
			'   sections total.',
			'5. The first section should directly address the question; later sections add',
			'   supporting detail (column profiles, sample rows, quality observations, etc.).',
			'6. NEVER invent table names, column names, connection ids, paths, or counts',
			'   that aren\'t in the evidence.',
			'',
			'Scope discipline (do NOT violate -- the orchestrator stitches per-section drafts):',
			'7. CONNECTION-WIDE TOTALS (table lists, namespace lists, index inventories) come',
			'   from broad-context skills like `data.source.rdbms.list-tables`,',
			'   `data.source.kv.list-namespaces`, or `data.source.rdbms.list-indexes` and',
			'   describe the WHOLE connection (or the whole namespace), not your section topic.',
			'   NEVER reframe them as "in the orders table" / "in the user schema" / "across',
			'   the events stream" -- those phrasings require target-scoped evidence (e.g.,',
			'   from `data.source.rdbms.describe-table` or `data.source.kv.scan-keys`). If the',
			'   evidence ledger doesn\'t carry target-scoped counts, OMIT them rather than',
			'   misattributing the connection-wide numbers.',
			'8. Do NOT emit a "Connection Context", "Database Overview", "Schema Summary",',
			'   "Cluster Scale", or similar tail sub-section that just restates connection-',
			'   wide totals. The orchestrator already has a report-level header. Per-section',
			'   drafts that pad with a connection-summary recap are noise -- omit them outright.',
		].join('\n'),
	};

	const evidenceBlock = renderEvidence(input, dispatched, deps.workingState.list());

	const user: LLMMessage = {
		role: 'user',
		content: [
			`Question: ${input.question}`,
			`Connections (${input.connections.length}): ${renderConnectionRoster(input.connections)}`,
			'',
			'Evidence (each entry is identified by its `ref` -- use these refs in citationRefs):',
			evidenceBlock,
		].join('\n'),
	};

	// One-shot retry on no-tool-call. Same defensive pattern as
	// code.answer-question -- cloud providers honor toolChoice
	// best-effort; the retry usually lands the tool_use block.
	let response = await deps.llm.complete([sys, user], {
		maxTokens:   3000,
		temperature: 0,
		tools:       [SUBMIT_TOOL],
		toolChoice:  { name: SUBMIT_TOOL_NAME },
	});

	let toolCall = response.toolCalls?.find(tc => tc.name === SUBMIT_TOOL_NAME);
	if (toolCall === undefined) {
		log.info({ stopReason: response.stopReason }, 'data.answer-question: LLM did not emit submit_answer on first pass; retrying');
		const retryUser: LLMMessage = {
			role: 'user',
			content: [
				user.content as string,
				'',
				`REMINDER: You MUST respond by calling the \`${SUBMIT_TOOL_NAME}\` tool. Do not reply with prose.`,
			].join('\n'),
		};
		response = await deps.llm.complete([sys, retryUser], {
			maxTokens:   3000,
			temperature: 0,
			tools:       [SUBMIT_TOOL],
			toolChoice:  { name: SUBMIT_TOOL_NAME },
		});
		toolCall = response.toolCalls?.find(tc => tc.name === SUBMIT_TOOL_NAME);
		if (toolCall === undefined) {
			log.warn({ stopReason: response.stopReason }, 'data.answer-question: LLM did not emit submit_answer after retry');
			return { sections: [], draftedSuccessfully: false };
		}
	}

	const callInput = toolCall.input as { sections?: unknown };
	const sectionsRaw = Array.isArray(callInput.sections) ? callInput.sections : [];
	const sections: DraftedSection[] = [];
	for (const s of sectionsRaw) {
		if (typeof s !== 'object' || s === null) { continue; }
		const o = s as Record<string, unknown>;
		const rawTitle = o['title'];
		const body  = o['body'];
		const refs  = o['citationRefs'];
		if (typeof body !== 'string' || !Array.isArray(refs)) { continue; }
		// title is optional in practice -- some models occasionally omit
		// it. Derive one from the first line of the body when missing.
		const title = typeof rawTitle === 'string' && rawTitle.length > 0
			? rawTitle
			: deriveTitle(body);
		const refStrings = refs.filter((r): r is string => typeof r === 'string');
		const draftedSection: DraftedSection = {
			title,
			body,
			citationRefs: refStrings,
			...(o['details'] !== undefined ? { details: o['details'] } : {}),
		};
		sections.push(draftedSection);
	}

	return { sections, draftedSuccessfully: true };
}

function renderConnectionRoster(connections: readonly ConnectionInfo[]): string {
	if (connections.length === 0) { return '(no connections registered)'; }
	return connections
		.slice(0, 8)
		.map(c => {
			const labelPart = c.label !== undefined ? ` "${c.label}"` : '';
			const kindPart  = c.kind  !== undefined ? `/${c.kind}` : '';
			return `${c.id} [${c.family}${kindPart}]${labelPart}`;
		})
		.join(', ') + (connections.length > 8 ? ` (+${connections.length - 8} more)` : '');
}

function renderEvidence(
	_input:     AnswerQuestionInput,
	dispatched: readonly DispatchTrace[],
	ledger:     readonly LedgerEntry<unknown>[],
): string {
	const lines: string[] = [];

	// Sub-call dispatch trace (skill ids + goals) helps the model
	// understand why each entry exists.
	if (dispatched.length > 0) {
		lines.push('Dispatch plan (which skills ran with which goals):');
		for (const d of dispatched) {
			lines.push(`  - ${d.skillId} :: ${d.goal}`);
		}
		lines.push('');
	}

	// Each ledger entry inline. Truncate large payloads so the prompt
	// stays bounded. Special-case the broad-context per-connection
	// listing skills: render as a compact one-line summary instead of
	// the full JSON, so the LLM is less tempted to lift those numbers
	// into a section-scoped claim (P11 misattribution pattern).
	for (let i = 0; i < ledger.length; i++) {
		const entry = ledger[i]!;
		if (entry.source.kind !== 'sub-call') { continue; }
		const skillId = entry.source.skillId;
		const payload = entry.payload;
		if (BROAD_CONTEXT_SKILLS.has(skillId)) {
			lines.push(`### ref=\`${entry.ref}\` from \`${skillId}\` (CONNECTION-WIDE -- do NOT attribute to a section topic)`);
			lines.push(renderBroadContextCompact(skillId, payload));
			lines.push('');
			continue;
		}
		const rendered = renderPayload(payload, 1500);
		lines.push(`### ref=\`${entry.ref}\` from \`${skillId}\``);
		lines.push(rendered);
		lines.push('');
	}

	if (lines.length === 0) {
		lines.push('(no evidence gathered)');
	}

	return lines.join('\n');
}

/**
 * Render the broad-context skill payloads (`list-tables`,
 * `list-namespaces`, `list-indexes`) as a single short summary line
 * instead of a multi-KB JSON listing. The LLM still gets the load-
 * bearing facts (count + a sample of names) but the reduced surface
 * area lowers the temptation to recite per-connection inventories as
 * if they were section-scoped findings.
 */
function renderBroadContextCompact(skillId: string, payload: unknown): string {
	if (typeof payload !== 'object' || payload === null) {
		return `(${skillId} payload unavailable)`;
	}
	const top = payload as Record<string, unknown>;
	// SkillResult shape: { value, confidence, ... }. Drill to value.
	const value = (top['value'] ?? top) as Record<string, unknown>;
	// The data L1 listing skills use varying field names; sniff the
	// common ones.
	const items =
		(Array.isArray(value['tables'])     && value['tables'])     ||
		(Array.isArray(value['namespaces']) && value['namespaces']) ||
		(Array.isArray(value['indexes'])    && value['indexes'])    ||
		(Array.isArray(value['items'])      && value['items'])      ||
		undefined;
	const itemKind = Array.isArray(value['tables'])
		? 'tables'
		: Array.isArray(value['namespaces'])
			? 'namespaces'
			: Array.isArray(value['indexes'])
				? 'indexes'
				: 'items';
	if (Array.isArray(items)) {
		const sample = items
			.slice(0, 6)
			.map(it => {
				if (typeof it === 'string') return it;
				if (typeof it === 'object' && it !== null) {
					const obj = it as Record<string, unknown>;
					const n = obj['name'] ?? obj['table'] ?? obj['id'];
					return typeof n === 'string' ? n : '?';
				}
				return '?';
			})
			.join(', ');
		const more = items.length > 6 ? ` (+${items.length - 6} more)` : '';
		return `Connection-wide listing (NOT section-scoped): ${items.length} ${itemKind}; sample: ${sample}${more}`;
	}
	return `(${skillId} payload empty or unrecognised shape)`;
}

function deriveTitle(body: string): string {
	const firstLine = body.split('\n', 1)[0]!.trim();
	const cleaned = firstLine.replace(/^[\s#\-*]+/, '').slice(0, 80);
	return cleaned.length > 0 ? cleaned : 'Answer';
}

function renderPayload(payload: unknown, maxChars: number): string {
	try {
		const text = JSON.stringify(payload, null, 2);
		if (text.length <= maxChars) { return text; }
		return text.slice(0, maxChars) + '\n... <truncated>';
	} catch {
		return '(unrenderable payload)';
	}
}

// ---------------------------------------------------------------------------
// Grounding
// ---------------------------------------------------------------------------

interface GroundingResult {
	readonly sections: readonly AnswerSection[];
	readonly evidence: readonly Evidence[];
	readonly dropped:  number;
}

function groundSections(
	sections: readonly DraftedSection[],
	ledger:   readonly LedgerEntry<unknown>[],
	deps:     L2Deps,
): GroundingResult {
	const knownRefs = new Set(ledger.map(e => e.ref));
	const grounded: AnswerSection[] = [];
	const evidence: Evidence[]      = [];
	let dropped = 0;

	for (const s of sections) {
		const validRefs = s.citationRefs.filter(r => knownRefs.has(r));
		if (validRefs.length === 0) {
			deps.emit({
				kind:  'self-ground-flagged',
				claim: s.title,
				at:    Date.now(),
			});
			dropped++;
			continue;
		}
		grounded.push({
			title: s.title,
			body:  s.body,
			...(s.details !== undefined ? { details: s.details } : {}),
		});
		evidence.push({ claim: s.title, citations: validRefs });
	}

	return { sections: grounded, evidence, dropped };
}

// ---------------------------------------------------------------------------
// Shortcut helper for early returns
// ---------------------------------------------------------------------------

function shortcut(
	input:        AnswerQuestionInput,
	reason:       string,
	noteTag:      string,
	questionType: string = 'free-form',
	dispatched:   readonly DispatchTrace[] = [],
): SkillOutput<AnswerOutput> {
	return {
		value: {
			question:    input.question,
			questionType,
			sections:    [],
			dispatched,
		},
		evidence:   [],
		confidence: 'low',
		notes:      [`early-exit: ${noteTag}: ${reason}`],
	};
}

// ---------------------------------------------------------------------------
// Sub-call payload shapes (loose; we don't enforce -- just type guards)
// ---------------------------------------------------------------------------

interface ClassifyCandidate {
	readonly skillId:        string;
	readonly rationale?:     string;
	readonly goal?:          string;
	readonly mustHaveScope?: string;
}

interface ClassifyShape {
	readonly questionType:     string;
	readonly candidates:       readonly ClassifyCandidate[];
	readonly fallbacks:        readonly string[];
	readonly uncertaintyNotes: readonly string[];
}

interface ScopedInvocation {
	readonly skillId:       string;
	readonly args:          Record<string, unknown>;
	readonly resolvedScope: Record<string, unknown>;
	readonly ambiguity?:    Record<string, unknown>;
}

interface SelectScopeShape {
	readonly scoped: readonly ScopedInvocation[];
	readonly notes:  readonly string[];
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerDataAnswerQuestionSkill(): void {
	registerL2Skill(skill as unknown as L2Skill);
}

// Test export.
export const _dataAnswerQuestionSkillForTest = skill;
