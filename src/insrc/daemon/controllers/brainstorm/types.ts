/**
 * Brainstorm category types.
 *
 * Each category produces a different kind of output through
 * category-specific prompts, templates, convergence logic, and
 * Claude review criteria.
 */

export type BrainstormCategory =
  | 'requirements'
  | 'design'
  | 'implementation'
  | 'testing'
  | 'general';
