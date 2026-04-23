/**
 * Generic classifier types. Daemon-layer and agent-layer code both
 * consume these; keep it dependency-free.
 *
 * The classifier module itself lives at `src/insrc/agent/classify/`.
 */

/**
 * Scope / size estimate for the work the user is asking for. Always
 * returned alongside the class id so downstream agents can adapt
 * (how many ideas to seed, Pair vs Delegate routing, single-turn vs
 * multi-round planning, etc.).
 *
 *   S      -- one small, localized change (minutes)
 *   M      -- a few related changes in one module (single session)
 *   L      -- a feature or module-sized piece of work (multi-session)
 *   XL     -- subsystem-scale change spanning several modules
 *   XXL    -- multi-subsystem change (auth + storage + UI, etc.)
 *   XXXL   -- cross-cutting architectural change
 *   XXXXL  -- major rewrite / new product direction
 *
 * When the LLM doesn't return a recognizable scope, callers get 'M'
 * (the safe "normal" default). `fallback: true` lets callers
 * distinguish a guessed scope from a confidently-emitted one.
 */
export type ScopeSize = 'S' | 'M' | 'L' | 'XL' | 'XXL' | 'XXXL' | 'XXXXL';

/**
 * Human-readable metadata for each scope tier. Consumed by the UI for
 * the intent pill / logs for operator readability / downstream agents
 * that want to quote the tier to the user.
 *
 * `label` is a two-word headline suitable for a chip / pill.
 * `description` is a one-liner suitable for a tooltip or log line.
 */
export interface ScopeMeta {
  readonly label: string;
  readonly description: string;
}

export const SCOPE_META: Readonly<Record<ScopeSize, ScopeMeta>> = {
  S: {
    label: 'Small',
    description: 'one small, localized change (minutes of work)',
  },
  M: {
    label: 'Medium',
    description: 'a few related changes in one module (single session)',
  },
  L: {
    label: 'Large',
    description: 'a feature or module-sized piece of work (multi-session)',
  },
  XL: {
    label: 'Extra-Large',
    description: 'subsystem-scale change spanning several modules',
  },
  XXL: {
    label: 'Double-XL',
    description: 'multi-subsystem change (e.g. auth + storage + UI)',
  },
  XXXL: {
    label: 'Triple-XL',
    description: 'cross-cutting architectural change',
  },
  XXXXL: {
    label: 'Quadruple-XL',
    description: 'major rewrite or new product direction',
  },
};

/** Ordered scope tiers, smallest to largest. */
export const SCOPE_ORDER: readonly ScopeSize[] = ['S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'XXXXL'];

/** Convenience: label for a scope tier. */
export function scopeLabel(scope: ScopeSize): string {
  return SCOPE_META[scope].label;
}

/** Convenience: description for a scope tier. */
export function scopeDescription(scope: ScopeSize): string {
  return SCOPE_META[scope].description;
}

/** One class the caller wants the LLM to consider. */
export interface ClassChoice {
  /** Machine-readable key returned to the caller. */
  readonly id: string;
  /** Short human-readable label shown in the prompt. Defaults to `id`. */
  readonly label?: string;
  /**
   * One-line description of what the class means. Strongly encouraged
   * -- without it the LLM has to guess from the `id` alone.
   */
  readonly description?: string;
}

export interface ClassifyInput {
  /** The classes to choose from. Order preserved. */
  readonly classes: readonly ClassChoice[];
  /** The user / system text to classify. */
  readonly text: string;
  /**
   * Optional context appended to the prompt. Free-form string --
   * anything the caller wants the LLM to know (prior intent,
   * selected entity, previous user turn, etc.).
   */
  readonly context?: string;
  /**
   * Optional role label for the prompt preamble ("You are a <role>...").
   * Defaults to "classifier".
   */
  readonly role?: string;
}

export interface ClassifyResult {
  /**
   * The `id` of the chosen class. Always one of `classes[i].id`.
   * When the LLM returned an unknown id or errored, falls back to
   * `classes[0].id` and `fallback: true`.
   */
  readonly id: string;
  /** 0..1 confidence the LLM reported. Clamped. */
  readonly confidence: number;
  /** One-sentence reasoning the LLM gave. May be empty. */
  readonly reasoning: string;
  /**
   * Scope / size estimate. Always present -- defaults to 'M' when
   * the LLM omits it or returns an unrecognized value.
   */
  readonly scope: ScopeSize;
  /**
   * True when the LLM errored / returned unparseable output / returned
   * an id not in `classes`. The caller decides whether to retry.
   */
  readonly fallback: boolean;
}
