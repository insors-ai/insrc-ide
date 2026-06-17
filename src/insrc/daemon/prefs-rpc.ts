/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `/prefs` IPC handlers (memory-context M1.7).
 *
 * Exposes CRUD over the `agent:chat` owner's `user-assertions` namespace --
 * the bucket the chat-side classifier writes preferences into.
 *
 *   prefs.list     -> all active preferences (post-noise-threshold)
 *   prefs.edit     -> replace canonical text + optionally confidence
 *   prefs.discard  -> remove a preference by key
 *
 * The slash dispatcher (`runPrefsSlash` in chat-handler.ts) is a thin
 * markdown layer over these handlers; the IDE-side palette commands can
 * reuse them directly too.
 *
 * Key shape (from `runtime.ts`): `<turnId>::<preferenceSubject>`. The
 * full key is the public identifier. Edit/discard accept a key prefix
 * provided it uniquely identifies one entry, matching the way slash
 * commands typically tolerate abbreviation.
 */

import { getLogger } from '../shared/logger.js';
import { AGENT_CHAT_OWNER, getSubstrateRuntime, hasSubstrateRuntime } from './substrate/singleton.js';
import type { FeedbackEvent } from './substrate/types.js';

const log = getLogger('daemon:prefs-rpc');

const NS = 'user-assertions';

// Default noise threshold (G7 of design/memory-context.html). The /prefs UI
// shows everything above this floor so the user can edit or discard fading
// entries before they roll off; the L1 retrieval path in agent/context/
// applies the same cut.
const DEFAULT_NOISE_THRESHOLD = 0.30;

// ---------------------------------------------------------------------------
// Public DTO shape (matched by the IDE-side palette + the slash renderer)
// ---------------------------------------------------------------------------

export interface PrefsEntry {
	readonly key:           string;          // <turnId>::<subject>
	readonly subject:       string;          // PreferenceSubject
	readonly canonicalText: string;
	readonly confidence:    number;
	readonly polarity:      string;
	readonly scope:         string;
	readonly capturedAtTurn?: string;
	readonly categories?:   readonly string[];
	readonly repoPaths?:    readonly string[];
}

export interface PrefsListResult {
	readonly entries: readonly PrefsEntry[];
}

export interface PrefsEditParams {
	readonly key:           string;
	readonly canonicalText?: string;
	readonly confidence?:   number;
}

export interface PrefsDiscardParams {
	readonly key: string;
}

export interface PrefsMutationResult {
	readonly ok:      true;
	readonly key:     string;
	readonly entry?: PrefsEntry;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export async function prefsListRpc(params?: unknown): Promise<PrefsListResult> {
	if (!hasSubstrateRuntime()) {
		log.debug('prefs.list: substrate runtime not initialised; returning empty');
		return { entries: [] };
	}
	const includeNoisy = isRecord(params) && params['includeNoisy'] === true;
	const threshold = includeNoisy ? 0 : DEFAULT_NOISE_THRESHOLD;

	const runtime = getSubstrateRuntime();
	const ns = runtime.memory.scope(AGENT_CHAT_OWNER, NS);
	const out: PrefsEntry[] = [];
	for await (const entry of ns.scan<Record<string, unknown>>('')) {
		if (entry.kind !== 'constraint') { continue; }
		if (entry.confidence < threshold) { continue; }
		out.push(rowToPrefsEntry(entry.key, entry.confidence, entry.value, entry.source));
	}
	// Stable order: descending confidence, then key. Predictable for tests
	// and pleasant for the human reader (most-trusted entries first).
	out.sort((a, b) => b.confidence - a.confidence || a.key.localeCompare(b.key));
	return { entries: out };
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

export async function prefsEditRpc(params: unknown): Promise<PrefsMutationResult> {
	if (!hasSubstrateRuntime()) {
		throw new Error('substrate runtime not initialised');
	}
	const p = validateEditParams(params);
	const runtime = getSubstrateRuntime();
	const ns = runtime.memory.scope(AGENT_CHAT_OWNER, NS);

	const resolvedKey = await resolveKey(ns, p.key);
	const existing = await ns.get<Record<string, unknown>>(resolvedKey);
	if (existing === undefined) {
		throw new Error(`prefs.edit: no entry found for key '${resolvedKey}'`);
	}

	const updatedValue: Record<string, unknown> = { ...existing.value };
	if (p.canonicalText !== undefined) {
		updatedValue['canonicalText'] = p.canonicalText;
		// Keep the legacy `text` field aligned -- some downstream callers
		// (older entries pre-M1.4) still rely on it as the canonical surface.
		updatedValue['text'] = p.canonicalText;
	}
	const newConfidence = p.confidence ?? existing.confidence;
	if (p.confidence !== undefined) {
		updatedValue['confidence'] = p.confidence;
	}

	// Delete-then-put: substrate's D4 merge policy keeps the prior entry on
	// same-kind / same-confidence / same-millisecond writes, so an in-place
	// `put` would silently no-op when the user-visible edit happens fast
	// enough after the seed/prior put. Deleting first lets the new value
	// land authoritatively.
	await ns.delete(resolvedKey);
	const ref = await ns.put(resolvedKey, updatedValue, {
		kind:       'constraint',
		source:     existing.source,
		confidence: newConfidence,
	});

	// Feedback dispatch so subscribers (ContextManager, future loggers)
	// see the edit. Mirrors the bus shape used by the classifier.
	try {
		const event: FeedbackEvent = {
			id:          `prefs-edit-${resolvedKey}-${Date.now()}`,
			kind:        'user-correction',
			targetOwner: AGENT_CHAT_OWNER,
			memoryRefs:  [ref],
			payload:     { source: 'prefs.edit', editedKey: resolvedKey, change: p },
			source:      'rpc:prefs.edit',
			at:          Date.now(),
		};
		await runtime.feedbackBus.emit(event);
	} catch (err) {
		log.warn({ err: (err as Error).message }, 'prefs.edit: feedback dispatch failed (write still succeeded)');
	}

	const refreshed = await ns.get<Record<string, unknown>>(resolvedKey);
	const result: PrefsMutationResult = refreshed !== undefined
		? {
			ok:    true,
			key:   resolvedKey,
			entry: rowToPrefsEntry(resolvedKey, refreshed.confidence, refreshed.value, refreshed.source),
		}
		: { ok: true, key: resolvedKey };
	return result;
}

// ---------------------------------------------------------------------------
// Discard
// ---------------------------------------------------------------------------

export async function prefsDiscardRpc(params: unknown): Promise<PrefsMutationResult> {
	if (!hasSubstrateRuntime()) {
		throw new Error('substrate runtime not initialised');
	}
	const p = validateDiscardParams(params);
	const runtime = getSubstrateRuntime();
	const ns = runtime.memory.scope(AGENT_CHAT_OWNER, NS);

	const resolvedKey = await resolveKey(ns, p.key);
	const existing = await ns.get<Record<string, unknown>>(resolvedKey);
	if (existing === undefined) {
		throw new Error(`prefs.discard: no entry found for key '${resolvedKey}'`);
	}
	await ns.delete(resolvedKey);

	try {
		const event: FeedbackEvent = {
			id:          `prefs-discard-${resolvedKey}-${Date.now()}`,
			kind:        'user-correction',
			targetOwner: AGENT_CHAT_OWNER,
			memoryRefs:  [],
			payload:     { source: 'prefs.discard', key: resolvedKey },
			source:      'rpc:prefs.discard',
			at:          Date.now(),
		};
		await runtime.feedbackBus.emit(event);
	} catch (err) {
		log.warn({ err: (err as Error).message }, 'prefs.discard: feedback dispatch failed (delete still succeeded)');
	}

	return { ok: true, key: resolvedKey };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToPrefsEntry(
	key:        string,
	confidence: number,
	value:      Record<string, unknown>,
	source:    { kind?: unknown; turnId?: unknown } | unknown,
): PrefsEntry {
	const subject = strField(value, 'preferenceSubject') ?? strField(value, 'subject') ?? '';
	const canonicalText = strField(value, 'canonicalText') ?? strField(value, 'text') ?? '';
	const polarity = strField(value, 'polarity') ?? 'preference';
	const scope    = strField(value, 'scope')    ?? 'workspace';
	const categories = arrField(value, 'categories');
	const repoPaths  = arrField(value, 'repoPaths');
	const capturedAtTurn = isRecord(source) && typeof source['turnId'] === 'string'
		? source['turnId']
		: undefined;
	return {
		key,
		subject,
		canonicalText,
		confidence,
		polarity,
		scope,
		...(capturedAtTurn !== undefined ? { capturedAtTurn } : {}),
		...(categories !== undefined ? { categories } : {}),
		...(repoPaths  !== undefined ? { repoPaths }  : {}),
	};
}

function strField(o: Record<string, unknown>, k: string): string | undefined {
	const v = o[k];
	return typeof v === 'string' ? v : undefined;
}

function arrField(o: Record<string, unknown>, k: string): string[] | undefined {
	const v = o[k];
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
}

function isRecord(x: unknown): x is Record<string, unknown> {
	return typeof x === 'object' && x !== null;
}

function validateEditParams(params: unknown): PrefsEditParams {
	if (!isRecord(params) || typeof params['key'] !== 'string' || params['key'].length === 0) {
		throw new Error('prefs.edit: `key` (string) is required');
	}
	const out: { key: string; canonicalText?: string; confidence?: number } = { key: params['key'] };
	if (params['canonicalText'] !== undefined) {
		if (typeof params['canonicalText'] !== 'string' || params['canonicalText'].length === 0) {
			throw new Error('prefs.edit: `canonicalText` must be a non-empty string');
		}
		out.canonicalText = params['canonicalText'];
	}
	if (params['confidence'] !== undefined) {
		const c = params['confidence'];
		if (typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > 1) {
			throw new Error('prefs.edit: `confidence` must be a number in [0, 1]');
		}
		out.confidence = c;
	}
	if (out.canonicalText === undefined && out.confidence === undefined) {
		throw new Error('prefs.edit: nothing to update (provide `canonicalText` and/or `confidence`)');
	}
	return out;
}

function validateDiscardParams(params: unknown): PrefsDiscardParams {
	if (!isRecord(params) || typeof params['key'] !== 'string' || params['key'].length === 0) {
		throw new Error('prefs.discard: `key` (string) is required');
	}
	return { key: params['key'] };
}

/**
 * Resolve a key OR a unique key prefix to a full key. Prefix matching is
 * the UX affordance for typing `/prefs discard turn-1` when the full key
 * is `turn-1::test-policy`. Ambiguity (>1 match) is an error, not a guess.
 */
async function resolveKey(
	ns:     ReturnType<ReturnType<typeof getSubstrateRuntime>['memory']['scope']>,
	input:  string,
): Promise<string> {
	// Fast path: exact hit.
	const direct = await ns.get(input);
	if (direct !== undefined) {
		return input;
	}
	// Prefix scan.
	const matches: string[] = [];
	for await (const entry of ns.scan(input)) {
		if (entry.kind !== 'constraint') { continue; }
		matches.push(entry.key);
		if (matches.length > 1) {
			throw new Error(`prefs: key prefix '${input}' is ambiguous (matches at least: ${matches.slice(0, 2).join(', ')})`);
		}
	}
	if (matches.length === 0) {
		throw new Error(`prefs: no entry found for key '${input}'`);
	}
	return matches[0]!;
}
