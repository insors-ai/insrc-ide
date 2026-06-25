/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Daemon RPC surface for the analyze framework's Context Builder.
 *
 * Three methods, one per invocation mode:
 *
 *   analyze.context.buildClassification(params)
 *     params: { runId, scopeRef, userPrompt }
 *
 *   analyze.context.buildRun(params)
 *     params: { runId, intent }
 *
 *   analyze.context.buildTask(params)
 *     params: { runId, intent, task, template, upstream }
 *
 * Each method returns a tagged union:
 *
 *   { ok: true,  bundle: AnalyzeContextBundle }
 *   { ok: false, error:  { code: string; message: string; data?: unknown } }
 *
 * Tagged-union return (rather than throwing across the IPC layer)
 * lets every typed shaper error from P6 surface to the client
 * verbatim with a stable error code. Unexpected errors -- network
 * faults below the shaper layer, programming bugs in the params
 * validators -- fall through and the server's standard error handler
 * converts them to a string `error` field on the JSON-RPC envelope.
 *
 * No IDE / CLI surface yet -- the framework's outer-loop RPC (P7+)
 * is the eventual caller of these handlers.
 *
 * See: design/analyze-framework.md "Surfaces" (Daemon RPC)
 *      plans/analyze-context-builder.md Phase 7
 */

import { shaperFor } from '../analyze/index.js';
import {
	ShaperLlmUnavailableError,
	ShaperPromptMissingError,
	ShaperSchemaUnrecoverable,
	ShaperToolLoopExhausted,
} from '../analyze/context/driver.js';
import { ScopeNotIndexedError } from '../analyze/context/invariants.js';
import type {
	AnalyzeContextBundle,
	ClassificationShapeInput,
	RunShapeInput,
	ShapeOpts,
	TaskShapeInput,
} from '../analyze/context/types.js';
import { getLogger } from '../shared/logger.js';
import type {
	AnalyzeScopeRef,
	AnalyzeTaskTemplate,
	ClassifiedIntent,
	PlannedTask,
} from '../shared/analyze-types.js';

const log = getLogger('analyze-rpc');

// ---------------------------------------------------------------------------
// Tagged-union response shape
// ---------------------------------------------------------------------------

export interface AnalyzeRpcOk {
	readonly ok:     true;
	readonly bundle: AnalyzeContextBundle;
}

export interface AnalyzeRpcErr {
	readonly ok:    false;
	readonly error: AnalyzeRpcErrorPayload;
}

export interface AnalyzeRpcErrorPayload {
	readonly code:    AnalyzeRpcErrorCode;
	readonly message: string;
	readonly data?:   Readonly<Record<string, unknown>>;
}

export type AnalyzeRpcResponse = AnalyzeRpcOk | AnalyzeRpcErr;

/**
 * Stable error codes for typed shaper failures. The orchestrator
 * (P7+) and the IDE dispatch on these codes; new code values
 * land in lock-step with new typed errors in the shaper.
 */
export type AnalyzeRpcErrorCode =
	| 'invalid-params'
	| 'scope-not-indexed'
	| 'shaper-llm-unavailable'
	| 'shaper-tool-loop-exhausted'
	| 'shaper-schema-unrecoverable'
	| 'shaper-prompt-missing'
	| 'internal-error';

// ---------------------------------------------------------------------------
// Public handlers
// ---------------------------------------------------------------------------

export async function buildClassification(params: unknown): Promise<AnalyzeRpcResponse> {
	let parsed: ClassificationParams;
	try {
		parsed = parseClassificationParams(params);
	} catch (err) {
		return invalidParams(err);
	}
	const shaper = shaperFor('classification');
	const input: ClassificationShapeInput = {
		scopeRef:   parsed.scopeRef,
		userPrompt: parsed.userPrompt,
	};
	const opts: ShapeOpts = { runId: parsed.runId };
	return invoke(() => shaper.buildClassificationBundle(input, opts), 'classification', parsed.runId);
}

export async function buildRun(params: unknown): Promise<AnalyzeRpcResponse> {
	let parsed: RunParams;
	try {
		parsed = parseRunParams(params);
	} catch (err) {
		return invalidParams(err);
	}
	const shaper = shaperFor('run', parsed.intent.target);
	const input: RunShapeInput = { intent: parsed.intent };
	const opts: ShapeOpts = { runId: parsed.runId };
	return invoke(() => shaper.buildRunBundle(input, opts), 'run', parsed.runId);
}

export async function buildTask(params: unknown): Promise<AnalyzeRpcResponse> {
	let parsed: TaskParams;
	try {
		parsed = parseTaskParams(params);
	} catch (err) {
		return invalidParams(err);
	}
	if (parsed.intent.target === 'generic') {
		return {
			ok: false,
			error: {
				code:    'invalid-params',
				message: "analyze.context.buildTask: target='generic' is not valid at task scope; " +
					'task-level dispatch routes by task family namespace',
			},
		};
	}
	const shaper = shaperFor('task', parsed.intent.target);
	const input: TaskShapeInput = {
		intent:        parsed.intent,
		task:          parsed.task,
		template:      parsed.template,
		upstreamTasks: parsed.upstream,
	};
	const opts: ShapeOpts = { runId: parsed.runId };
	return invoke(() => shaper.buildTaskBundle(input, opts), 'task', parsed.runId);
}

// ---------------------------------------------------------------------------
// invoke -- single error-classification path for every handler
// ---------------------------------------------------------------------------

async function invoke(
	thunk:    () => Promise<AnalyzeContextBundle>,
	mode:     'classification' | 'run' | 'task',
	runId:    string,
): Promise<AnalyzeRpcResponse> {
	try {
		const bundle = await thunk();
		log.debug({ mode, runId }, 'analyze rpc invocation complete');
		return { ok: true, bundle };
	} catch (err) {
		const payload = classifyShaperError(err);
		log.info(
			{ mode, runId, code: payload.code, message: payload.message },
			'analyze rpc invocation failed',
		);
		return { ok: false, error: payload };
	}
}

/**
 * Map a typed shaper error onto an AnalyzeRpcErrorPayload. Untyped
 * errors fall through with code `internal-error` so the client sees
 * SOMETHING structured instead of a generic string; the message
 * preserves the original error's message.
 */
function classifyShaperError(err: unknown): AnalyzeRpcErrorPayload {
	if (err instanceof ScopeNotIndexedError) {
		return {
			code:    'scope-not-indexed',
			message: err.message,
			data:    {
				scopePath:    err.scopePath,
				registeredAs: err.registeredAs,
			},
		};
	}
	if (err instanceof ShaperLlmUnavailableError) {
		return { code: 'shaper-llm-unavailable', message: err.message };
	}
	if (err instanceof ShaperToolLoopExhausted) {
		return { code: 'shaper-tool-loop-exhausted', message: err.message };
	}
	if (err instanceof ShaperSchemaUnrecoverable) {
		return { code: 'shaper-schema-unrecoverable', message: err.message };
	}
	if (err instanceof ShaperPromptMissingError) {
		return { code: 'shaper-prompt-missing', message: err.message };
	}
	const message = err instanceof Error ? err.message : String(err);
	return { code: 'internal-error', message };
}

function invalidParams(err: unknown): AnalyzeRpcErr {
	const message = err instanceof Error ? err.message : String(err);
	return { ok: false, error: { code: 'invalid-params', message } };
}

// ---------------------------------------------------------------------------
// Params parsing -- each handler has a typed parser that throws
// TypeError on bad shape. invoke()'s try/catch turns those into
// invalid-params responses.
// ---------------------------------------------------------------------------

interface ClassificationParams {
	readonly runId:      string;
	readonly scopeRef:   AnalyzeScopeRef;
	readonly userPrompt: string;
}

interface RunParams {
	readonly runId:  string;
	readonly intent: ClassifiedIntent;
}

interface TaskParams {
	readonly runId:    string;
	readonly intent:   ClassifiedIntent;
	readonly task:     PlannedTask;
	readonly template: AnalyzeTaskTemplate;
	readonly upstream: ReadonlyMap<string, unknown | null>;
}

function parseClassificationParams(params: unknown): ClassificationParams {
	const obj = requireObject(params, 'params');
	return {
		runId:      requireString(obj, 'runId'),
		scopeRef:   parseScopeRef(obj['scopeRef']),
		userPrompt: requireString(obj, 'userPrompt'),
	};
}

function parseRunParams(params: unknown): RunParams {
	const obj = requireObject(params, 'params');
	return {
		runId:  requireString(obj, 'runId'),
		intent: parseIntent(obj['intent']),
	};
}

function parseTaskParams(params: unknown): TaskParams {
	const obj = requireObject(params, 'params');
	return {
		runId:    requireString(obj, 'runId'),
		intent:   parseIntent(obj['intent']),
		task:     parseTask(obj['task']),
		template: parseTemplate(obj['template']),
		upstream: parseUpstream(obj['upstream']),
	};
}

function parseScopeRef(value: unknown): AnalyzeScopeRef {
	const obj = requireObject(value, 'scopeRef');
	const kind = requireString(obj, 'kind');
	const validKinds = ['repo', 'module', 'file', 'symbol', 'connection', 'manifest-dir', 'workspace'];
	if (!validKinds.includes(kind)) {
		throw new TypeError(
			`scopeRef.kind: must be one of ${validKinds.join(', ')}; got '${kind}'`,
		);
	}
	return {
		kind:  kind as AnalyzeScopeRef['kind'],
		value: requireString(obj, 'value'),
	};
}

function parseIntent(value: unknown): ClassifiedIntent {
	const obj = requireObject(value, 'intent');
	const target = requireString(obj, 'target');
	const validTargets = ['code', 'data', 'infra', 'generic'];
	if (!validTargets.includes(target)) {
		throw new TypeError(`intent.target: must be one of ${validTargets.join(', ')}; got '${target}'`);
	}
	const scope = requireString(obj, 'scope');
	const validScopes = ['XS', 'S', 'M', 'L', 'XL'];
	if (!validScopes.includes(scope)) {
		throw new TypeError(`intent.scope: must be one of ${validScopes.join(', ')}; got '${scope}'`);
	}
	const result: Record<string, unknown> = {
		target:    target as ClassifiedIntent['target'],
		scope:     scope as ClassifiedIntent['scope'],
		focused:   requireBoolean(obj, 'focused'),
		scopeRef:  parseScopeRef(obj['scopeRef']),
		reasoning: requireString(obj, 'reasoning'),
	};
	if (obj['focus'] !== undefined && obj['focus'] !== null) {
		result['focus'] = requireString(obj, 'focus');
	}
	return result as unknown as ClassifiedIntent;
}

function parseTask(value: unknown): PlannedTask {
	const obj = requireObject(value, 'task');
	const params = obj['params'];
	if (params === undefined || params === null || typeof params !== 'object') {
		throw new TypeError("task.params: must be an object");
	}
	const outputs = obj['outputs'];
	if (!Array.isArray(outputs) || outputs.some(o => typeof o !== 'string')) {
		throw new TypeError("task.outputs: must be string[]");
	}
	const result: Record<string, unknown> = {
		taskId:   requireString(obj, 'taskId'),
		template: requireString(obj, 'template'),
		params:   params as Record<string, unknown>,
		outputs:  outputs as string[],
	};
	if (Array.isArray(obj['dependsOnOutputs'])) {
		const deps = obj['dependsOnOutputs'];
		if (deps.some((d: unknown) => typeof d !== 'string')) {
			throw new TypeError("task.dependsOnOutputs: must be string[]");
		}
		result['dependsOnOutputs'] = deps as string[];
	}
	return result as unknown as PlannedTask;
}

function parseTemplate(value: unknown): AnalyzeTaskTemplate {
	const obj = requireObject(value, 'template');
	const kind = requireString(obj, 'kind');
	if (kind !== 'leaf' && kind !== 'planner') {
		throw new TypeError(`template.kind: must be 'leaf' or 'planner'; got '${kind}'`);
	}
	const target = requireString(obj, 'target');
	const validTargets = ['code', 'data', 'infra', 'generic'];
	if (!validTargets.includes(target)) {
		throw new TypeError(`template.target: invalid '${target}'`);
	}
	return {
		id:       requireString(obj, 'id'),
		target:   target as AnalyzeTaskTemplate['target'],
		family:   requireString(obj, 'family'),
		kind:     kind as AnalyzeTaskTemplate['kind'],
		revision: requireString(obj, 'revision'),
	};
}

function parseUpstream(value: unknown): ReadonlyMap<string, unknown | null> {
	// Accept three input shapes:
	//   1. undefined -> empty Map
	//   2. { taskId: outputJson }
	//   3. [[taskId, outputJson]]
	if (value === undefined || value === null) {
		return new Map();
	}
	if (Array.isArray(value)) {
		const m = new Map<string, unknown | null>();
		for (const entry of value) {
			if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
				throw new TypeError("upstream: array form must be [[taskId, output], ...]");
			}
			m.set(entry[0], entry[1] as unknown | null);
		}
		return m;
	}
	if (typeof value === 'object') {
		const m = new Map<string, unknown | null>();
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			m.set(k, v as unknown | null);
		}
		return m;
	}
	throw new TypeError("upstream: must be an object, array of [taskId, output] pairs, or undefined");
}

// ---------------------------------------------------------------------------
// Tiny shape helpers
// ---------------------------------------------------------------------------

function requireObject(value: unknown, field: string): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError(`${field}: must be an object`);
	}
	return value as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, field: string): string {
	const v = obj[field];
	if (typeof v !== 'string' || v.length === 0) {
		throw new TypeError(`${field}: must be a non-empty string`);
	}
	return v;
}

function requireBoolean(obj: Record<string, unknown>, field: string): boolean {
	const v = obj[field];
	if (typeof v !== 'boolean') {
		throw new TypeError(`${field}: must be a boolean`);
	}
	return v;
}
