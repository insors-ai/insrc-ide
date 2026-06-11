/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 3 of plans/section-flow-architecture-redesign.md.
 *
 * `runBuildContext` runs ONE local-tier LLM turn that decides which
 * artifact ids the shape-resolver needs in `priorOutputs` before it can
 * resolve the active skill's args. The orchestrator then fetches each
 * named artifact (via `getArtifactById`) and merges them into the
 * shape-resolver's prior-output map.
 *
 * Validation:
 *
 *   - Response MUST parse as `{ "fetch": string[], "notes": string }`.
 *   - Every id in `fetch` MUST appear in the supplied TOC entry set
 *     (`tocIds`). Unknown ids are rejected.
 *   - `fetch` may be empty -- the step has no artifact dependency.
 *
 * Retry: one corrective hint on validation failure. Second failure
 * falls back to `fetch: []` (graceful degrade per the plan -- forward
 * progress isn't blocked when build-context misfires).
 *
 * The artifact fetch + merge happens in the caller (Phase 3 batch 3.2's
 * leaf-executor integration), not here. This module's job is the LLM
 * turn + validation.
 */

import type {
	ContentBlock,
	LLMMessage,
	LLMProvider,
	ToolDefinition,
} from '../../shared/types.js';
import type { LocalMemoryView } from '../working-memory/index.js';
import type { BuildContextWriterInput } from '../prompts/writers/build-context.js';
import type { SkillRunnerDeps } from '../../daemon/skills/invoke.js';
import { runSkill } from '../../daemon/skills/invoke.js';
import { getSkill } from '../../daemon/skills/index.js';
import { getPromptRegistry } from '../prompts/registry.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('section-flow:build-context');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BuildContextInput {
	readonly stepIntent:       string;
	readonly skillId:          string;
	readonly skillDescription: string;
	/** JSON-schema text for the skill's input shape (already stringified). */
	readonly skillSchema:      string;
	readonly todoObjective:    string;
	/** Pre-rendered TOC text (from `renderToc(buildToc(sessionId))`). */
	readonly toc:              string;
	/**
	 * Valid artifact ids. The validator rejects any `fetch` entry whose
	 * value isn't in this set. Build by enumerating the same TOC entries
	 * the writer rendered.
	 */
	readonly tocIds:           ReadonlySet<string>;
	readonly memory?:          LocalMemoryView | undefined;
	/**
	 * Absolute path to the workspace root (typically `session.repoPath`).
	 * Surfaced verbatim in the prompt so the LLM constructs full
	 * absolute paths instead of guessing suffixes (live-run fix).
	 */
	readonly workspaceRoot?:   string | undefined;
	/** Local-tier LLM provider (Ollama). */
	readonly provider:         LLMProvider;
	/**
	 * When supplied, the build-context turn gets read-only tool access
	 * to `shared.fs.list-files` and `shared.fs.peek` (Phase 3 of
	 * plans/section-flow-architecture-redesign.md). The LLM can call
	 * either tool BEFORE emitting its JSON when the TOC lacks what the
	 * step needs and the answer lives in an unindexed file on disk.
	 * Each tool call runs through `runSkill`, which (via the production
	 * spill-writer onSkillEnd hook) persists the output as a NEW
	 * artifact_vec row -- the fetched output becomes reusable.
	 *
	 * When `undefined`, the build-context turn runs single-shot (no
	 * tools); the legacy path most unit tests exercise.
	 */
	readonly runnerDeps?:      SkillRunnerDeps | undefined;
}

export interface BuildContextResult {
	/** Artifact ids the LLM asked the orchestrator to fetch. May be empty. */
	readonly fetchIds: readonly string[];
	/** LLM-supplied 1-sentence justification. Logged for telemetry. */
	readonly notes:    string;
	/** True when the validator triggered the corrective-hint retry. */
	readonly retried:  boolean;
	/**
	 * True when both attempts failed validation and the result fell back
	 * to `fetchIds: []`. The orchestrator's shape-resolver still runs;
	 * forward progress is preserved.
	 */
	readonly gracefulDegrade: boolean;
	/** First-attempt failure reason, when set. Useful for telemetry. */
	readonly firstFailureReason?: string | undefined;
}

const MAX_TOKENS = 1024;
/**
 * Hard cap on accepted `fetch` length. The LLM's tendency on retries is
 * to fetch everything in the TOC -- the cap forces selectivity. Eight
 * is the largest reasonable working set per the writer's prompt rule.
 */
const MAX_FETCH = 8;

export async function runBuildContext(input: BuildContextInput): Promise<BuildContextResult> {
	const first = await callBuildContext(input, false, undefined);
	const firstParsed = validate(first, input.tocIds);
	if (firstParsed.ok) {
		log.info({
			skillId: input.skillId, stepIntent: input.stepIntent.slice(0, 80),
			fetchCount: firstParsed.fetchIds.length,
			tocSize: input.tocIds.size,
		}, 'build-context: first-attempt validated');
		return {
			fetchIds: firstParsed.fetchIds,
			notes:    firstParsed.notes,
			retried:  false,
			gracefulDegrade: false,
		};
	}

	log.warn({
		skillId: input.skillId, stepIntent: input.stepIntent.slice(0, 80),
		reason: firstParsed.reason,
	}, 'build-context: first-attempt rejected; retrying with corrective hint');

	const retry = await callBuildContext(input, true, firstParsed.reason);
	const retryParsed = validate(retry, input.tocIds);
	if (retryParsed.ok) {
		log.info({
			skillId: input.skillId, fetchCount: retryParsed.fetchIds.length,
		}, 'build-context: retry validated');
		return {
			fetchIds: retryParsed.fetchIds,
			notes:    retryParsed.notes,
			retried:  true,
			gracefulDegrade: false,
			firstFailureReason: firstParsed.reason,
		};
	}

	log.warn({
		skillId: input.skillId,
		reason: retryParsed.reason,
		firstFailureReason: firstParsed.reason,
	}, 'build-context: retry also rejected -> graceful degrade (fetch: [])');
	return {
		fetchIds:        [],
		notes:           '(build-context fell back to fetch:[] -- both attempts failed validation)',
		retried:         true,
		gracefulDegrade: true,
		firstFailureReason: firstParsed.reason,
	};
}

// ---------------------------------------------------------------------------
// LLM call (with optional fs.* tool loop)
// ---------------------------------------------------------------------------

/** Names of the read-only tools the build-context LLM may call. */
const FS_TOOL_IDS = ['shared.fs.list-files', 'shared.fs.peek'] as const;

/** Cap on tool-call iterations per attempt. The plan-mandated read-only
 *  tools are inexpensive, but each call's output spills as a new artifact
 *  -- cap keeps the artifact store from ballooning on a runaway LLM. */
const MAX_TOOL_ITERATIONS = 2;

async function callBuildContext(
	input:              BuildContextInput,
	isRetry:            boolean,
	priorFailureReason: string | undefined,
): Promise<string> {
	const writer = getPromptRegistry().get<BuildContextWriterInput, readonly LLMMessage[]>('build-context');
	const messages: LLMMessage[] = [...writer.build({
		stepIntent:         input.stepIntent,
		skillId:            input.skillId,
		skillDescription:   input.skillDescription,
		skillSchema:        input.skillSchema,
		todoObjective:      input.todoObjective,
		toc:                input.toc,
		workspaceRoot:      input.workspaceRoot,
		memory:             input.memory,
		isRetry,
		priorFailureReason,
	})];

	const tools = input.runnerDeps !== undefined ? buildFsTools() : undefined;

	for (let iter = 0; iter < MAX_TOOL_ITERATIONS + 1; iter++) {
		const response = await input.provider.complete(messages, {
			maxTokens:       MAX_TOKENS,
			temperature:     0,
			responseFormat:  'json',
			disableThinking: true,
			...(tools !== undefined ? { tools } : {}),
		});
		const calls = response.toolCalls ?? [];
		if (calls.length === 0 || tools === undefined) {
			// No tool calls -> final JSON answer.
			return response.text;
		}
		if (iter === MAX_TOOL_ITERATIONS) {
			log.warn({
				skillId: input.skillId,
				toolIterations: iter,
				suppressedCallCount: calls.length,
			}, 'build-context: tool-iteration cap reached; ignoring further calls and treating response as final');
			return response.text;
		}
		// Run each tool call via runSkill. The production runner's
		// onSkillEnd is the spill-writer -- each output lands as a new
		// artifact_vec row automatically.
		const toolUseBlocks: ContentBlock[] = [];
		const toolResultBlocks: ContentBlock[] = [];
		for (const tc of calls) {
			if (!isAllowedFsTool(tc.name)) {
				log.warn({ skillId: input.skillId, toolName: tc.name }, 'build-context: ignoring disallowed tool call');
				toolUseBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
				toolResultBlocks.push({
					type:        'tool_result',
					tool_use_id: tc.id,
					content:     `Error: tool "${tc.name}" is not available in this turn. Allowed: ${FS_TOOL_IDS.join(', ')}.`,
					isError:     true,
				});
				continue;
			}
			toolUseBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
			try {
				const result = await runSkill(tc.name, tc.input, input.runnerDeps!);
				const rendered = stringifyToolValue(result.value);
				toolResultBlocks.push({
					type:        'tool_result',
					tool_use_id: tc.id,
					content:     rendered,
				});
			} catch (err) {
				toolResultBlocks.push({
					type:        'tool_result',
					tool_use_id: tc.id,
					content:     `Error: ${(err as Error).message}`,
					isError:     true,
				});
			}
		}
		messages.push({ role: 'assistant', content: toolUseBlocks });
		messages.push({ role: 'user',      content: toolResultBlocks });
	}
	// Loop exit without return is impossible (the `iter === MAX` branch
	// returns response.text); satisfy the type system.
	return '';
}

/**
 * Build the `ToolDefinition` list the build-context LLM receives. Pulls
 * each skill's `inputs` schema + description from the registry so the
 * tool surface stays in sync with what `runSkill` accepts.
 */
function buildFsTools(): ToolDefinition[] {
	const tools: ToolDefinition[] = [];
	for (const id of FS_TOOL_IDS) {
		const skill = getSkill(id);
		if (skill === undefined) {
			log.warn({ skillId: id }, 'build-context: skill not in registry; tool unavailable for this turn');
			continue;
		}
		tools.push({
			name:        skill.id,
			description: skill.description,
			inputSchema: skill.inputs,
		});
	}
	return tools;
}

function isAllowedFsTool(name: string): name is typeof FS_TOOL_IDS[number] {
	return (FS_TOOL_IDS as readonly string[]).includes(name);
}

function stringifyToolValue(value: unknown): string {
	if (typeof value === 'string') { return value; }
	if (value === undefined || value === null) { return ''; }
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface ValidationOk {
	readonly ok:       true;
	readonly fetchIds: readonly string[];
	readonly notes:    string;
}

interface ValidationErr {
	readonly ok:     false;
	readonly reason: string;
}

type ValidationResult = ValidationOk | ValidationErr;

export function validate(raw: string, tocIds: ReadonlySet<string>): ValidationResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripFences(raw));
	} catch (err) {
		return { ok: false, reason: `JSON parse failed: ${(err as Error).message}` };
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { ok: false, reason: 'response is not a JSON object' };
	}
	const obj = parsed as Record<string, unknown>;

	const fetchRaw = obj['fetch'];
	if (!Array.isArray(fetchRaw)) {
		return { ok: false, reason: '`fetch` must be an array of artifact ids' };
	}
	if (fetchRaw.length > MAX_FETCH) {
		return { ok: false, reason: `\`fetch\` has ${fetchRaw.length} entries; cap is ${MAX_FETCH}` };
	}
	const fetchIds: string[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < fetchRaw.length; i++) {
		const v = fetchRaw[i];
		if (typeof v !== 'string' || v.trim().length === 0) {
			return { ok: false, reason: `fetch[${i}] is not a non-empty string` };
		}
		const id = v.trim();
		if (!tocIds.has(id)) {
			const sample = [...tocIds].slice(0, 5).join(', ');
			return {
				ok: false,
				reason: `fetch[${i}] "${id}" is not in the TOC (valid ids start with: ${sample}${tocIds.size > 5 ? ', ...' : ''})`,
			};
		}
		if (seen.has(id)) { continue; }
		seen.add(id);
		fetchIds.push(id);
	}

	const notesRaw = obj['notes'];
	const notes = typeof notesRaw === 'string' ? notesRaw.trim() : '';

	return { ok: true, fetchIds, notes };
}

function stripFences(text: string): string {
	let out = text.trim();
	if (out.startsWith('```')) {
		out = out.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
	}
	return out.trim();
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _validateForTest    = validate;
export const _stripFencesForTest = stripFences;
export const _MAX_FETCH          = MAX_FETCH;
