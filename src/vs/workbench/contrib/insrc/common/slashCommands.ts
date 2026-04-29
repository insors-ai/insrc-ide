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
];
