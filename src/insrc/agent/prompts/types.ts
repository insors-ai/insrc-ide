/**
 * PromptWriter abstraction (Phase 0 of
 * `plans/section-flow-architecture-redesign.md`).
 *
 * Every prompt the section-flow sends to an LLM is built by a
 * registered `PromptWriter`. Writers are versioned + tier-scoped
 * (local vs cloud) so:
 *
 *   - Old versions stay runnable for rollback / A/B comparison.
 *   - The orchestrator can pin specific versions via config without
 *     code churn.
 *   - Telemetry can report which (writer-id, version) ran for every
 *     LLM call.
 *
 * The interface is generic over both input (the typed context the
 * caller passes) and output (usually `readonly LLMMessage[]`, but
 * some writers may emit different shapes -- e.g. a tool definition
 * for `submit_skill_args`).
 */

import type { LLMMessage } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type PromptTier = 'local' | 'cloud';

export interface PromptWriter<TInput, TOutput = readonly LLMMessage[]> {
	/** Stable identifier (e.g. `"shape-resolver"`). */
	readonly id:       string;
	/** Bumped on incompatible changes; same number for back-compat additions. */
	readonly version:  number;
	/** Drives provider routing AND test-tier selection. */
	readonly tier:     PromptTier;
	/** One-line "what this prompt does" -- shown in registry listings + logs. */
	readonly summary:  string;

	build(input: TInput): TOutput;

	/**
	 * Optional response schema for callers that expect a typed output.
	 * Most writers leave this undefined; structured-JSON writers carry
	 * a JSON-Schema-like object that the provider passes as
	 * `responseFormat.schema`. Kept as `unknown` here so the prompts
	 * module doesn't have to pull in a schema-validation dependency.
	 */
	readonly responseFormat?: unknown | undefined;
}

/**
 * Lightweight metadata used by the registry's `list` method for
 * introspection / telemetry. Stripped of the `build` function +
 * the `responseFormat` blob to keep listing cheap.
 */
export interface PromptWriterMetadata {
	readonly id:       string;
	readonly version:  number;
	readonly tier:     PromptTier;
	readonly summary:  string;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Filter shape for `list()`. Composable; all fields are optional and
 * narrow the result set.
 */
export interface PromptListFilter {
	readonly tier?:    PromptTier | undefined;
	readonly idPrefix?: string    | undefined;
}

/**
 * The registry is the single source of truth for which writers exist
 * at which versions. Lookup is by id (returns the highest registered
 * version by default) or id+version (returns the exact match, throws
 * if not registered).
 */
export interface PromptRegistry {
	register<TInput, TOutput>(writer: PromptWriter<TInput, TOutput>): void;
	get<TInput, TOutput = readonly LLMMessage[]>(
		id:       string,
		version?: number,
	): PromptWriter<TInput, TOutput>;
	list(filter?: PromptListFilter): readonly PromptWriterMetadata[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown by `get` when the requested id (or id+version) is not registered. */
export class PromptNotRegisteredError extends Error {
	constructor(id: string, version?: number) {
		super(version === undefined
			? `prompt writer "${id}" is not registered`
			: `prompt writer "${id}" version ${version} is not registered`);
		this.name = 'PromptNotRegisteredError';
	}
}

/** Thrown by `register` when the same (id, version) pair is registered twice. */
export class PromptAlreadyRegisteredError extends Error {
	constructor(id: string, version: number) {
		super(`prompt writer "${id}" version ${version} is already registered`);
		this.name = 'PromptAlreadyRegisteredError';
	}
}
