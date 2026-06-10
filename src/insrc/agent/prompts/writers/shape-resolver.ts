/**
 * shape-resolver writer v1 -- migrated from
 * `agent/section-flow/shape-resolve.ts`'s SYSTEM_PROMPT + buildMessages.
 *
 * Behaviour-preserving migration: produces the SAME message array
 * the previous inline helper produced, sourced from composers
 * (anti-fabrication rules block, etc.) so future writers (build-
 * context, sketch, decide-next-step) can reuse the same blocks.
 *
 * The shape-resolver call STILL goes through the same Ollama path
 * with the same `submit_skill_args` tool; only the prompt
 * construction is refactored.
 *
 * String-equivalence test pins the migration in
 * `__tests__/shape-resolver-migration.test.ts`.
 */

import type { LLMMessage } from '../../../shared/types.js';
import { renderAntiFabricationRules } from '../composers/anti-fabrication.js';
import type { PromptWriter } from '../types.js';

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

export interface ShapeResolverWriterInput {
	readonly skillId:          string;
	readonly skillDescription: string;
	readonly objective:        string;
	readonly userQuestion:     string;
	readonly priorOutputs:     Readonly<Record<string, string>>;
	readonly contextBag:       Readonly<Record<string, unknown>>;
}

const PRIOR_OUTPUT_PREVIEW_CHARS = 1500;
const SUBMIT_ARGS_TOOL = 'submit_skill_args';

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT_PREFIX = [
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
].join('\n');

function buildSystemPrompt(): string {
	return SYSTEM_PROMPT_PREFIX + renderAntiFabricationRules();
}

// ---------------------------------------------------------------------------
// User prompt
// ---------------------------------------------------------------------------

function buildUserPrompt(input: ShapeResolverWriterInput): string {
	return [
		'## USER QUESTION',
		input.userQuestion.trim(),
		'',
		'## LEAF OBJECTIVE (what this skill invocation must accomplish)',
		input.objective.trim(),
		'',
		`## SKILL TO INVOKE: \`${input.skillId}\``,
		`Description: ${input.skillDescription}`,
		'',
		'## AVAILABLE PRIOR OUTPUTS',
		formatPriorOutputs(input.priorOutputs),
		'',
		'## SESSION CONTEXT',
		formatContextBag(input.contextBag),
		'',
		'## TASK',
		`Emit one \`${SUBMIT_ARGS_TOOL}\` tool_use block now. The \`input\` object MUST satisfy the skill schema (the tool definition above carries it verbatim). Pull wire data from the prior outputs as needed.`,
	].join('\n');
}

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
// Writer
// ---------------------------------------------------------------------------

export const shapeResolverWriterV1: PromptWriter<ShapeResolverWriterInput, readonly LLMMessage[]> = {
	id:      'shape-resolver',
	version: 1,
	tier:    'local',
	summary: 'Resolve `submit_skill_args` args for one skill invocation from prior outputs, anti-fabrication-strict.',

	build(input: ShapeResolverWriterInput): readonly LLMMessage[] {
		return [
			{ role: 'system', content: buildSystemPrompt() },
			{ role: 'user',   content: buildUserPrompt(input) },
		];
	},
};

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _buildSystemPromptForTest = buildSystemPrompt;
export const _buildUserPromptForTest   = buildUserPrompt;
export const _formatPriorOutputsForTest = formatPriorOutputs;
