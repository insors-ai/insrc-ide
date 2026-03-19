/**
 * Brainstorm controller module — re-exports for all sub-controllers.
 */

export { BrainstormControllerBase } from './base.js';
export { RequirementsBrainstormController } from './requirements.js';
export type { BrainstormCategory } from './types.js';

// Backward compat: default export is requirements (current behavior)
export { RequirementsBrainstormController as BrainstormController } from './requirements.js';
