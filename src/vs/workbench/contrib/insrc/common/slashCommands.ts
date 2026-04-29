/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Workbench-side mirror of the daemon's slash-command registry
 * (`src/insrc/shared/slash-commands.ts`). The chat input uses this
 * list to drive `/`-autocomplete in the chat panel.
 *
 * Kept in sync by hand for now -- only one entry today; revisit
 * with a build-time generator if the list grows past ~5 entries.
 */

export interface SlashCommand {
	readonly id: string;
	readonly description: string;
	readonly example: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
	{
		id: 'code-analyze',
		description: 'Run a structural code analysis against the active repo.',
		example: '/code-analyze how does the auth middleware work?',
	},
	// Intent shortcuts -- bypass the topic classifier and route directly
	// to the matching agent family. Mirror of src/insrc/shared/slash-commands.ts.
	{
		id: 'design',
		description: 'Designer agent -- iterative per-requirement design with validation gates.',
		example: '/design a token-bucket rate limiter for the public API',
	},
	{
		id: 'plan',
		description: 'Planner agent -- 8-step implementation plan generation.',
		example: '/plan migrate auth from session cookies to JWT',
	},
	{
		id: 'brainstorm',
		description: 'Brainstorm agent -- iterative spec-building from a fuzzy idea.',
		example: '/brainstorm options for cross-region failover',
	},
	{
		id: 'implement',
		description: 'Implement an approved plan or a single-shot change (Pair / Delegate).',
		example: '/implement the rate limiter from the plan',
	},
	{
		id: 'refactor',
		description: 'Refactor existing code without changing behaviour.',
		example: '/refactor extract the retry loop into a helper',
	},
	{
		id: 'test',
		description: 'Tester agent -- write or run tests; never modifies impl code.',
		example: '/test add coverage for the token-bucket edge cases',
	},
	{
		id: 'debug',
		description: 'Pair agent in debug mode -- investigate + fix a specific failure.',
		example: '/debug the 500 on POST /v1/sessions',
	},
	{
		id: 'review',
		description: 'Review a diff, branch, or recent change.',
		example: '/review the last commit',
	},
	{
		id: 'document',
		description: 'Generate or update documentation for a module / API.',
		example: '/document the auth middleware',
	},
	{
		id: 'research',
		description: 'Research agent -- web + external sources, no code modifications.',
		example: '/research current best practices for token-bucket rate limiting',
	},
	{
		id: 'requirements',
		description: 'Requirements agent -- capture acceptance criteria from a fuzzy ask.',
		example: '/requirements the new billing dashboard',
	},
];
