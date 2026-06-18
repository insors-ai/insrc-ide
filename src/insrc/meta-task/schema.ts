/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Schema validators for the meta-task wire shapes.
 *
 * Every cloud-LLM response (`Phase1Ask`, `Phase2Out`) and every local-LLM emission
 * (`Phase1Result`, individual `ContextChunk`) passes through these gates before the
 * orchestrator consumes it. The validators reject malformed shapes that the discriminated
 * union types alone can't enforce -- e.g. an empty `requests` array on a `context-needed`
 * ask (must be `sufficient` instead), a `needs-narrowing` chunk with no `narrowingHint`,
 * an `abort` payload missing `resolution`.
 *
 * Hand-written (no ajv / no codegen) to keep the dependency surface small and to keep
 * the rejection messages tightly informative -- they're fed back to the cloud LLM as
 * part of the retry prompt, so the wording matters.
 *
 * Pattern: each validator returns `{ ok: true; value }` on success or
 * `{ ok: false; errors }` on failure. Producers + consumers both pin on this shape.
 * On failure the caller assembles the errors into a retry-prompt section.
 */

import type {
	ContextChunk,
	ContextRequest,
	NarrowingHint,
	Phase1Ask,
	Phase1Result,
	Phase2Out,
} from './types.js';

export type ValidationResult<T> =
	| { readonly ok: true;  readonly value: T }
	| { readonly ok: false; readonly errors: readonly string[] };


// ---------------------------------------------------------------------------
// ContextRequest -- slot-specific shape validation. Each kind has different
// required fields; we route by `kind` and check the corresponding subset.
// ---------------------------------------------------------------------------

const CONTEXT_REQUEST_KINDS = new Set<string>([
	'entities', 'files', 'deliverable', 'semantic', 'graph', 'git', 'trace', 'memory', 'preferences',
]);

const GRAPH_OPS = new Set<string>(['callers', 'callees', 'imports', 'importers', 'closure']);

export function validateContextRequest(raw: unknown, path = 'request'): ValidationResult<ContextRequest> {
	if (!isObject(raw)) {
		return fail([`${path}: must be an object`]);
	}
	const kind = (raw as { kind?: unknown }).kind;
	if (typeof kind !== 'string') {
		return fail([`${path}.kind: required string`]);
	}
	if (!CONTEXT_REQUEST_KINDS.has(kind)) {
		return fail([`${path}.kind: must be one of ${[...CONTEXT_REQUEST_KINDS].join(', ')}; got '${kind}'`]);
	}

	const errors: string[] = [];

	switch (kind) {
		case 'entities': {
			const r = raw as Record<string, unknown>;
			if (r.names      !== undefined && !isStringArray(r.names))     { errors.push(`${path}.names: must be string[] or omitted`); }
			if (r.kinds      !== undefined && !isStringArray(r.kinds))     { errors.push(`${path}.kinds: must be string[] or omitted`); }
			if (r.repos      !== undefined && !isStringArray(r.repos))     { errors.push(`${path}.repos: must be string[] or omitted`); }
			// At least one filter must be present; an unbounded entities query is rejected.
			if (r.names === undefined && r.kinds === undefined && r.repos === undefined) {
				errors.push(`${path}: requires at least one of names / kinds / repos (unbounded query rejected)`);
			}
			break;
		}
		case 'files': {
			const r = raw as Record<string, unknown>;
			if (!isStringArray(r.globs) || (r.globs as string[]).length === 0) {
				errors.push(`${path}.globs: required non-empty string[]`);
			}
			if (r.maxBytes !== undefined && (typeof r.maxBytes !== 'number' || r.maxBytes <= 0)) {
				errors.push(`${path}.maxBytes: must be positive number or omitted`);
			}
			break;
		}
		case 'deliverable': {
			const r = raw as Record<string, unknown>;
			if (typeof r.specId !== 'string' || r.specId.length === 0) {
				errors.push(`${path}.specId: required non-empty string`);
			}
			if (r.heading !== undefined && typeof r.heading !== 'string') {
				errors.push(`${path}.heading: must be string or omitted`);
			}
			break;
		}
		case 'semantic': {
			const r = raw as Record<string, unknown>;
			if (typeof r.query !== 'string' || r.query.length === 0) {
				errors.push(`${path}.query: required non-empty string`);
			}
			if (r.topK !== undefined && (typeof r.topK !== 'number' || r.topK <= 0 || !Number.isInteger(r.topK))) {
				errors.push(`${path}.topK: must be positive integer or omitted`);
			}
			if (r.over !== undefined) {
				if (!Array.isArray(r.over) || r.over.length === 0 || r.over.some(o => o !== 'entities' && o !== 'deliverables')) {
					errors.push(`${path}.over: must be non-empty array of 'entities' | 'deliverables', or omitted`);
				}
			}
			break;
		}
		case 'graph': {
			const r = raw as Record<string, unknown>;
			if (typeof r.op !== 'string' || !GRAPH_OPS.has(r.op)) {
				errors.push(`${path}.op: must be one of ${[...GRAPH_OPS].join(', ')}`);
			}
			if (!isStringArray(r.targets) || (r.targets as string[]).length === 0) {
				errors.push(`${path}.targets: required non-empty string[]`);
			}
			if (r.depth !== undefined && (typeof r.depth !== 'number' || r.depth < 0 || !Number.isInteger(r.depth))) {
				errors.push(`${path}.depth: must be non-negative integer or omitted`);
			}
			break;
		}
		case 'git': {
			const r = raw as Record<string, unknown>;
			if (r.paths !== undefined && !isStringArray(r.paths)) {
				errors.push(`${path}.paths: must be string[] or omitted`);
			}
			if (r.since !== undefined && typeof r.since !== 'string') {
				errors.push(`${path}.since: must be string or omitted`);
			}
			if (r.maxCommits !== undefined && (typeof r.maxCommits !== 'number' || r.maxCommits <= 0 || !Number.isInteger(r.maxCommits))) {
				errors.push(`${path}.maxCommits: must be positive integer or omitted`);
			}
			break;
		}
		case 'trace': {
			const r = raw as Record<string, unknown>;
			if (typeof r.specId !== 'string' || r.specId.length === 0) {
				errors.push(`${path}.specId: required non-empty string`);
			}
			break;
		}
		case 'memory': {
			const r = raw as Record<string, unknown>;
			if (r.query !== undefined && typeof r.query !== 'string') {
				errors.push(`${path}.query: must be string or omitted`);
			}
			break;
		}
		case 'preferences': {
			// memory-context M2.3. All fields optional -- a bare
			// `{ kind: 'preferences' }` is valid (no scope filter, no
			// stepIntent => no LLM curation pass, return all candidates
			// for the active owner).
			const r = raw as Record<string, unknown>;
			if (r.scope !== undefined) {
				if (!isObject(r.scope)) {
					errors.push(`${path}.scope: must be object or omitted`);
				} else {
					const s = r.scope as Record<string, unknown>;
					if (s.templateId !== undefined && typeof s.templateId !== 'string') {
						errors.push(`${path}.scope.templateId: must be string or omitted`);
					}
					if (s.category !== undefined && typeof s.category !== 'string') {
						errors.push(`${path}.scope.category: must be string or omitted`);
					}
					if (s.repoPath !== undefined && typeof s.repoPath !== 'string') {
						errors.push(`${path}.scope.repoPath: must be string or omitted`);
					}
				}
			}
			if (r.stepIntent !== undefined && typeof r.stepIntent !== 'string') {
				errors.push(`${path}.stepIntent: must be string or omitted`);
			}
			break;
		}
	}

	if (errors.length > 0) {
		return fail(errors);
	}
	return { ok: true, value: raw as ContextRequest };
}


// ---------------------------------------------------------------------------
// Phase1Ask -- discriminated by kind. `sufficient` is bare; `context-needed`
// must carry a non-empty `requests` array.
// ---------------------------------------------------------------------------

export function validatePhase1Ask(raw: unknown): ValidationResult<Phase1Ask> {
	if (!isObject(raw)) {
		return fail([`phase1Ask: must be an object`]);
	}
	const kind = (raw as { kind?: unknown }).kind;
	if (kind === 'sufficient') {
		return { ok: true, value: { kind: 'sufficient' } };
	}
	if (kind !== 'context-needed') {
		return fail([`phase1Ask.kind: must be 'sufficient' or 'context-needed'; got '${String(kind)}'`]);
	}
	const requests = (raw as { requests?: unknown }).requests;
	if (!Array.isArray(requests) || requests.length === 0) {
		return fail([
			`phase1Ask.requests: required non-empty array on 'context-needed' (empty array is rejected -- emit { kind: 'sufficient' } if you need nothing)`,
		]);
	}
	const errors: string[] = [];
	const validated: ContextRequest[] = [];
	requests.forEach((req, idx) => {
		const r = validateContextRequest(req, `phase1Ask.requests[${idx}]`);
		if (r.ok) { validated.push(r.value); }
		else      { errors.push(...r.errors); }
	});
	const intent = (raw as { intent?: unknown }).intent;
	if (intent !== undefined && typeof intent !== 'string') {
		errors.push(`phase1Ask.intent: must be string or omitted`);
	}
	if (errors.length > 0) {
		return fail(errors);
	}
	return {
		ok: true,
		value: intent !== undefined
			? { kind: 'context-needed', requests: validated, intent: intent as string }
			: { kind: 'context-needed', requests: validated },
	};
}


// ---------------------------------------------------------------------------
// NarrowingHint -- structured push-back on `needs-narrowing` chunks.
// ---------------------------------------------------------------------------

function validateNarrowingHint(raw: unknown, path: string): ValidationResult<NarrowingHint> {
	if (!isObject(raw)) {
		return fail([`${path}: must be an object`]);
	}
	const r = raw as Record<string, unknown>;
	const errors: string[] = [];
	if (typeof r.matched !== 'number' || r.matched < 0) {
		errors.push(`${path}.matched: required non-negative number`);
	}
	if (r.suggestedFilters !== undefined && !isStringArray(r.suggestedFilters)) {
		errors.push(`${path}.suggestedFilters: must be string[] or omitted`);
	}
	if (r.suggestedAlternativeKinds !== undefined) {
		if (!Array.isArray(r.suggestedAlternativeKinds)
			|| r.suggestedAlternativeKinds.some(k => typeof k !== 'string' || !CONTEXT_REQUEST_KINDS.has(k))) {
			errors.push(`${path}.suggestedAlternativeKinds: must be array of valid ContextRequest kinds or omitted`);
		}
	}
	if (r.note !== undefined && typeof r.note !== 'string') {
		errors.push(`${path}.note: must be string or omitted`);
	}
	if (errors.length > 0) {
		return fail(errors);
	}
	return { ok: true, value: raw as unknown as NarrowingHint };
}


// ---------------------------------------------------------------------------
// ContextChunk -- echoed request, status, payload, optional rationale +
// REQUIRED narrowingHint on `needs-narrowing`.
// ---------------------------------------------------------------------------

const CHUNK_STATUSES = new Set<string>(['ok', 'empty', 'partial', 'needs-narrowing', 'error']);

export function validateContextChunk(raw: unknown, path = 'chunk'): ValidationResult<ContextChunk> {
	if (!isObject(raw)) {
		return fail([`${path}: must be an object`]);
	}
	const r = raw as Record<string, unknown>;
	const errors: string[] = [];

	// Echoed request -- must round-trip validateContextRequest.
	const reqRes = validateContextRequest(r.request, `${path}.request`);
	if (!reqRes.ok) {
		errors.push(...reqRes.errors);
	}

	const status = r.status;
	if (typeof status !== 'string' || !CHUNK_STATUSES.has(status)) {
		errors.push(`${path}.status: must be one of ${[...CHUNK_STATUSES].join(', ')}; got '${String(status)}'`);
	}

	// note is optional free-text.
	if (r.note !== undefined && typeof r.note !== 'string') {
		errors.push(`${path}.note: must be string or omitted`);
	}

	// narrowingHint -- required when status === 'needs-narrowing'; otherwise
	// optional. The schema rejects a 'needs-narrowing' chunk without a hint
	// because the hint is the entire point of that status.
	if (status === 'needs-narrowing') {
		if (r.narrowingHint === undefined) {
			errors.push(`${path}.narrowingHint: required when status === 'needs-narrowing'`);
		} else {
			const hintRes = validateNarrowingHint(r.narrowingHint, `${path}.narrowingHint`);
			if (!hintRes.ok) { errors.push(...hintRes.errors); }
		}
	} else if (r.narrowingHint !== undefined) {
		const hintRes = validateNarrowingHint(r.narrowingHint, `${path}.narrowingHint`);
		if (!hintRes.ok) { errors.push(...hintRes.errors); }
	}

	// payload is unknown shape; we don't dive into it.
	if (errors.length > 0) {
		return fail(errors);
	}
	return { ok: true, value: raw as unknown as ContextChunk };
}


// ---------------------------------------------------------------------------
// Phase1Result -- collection of chunks + meta. Meta fields are sanity-checked
// but not particularly strict; the cloud LLM never produces a Phase1Result so
// this validator mostly catches internal bugs.
// ---------------------------------------------------------------------------

export function validatePhase1Result(raw: unknown): ValidationResult<Phase1Result> {
	if (!isObject(raw)) {
		return fail([`phase1Result: must be an object`]);
	}
	const r = raw as Record<string, unknown>;
	const errors: string[] = [];
	if (!Array.isArray(r.chunks)) {
		errors.push(`phase1Result.chunks: required array`);
	}
	const validatedChunks: ContextChunk[] = [];
	if (Array.isArray(r.chunks)) {
		r.chunks.forEach((c, idx) => {
			const res = validateContextChunk(c, `phase1Result.chunks[${idx}]`);
			if (res.ok) { validatedChunks.push(res.value); }
			else        { errors.push(...res.errors); }
		});
	}
	if (!isObject(r.meta)) {
		errors.push(`phase1Result.meta: required object`);
	} else {
		const m = r.meta as Record<string, unknown>;
		if (typeof m.totalBytes      !== 'number' || m.totalBytes      < 0) { errors.push(`phase1Result.meta.totalBytes: required non-negative number`); }
		if (typeof m.elapsedMs       !== 'number' || m.elapsedMs       < 0) { errors.push(`phase1Result.meta.elapsedMs: required non-negative number`); }
		if (typeof m.droppedRequests !== 'number' || m.droppedRequests < 0) { errors.push(`phase1Result.meta.droppedRequests: required non-negative number`); }
	}
	if (errors.length > 0) {
		return fail(errors);
	}
	return { ok: true, value: raw as unknown as Phase1Result };
}


// ---------------------------------------------------------------------------
// Phase2Out -- the cloud LLM's terminal output. Strict per discriminator:
//   - 'deliverable'      requires non-empty body
//   - 'context-needed'   requires non-empty requests + non-empty reason
//   - 'abort'            requires non-empty reason + resolution enum
// ---------------------------------------------------------------------------

const ABORT_RESOLUTIONS = new Set<string>(['user-required', 'plan-revisable']);

export function validatePhase2Out(raw: unknown): ValidationResult<Phase2Out> {
	if (!isObject(raw)) {
		return fail([`phase2Out: must be an object`]);
	}
	const r = raw as Record<string, unknown>;
	const kind = r.kind;
	if (kind === 'deliverable') {
		if (typeof r.body !== 'string' || r.body.length === 0) {
			return fail([`phase2Out.body: required non-empty string on 'deliverable'`]);
		}
		return { ok: true, value: { kind: 'deliverable', body: r.body } };
	}
	if (kind === 'context-needed') {
		const errors: string[] = [];
		if (!Array.isArray(r.requests) || r.requests.length === 0) {
			errors.push(`phase2Out.requests: required non-empty array on 'context-needed'`);
		}
		if (typeof r.reason !== 'string' || r.reason.trim().length === 0) {
			errors.push(`phase2Out.reason: required non-empty string on 'context-needed' (retries demand an articulated why)`);
		}
		const validatedReqs: ContextRequest[] = [];
		if (Array.isArray(r.requests)) {
			r.requests.forEach((req, idx) => {
				const res = validateContextRequest(req, `phase2Out.requests[${idx}]`);
				if (res.ok) { validatedReqs.push(res.value); }
				else        { errors.push(...res.errors); }
			});
		}
		if (r.intent !== undefined && typeof r.intent !== 'string') {
			errors.push(`phase2Out.intent: must be string or omitted`);
		}
		if (errors.length > 0) {
			return fail(errors);
		}
		return {
			ok: true,
			value: r.intent !== undefined
				? { kind: 'context-needed', requests: validatedReqs, reason: r.reason as string, intent: r.intent as string }
				: { kind: 'context-needed', requests: validatedReqs, reason: r.reason as string },
		};
	}
	if (kind === 'abort') {
		const errors: string[] = [];
		if (typeof r.reason !== 'string' || r.reason.trim().length === 0) {
			errors.push(`phase2Out.reason: required non-empty string on 'abort'`);
		}
		if (typeof r.resolution !== 'string' || !ABORT_RESOLUTIONS.has(r.resolution)) {
			errors.push(`phase2Out.resolution: required, must be one of ${[...ABORT_RESOLUTIONS].join(', ')}`);
		}
		if (r.hint !== undefined && typeof r.hint !== 'string') {
			errors.push(`phase2Out.hint: must be string or omitted`);
		}
		if (errors.length > 0) {
			return fail(errors);
		}
		return {
			ok: true,
			value: r.hint !== undefined
				? { kind: 'abort', reason: r.reason as string, resolution: r.resolution as 'user-required' | 'plan-revisable', hint: r.hint as string }
				: { kind: 'abort', reason: r.reason as string, resolution: r.resolution as 'user-required' | 'plan-revisable' },
		};
	}
	return fail([`phase2Out.kind: must be 'deliverable' | 'context-needed' | 'abort'; got '${String(kind)}'`]);
}


// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

function fail<T>(errors: readonly string[]): ValidationResult<T> {
	return { ok: false, errors };
}

function isObject(x: unknown): x is Record<string, unknown> {
	return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isStringArray(x: unknown): x is string[] {
	return Array.isArray(x) && x.every(s => typeof s === 'string');
}
