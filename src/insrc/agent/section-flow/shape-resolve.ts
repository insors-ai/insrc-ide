/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Per-leaf shape resolver -- the 2-step executor's first stage.
 *
 * Restores the design pattern from the deleted
 * `agent/tasks/data-analyzer/execute-step.ts` (commit b8650f67d60,
 * removed in P5.b.2's section-flow cutover). The section-planner
 * picks skill ids by id+description only -- it never sees the
 * skill's input schema. This module fills the gap: for each leaf,
 * make one focused LLM call that names the EXACT skill, inlines
 * the skill's `inputs` JSON Schema, and forces a single tool_use
 * block whose args satisfy that schema.
 *
 * The prompt surface the model sees:
 *   - Leaf objective (planner's natural-language intent)
 *   - User question (root scope context)
 *   - Skill id + description
 *   - Skill input schema (the authoritative target)
 *   - Available prior outputs (id -> truncated value), for the
 *     model to pull wire data from
 *   - Optional context bag keys (for context-source bindings)
 *
 * `tool_choice: { name: 'submit_skill_args' }` forces the model
 * onto a single tool_use block. On empty toolCalls or schema
 * violation, one corrective retry fires; second failure returns
 * a typed failure that the leaf executor surfaces upstream
 * (orchestrator treats it as a leaf invalid-input).
 */

import type { LLMMessage, LLMProvider, ToolDefinition } from '../../shared/types.js';
import { getSkill } from '../../daemon/skills/index.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('section-flow:shape-resolve');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const SUBMIT_ARGS_TOOL = 'submit_skill_args';

export interface ShapeResolveInput {
	readonly skillId:      string;
	/** Free-text intent for THIS leaf (planner's `leaf.objective` field). */
	readonly objective:    string;
	/** Map of `nodeId -> stringified prior output`. The model picks what it needs. */
	readonly priorOutputs: Readonly<Record<string, string>>;
	/** The user's original question. */
	readonly userQuestion: string;
	/** Caller-supplied context bag (for `context`-source bindings). */
	readonly contextBag:   Readonly<Record<string, unknown>>;
	readonly provider:     LLMProvider;
	/** Per-call max tokens. Default 1024 -- model only needs to emit one tool_use block. */
	readonly maxTokens?:   number | undefined;
}

export type ShapeResolveResult =
	| { kind: 'ok';     args: Record<string, unknown>; retried: boolean }
	| { kind: 'failed'; reason: string;                retried: boolean };

export async function resolveSkillShape(input: ShapeResolveInput): Promise<ShapeResolveResult> {
	const skill = getSkill(input.skillId);
	if (skill === undefined) {
		return { kind: 'failed', reason: `unknown skill id: ${input.skillId}`, retried: false };
	}

	const tool: ToolDefinition = {
		name:        SUBMIT_ARGS_TOOL,
		description: `Submit the args dict for invoking skill \`${input.skillId}\`. The args MUST satisfy the skill's input schema.`,
		inputSchema: skill.inputs as Record<string, unknown>,
	};

	const baseMessages = buildMessages(input, skill.description);
	const maxTokens    = input.maxTokens ?? 1024;

	// First attempt.
	const first = await callOnce(input.provider, baseMessages, tool, maxTokens);
	if (first.kind === 'ok') {
		const missingReq = checkRequired(first.args, skill.inputs as Record<string, unknown>);
		if (missingReq.length === 0) {
			return { kind: 'ok', args: first.args, retried: false };
		}
		log.warn({ skillId: input.skillId, missing: missingReq }, 'shape-resolve: first attempt missing required args; retrying');
		const retry = await callOnce(input.provider, withCorrection(baseMessages, `Missing required args: ${missingReq.join(', ')}. Re-emit submit_skill_args populating every required key for which AVAILABLE PRIOR OUTPUTS contains a literal value. If a required arg has no literal source in prior outputs, OMIT it -- do not fabricate. The orchestrator will treat the omission as a missing-prerequisite leaf failure and re-plan.`), tool, maxTokens);
		if (retry.kind === 'ok') {
			const stillMissing = checkRequired(retry.args, skill.inputs as Record<string, unknown>);
			if (stillMissing.length === 0) {
				return { kind: 'ok', args: retry.args, retried: true };
			}
			return { kind: 'failed', reason: `retry still missing required: ${stillMissing.join(', ')}`, retried: true };
		}
		return { kind: 'failed', reason: retry.reason, retried: true };
	}

	log.warn({ skillId: input.skillId, reason: first.reason }, 'shape-resolve: first attempt failed; retrying with corrective hint');
	const retry = await callOnce(input.provider, withCorrection(baseMessages, `Previous attempt failed: ${first.reason}. Emit ONE submit_skill_args tool_use block whose input matches the schema. If you skipped the tool_use because no required arg can be grounded, you may still emit submit_skill_args with the unfillable keys OMITTED (key absent from the JSON object). Do not fabricate values to make the call succeed.`), tool, maxTokens);
	if (retry.kind === 'ok') {
		const missingReq = checkRequired(retry.args, skill.inputs as Record<string, unknown>);
		if (missingReq.length === 0) {
			return { kind: 'ok', args: retry.args, retried: true };
		}
		return { kind: 'failed', reason: `retry missing required: ${missingReq.join(', ')}`, retried: true };
	}
	return { kind: 'failed', reason: retry.reason, retried: true };
}

// ---------------------------------------------------------------------------
// Single-call helper
// ---------------------------------------------------------------------------

type CallOutcome =
	| { kind: 'ok';     args: Record<string, unknown> }
	| { kind: 'failed'; reason: string };

async function callOnce(
	provider: LLMProvider,
	messages: LLMMessage[],
	tool:     ToolDefinition,
	maxTokens: number,
): Promise<CallOutcome> {
	let response;
	try {
		response = await provider.complete(messages, {
			maxTokens,
			temperature:     0,
			tools:           [tool],
			toolChoice:      { name: tool.name },
			disableThinking: true,
		});
	} catch (err) {
		return { kind: 'failed', reason: `provider error: ${(err as Error).message}` };
	}
	const calls = response.toolCalls ?? [];
	const call  = calls.find(c => c.name === tool.name);
	if (call === undefined) {
		return { kind: 'failed', reason: `no ${tool.name} tool_use block returned (got ${calls.length} calls)` };
	}
	if (typeof call.input !== 'object' || call.input === null || Array.isArray(call.input)) {
		return { kind: 'failed', reason: `${tool.name}.input was not a JSON object` };
	}
	return { kind: 'ok', args: call.input };
}

function withCorrection(base: LLMMessage[], hint: string): LLMMessage[] {
	return [
		...base,
		{ role: 'user', content: `## RETRY CORRECTION\n${hint}` },
	];
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
	'You are the SHAPE RESOLVER for one skill invocation in a section-flow',
	'investigation. The orchestrator has already chosen the skill; your',
	'job is to emit a SINGLE `submit_skill_args` tool_use block whose',
	'`input` matches the skill\'s declared input schema.',
	'',
	'Rules:',
	'  - Emit EXACTLY ONE `submit_skill_args` tool_use block. No prose.',
	'  - The `input` MUST be a JSON object satisfying the schema below.',
	'  - Consult the schema\'s `required` array; every required key MUST',
	'    be populated IF you can ground it (see anti-fabrication rules).',
	'  - Pull wire data from the AVAILABLE PRIOR OUTPUTS section -- those',
	'    are stringified results from earlier leaves in the same section.',
	'    Reference them by id and quote the relevant fields literally.',
	'  - When a prior output contains JSON, parse it mentally and use the',
	'    field values directly. When it is markdown, extract the relevant',
	'    facts as best you can.',
	'',
	'## ANTI-FABRICATION RULES (CRITICAL)',
	'',
	'  - NEVER invent identifier values. `entityId`, content hashes, file',
	'    paths, repo roots, line numbers, and exact class / field names',
	'    MUST appear verbatim in the AVAILABLE PRIOR OUTPUTS section.',
	'    Do not synthesize plausible-looking hex strings. Do not use a',
	'    class name (e.g. "INGRN") where the schema asks for a 32-char',
	'    hex entityId. Do not invent placeholder ids like `000...001`',
	'    or fresh hex from nowhere.',
	'',
	'  - Locate-first dependency: when an arg requires an entityId or any',
	'    other lookup-derived value and no prior output supplied it, you',
	'    are looking at a missing prerequisite, NOT an opportunity to',
	'    guess. The right move is to OMIT the unfillable arg from your',
	'    `input` (yes, even if it is in `required`). The orchestrator',
	'    will detect the gap, surface a leaf failure, and re-plan to',
	'    insert the missing locate-by-name / extract step. A hallucinated',
	'    value contaminates the investigation more than a missing one.',
	'',
	'  - "Omit" means the key is ABSENT from the JSON object. Do NOT emit',
	'    an empty string `""`, an empty array `[]`, null, "unknown",',
	'    "TBD", or any placeholder value to satisfy the type. The',
	'    downstream schema validator distinguishes "key missing" from',
	'    "key present with empty value" and only the former triggers the',
	'    correct re-plan behaviour.',
	'',
	'  - Structured array args (e.g. `classFields`, `dataShape`, `columns`)',
	'    must be lifted whole from ONE prior output that ACTUALLY PRODUCED',
	'    THAT EXACT KIND OF DATA. Critical anti-pattern: when the only',
	'    available prior output is a JSON data shape (from',
	'    `data.source.file.sample-shape` / `.describe`), you CANNOT use',
	'    it as `classFields`. Class fields come from',
	'    `code.class.extract-fields` calls; data shape comes from data',
	'    source calls. They describe different objects. Copying a data',
	'    shape into `classFields` -- even with matching `{name, type,',
	'    nullable}` keys -- is the canonical fabrication bug. The JSON',
	'    keys `grn_number`, `vendor_details`, `sku_details` are NOT',
	'    Pydantic field names; if a `code.class.extract-fields` prior',
	'    output is absent, OMIT `classFields`.',
	'',
	'  - On a RETRY CORRECTION asking for missing keys, populate them ONLY',
	'    from literal prior-output values. The instruction to "populate',
	'    every required key" never overrides the anti-fabrication rules.',
	'',
	'  - Empty `args: {}` is almost always wrong, BUT it is correct when',
	'    every required key requires fabrication -- omission beats',
	'    invention every time.',
	'',
	'## WORKED EXAMPLES (read carefully)',
	'',
	'Example A -- entityId IS in a prior output:',
	'  Prior output `locate`: `{"entityId":"b2097ef0ba38110e005d437d6b0c8442","name":"INGRN"}`',
	'  Schema requires `entityId` (32-hex), `scope` (optional).',
	'  CORRECT input: `{"entityId":"b2097ef0ba38110e005d437d6b0c8442"}`',
	'',
	'Example B -- entityId is NOT in any prior output:',
	'  Prior outputs contain only the class NAME "INGRN" and a file path,',
	'  no 32-char hex entityId anywhere.',
	'  Schema requires `entityId` (32-hex), `scope` (optional).',
	'  CORRECT input: `{}` -- the entityId key is ABSENT.',
	'  WRONG: `{"entityId":""}`     (empty string is still a value)',
	'  WRONG: `{"entityId":"INGRN"}` (class name is not a hex id)',
	'  WRONG: `{"entityId":"00000000000000000000000000000042"}` (placeholder hex)',
	'  WRONG: `{"entityId":"deadbeefdeadbeefdeadbeefdeadbeef"}` (fresh-from-nowhere hex)',
	'  The orchestrator will detect the missing entityId, surface a leaf',
	'  failure, and insert a `code.entity.locate-by-name` step on re-plan.',
	'',
	'Example C -- classFields with no extract-fields prior output:',
	'  Prior output `sample-shape` (from data.source.file.sample-shape):',
	'  `[{"path":"grn_number","type":"string"}, {"path":"vendor_details","type":"object"}]`',
	'  Schema requires `className`, `classFields`, `dataShape`.',
	'  CORRECT input: `{"className":"INGRN","dataShape":[...lift verbatim...]}`',
	'    -- `classFields` key is ABSENT because no code.class.extract-fields',
	'    output exists.',
	'  WRONG: `{"className":"INGRN","classFields":[{"name":"grn_number",...}],...}`',
	'    -- those are JSON keys masquerading as Pydantic class fields.',
	'  WRONG: `{"className":"INGRN","classFields":[],...}`',
	'    -- empty array is not omission.',
].join('\n');

function buildMessages(input: ShapeResolveInput, skillDescription: string): LLMMessage[] {
	const priorBlock = formatPriorOutputs(input.priorOutputs);
	const contextBlock = formatContextBag(input.contextBag);

	const user = [
		'## USER QUESTION',
		input.userQuestion.trim(),
		'',
		'## LEAF OBJECTIVE (what this skill invocation must accomplish)',
		input.objective.trim(),
		'',
		`## SKILL TO INVOKE: \`${input.skillId}\``,
		`Description: ${skillDescription}`,
		'',
		'## AVAILABLE PRIOR OUTPUTS',
		priorBlock,
		'',
		'## SESSION CONTEXT',
		contextBlock,
		'',
		'## TASK',
		`Emit one \`${SUBMIT_ARGS_TOOL}\` tool_use block now. The \`input\` object MUST satisfy the skill schema (the tool definition above carries it verbatim). Pull wire data from the prior outputs as needed.`,
	].join('\n');

	return [
		{ role: 'system', content: SYSTEM_PROMPT },
		{ role: 'user',   content: user },
	];
}

const PRIOR_OUTPUT_PREVIEW_CHARS = 1500;

function formatPriorOutputs(priorOutputs: Readonly<Record<string, string>>): string {
	const ids = Object.keys(priorOutputs);
	if (ids.length === 0) { return '(no prior outputs -- this is an early leaf)'; }
	const lines: string[] = [];
	for (const id of ids) {
		const raw = priorOutputs[id] ?? '';
		const preview = raw.length > PRIOR_OUTPUT_PREVIEW_CHARS
			? raw.slice(0, PRIOR_OUTPUT_PREVIEW_CHARS) + '\n  ...(truncated)'
			: raw;
		lines.push(`### \`${id}\``);
		lines.push('```');
		lines.push(preview);
		lines.push('```');
	}
	return lines.join('\n');
}

function formatContextBag(contextBag: Readonly<Record<string, unknown>>): string {
	const keys = Object.keys(contextBag);
	if (keys.length === 0) { return '(no session context surfaced)'; }
	const lines: string[] = [];
	for (const k of keys) {
		const v = contextBag[k];
		const s = typeof v === 'string' ? v : JSON.stringify(v);
		const preview = s.length > 200 ? s.slice(0, 200) + '...' : s;
		lines.push(`- ${k}: ${preview}`);
	}
	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Schema check
// ---------------------------------------------------------------------------

function checkRequired(args: Record<string, unknown>, schema: Record<string, unknown>): string[] {
	const required = schema['required'];
	if (!Array.isArray(required)) { return []; }
	const provided = new Set(Object.keys(args));
	return required.filter((r): r is string => typeof r === 'string' && !provided.has(r));
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _buildMessagesForTest      = buildMessages;
export const _checkRequiredForTest      = checkRequired;
export const _formatPriorOutputsForTest = formatPriorOutputs;
export const SUBMIT_ARGS_TOOL_NAME      = SUBMIT_ARGS_TOOL;
