/**
 * Context-provider registry -- P4.1 of plans/skills/substrate-implementation-status.md.
 *
 * Holds the set of `ContextProvider`s the assembler can route slot
 * requests to. Per substrate doc §D5a:
 *
 *   - Providers are first-class registered components.
 *   - Slot requests target them via `fromOwner: 'provider:<id>'`.
 *   - Read-only, no writes / feedback / distillation.
 *   - Entries returned MUST carry `source.kind: 'provider:<id>'` so
 *     consumers + grounding can tell what came from where.
 *
 * P4 deltas from the eventual D5a design:
 *   - Synchronous lookup only (no async resolution / lazy load).
 *   - No per-call timeout enforcement -- providers are trusted to be
 *     cheap. A misbehaving provider blocks assembly; telemetry that
 *     surfaces slow providers lands when needed.
 */

import { getLogger } from '../../shared/logger.js';

import type {
	ContextProvider,
	ContextSlotRequest,
	MemoryEntry,
	ProviderDeps,
} from './types.js';
import { isProviderOwner, providerIdOf } from './types.js';

const log = getLogger('substrate:provider-registry');

// ---------------------------------------------------------------------------

export interface ProviderRegistry {
	register(provider: ContextProvider): void;
	deregister(id: string): void;
	get(id: string): ContextProvider | undefined;
	/**
	 * Route a slot to its provider. Returns [] if `slot.fromOwner` is
	 * not a provider owner or no provider is registered for the id.
	 * The assembler stamps entries with the right source tag.
	 */
	resolve(slot: ContextSlotRequest, deps: ProviderDeps): Promise<readonly MemoryEntry<unknown>[]>;
}

export function createProviderRegistry(): ProviderRegistry {
	const providers = new Map<string, ContextProvider>();

	return {
		register(provider: ContextProvider): void {
			if (providers.has(provider.id)) {
				log.warn({ providerId: provider.id }, 'provider-registry: replacing existing provider');
			}
			providers.set(provider.id, provider);
			log.debug({ providerId: provider.id, schemaVersion: provider.schemaVersion }, 'provider-registry: register');
		},

		deregister(id: string): void {
			providers.delete(id);
		},

		get(id: string): ContextProvider | undefined {
			return providers.get(id);
		},

		async resolve(slot: ContextSlotRequest, deps: ProviderDeps): Promise<readonly MemoryEntry<unknown>[]> {
			if (!isProviderOwner(slot.fromOwner)) {
				log.debug({ slot: slot.name, owner: slot.fromOwner }, 'provider-registry: slot is not a provider slot');
				return [];
			}

			const id = providerIdOf(slot.fromOwner);
			const provider = providers.get(id);
			if (provider === undefined) {
				log.warn({ slot: slot.name, providerId: id }, 'provider-registry: no provider registered');
				return [];
			}

			const entries = await provider.read(slot, deps);
			return stampProviderSource(entries, id);
		},
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Ensure every entry from a provider is tagged with the right source.
 * Per D5a §"Provider entries tagged in context" -- consumers + grounding-
 * review must be able to tell provider data from memory data. We rewrite
 * the source here so a sloppy provider can't escape the contract.
 */
function stampProviderSource(
	entries: readonly MemoryEntry<unknown>[],
	providerId: string,
): readonly MemoryEntry<unknown>[] {
	return entries.map(e => ({
		...e,
		source: { kind: 'provider' as const, providerId },
	}));
}
