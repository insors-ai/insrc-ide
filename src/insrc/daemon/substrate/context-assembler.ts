/**
 * Context assembler -- P1.1 of plans/skills/substrate-implementation-status.md.
 *
 * Per substrate doc §"Context assembler" + §"Retrieval design": builds
 * the per-execution briefing for one consumer. Read-only -- consumers
 * mutate memory (via working state + distillation), not context.
 *
 * P1 deltas from the eventual design:
 *   - Memory-only sources. Context providers (D5a) land in P4.
 *   - Default ranking (trichotomy > confidence > recency) is applied
 *     per substrate D4; per-slot custom rankers land later as needed.
 *   - Budget enforcement uses a chars/3 token estimator (the same
 *     ratio used elsewhere in the codebase).
 *   - Cross-slot pressure resolved via proportional truncation; the
 *     `required` / `preferred` / `optional` priority opt-in lands later.
 *   - No caching layer yet; substrate's reproducibility-via-snapshot
 *     story lands when needed.
 */

import { getLogger } from '../../shared/logger.js';

import type { ProviderRegistry } from './provider-registry.js';
import type {
	AssembleRequest,
	AssembledContext,
	ContextBudget,
	ContextBudgetSnapshot,
	ContextQuery,
	ContextSlotRequest,
	EntryKind,
	MemoryEntry,
	MemoryStore,
	ProviderDeps,
} from './types.js';
import { isProviderOwner } from './types.js';

const log = getLogger('substrate:context-assembler');

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateContextAssemblerOpts {
	readonly memory: MemoryStore;
	/**
	 * Optional provider registry. When present, slots whose
	 * `fromOwner` starts with `provider:` route through the registry
	 * instead of memory. When absent, provider slots resolve empty
	 * (back-compat with P1-P2 callers that don't supply providers).
	 */
	readonly providers?: ProviderRegistry;
	/**
	 * Token estimator. Defaults to chars/3 -- matches the existing
	 * codebase convention (see CLAUDE.md "Context management").
	 */
	readonly estimateTokens?: (value: unknown) => number;
}

export interface ContextAssembler {
	assemble(req: AssembleRequest, deps?: AssembleDeps): Promise<AssembledContext>;
}

/**
 * Per-call dependencies the assembler may pass to providers. Optional --
 * the assembler builds a no-op AbortSignal when omitted so tests don't
 * have to fabricate one.
 */
export interface AssembleDeps {
	readonly signal?:  AbortSignal;
	readonly session?: unknown;
}

export function createContextAssembler(opts: CreateContextAssemblerOpts): ContextAssembler {
	const estimateTokens = opts.estimateTokens ?? defaultEstimateTokens;
	return {
		async assemble(req: AssembleRequest, deps?: AssembleDeps): Promise<AssembledContext> {
			return assemble(req, opts.memory, opts.providers, deps, estimateTokens);
		},
	};
}

// ---------------------------------------------------------------------------
// Assembly pipeline
// ---------------------------------------------------------------------------

async function assemble(
	req: AssembleRequest,
	memory: MemoryStore,
	providers: ProviderRegistry | undefined,
	deps: AssembleDeps | undefined,
	estimateTokens: (value: unknown) => number,
): Promise<AssembledContext> {
	const notes: string[] = [];
	const slotResults = new Map<string, MemoryEntry<unknown>[]>();

	// Per-call provider deps -- providers see the AssembleDeps signal +
	// session. Caller's signal is honored; absent means no cancellation.
	const providerDeps: ProviderDeps = {
		signal:  deps?.signal ?? new AbortController().signal,
		...(deps?.session !== undefined ? { session: deps.session } : {}),
	};

	// Per-slot fill.
	for (const slot of req.slots) {
		const entries = await fillSlot(slot, req, memory, providers, providerDeps);
		const ranked = rank(entries);
		const limited = slot.limit !== undefined ? ranked.slice(0, slot.limit) : ranked;

		if (slot.required === true && limited.length === 0) {
			throw new Error(`context-assembler: required slot '${slot.name}' is empty`);
		}

		if (entries.length > limited.length) {
			notes.push(`slot:${slot.name} truncated ${entries.length - limited.length} entries (per-slot limit)`);
		}

		slotResults.set(slot.name, limited);
	}

	// Cross-slot budget enforcement (proportional truncation).
	const budgetUsed = enforceBudget(slotResults, req.budget, estimateTokens, notes);

	log.debug(
		{ owner: req.owner, slotCount: slotResults.size, tokensUsed: budgetUsed.tokensUsed, truncations: notes.length },
		'context:assemble',
	);

	return {
		slots:      slotResults,
		task:       req.task,
		session:    req.session,
		budgetUsed,
		notes,
	};
}

// ---------------------------------------------------------------------------
// Slot filling
// ---------------------------------------------------------------------------

async function fillSlot(
	slot: ContextSlotRequest,
	req: AssembleRequest,
	memory: MemoryStore,
	providers: ProviderRegistry | undefined,
	providerDeps: ProviderDeps,
): Promise<MemoryEntry<unknown>[]> {
	// D5a: provider routing. Slot's `fromOwner` of the form `provider:<id>`
	// routes to the registry; the provider returns transient entries
	// (uncached, tagged with `source.kind: 'provider'`).
	if (isProviderOwner(slot.fromOwner)) {
		if (providers === undefined) {
			log.debug({ slot: slot.name, owner: slot.fromOwner }, 'assemble: provider slot without registry -- empty');
			return [];
		}
		const out = await providers.resolve(slot, providerDeps);
		return out.slice();
	}

	const query: ContextQuery = typeof slot.query === 'function' ? slot.query(req) : slot.query;
	const ns = memory.scope(slot.fromOwner, slot.namespace);

	switch (query.kind) {
		case 'byKey': {
			const got = await ns.get(query.key);
			return got === undefined ? [] : [got];
		}
		case 'prefix': {
			const out: MemoryEntry<unknown>[] = [];
			const scanOpts = query.ascending !== undefined ? { ascending: query.ascending } : {};
			for await (const e of ns.scan(query.prefix, scanOpts)) {
				out.push(e);
			}
			return out;
		}
		case 'filter': {
			const out: MemoryEntry<unknown>[] = [];
			for await (const e of ns.filter(query.predicate)) {
				out.push(e);
			}
			return out;
		}
		case 'byEmbedding': {
			// P2: Lance integration. P1 returns empty.
			return [];
		}
	}
}

// ---------------------------------------------------------------------------
// Ranking (substrate "Retrieval design" §"Ranking")
// ---------------------------------------------------------------------------

function rank(entries: MemoryEntry<unknown>[]): MemoryEntry<unknown>[] {
	return entries.slice().sort((a, b) => {
		// Trichotomy: constraint > fact > hint.
		const kindDiff = kindRank(b.kind) - kindRank(a.kind);
		if (kindDiff !== 0) { return kindDiff; }

		// Confidence DESC.
		if (b.confidence !== a.confidence) { return b.confidence - a.confidence; }

		// Recency DESC.
		return b.writtenAt - a.writtenAt;
	});
}

function kindRank(k: EntryKind): number {
	switch (k) {
		case 'constraint': return 3;
		case 'fact':       return 2;
		case 'hint':       return 1;
	}
}

// ---------------------------------------------------------------------------
// Budget enforcement (D2 caller-owned)
// ---------------------------------------------------------------------------

function enforceBudget(
	slots: Map<string, MemoryEntry<unknown>[]>,
	budget: ContextBudget,
	estimateTokens: (value: unknown) => number,
	notes: string[],
): ContextBudgetSnapshot {
	let totalTokens = 0;
	let totalEntries = 0;
	for (const entries of slots.values()) {
		for (const e of entries) {
			totalTokens += estimateTokens(e.value);
			totalEntries++;
		}
	}

	const maxTokens  = budget.maxTokens;
	const maxEntries = budget.maxEntries;

	const overByTokens  = maxTokens  !== undefined && totalTokens  > maxTokens;
	const overByEntries = maxEntries !== undefined && totalEntries > maxEntries;
	if (!overByTokens && !overByEntries) {
		return { tokensUsed: totalTokens, entriesUsed: totalEntries };
	}

	// Proportional truncation: drop entries from the LOWEST-ranked end of
	// each slot until we fit. Each slot loses entries roughly in
	// proportion to its current consumption. Repeated single-entry drops
	// from the largest contributor until budget is satisfied.
	while (
		(maxTokens  !== undefined && totalTokens  > maxTokens) ||
		(maxEntries !== undefined && totalEntries > maxEntries)
	) {
		const biggestSlot = pickLargestContributor(slots, estimateTokens);
		if (biggestSlot === undefined) { break; }

		const arr = slots.get(biggestSlot)!;
		const dropped = arr.pop();
		if (dropped === undefined) {
			slots.delete(biggestSlot);
			continue;
		}
		totalTokens  -= estimateTokens(dropped.value);
		totalEntries -= 1;
		notes.push(`slot:${biggestSlot} dropped 1 entry (cross-slot budget pressure)`);
	}

	return { tokensUsed: totalTokens, entriesUsed: totalEntries };
}

function pickLargestContributor(
	slots: Map<string, MemoryEntry<unknown>[]>,
	estimateTokens: (value: unknown) => number,
): string | undefined {
	let largest: string | undefined;
	let largestSize = -1;
	for (const [name, arr] of slots) {
		if (arr.length === 0) { continue; }
		const size = arr.reduce((acc, e) => acc + estimateTokens(e.value), 0);
		if (size > largestSize) {
			largest = name;
			largestSize = size;
		}
	}
	return largest;
}

// ---------------------------------------------------------------------------
// Default token estimator
// ---------------------------------------------------------------------------

function defaultEstimateTokens(value: unknown): number {
	let chars: number;
	if (typeof value === 'string') {
		chars = value.length;
	} else {
		try { chars = JSON.stringify(value).length; }
		catch { chars = 256; }
	}
	return Math.ceil(chars / 3);
}
