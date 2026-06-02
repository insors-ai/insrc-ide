/**
 * code.answer-question -- L2 open-ended Q&A pilot.
 *
 * Per plans/skills/code/code.answer-question.md + plans/code-analyzer-
 * migration.md §"Phase 6" (replace writer + grounding-review pingpong
 * with L2 self-grounding).
 *
 * Flow:
 *   1. PLAN     -- callL1 code.meta.classify-question(question, repo)
 *      Returns candidates [{ skillId, goal, mustHaveScope, ... }] via A5.
 *   2. SCOPE    -- callL1 code.meta.select-scope(question, candidates, ...)
 *      Returns scoped invocations [{ skillId, args, resolvedScope }].
 *   3. DISPATCH -- for each scoped invocation, callL1(skillId, args).
 *      Each result auto-appends to the working state per the L2 runtime.
 *   4. DRAFT    -- one LLM tool-call with all evidence in the prompt.
 *      Tool: submit_answer({ sections: [{ title, body, citationRefs }] }).
 *   5. GROUND   -- map citationRefs to ledger entries; drop sections
 *      that don't ground (self-ground-flagged events).
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

const log = getLogger('skill.code.answer-question');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AnswerQuestionInput {
	readonly question:       string;
	readonly activeRepoPath: string;
	readonly scopeTier?:     'S' | 'M' | 'L' | 'XL';
	readonly repoMeta?: {
		readonly primaryLanguages?: readonly string[];
		readonly detectedOrms?:     readonly string[];
		readonly migrationTool?:    string;
	};
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

const INPUT_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		question:       { type: 'string', minLength: 1, maxLength: 4000 },
		activeRepoPath: { type: 'string', minLength: 1 },
		scopeTier:      { type: 'string', enum: ['S', 'M', 'L', 'XL'] },
		repoMeta: {
			type: 'object',
			properties: {
				primaryLanguages: { type: 'array', items: { type: 'string' } },
				detectedOrms:     { type: 'array', items: { type: 'string' } },
				migrationTool:    { type: 'string' },
			},
			additionalProperties: false,
		},
	},
	required: ['question', 'activeRepoPath'],
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
	maxSubCalls:    16,
	maxWallclockMs: 300_000,
	maxDepth:       3,
};

// ---------------------------------------------------------------------------
// Substrate-facing declarations (ownership only)
// ---------------------------------------------------------------------------

const OWNER_ID: OwnerId = 'skill:code.answer-question';
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

// ---------------------------------------------------------------------------
// Skill body
// ---------------------------------------------------------------------------

const skill: L2Skill<AnswerQuestionInput, AnswerOutput> = {
	id:          'code.answer-question',
	name:        'Code: answer a question',
	description: 'Open-ended Q&A pilot. Plans its own discovery via classify-question + select-scope, dispatches L1 sub-calls, drafts a section-shaped answer, self-grounds every claim against the working-state ledger.',
	family:      'meta',
	owner:       'code-analyzer',
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
			description: `answer-question: classify -> select-scope -> dispatch -> draft -> ground (question="${input.question.slice(0, 80)}")`,
			at:          Date.now(),
		});

		// 1. PLAN: callL1 classify-question.
		const repoCtx: Record<string, unknown> = { path: input.activeRepoPath };
		if (input.repoMeta?.primaryLanguages !== undefined && input.repoMeta.primaryLanguages.length > 0) {
			repoCtx['primaryLanguages'] = input.repoMeta.primaryLanguages;
		}
		if (input.repoMeta?.detectedOrms !== undefined && input.repoMeta.detectedOrms.length > 0) {
			repoCtx['detectedOrms'] = input.repoMeta.detectedOrms;
		}
		if (input.repoMeta?.migrationTool !== undefined && input.repoMeta.migrationTool.length > 0) {
			repoCtx['migrationTool'] = input.repoMeta.migrationTool;
		}

		let classifyResult: { value: ClassifyShape; confidence: 'high' | 'medium' | 'low' };
		try {
			classifyResult = await deps.callL1<unknown, ClassifyShape>(
				'code.meta.classify-question',
				{ question: input.question, repo: repoCtx },
			);
		} catch (err) {
			return shortcut(input,
				`classify-question failed: ${(err as Error).message}`,
				`classify-failed`);
		}

		const candidates = classifyResult.value?.candidates ?? [];
		const questionType = classifyResult.value?.questionType ?? 'free-form';

		if (candidates.length === 0) {
			return shortcut(input,
				'classify-question returned no candidates -- the question doesn\'t match any known skill family. ' +
					'Either the catalog is empty for this repo or the question doesn\'t fit code-analyzer scope.',
				'no-candidates', questionType);
		}

		// 2. SCOPE: callL1 select-scope.
		// NOTE: select-scope's input schema is additionalProperties: false
		// and does NOT declare `scopeTier` -- the tier hint stays inside
		// this L2 skill (used for sub-skill selection, not propagated to
		// select-scope, which reads `candidates[i].mustHaveScope` instead).
		let scopeResult: { value: SelectScopeShape; confidence: 'high' | 'medium' | 'low' };
		try {
			scopeResult = await deps.callL1<unknown, SelectScopeShape>(
				'code.meta.select-scope',
				{
					question: input.question,
					candidates,
					repo: repoCtx,
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
			// before any L1 sub-call fired. The "what we planned" lives
			// in classify's candidate list, but the typed contract for
			// AnswerOutput.dispatched is "skills that ran", not "skills
			// we considered" -- the plan doc is the source of truth.
			return shortcut(input,
				'select-scope returned no scoped invocations -- either every candidate was unresolvable or the question lacks the scope it needs.',
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
				log.warn({ skillId: inv.skillId, err: msg }, 'code.answer-question: sub-call failed');
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
			'code.answer-question returning',
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
			'You are answering a code question for a developer. Read the evidence below and emit',
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
			'   structured facts). Aim for 1-4 sections total.',
			'5. The first section should directly address the question; later sections add',
			'   supporting detail (call sites, related entities, quality observations, etc.).',
			'6. NEVER invent file paths, entity ids, or claims that aren\'t in the evidence.',
		].join('\n'),
	};

	const evidenceBlock = renderEvidence(input, dispatched, deps.workingState.list());

	const user: LLMMessage = {
		role: 'user',
		content: [
			`Question: ${input.question}`,
			`Active repo: ${input.activeRepoPath}`,
			'',
			'Evidence (each entry is identified by its `ref` -- use these refs in citationRefs):',
			evidenceBlock,
		].join('\n'),
	};

	// One-shot retry on no-tool-call. qwen3-coder honors toolChoice
	// best-effort -- occasionally returns plain text instead. The retry
	// re-issues the same prompt; usually that's enough to land the
	// tool_use block. Same pattern as classify-question's retry-once
	// on validation failure.
	let response = await deps.llm.complete([sys, user], {
		maxTokens:   3000,
		temperature: 0,
		tools:       [SUBMIT_TOOL],
		toolChoice:  { name: SUBMIT_TOOL_NAME },
	});

	let toolCall = response.toolCalls?.find(tc => tc.name === SUBMIT_TOOL_NAME);
	if (toolCall === undefined) {
		log.info({ stopReason: response.stopReason }, 'answer-question: LLM did not emit submit_answer on first pass; retrying');
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
			log.warn({ stopReason: response.stopReason }, 'answer-question: LLM did not emit submit_answer after retry');
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
		// title is optional in practice -- qwen3-coder sometimes omits
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
	// stays bounded.
	for (let i = 0; i < ledger.length; i++) {
		const entry = ledger[i]!;
		if (entry.source.kind !== 'sub-call') { continue; }
		const skillId = entry.source.skillId;
		const payload = entry.payload;
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
	readonly skillId:       string;
	readonly rationale?:    string;
	readonly goal?:         string;
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

export function registerCodeAnswerQuestionSkill(): void {
	registerL2Skill(skill as unknown as L2Skill);
}

// Test export.
export const _codeAnswerQuestionSkillForTest = skill;
