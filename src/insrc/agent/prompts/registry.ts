/**
 * In-memory registry of all PromptWriters. Single global instance
 * per process; tests can swap it out with `_setRegistryForTest`.
 */

import type {
	PromptListFilter,
	PromptRegistry,
	PromptWriter,
	PromptWriterMetadata,
} from './types.js';
import {
	PromptAlreadyRegisteredError,
	PromptNotRegisteredError,
} from './types.js';

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class InMemoryPromptRegistry implements PromptRegistry {
	/** id -> (version -> writer). */
	private readonly byId = new Map<string, Map<number, PromptWriter<unknown, unknown>>>();

	register<TInput, TOutput>(writer: PromptWriter<TInput, TOutput>): void {
		if (writer.id.length === 0) {
			throw new Error('prompt writer id must be non-empty');
		}
		if (!Number.isInteger(writer.version) || writer.version < 1) {
			throw new Error(`prompt writer "${writer.id}" version must be a positive integer (got ${writer.version})`);
		}
		const versions = this.byId.get(writer.id) ?? new Map<number, PromptWriter<unknown, unknown>>();
		if (versions.has(writer.version)) {
			throw new PromptAlreadyRegisteredError(writer.id, writer.version);
		}
		versions.set(writer.version, writer as PromptWriter<unknown, unknown>);
		this.byId.set(writer.id, versions);
	}

	get<TInput, TOutput>(id: string, version?: number): PromptWriter<TInput, TOutput> {
		const versions = this.byId.get(id);
		if (versions === undefined || versions.size === 0) {
			throw new PromptNotRegisteredError(id);
		}
		if (version !== undefined) {
			const exact = versions.get(version);
			if (exact === undefined) {
				throw new PromptNotRegisteredError(id, version);
			}
			return exact as PromptWriter<TInput, TOutput>;
		}
		// Default: highest registered version.
		const highest = Math.max(...versions.keys());
		const writer = versions.get(highest);
		// versions.size > 0 was checked above, so writer is defined.
		return writer as PromptWriter<TInput, TOutput>;
	}

	list(filter?: PromptListFilter): readonly PromptWriterMetadata[] {
		const out: PromptWriterMetadata[] = [];
		for (const [id, versions] of this.byId) {
			if (filter?.idPrefix !== undefined && !id.startsWith(filter.idPrefix)) {
				continue;
			}
			for (const [, writer] of versions) {
				if (filter?.tier !== undefined && writer.tier !== filter.tier) {
					continue;
				}
				out.push({
					id:      writer.id,
					version: writer.version,
					tier:    writer.tier,
					summary: writer.summary,
				});
			}
		}
		out.sort((a, b) => a.id === b.id ? a.version - b.version : a.id.localeCompare(b.id));
		return out;
	}
}

// ---------------------------------------------------------------------------
// Global instance
// ---------------------------------------------------------------------------

let _registry: PromptRegistry = new InMemoryPromptRegistry();

export function getPromptRegistry(): PromptRegistry {
	return _registry;
}

/** Test-only: replace the registry singleton with a fresh empty one. */
export function _resetPromptRegistryForTest(): void {
	_registry = new InMemoryPromptRegistry();
}

/** Test-only: install a specific registry (e.g. a stub). */
export function _setPromptRegistryForTest(reg: PromptRegistry): void {
	_registry = reg;
}
