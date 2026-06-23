/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Analyze framework -- top-level barrel.
 *
 * See: design/analyze-framework.md
 */

export { CONTRACT_FOOTER_MD } from './contract.js';
export { shaperFor, PROMPT_PATHS } from './context/index.js';
export { validateAnalyzePrompts, AnalyzePromptValidationError } from './context/boot-validator.js';
export type * from './context/types.js';
