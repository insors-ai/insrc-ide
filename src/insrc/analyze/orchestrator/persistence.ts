/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Persistence for the orchestrator's RunRecord (<runRoot>/run.json).
 *
 * The orchestrator stamps a fresh record at run start, then patches
 * the same file at every stage transition + at the terminal end.
 * Atomic write via tmp+rename so partial files never leak.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { getLogger } from '../../shared/logger.js';
import { PATHS } from '../../shared/paths.js';

import type { RunRecord } from './types.js';

const log = getLogger('analyze:orchestrator:persistence');

export function runRecordPathFor(runId: string): string {
	return PATHS.analyzeRunRecord(runId);
}

export function readRunRecord(runId: string): RunRecord | null {
	const path = runRecordPathFor(runId);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, 'utf8')) as RunRecord;
	} catch (err) {
		log.warn({ path, err: (err as Error).message }, 'run record unreadable; treating as miss');
		return null;
	}
}

export function writeRunRecord(record: RunRecord): string {
	const path = runRecordPathFor(record.runId);
	atomicWriteJson(path, record);
	log.debug(
		{ runId: record.runId, stage: record.stage, status: record.status },
		'wrote run record',
	);
	return path;
}

/** Test-only -- remove the entire run dir. Production cleanup is the
 *  analyze.run.purge IPC (separate phase). */
export function purgeRunForTests(runId: string): void {
	const dir = dirname(runRecordPathFor(runId));
	try { rmSync(dir, { recursive: true }); }
	catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
			log.debug({ dir, err: (err as Error).message }, 'purgeRunForTests: non-ENOENT');
		}
	}
}

function atomicWriteJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const json = JSON.stringify(value, null, '\t');
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, json, 'utf8');
	renameSync(tmp, path);
}
