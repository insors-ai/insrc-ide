/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * P1 stub -- bundle assembler.
 *
 * Phase 1 of plans/analyze-context-builder.md owns this module:
 *   assembleMarkdown(bundle): string
 *     renders the bundle's layers in the fixed order
 *     `system -> focus -> summary -> structure -> surface ->
 *      artefacts -> upstream`, omitting any layer named in
 *     `meta.emptyLayers`, and appending CONTRACT_FOOTER_MD.
 *
 * No business logic in this stub.
 */

import type { AnalyzeContextBundle } from './types.js';

export function assembleMarkdown(_bundle: AnalyzeContextBundle): string {
	throw new Error('analyze/context/bundle.ts: assembleMarkdown is a P1 stub');
}
