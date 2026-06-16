/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Context fetcher driver.
 *
 * Top-level entry the orchestrator calls after the cloud LLM emits a `Phase1Ask` of
 * `kind: 'context-needed'`. Loops over the cloud's requested slots in order, dispatches
 * each to its per-slot fetcher (`fetchers.ts`), and aggregates results into a
 * `Phase1Result`.
 *
 * Design ref: [`design/meta-tasks.html`](../../../design/meta-tasks.html) §5.3.
 * Plan ref:   [`plans/meta-tasks.md`](../../../plans/meta-tasks.md) M1.5.
 *
 * The driver does NOT make routing decisions; it has no heuristics about "should we
 * skip this request" or "is this too broad". Those judgments belong to:
 *
 *   - The fetcher itself (emits `needs-narrowing` when too broad).
 *   - The cloud LLM (which sees the resulting `Phase1Result` and decides whether
 *     to retry / refine / proceed).
 *
 * Per-request byte caps are enforced at the slot level; the driver only meters the
 * aggregate elapsed time + total payload bytes.
 */

import { dispatchFetch, type FetchInputs } from './fetchers.js';
import type {
	ContextChunk,
	DeliverableCatalog,
	Phase1Ask,
	Phase1Result,
	ScopeManifest,
} from './types.js';

export interface FulfillOpts {
	readonly scope:    ScopeManifest;
	readonly catalog:  DeliverableCatalog;
	/** Per-request byte cap. Each slot honors this independently; the aggregate
	 *  result can exceed it across requests. Default: 50 KB. */
	readonly byteCap?: number | undefined;
	/** Embedder for `semantic` / `memory` slots. Caller-provided so the driver
	 *  stays free of provider plumbing. */
	readonly embed: (text: string) => Promise<number[]>;
	/** Wall-clock source. Override in tests. */
	readonly now?: (() => number) | undefined;
}

const DEFAULT_BYTE_CAP = 50 * 1024;

/**
 * Fulfill a phase-1 ask. Returns the aggregated `Phase1Result`.
 *
 * When `ask.kind === 'sufficient'` this returns `null` -- the orchestrator
 * short-circuits to phase 2 without invoking the local LLM. Returning null
 * (rather than an empty `Phase1Result`) keeps the "cloud declared sufficient"
 * signal distinct from "fetcher ran and found nothing".
 */
export async function fulfill(ask: Phase1Ask, opts: FulfillOpts): Promise<Phase1Result | null> {
	if (ask.kind === 'sufficient') {
		return null;
	}
	const now = opts.now ?? (() => Date.now());
	const byteCap = opts.byteCap ?? DEFAULT_BYTE_CAP;
	const inputs: FetchInputs = {
		scope:   opts.scope,
		catalog: opts.catalog,
		byteCap,
		embed:   opts.embed,
	};

	const t0 = now();
	const chunks: ContextChunk[] = [];
	let totalBytes = 0;
	let droppedRequests = 0;

	for (const request of ask.requests) {
		const chunk = await dispatchFetch(request, inputs);
		chunks.push(chunk);
		if (chunk.status === 'error') {
			droppedRequests += 1;
		}
		// Estimate payload bytes for the meta tally. We don't dedupe across
		// requests; if the cloud asks for the same files twice, both copies
		// count toward the totalBytes meter.
		try { totalBytes += Buffer.byteLength(JSON.stringify(chunk.payload), 'utf8'); }
		catch { /* circular / unserializable payload -- skip */ }
	}

	return {
		chunks,
		meta: {
			totalBytes,
			elapsedMs:       now() - t0,
			droppedRequests,
		},
	};
}
