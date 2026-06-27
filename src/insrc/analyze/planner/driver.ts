/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Plan Builder driver.
 *
 * Pipeline:
 *
 *   1. Load planner.system.md.
 *   2. Build the message list:
 *      - system  = prompt + contract reminder footer
 *      - user    = intent + assembled context bundle Markdown
 *                + DEPTH POLICY BAND + TASK CATALOG +
 *                final emit instruction
 *   3. Call OllamaProvider.completeStructured against
 *      PLAN_TASK_SCHEMA with retry budget for wire-layer faults.
 *   4. Stamp `parentTaskPath` from the call site (NOT from the LLM).
 *      INV-15 enforces presence-iff-not-root.
 *   5. Run validatePlan(plan, catalog, { focused, isChildPlan }).
 *      On failure, append a `## VALIDATOR FEEDBACK` block to the user
 *      message + the rejected plan as an assistant turn, then retry.
 *      Up to `maxAttempts` total (default 3). Exhaustion -> typed
 *      ClassifierLlmUnavailable-style error.
 *
 * No tool-loop: the planner only consumes the context bundle the
 * caller already built.
 *
 * See: design/analyze-plan-builder.md
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OllamaProvider } from '../../agent/providers/ollama.js';
import { loadAnalyzeConfig } from '../../config/analyze.js';
import { loadLocalProviderConfig } from '../../config/local.js';
import { getLogger } from '../../shared/logger.js';
import type { LLMMessage, LLMProvider } from '../../shared/types.js';
import { CONTRACT_FOOTER_MD } from '../contract.js';
import { assembleMarkdown } from '../context/bundle.js';

import { renderCatalog, renderDepthPolicy } from './render-catalog.js';
import {
	PLAN_TASK_SCHEMA,
	PLAN_SCHEMA_VERSION,
	validatePlanShapeWithErrors,
} from './schema.js';
import { getTemplatesForTarget } from './templates/registry.js';
import type {
	PlanBuilderInput,
	PlanBuilderOpts,
	PlanTask,
} from './types.js';
import { validatePlan, type PlanValidationFailure } from './validate.js';

const log = getLogger('analyze:planner');

const PLANNER_PROMPT_REL = 'prompts/analyze/planner.system.md';

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class PlanBuilderLlmUnavailableError extends Error {
	constructor(cause: string) {
		super(`Local Ollama unavailable for Plan Builder: ${cause}`);
		this.name = 'PlanBuilderLlmUnavailableError';
	}
}

export class PlanBuilderSchemaUnrecoverable extends Error {
	constructor(lastErrors: readonly string[]) {
		super(`Plan Builder structured output unrecoverable: ${lastErrors.join('; ')}`);
		this.name = 'PlanBuilderSchemaUnrecoverable';
	}
}

export class PlanBuilderExhausted extends Error {
	readonly attempts:    readonly PlanTask[];
	readonly failures:    readonly PlanValidationFailure[];
	readonly lastFailure: PlanValidationFailure;

	constructor(attempts: readonly PlanTask[], failures: readonly PlanValidationFailure[]) {
		const last = failures[failures.length - 1]!;
		super(
			`Plan Builder exhausted after ${attempts.length} attempts. ` +
				`Last failure: ${last.invariantId} -- ${last.message}`,
		);
		this.name = 'PlanBuilderExhausted';
		this.attempts = attempts;
		this.failures = failures;
		this.lastFailure = last;
	}
}

export class PlanBuilderPromptMissingError extends Error {
	constructor(promptPath: string) {
		super(`Plan Builder prompt file missing: ${promptPath}`);
		this.name = 'PlanBuilderPromptMissingError';
	}
}

// ---------------------------------------------------------------------------
// runPlanner -- public entry point
// ---------------------------------------------------------------------------

export interface RunPlannerArgs {
	readonly input:     PlanBuilderInput;
	readonly opts:      PlanBuilderOpts;
	readonly provider?: LLMProvider | undefined;
}

export async function runPlanner(args: RunPlannerArgs): Promise<PlanTask> {
	const cfg = loadAnalyzeConfig();
	const { input, opts } = args;
	const { intent, contextBundle, parentTaskPath, catalog: catalogArg } = input;

	// (1) Catalog: use the provided catalog or fall back to the
	// registered builtins filtered to this plan's target.
	const catalog = catalogArg.length > 0
		? catalogArg
		: getTemplatesForTarget(intent.target);

	// (2) Prompt load.
	const promptContent = loadPromptFile();

	// (3) Provider.
	const provider = args.provider ?? buildProvider(cfg.shaperModel, cfg.shaper.ollamaNumCtx);

	// (4) Initial messages.
	const bundleMd = assembleMarkdown(contextBundle);
	let messages = buildInitialMessages({
		promptContent,
		bundleMd,
		intent,
		catalog,
		parentTaskPath,
	});

	const attempts: PlanTask[] = [];
	const failures: PlanValidationFailure[] = [];
	const maxAttempts = cfg.shaper.structuredOutputRetries;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		let raw: PlanTask;
		try {
			raw = await provider.completeStructured<PlanTask>(
				messages,
				PLAN_TASK_SCHEMA as Record<string, unknown>,
				{
					maxAttempts:     cfg.shaper.structuredOutputRetries,
					disableThinking: true,
				},
			);
		} catch (err) {
			throw classifyError(err);
		}

		// Stamp parentTaskPath from the call site (INV-15). The LLM
		// may or may not have emitted it; either way the call site is
		// authoritative.
		const stamped: PlanTask = (() => {
			const { parentTaskPath: _ignored, ...rest } = raw;
			return parentTaskPath !== undefined
				? { ...rest, parentTaskPath }
				: rest;
		})();

		// Wire-layer re-validation (defensive).
		const shape = validatePlanShapeWithErrors(stamped);
		if (!shape.ok) {
			throw new PlanBuilderSchemaUnrecoverable(shape.errors);
		}

		// Semantic invariants.
		const failure = validatePlan(stamped, catalog, {
			focused:     intent.focused,
			isChildPlan: parentTaskPath !== undefined,
		});
		if (failure === null) {
			log.info(
				{
					runId:       opts.runId,
					target:      stamped.target,
					scope:       stamped.scope,
					taskCount:   stamped.tasks.length,
					attempt:     attempt + 1,
					isChildPlan: parentTaskPath !== undefined,
				},
				'Plan Builder accepted',
			);
			return stamped;
		}

		attempts.push(stamped);
		failures.push(failure);
		log.info(
			{
				runId:       opts.runId,
				attempt:     attempt + 1,
				invariantId: failure.invariantId,
				message:     failure.message,
			},
			'Plan Builder validation failure -- corrective retry',
		);

		messages = appendCorrectionTurn(messages, stamped, failure);
	}

	throw new PlanBuilderExhausted(attempts, failures);
}

// ---------------------------------------------------------------------------
// Message composition
// ---------------------------------------------------------------------------

interface BuildMessagesArgs {
	readonly promptContent:    string;
	readonly bundleMd:         string;
	readonly intent:           PlanBuilderInput['intent'];
	readonly catalog:          PlanBuilderInput['catalog'];
	readonly parentTaskPath?:  string | undefined;
}

function buildInitialMessages(args: BuildMessagesArgs): LLMMessage[] {
	const { promptContent, bundleMd, intent, catalog, parentTaskPath } = args;

	const systemContent = `${promptContent.trimEnd()}\n\n${CONTRACT_FOOTER_MD}`;

	const parentNote = parentTaskPath !== undefined
		? `\n**Child plan**: this plan is being built for parent task \`${parentTaskPath}\`. ` +
		  `Do NOT emit \`parentTaskPath\` -- the framework stamps it from the call site.\n`
		: '\n';

	const userContent =
		`PlanSchemaVersion: ${PLAN_SCHEMA_VERSION}\n` +
		`\n` +
		`## Intent\n` +
		'```json\n' +
		JSON.stringify(intent, null, 2) +
		'\n```\n' +
		parentNote +
		`\n` +
		`## Context bundle\n` +
		bundleMd +
		`\n\n` +
		`## DEPTH POLICY BAND (this plan)\n` +
		renderDepthPolicy(intent.scope, intent.focused) +
		`\n` +
		`## TASK CATALOG (emit task ids from here only)\n` +
		renderCatalog(catalog) +
		`\n` +
		`## OUTPUT SHAPE\n` +
		'```json\n' +
		JSON.stringify(PLAN_TASK_SCHEMA, null, 2) +
		'\n```\n' +
		`\n` +
		`## TASK\n` +
		`Emit the PlanTask JSON object now. ONLY the JSON object -- no markdown fences, no prose.`;

	return [
		{ role: 'system', content: systemContent },
		{ role: 'user',   content: userContent },
	];
}

function appendCorrectionTurn(
	prior:    LLMMessage[],
	rejected: PlanTask,
	failure:  PlanValidationFailure,
): LLMMessage[] {
	return [
		...prior,
		{ role: 'assistant', content: JSON.stringify(rejected) },
		{
			role:    'user',
			content:
				`## VALIDATOR FEEDBACK\n` +
				`The plan failed invariant **${failure.invariantId}**:\n` +
				`> ${failure.message}\n` +
				`\n` +
				(failure.target !== undefined
					? `Pointer: \`${JSON.stringify(failure.target)}\`\n\n`
					: '\n') +
				`Emit a corrected PlanTask. Address ${failure.invariantId} specifically -- do not ` +
				`re-architect the whole plan; fix the named issue and keep the rest.\n` +
				`\n` +
				`Respond with ONLY the corrected JSON object -- no markdown fences, no prose.`,
		},
	];
}

// ---------------------------------------------------------------------------
// Prompt loading + provider construction
// ---------------------------------------------------------------------------

function loadPromptFile(): string {
	const abs = isAbsolute(PLANNER_PROMPT_REL)
		? PLANNER_PROMPT_REL
		: resolveRelativeToInsrcRoot(PLANNER_PROMPT_REL);
	try {
		return readFileSync(abs, 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new PlanBuilderPromptMissingError(abs);
		}
		throw err;
	}
}

function resolveRelativeToInsrcRoot(relativePath: string): string {
	const thisFile = fileURLToPath(import.meta.url);
	// .../analyze/planner/driver.js -> .../analyze/planner -> .../analyze -> .../insrc
	const insrcRoot = resolve(thisFile, '..', '..', '..');
	return resolve(insrcRoot, relativePath);
}

function buildProvider(modelId: string, numCtx: number): LLMProvider {
	const local = loadLocalProviderConfig();
	return new OllamaProvider(modelId, local.host, numCtx);
}

// ---------------------------------------------------------------------------
// Error classification (mirrors the shaper + classifier surface)
// ---------------------------------------------------------------------------

const UNAVAILABLE_PATTERNS = [
	'Ollama is not running',
	'Model not found',
	'ECONNREFUSED',
	'ECONNRESET',
	'fetch failed',
	'socket hang up',
	'EPIPE',
	'other side closed',
	'Did not receive done or success response in stream',
];

function classifyError(err: unknown): Error {
	if (!(err instanceof Error)) return new Error(String(err));
	const msg = err.message;
	for (const pat of UNAVAILABLE_PATTERNS) {
		if (msg.includes(pat)) return new PlanBuilderLlmUnavailableError(msg);
	}
	return new PlanBuilderSchemaUnrecoverable([msg]);
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

export const PLANNER_PROMPT_PATH = PLANNER_PROMPT_REL;
export const _buildInitialMessagesForTest = buildInitialMessages;
export const _appendCorrectionTurnForTest = appendCorrectionTurn;
export const _classifyErrorForTest = classifyError;
