/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Boot-time validator -- asserts every shaper's prompt file exists +
 * is non-empty before the daemon starts serving requests.
 *
 * Failure mode: the daemon refuses to start. We throw a typed error
 * so the caller (daemon/index.ts main loop) can log + exit cleanly
 * instead of bumping into the missing file later, at runtime, when a
 * shaper invocation tries to load it.
 *
 * The rationale: a missing prompt makes the affected shaper unusable.
 * Detecting this at boot turns a runtime "scope not analyzable" error
 * into a startup-refusal log line, which is easier to triage.
 *
 * Tests: src/insrc/analyze/context/__tests__/boot-validator.test.ts
 * Wiring: src/insrc/daemon/index.ts (between tool registration and
 * accepting requests).
 */

import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getLogger } from '../../shared/logger.js';

import { PROMPT_PATHS } from './index.js';
import type { ShaperId } from './types.js';

const log = getLogger('analyze:context:boot-validator');

export class AnalyzePromptValidationError extends Error {
	readonly missing: readonly { shaperId: ShaperId; path: string; reason: string }[];

	constructor(missing: { shaperId: ShaperId; path: string; reason: string }[]) {
		const list = missing
			.map(m => `  - ${m.shaperId}: ${m.path} (${m.reason})`)
			.join('\n');
		super(
			`analyze: shaper prompt validation failed:\n${list}\n` +
				'Fix: ensure every prompts/analyze/<shaper>.system.md exists and is non-empty.',
		);
		this.name = 'AnalyzePromptValidationError';
		this.missing = missing;
	}
}

/**
 * Validate every prompt file declared in PROMPT_PATHS.
 *
 * Returns silently on success. Throws AnalyzePromptValidationError
 * listing every failure on the first failed shaper.
 *
 * Implementation:
 *   - Resolve the relative path against the insrc root (same resolver
 *     the driver uses at request time -- single source of truth for
 *     where prompts live).
 *   - stat -> readFileSync. ENOENT, empty body (length 0 after trim),
 *     and read errors are all collected into `missing` so the user
 *     gets the full picture in one go.
 *   - Successful prompts are debug-logged so the daemon log carries
 *     a record of which prompts loaded cleanly.
 */
export function validateAnalyzePrompts(): void {
	const failures: { shaperId: ShaperId; path: string; reason: string }[] = [];

	for (const [shaperIdRaw, relPath] of Object.entries(PROMPT_PATHS)) {
		const shaperId = shaperIdRaw as ShaperId;
		const abs = isAbsolute(relPath) ? relPath : resolveRelativeToInsrcRoot(relPath);

		try {
			statSync(abs);
		} catch (err) {
			failures.push({
				shaperId,
				path:   abs,
				reason: (err as NodeJS.ErrnoException).code === 'ENOENT'
					? 'file not found'
					: `stat failed: ${(err as Error).message}`,
			});
			continue;
		}

		let body: string;
		try {
			body = readFileSync(abs, 'utf8');
		} catch (err) {
			failures.push({
				shaperId,
				path:   abs,
				reason: `read failed: ${(err as Error).message}`,
			});
			continue;
		}

		if (body.trim().length === 0) {
			failures.push({ shaperId, path: abs, reason: 'file is empty' });
			continue;
		}

		log.debug({ shaperId, path: abs, bytes: body.length }, 'shaper prompt loaded');
	}

	if (failures.length > 0) {
		throw new AnalyzePromptValidationError(failures);
	}

	log.info({ count: Object.keys(PROMPT_PATHS).length }, 'shaper prompts validated');
}

function resolveRelativeToInsrcRoot(relativePath: string): string {
	const thisFile = fileURLToPath(import.meta.url);
	// .../analyze/context/boot-validator.js -> ... -> .../insrc
	const insrcRoot = resolve(thisFile, '..', '..', '..');
	return resolve(insrcRoot, relativePath);
}
