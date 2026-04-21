/**
 * Brainstorm category types.
 *
 * Moved to shared/brainstorm-classes.ts alongside the class list fed to
 * the generic classifier. This file re-exports for backwards compat
 * with existing importers inside the daemon; new code should import
 * directly from `src/insrc/shared/brainstorm-classes.js`.
 */

export type { BrainstormCategory } from '../../../shared/brainstorm-classes.js';
