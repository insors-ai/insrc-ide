/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Per-handoff cost meter (plans/external-agent-integration.md §5.2).
 *
 * Tracks the rough resource footprint of a single handoff:
 *
 *   - Wall-time: from `spec-assembling` to one of the terminal stages
 *     (`handoff-final` / `handoff-error`).
 *   - Token estimate: characters-in/out turned into tokens via the
 *     same chars-per-token ratio the rest of the agent uses
 *     (default 3 chars per token). Stdout/stderr from the agent
 *     subprocess + the assembled spec are the size signals -- we
 *     don't have first-class token counts from the external CLIs
 *     today, so the estimate is intentionally a coarse upper bound.
 *   - Subprocess exit code + duration: pulled from `agent-completed`.
 *   - Verdict: pulled from `audit-ready`.
 *   - Mode B prompt counts: how many tool prompts got escalated and
 *     how the user resolved them.
 *
 * The meter never throws. Update calls are cheap and idempotent.
 *
 * Output: callers read {@link CostMeter.snapshot} on close and
 * persist the result to `<persistRoot>/<sessionId>/<specId>.cost.json`
 * (the runHandoff orchestrator does this in the same persist
 * step that writes `.audit.json` / `.deliverable.md`).
 */

import type { HandoffEvent } from '../types.js';

export interface CostSnapshot {
	readonly startedAt:        number;
	readonly endedAt:          number | undefined;
	readonly durationMs:       number;
	readonly specMdChars:      number;
	readonly stdoutChars:      number;
	readonly stderrChars:      number;
	/** chars-per-token used to derive `estimatedTokens`. */
	readonly charsPerToken:    number;
	readonly estimatedTokens:  number;
	readonly agentExitCode:    number | undefined;
	readonly agentDurationMs:  number | undefined;
	readonly verdict:          'accept' | 'revise-edits' | 'revise-major' | undefined;
	readonly errorStage:       string | undefined;
	readonly modeBPromptCount: number;
	readonly modeBAllowCount:  number;
	readonly modeBDenyCount:   number;
	readonly diffBytes:        number | undefined;
}

export interface CostMeter {
	/**
	 * Update the running meter for one event. Cheap; meant to be
	 * called from the runHandoff event loop alongside trace writes.
	 */
	record(event: HandoffEvent): void;
	/**
	 * Add a chunk's character count (Phase 2c chunk stream).
	 * Called separately from `record` because chunks come on a
	 * different fan-out today and we want to avoid event-shape
	 * coupling with the meter.
	 */
	recordChunk(stream: 'stdout' | 'stderr', chars: number): void;
	/**
	 * Record the assembled spec text so the meter has a full
	 * char count for the token estimate (the `spec-ready` event
	 * only carries the 200-char preview). Idempotent: only the
	 * largest length wins.
	 */
	recordSpec(specMd: string): void;
	/** Mark the meter as ended. Idempotent. */
	finalize(): void;
	/** Read the current state. Safe to call before or after finalize. */
	snapshot(): CostSnapshot;
}

export interface OpenCostMeterOpts {
	/** Test seam: deterministic clock. Defaults to Date.now. */
	readonly nowMs?:        (() => number) | undefined;
	readonly charsPerToken?: number | undefined;
}

const DEFAULT_CHARS_PER_TOKEN = 3;

export function openCostMeter(opts: OpenCostMeterOpts = {}): CostMeter {
	const now = opts.nowMs ?? (() => Date.now());
	const charsPerToken = opts.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;

	const startedAt = now();
	let endedAt: number | undefined;
	let specMdChars = 0;
	let stdoutChars = 0;
	let stderrChars = 0;
	let agentExitCode: number | undefined;
	let agentDurationMs: number | undefined;
	let verdict: 'accept' | 'revise-edits' | 'revise-major' | undefined;
	let errorStage: string | undefined;
	let modeBPromptCount = 0;
	let modeBAllowCount  = 0;
	let modeBDenyCount   = 0;
	let diffBytes: number | undefined;

	const buildSnapshot = (): CostSnapshot => {
		const end = endedAt ?? now();
		const totalChars = specMdChars + stdoutChars + stderrChars;
		const estimatedTokens = Math.ceil(totalChars / charsPerToken);
		return {
			startedAt,
			endedAt,
			durationMs: end - startedAt,
			specMdChars,
			stdoutChars,
			stderrChars,
			charsPerToken,
			estimatedTokens,
			agentExitCode,
			agentDurationMs,
			verdict,
			errorStage,
			modeBPromptCount,
			modeBAllowCount,
			modeBDenyCount,
			diffBytes,
		};
	};

	return {
		record(event: HandoffEvent): void {
			switch (event.kind) {
				case 'spec-ready':
					// `preview` is the first 200 chars; the full spec
					// chars are added separately if the caller wants
					// (we don't have access to the assembled spec at
					// event time). Default to the preview length so
					// the floor estimate stays nonzero.
					specMdChars = Math.max(specMdChars, event.preview.length);
					break;
				case 'agent-completed':
					agentExitCode   = event.exitCode;
					agentDurationMs = event.durationMs;
					break;
				case 'audit-ready':
					verdict   = event.verdict;
					diffBytes = event.diffBytes;
					break;
				case 'handoff-final':
					verdict = event.verdict;
					if (diffBytes === undefined && event.diff !== undefined) {
						diffBytes = event.diff.length;
					}
					if (endedAt === undefined) endedAt = now();
					break;
				case 'handoff-error':
					errorStage = event.stage;
					if (endedAt === undefined) endedAt = now();
					break;
				case 'mode-b-gate-request':
					modeBPromptCount++;
					break;
				case 'mode-b-gate-resolved':
					if (event.verdict === 'allow') modeBAllowCount++;
					else modeBDenyCount++;
					break;
				default:
					// Other events don't move the meter; intentional fall-through.
					break;
			}
		},
		recordChunk(stream: 'stdout' | 'stderr', chars: number): void {
			if (stream === 'stdout') stdoutChars += chars;
			else                     stderrChars += chars;
		},
		recordSpec(specMd: string): void {
			if (specMd.length > specMdChars) {
				specMdChars = specMd.length;
			}
		},
		finalize(): void {
			if (endedAt === undefined) endedAt = now();
		},
		snapshot(): CostSnapshot {
			return buildSnapshot();
		},
	};
}

