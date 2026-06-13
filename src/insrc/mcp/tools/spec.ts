/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `insrc_spec_*` MCP tools -- only meaningful during an active handoff.
 * Let the external agent ask insrc about the spec it's currently
 * executing (e.g. "what are the acceptance criteria?").
 *
 * Phase 1: stubs only. The backing data structure for specs lands in
 * Phase 2a (spec-assembler.ts). Until then, both tools throw
 * NotImplementedError.
 */

import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { NotImplementedError } from '../types.js';

const specAcceptanceCriteria: ToolDefinition = {
	name:        'insrc_spec_acceptance_criteria',
	description: 'Return the structured acceptance criteria for the active spec, including cited evidence ids per criterion.',
	scope:       'session',
	inputSchema: {
		specId: z.string().min(1).describe('Spec id from INSRC_SPEC_ID env var of the handoff.'),
	},
	async handler() { throw new NotImplementedError('insrc_spec_acceptance_criteria'); },
};

const specContext: ToolDefinition = {
	name:        'insrc_spec_context',
	description: 'Drill into a section of the active spec by topic; returns the pre-rendered section text plus its cited evidence ids.',
	scope:       'session',
	inputSchema: {
		specId: z.string().min(1).describe('Spec id from INSRC_SPEC_ID env var of the handoff.'),
		topic:  z.string().min(1).describe('Topic / section label to fetch.'),
	},
	async handler() { throw new NotImplementedError('insrc_spec_context'); },
};

export const SPEC_TOOLS: readonly ToolDefinition[] = [
	specAcceptanceCriteria,
	specContext,
];
