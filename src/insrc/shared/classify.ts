/**
 * Generic classifier types. Daemon-layer and agent-layer code both
 * consume these; keep it dependency-free.
 *
 * The classifier module itself lives at `src/insrc/agent/classify/`.
 */

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
   * True when the LLM errored / returned unparseable output / returned
   * an id not in `classes`. The caller decides whether to retry.
   */
  readonly fallback: boolean;
}
