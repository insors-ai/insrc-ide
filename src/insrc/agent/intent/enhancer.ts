/**
 * Question-enhancer
 * (conversation-flow-refinement.md Phase 3.3).
 *
 * One LLM call per turn (cloud-small affinity), structured JSON
 * output, schema-validated, with one retry on validation failure.
 * Plus an optional second pass when the first-pass output names
 * artefact ids in `requestArtifactIds` -- the orchestrator loads
 * those bodies from disk and re-prompts. Hard cap: one re-fetch
 * round, max 3 ids per request, second-pass `requestArtifactIds`
 * is ignored.
 *
 * The enhancer never blocks the chat flow: every failure path
 * degrades to a pass-through of the original message + a
 * low-confidence note.
 *
 * Provider affinity: cloud-small via the same resolver
 * `classifyPrimaryIntent` uses.
 */

import { promises as fs } from 'node:fs';
import { getLogger } from '../../shared/logger.js';
import { resolveClassifierProvider } from '../classify/provider.js';
import type { LLMMessage, LLMProvider, LLMResponse } from '../../shared/types.js';
import type { Session } from '../session.js';
import type { PriorContext, RetrievedArtifact } from './retriever.js';

const log = getLogger('question-enhancer');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_INLINE_ARTIFACTS    = 3;     // top-K previews shown to the LLM
const MAX_REQUESTED_REFETCHES = 3;     // hard cap on requestArtifactIds honored
const PREVIEW_MAX_BYTES       = 2048;
const FULL_INLINE_MAX_BYTES   = 16 * 1024;   // per artifact body inlined on second pass
const MAX_TOKENS              = 1024;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EnhancerInput {
	readonly originalMessage: string;
	readonly priorContext:    PriorContext;
}

export interface EnhancerOutput {
	readonly enhancedQuestion:   string;
	readonly citedArtifactIds:   readonly string[];
	readonly requestArtifactIds: readonly string[];
	readonly notes:              readonly string[];
}

export async function enhanceQuestion(
	session: Session,
	input: EnhancerInput,
): Promise<EnhancerOutput> {
	if (input.originalMessage.trim().length === 0) {
		return passThrough('', []);
	}

	const provider = resolveClassifierProvider(session, 'enhance');

	// First pass.
	let firstPass = await runOnePass(provider, input, /*inlineFullArtifacts*/ undefined);
	if (!firstPass.ok) {
		// One validation retry.
		log.info({ failure: firstPass.failure }, 'enhancer first-pass invalid -- retrying once');
		firstPass = await runOnePass(provider, input, undefined, firstPass.failure);
		if (!firstPass.ok) {
			log.warn({ failure: firstPass.failure }, 'enhancer second validation pass failed -- pass-through');
			return passThrough(input.originalMessage, [
				`enhancer fell back to pass-through: ${firstPass.failure}`,
			]);
		}
	}

	const requested = firstPass.value.requestArtifactIds;
	if (requested.length === 0) {
		return firstPass.value;
	}

	// Re-fetch round: load full bodies from disk for the named ids
	// (capped at MAX_REQUESTED_REFETCHES).
	const ids = requested.slice(0, MAX_REQUESTED_REFETCHES);
	const inlineFull = await loadFullArtifacts(input.priorContext, ids);
	if (inlineFull.length === 0) {
		log.info({ ids }, 'enhancer requested artifacts but none could be loaded -- using first-pass output');
		return { ...firstPass.value, requestArtifactIds: [] };
	}

	const secondPass = await runOnePass(provider, input, inlineFull);
	if (!secondPass.ok) {
		log.warn({ failure: secondPass.failure }, 'enhancer second-pass invalid -- using first-pass output');
		return { ...firstPass.value, requestArtifactIds: [] };
	}
	// Second-pass requestArtifactIds is IGNORED (one re-fetch round only).
	return { ...secondPass.value, requestArtifactIds: [] };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface InlineFullArtifact {
	readonly artifactId: string;
	readonly skillId:    string;
	readonly value:      unknown;
}

type ParseResult =
	| { ok: true;  value: EnhancerOutput }
	| { ok: false; failure: string };

async function runOnePass(
	provider: LLMProvider,
	input: EnhancerInput,
	inlineFullArtifacts: readonly InlineFullArtifact[] | undefined,
	retryHint?: string,
): Promise<ParseResult> {
	const messages = buildMessages(input, inlineFullArtifacts, retryHint);
	let raw: string;
	try {
		const response: LLMResponse = await provider.complete(messages, {
			maxTokens:   MAX_TOKENS,
			temperature: 0.1,
		});
		raw = response.text;
	} catch (err) {
		log.warn({ err: errMessage(err) }, 'enhancer LLM call failed');
		return { ok: false, failure: `LLM call failed: ${errMessage(err)}` };
	}
	return parseAndValidate(raw, input.priorContext);
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
	'You rewrite a brief follow-up into a self-contained question an',
	'analyzer can answer cold.',
	'',
	'Rules:',
	'  1. If the raw message is already self-contained, return it',
	'     unchanged. citedArtifactIds: [], requestArtifactIds: [].',
	'  2. If the raw message references a noun that resolves UNIQUELY in',
	'     `Prior facts`, replace the noun with the concrete identifier',
	'     and cite the source artifact id.',
	'  3. If a reference is ambiguous (matches multiple facts), surface',
	'     the ambiguity in the rewritten question. The analyzer\'s',
	'     select-scope step will gate on it.',
	'  4. Never invent a noun that isn\'t in the raw message or in prior',
	'     facts.',
	'  5. If a preview is truncated and you genuinely need the full body',
	'     to resolve a reference -- AND no fact resolves it -- list the',
	'     `artifact_id` in `requestArtifactIds` and STOP. The',
	'     orchestrator will refetch and prompt you again with the full',
	'     body inlined under `## Full artifact bodies`. Use sparingly:',
	'     bound is 3 ids; second-pass requests are ignored.',
	'  6. INTENT SHIFT: when the prompt includes a `Note: intent shifted`',
	'     line, the prior facts came from a different analyzer family',
	'     (e.g. code -> data). Translate identifiers across the boundary',
	'     when that\'s the natural mapping -- a code-side `users` table',
	'     reference becomes a data-side `(connectionId, target=users)`',
	'     pair when the data analyzer needs it. If no clean translation',
	'     exists, leave the noun as the user wrote it and add a note.',
	'',
	'Output strict JSON ONLY (no markdown fences, no prose):',
	'  { "enhancedQuestion": "...",',
	'    "citedArtifactIds": [...],',
	'    "requestArtifactIds": [...],',
	'    "notes": [...] }',
].join('\n');

function buildMessages(
	input: EnhancerInput,
	inlineFullArtifacts: readonly InlineFullArtifact[] | undefined,
	retryHint?: string,
): LLMMessage[] {
	const lines: string[] = [];

	lines.push('## Original message');
	lines.push(input.originalMessage.trim());
	lines.push('');

	// Phase 5.2: when the resolver flagged a shift, surface it as a
	// dedicated note so the LLM applies rule 6 (cross-family identifier
	// translation). Stable / fresh / tag-reuse paths just get the
	// current-intent line.
	lines.push('## Current intent');
	lines.push(input.priorContext.currentIntent);
	if (input.priorContext.intentChanged && input.priorContext.previousIntent !== undefined) {
		lines.push('');
		lines.push(
			`Note: intent shifted from \`${input.priorContext.previousIntent}\` to ` +
			`\`${input.priorContext.currentIntent}\`. Prior facts may need translation ` +
			'across the analyzer boundary -- see system rule 6.',
		);
	}
	lines.push('');

	lines.push('## Prior facts (mined; primary -- prefer these for label→identifier)');
	lines.push(...renderFacts(input.priorContext));
	lines.push('');

	const topPreviews = input.priorContext.artifacts.slice(0, MAX_INLINE_ARTIFACTS);
	lines.push(`## Recent artifacts (top-${topPreviews.length} by relevance)`);
	if (topPreviews.length === 0) {
		lines.push('(none)');
	} else {
		for (let i = 0; i < topPreviews.length; i++) {
			lines.push(...renderArtifactBlock(i, topPreviews[i]!));
		}
	}
	lines.push('');

	if (inlineFullArtifacts !== undefined && inlineFullArtifacts.length > 0) {
		lines.push('## Full artifact bodies (you requested these last pass)');
		for (let i = 0; i < inlineFullArtifacts.length; i++) {
			const a = inlineFullArtifacts[i]!;
			lines.push(`[${i + 1}] artifact_id: ${a.artifactId}  skill: ${a.skillId}`);
			lines.push('```json');
			lines.push(stringifyAndCap(a.value, FULL_INLINE_MAX_BYTES));
			lines.push('```');
		}
		lines.push('');
	}

	if (retryHint !== undefined) {
		lines.push('## Note');
		lines.push(`Your previous attempt was rejected: ${retryHint}`);
		lines.push('Return ONLY a JSON object matching the schema; no other text.');
	}

	return [
		{ role: 'system', content: SYSTEM_PROMPT },
		{ role: 'user',   content: lines.join('\n') },
	];
}

function renderFacts(priorContext: PriorContext): string[] {
	const out: string[] = [];
	const { facts } = priorContext;

	out.push(`### Modules (${facts.modules?.length ?? 0})`);
	if (facts.modules !== undefined && facts.modules.length > 0) {
		for (const m of facts.modules) {
			const labelPart = m.label !== undefined ? `  (label: "${m.label}")` : '';
			const sizePart  = m.fileCount !== undefined ? `  ${m.fileCount} files` : '';
			out.push(`- ${m.path}${labelPart}${sizePart}`);
		}
	} else {
		out.push('(none)');
	}

	out.push(`### Entities (${facts.entities?.length ?? 0})`);
	if (facts.entities !== undefined && facts.entities.length > 0) {
		for (const e of facts.entities) {
			const filePart = e.file !== undefined ? `  in ${e.file}` : '';
			out.push(`- ${e.kind} \`${e.name}\` (id: ${e.entityRef})${filePart}`);
		}
	} else {
		out.push('(none)');
	}

	out.push(`### Tables (${facts.tables?.length ?? 0})`);
	if (facts.tables !== undefined && facts.tables.length > 0) {
		for (const t of facts.tables) {
			const colPart = t.columns !== undefined && t.columns.length > 0
				? `  cols: ${t.columns.slice(0, 6).join(', ')}${t.columns.length > 6 ? ', ...' : ''}`
				: '';
			out.push(`- ${t.connectionId}.${t.name}${colPart}`);
		}
	} else {
		out.push('(none)');
	}

	out.push(`### ORM models (${facts.ormModels?.length ?? 0})`);
	if (facts.ormModels !== undefined && facts.ormModels.length > 0) {
		for (const o of facts.ormModels) {
			const tablePart = o.table !== undefined ? ` -> ${o.table}` : '';
			out.push(`- ${o.dialect}: ${o.name}${tablePart}`);
		}
	} else {
		out.push('(none)');
	}

	return out;
}

function renderArtifactBlock(index: number, a: RetrievedArtifact): string[] {
	const ageMs = Date.now() - a.timestamp;
	const ageStr = humanAge(ageMs);
	const previewBytes = Math.min(a.preview.length, PREVIEW_MAX_BYTES);
	const truncated = a.preview.length > PREVIEW_MAX_BYTES;
	return [
		`[${index + 1}] score=${a.score.toFixed(2)}  intent=${a.intent}  age=${ageStr}  ${a.skillId}`,
		`    artifact_id: ${a.id}`,
		`    spill_path:  ${a.path}`,
		`    preview (${previewBytes} bytes${truncated ? ', truncated' : ''}):`,
		'    ```json',
		'    ' + a.preview.slice(0, PREVIEW_MAX_BYTES).replace(/\n/g, '\n    '),
		'    ```',
	];
}

function humanAge(ms: number): string {
	if (ms < 0) return '0s';
	const s = Math.floor(ms / 1000);
	if (s < 60)        return `${s}s`;
	if (s < 60 * 60)   return `${Math.floor(s / 60)}m`;
	return `${Math.floor(s / 3600)}h`;
}

function stringifyAndCap(value: unknown, max: number): string {
	let raw: string;
	try {
		raw = JSON.stringify(value, null, 2);
	} catch {
		raw = '<unserializable>';
	}
	return raw.length <= max ? raw : raw.slice(0, max) + '\n... <truncated>';
}

// ---------------------------------------------------------------------------
// Output parsing + validation
// ---------------------------------------------------------------------------

function parseAndValidate(raw: string, priorContext: PriorContext): ParseResult {
	const text = stripFences(raw).trim();
	if (text.length === 0) {
		return { ok: false, failure: 'empty response' };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		return { ok: false, failure: `JSON parse failed: ${(err as Error).message}` };
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { ok: false, failure: 'output must be a JSON object' };
	}
	const obj = parsed as Record<string, unknown>;

	const enhancedQuestion = obj['enhancedQuestion'];
	if (typeof enhancedQuestion !== 'string' || enhancedQuestion.length === 0) {
		return { ok: false, failure: 'enhancedQuestion must be a non-empty string' };
	}

	const citedRaw = obj['citedArtifactIds'];
	if (!Array.isArray(citedRaw)) {
		return { ok: false, failure: 'citedArtifactIds must be an array' };
	}
	const knownIds = new Set(priorContext.artifacts.map(a => a.id));
	const cited: string[] = [];
	for (const c of citedRaw) {
		if (typeof c !== 'string' || c.length === 0) {
			return { ok: false, failure: 'citedArtifactIds entries must be non-empty strings' };
		}
		// Soft validation: cited ids that don't appear in priorContext
		// are dropped, not rejected. The LLM may reference an id from a
		// fact-mined source that wasn't in the top-K previews -- those
		// are valid citations even if the artifact wasn't shown
		// inline. Strict-reject would throw away signal.
		if (knownIds.has(c)) cited.push(c);
	}

	const reqRaw = obj['requestArtifactIds'];
	if (!Array.isArray(reqRaw)) {
		return { ok: false, failure: 'requestArtifactIds must be an array' };
	}
	const requested: string[] = [];
	for (const r of reqRaw) {
		if (typeof r !== 'string' || r.length === 0) {
			return { ok: false, failure: 'requestArtifactIds entries must be non-empty strings' };
		}
		if (!knownIds.has(r)) {
			return { ok: false, failure: `requestArtifactIds contains unknown id '${r}'` };
		}
		requested.push(r);
	}

	const notesRaw = obj['notes'];
	if (notesRaw !== undefined && !Array.isArray(notesRaw)) {
		return { ok: false, failure: 'notes must be an array (or omitted)' };
	}
	const notes: string[] = [];
	if (Array.isArray(notesRaw)) {
		for (const n of notesRaw) {
			if (typeof n === 'string') notes.push(n);
		}
	}

	return {
		ok: true,
		value: {
			enhancedQuestion,
			citedArtifactIds:   cited,
			requestArtifactIds: requested,
			notes,
		},
	};
}

function stripFences(text: string): string {
	const m = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(text);
	return m === null ? text : m[1]!;
}

// ---------------------------------------------------------------------------
// Re-fetch loader
// ---------------------------------------------------------------------------

async function loadFullArtifacts(
	priorContext: PriorContext,
	ids: readonly string[],
): Promise<InlineFullArtifact[]> {
	const byId = new Map<string, RetrievedArtifact>(
		priorContext.artifacts.map(a => [a.id, a]),
	);
	const out: InlineFullArtifact[] = [];
	for (const id of ids) {
		const a = byId.get(id);
		if (a === undefined) continue;
		try {
			const txt = await fs.readFile(a.path, 'utf8');
			const envelope = JSON.parse(txt) as { value?: unknown; skill_id?: string };
			out.push({
				artifactId: id,
				skillId:    envelope.skill_id ?? a.skillId,
				value:      envelope.value ?? null,
			});
		} catch (err) {
			log.warn({ id, path: a.path, err: errMessage(err) }, 'enhancer: failed to load artifact body');
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function passThrough(originalMessage: string, notes: readonly string[]): EnhancerOutput {
	return {
		enhancedQuestion:   originalMessage,
		citedArtifactIds:   [],
		requestArtifactIds: [],
		notes,
	};
}

function errMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

export const _parseAndValidateForTest = parseAndValidate;
export const _buildMessagesForTest    = buildMessages;
export const _stripFencesForTest      = stripFences;
export const MAX_REQUESTED_REFETCHES_FOR_TEST = MAX_REQUESTED_REFETCHES;
export const MAX_INLINE_ARTIFACTS_FOR_TEST    = MAX_INLINE_ARTIFACTS;
