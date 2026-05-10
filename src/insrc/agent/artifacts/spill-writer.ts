/**
 * Per-session output spill writer
 * (conversation-flow-refinement.md Phase 2).
 *
 * Wires the skill runner's `onSkillEnd` hook to two side effects:
 *
 *   1. Writes the skill's structured output JSON to the per-session
 *      tmp directory:
 *        ~/.insrc/tmp/<session_id>/<epoch_ms>-<skill_id>.json
 *   2. Embeds a preview of the output and upserts an `artifact_vec`
 *      Lance row keyed by `<session_id>:<timestamp>:<skill_id>`.
 *
 * Both side effects are fail-tolerant: a disk write failure or embed
 * failure is logged + dropped; the skill runner never blocks on
 * spill. Phase 3's retriever consumes the Lance rows; the disk file
 * is the canonical body for the enhancer's `requestArtifactIds`
 * re-fetch round.
 *
 * Cleanup lives in `purgeSession(sessionId)` -- called from the
 * session-close path in agent/session.ts. It deletes the Lance rows
 * + the tmp directory in one shot.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { getLogger } from '../../shared/logger.js';
import { PATHS } from '../../shared/paths.js';
import { embedQuery } from '../../indexer/embedder.js';
import {
	upsertArtifactVec,
	deleteArtifactsForSession,
	type ArtifactVecRow,
} from '../../db/lance/artifact-vec.js';
import { INTENT_TAG_CURRENT } from '../intent/resolver.js';
import type { Session } from '../session.js';
import type { SkillConfidence } from '../../daemon/skills/types.js';

const log = getLogger('spill-writer');

/**
 * Soft cap on the value preview embedded into the Lance row + the
 * inline preview shown in the enhancer prompt. The full body is on
 * disk; the LLM can `requestArtifactIds` to load more.
 */
const PREVIEW_MAX_BYTES = 2048;

/**
 * Hard cap on the value blob serialised to disk. Skill outputs are
 * usually well under this; the cap exists so a misbehaving skill
 * can't fill the user's tmp dir. Truncation is trailing.
 */
const FULL_BLOB_MAX_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SpillRecord {
	readonly id:         string;        // session_id:timestamp:skill_id
	readonly path:       string;        // absolute disk path
	readonly previewLen: number;        // bytes of preview indexed
}

/**
 * Build the `onSkillEnd` callback for a given Session. The callback
 * is what the orchestrator threads into `SkillRunnerDeps.onSkillEnd`
 * when constructing runner deps.
 *
 * Idempotent re-binding: building twice for the same session is
 * cheap; the disk + Lance writes are both keyed on a unique
 * timestamp + skill id so duplicate registration just produces
 * duplicate rows (which is benign for the retriever, but we don't
 * expect it).
 */
export function makeSpillHandler(session: Session): NonNullable<
	import('../../daemon/skills/invoke.js').SkillRunnerDeps['onSkillEnd']
> {
	return async (payload) => {
		try {
			await spillOne(session, payload);
		} catch (err) {
			log.warn(
				{ skillId: payload.skillId, err: errMessage(err) },
				'spill-writer: spill failed (swallowed; skill runner unaffected)',
			);
		}
	};
}

interface SpillPayload {
	readonly skillId:    string;
	readonly input:      unknown;
	readonly value:      unknown;
	readonly confidence: SkillConfidence;
	readonly notes:      readonly string[];
	readonly durationMs: number;
}

async function spillOne(session: Session, payload: SpillPayload): Promise<SpillRecord> {
	const intent = readIntentTag(session) || 'unknown';
	const ts     = Date.now();
	const id     = `${session.id}:${ts}:${payload.skillId}`;
	const dir    = PATHS.sessionTmp(session.id);
	const file   = join(dir, `${ts}-${safeSkillIdForPath(payload.skillId)}.json`);

	const fullBlob = JSON.stringify({
		session_id: session.id,
		timestamp:  ts,
		intent,
		skill_id:   payload.skillId,
		skill_input: payload.input,
		value:      payload.value,
		confidence: payload.confidence,
		notes:      payload.notes,
		durationMs: payload.durationMs,
	}, null, 2);

	const truncated = fullBlob.length > FULL_BLOB_MAX_BYTES;
	const onDisk    = truncated
		? fullBlob.slice(0, FULL_BLOB_MAX_BYTES) + '\n... <truncated>'
		: fullBlob;

	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(file, onDisk, 'utf8');

	// Embed a preview of the value blob (not the full envelope -- the
	// envelope adds noise like timestamp + duration that biases the
	// vector). Fall back to a synthetic stand-in when the value isn't
	// embeddable (empty / null / non-JSON-stringifiable).
	const previewSrc = previewOf(payload.value);
	const embedSrc   = previewSrc.length > 0
		? `${payload.skillId}\n${previewSrc}`
		: payload.skillId;

	let vec: number[] = [];
	try {
		vec = await embedQuery(embedSrc);
	} catch (err) {
		log.warn(
			{ skillId: payload.skillId, err: errMessage(err) },
			'spill-writer: embed failed -- writing Lance row with empty vector (still discoverable by id)',
		);
	}

	const row: ArtifactVecRow = {
		id,
		embedding:  vec,
		session_id: session.id,
		intent,
		skill_id:   payload.skillId,
		timestamp:  BigInt(ts),
		path:       file,
		preview:    previewSrc.slice(0, PREVIEW_MAX_BYTES),
	};
	if (vec.length > 0) {
		await upsertArtifactVec(row);
	} else {
		log.info({ id }, 'spill-writer: skipped Lance upsert -- empty vector');
	}

	return { id, path: file, previewLen: row.preview.length };
}

/**
 * Drop every artefact for a session. Called from `Session.close()`.
 * Both the Lance rows and the disk directory are removed; failures
 * are logged but don't propagate (close should never throw).
 */
export async function purgeSession(session: Session): Promise<void> {
	const dir = PATHS.sessionTmp(session.id);
	try {
		const removed = await deleteArtifactsForSession(session.id);
		log.info({ sessionId: session.id, lanceRowsRemoved: removed }, 'spill-writer: lance rows purged');
	} catch (err) {
		log.warn({ sessionId: session.id, err: errMessage(err) }, 'spill-writer: lance purge failed');
	}
	try {
		await fs.rm(dir, { recursive: true, force: true });
		log.info({ sessionId: session.id, dir }, 'spill-writer: tmp dir purged');
	} catch (err) {
		log.warn({ sessionId: session.id, dir, err: errMessage(err) }, 'spill-writer: tmp dir purge failed');
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readIntentTag(session: Session): string {
	try {
		return session.contextManager.getTag(INTENT_TAG_CURRENT);
	} catch {
		return '';
	}
}

function previewOf(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'string') return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/**
 * Make a skill id safe for a file name: dots are fine on POSIX +
 * macOS but `/` and other path separators would break the filename.
 * Skills today use dotted-lowercase ids (no slashes), so this is
 * defensive against future ids.
 */
function safeSkillIdForPath(skillId: string): string {
	return skillId.replace(/[/\\:]/g, '_');
}

function errMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

export const _previewOfForTest         = previewOf;
export const _safeSkillIdForPathForTest = safeSkillIdForPath;
export const PREVIEW_MAX_BYTES_FOR_TEST = PREVIEW_MAX_BYTES;
export const FULL_BLOB_MAX_BYTES_FOR_TEST = FULL_BLOB_MAX_BYTES;
