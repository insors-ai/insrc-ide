/**
 * Registered chat slash commands.
 *
 * Single source of truth on the daemon side for:
 *   - the family-direct dispatcher's regex match (`/code-analyze`),
 *   - the dispatcher's fuzzy "did you mean ..." fallback (Phase 4
 *     follow-up: typo'd `/code-analyzer` shouldn't misroute as
 *     research),
 *   - the intent classifier's system prompt (so the classifier knows
 *     to recognise `/<name>` literals as slash-command attempts
 *     instead of topic-classifying them).
 *
 * The workbench-side autocomplete consumes a duplicated copy of this
 * list at `vs/workbench/contrib/insrc/common/slashCommands.ts` --
 * cheap to keep in sync at the current size; revisit if the list
 * grows past ~5 entries.
 */

export interface SlashCommand {
	/** Token after `/`. e.g. `code-analyze`. */
	readonly id: string;
	/** One-sentence description for autocomplete + classifier prompt. */
	readonly description: string;
	/** Example invocation rendered in the autocomplete preview. */
	readonly example: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
	{
		id: 'code-analyze',
		description: 'Run a structural code analysis against the active repo.',
		example: '/code-analyze how does the auth middleware work?',
	},
];

const SLASH_NAMES: ReadonlySet<string> = new Set(SLASH_COMMANDS.map(c => c.id));

export function isRegisteredSlashCommand(name: string): boolean {
	return SLASH_NAMES.has(name);
}

/**
 * Find the closest registered slash command to a typo'd token via
 * Levenshtein distance. Returns the match when within `maxDistance`,
 * otherwise undefined. Threshold is tighter for short names (≤1 for
 * names < 10 chars) and looser for long names (≤2 for ≥ 10 chars)
 * so we don't accept surprising matches on short tokens.
 */
export function findClosestSlashCommand(
	typedName: string,
	maxDistance: number = 2,
): SlashCommand | undefined {
	const normalised = typedName.trim().toLowerCase();
	if (normalised.length === 0) {
		return undefined;
	}
	let best: { command: SlashCommand; distance: number } | undefined;
	for (const cmd of SLASH_COMMANDS) {
		const cap = cmd.id.length >= 10 ? maxDistance : Math.min(1, maxDistance);
		const d = levenshtein(normalised, cmd.id);
		if (d > cap) {
			continue;
		}
		if (best === undefined || d < best.distance) {
			best = { command: cmd, distance: d };
		}
	}
	return best?.command;
}

/**
 * Standard Levenshtein distance. Iterative two-row implementation --
 * O(m * n) time, O(min(m, n)) space. Good enough for the tiny strings
 * the slash registry compares (single-token names, < 30 chars).
 */
function levenshtein(a: string, b: string): number {
	if (a === b) {
		return 0;
	}
	if (a.length === 0) {
		return b.length;
	}
	if (b.length === 0) {
		return a.length;
	}
	let prev = new Array<number>(b.length + 1);
	let curr = new Array<number>(b.length + 1);
	for (let j = 0; j <= b.length; j++) {
		prev[j] = j;
	}
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
			curr[j] = Math.min(
				curr[j - 1]! + 1,        // insertion
				prev[j]! + 1,            // deletion
				prev[j - 1]! + cost,     // substitution
			);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[b.length]!;
}
