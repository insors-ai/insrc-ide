/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `/prefs` slash dispatcher (memory-context M1.7).
 *
 * Thin markdown renderer over the `prefs.*` IPC handlers. Lets the user
 * see and curate captured preferences from inside chat without leaving
 * the conversation panel.
 *
 *   /prefs                       -- alias for /prefs list
 *   /prefs list                  -- show every active preference
 *   /prefs list --all            -- include below-noise-threshold entries
 *   /prefs discard <key|prefix>  -- delete a preference
 *   /prefs edit <key|prefix> <new canonical text>
 *   /prefs help                  -- usage
 *
 * `<key|prefix>` is the substrate row key (`<turnId>::<subject>`); a
 * prefix is accepted when unique. The list output reports the full key
 * so users can copy-paste rather than guess.
 */

import { getLogger } from '../shared/logger.js';
import type { IpcStreamMessage } from '../shared/types.js';
import {
	prefsDiscardRpc,
	prefsEditRpc,
	prefsListRpc,
	type PrefsEntry,
} from './prefs-rpc.js';

const log = getLogger('daemon:prefs-slash');

const USAGE = [
	'**`/prefs`** -- curate captured user preferences',
	'',
	'Subcommands:',
	'- `/prefs list` (default) -- show all active preferences',
	'- `/prefs list --all` -- include below-noise-threshold entries',
	'- `/prefs discard <key>` -- delete one preference',
	'- `/prefs edit <key> <new text>` -- rewrite the canonical text',
	'',
	'`<key>` is shown in the list output. A unique prefix is accepted.',
].join('\n');


export async function runPrefsSlash(
	rawArgs:   string,
	requestId: number,
	send:      (msg: IpcStreamMessage) => void,
): Promise<void> {
	const trimmed = rawArgs.trim();
	const { sub, rest } = splitSubcommand(trimmed);

	try {
		switch (sub) {
			case '':
			case 'list': {
				const includeNoisy = rest.split(/\s+/).includes('--all');
				const result = await prefsListRpc({ includeNoisy });
				const text = renderList(result.entries, includeNoisy);
				send({ id: requestId, stream: 'delta', data: { text, format: 'markdown' } });
				send({ id: requestId, stream: 'done', data: { summary: `prefs list (${result.entries.length})` } });
				return;
			}
			case 'discard': {
				if (rest.length === 0) {
					return usage(requestId, send, '`/prefs discard <key>` -- key is required.');
				}
				const result = await prefsDiscardRpc({ key: rest });
				send({
					id:     requestId,
					stream: 'delta',
					data:   { text: `Discarded \`${result.key}\`.`, format: 'markdown' },
				});
				send({ id: requestId, stream: 'done', data: { summary: 'prefs discard' } });
				return;
			}
			case 'edit': {
				const editArgs = parseEditArgs(rest);
				if (editArgs === undefined) {
					return usage(requestId, send, '`/prefs edit <key> <new text>` -- key and new text are required.');
				}
				const result = await prefsEditRpc({ key: editArgs.key, canonicalText: editArgs.text });
				const lines: string[] = [
					`Updated \`${result.key}\`:`,
					'',
					...(result.entry !== undefined ? renderEntry(result.entry) : []),
				];
				send({
					id:     requestId,
					stream: 'delta',
					data:   { text: lines.join('\n'), format: 'markdown' },
				});
				send({ id: requestId, stream: 'done', data: { summary: 'prefs edit' } });
				return;
			}
			case 'help':
				return usage(requestId, send);
			default:
				return usage(requestId, send, `Unknown subcommand \`${sub}\`.`);
		}
	} catch (err) {
		const message = (err as Error).message ?? String(err);
		log.warn({ sub, err: message }, 'prefs slash failed');
		send({
			id:     requestId,
			stream: 'delta',
			data:   { text: `Error: ${message}`, format: 'markdown' },
		});
		send({ id: requestId, stream: 'done', data: { summary: 'prefs error' } });
	}
}


// ---------------------------------------------------------------------------
// Subcommand parsing
// ---------------------------------------------------------------------------

function splitSubcommand(input: string): { sub: string; rest: string } {
	if (input.length === 0) {
		return { sub: '', rest: '' };
	}
	const m = input.match(/^(\S+)(?:\s+([\s\S]+))?$/);
	if (m === null) {
		return { sub: '', rest: '' };
	}
	return { sub: (m[1] ?? '').toLowerCase(), rest: (m[2] ?? '').trim() };
}

function parseEditArgs(rest: string): { key: string; text: string } | undefined {
	const m = rest.match(/^(\S+)\s+([\s\S]+)$/);
	if (m === null) {
		return undefined;
	}
	const key = m[1]!.trim();
	const text = m[2]!.trim();
	if (key.length === 0 || text.length === 0) {
		return undefined;
	}
	return { key, text };
}


// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderList(entries: readonly PrefsEntry[], includeNoisy: boolean): string {
	if (entries.length === 0) {
		const scopeNote = includeNoisy
			? ' (including below-threshold entries)'
			: '';
		return `No active user preferences captured${scopeNote}.`;
	}
	const header = includeNoisy
		? `### Active preferences (${entries.length}; \`--all\` includes noisy)`
		: `### Active preferences (${entries.length})`;
	const blocks: string[] = [header, ''];
	for (const e of entries) {
		blocks.push(...renderEntry(e));
		blocks.push('');
	}
	return blocks.join('\n').trimEnd();
}

function renderEntry(e: PrefsEntry): string[] {
	const meta: string[] = [
		`confidence ${e.confidence.toFixed(2)}`,
		`scope ${e.scope}`,
	];
	if (e.repoPaths !== undefined && e.repoPaths.length > 0) {
		meta.push(`repos [${e.repoPaths.join(', ')}]`);
	}
	if (e.categories !== undefined && e.categories.length > 0) {
		meta.push(`tags [${e.categories.join(', ')}]`);
	}
	return [
		`- **\`${e.key}\`** _(${e.subject})_`,
		`  ${e.canonicalText}`,
		`  _${meta.join(' · ')}_`,
	];
}

function usage(
	requestId: number,
	send:      (msg: IpcStreamMessage) => void,
	prefix?:   string,
): void {
	const text = prefix !== undefined
		? `${prefix}\n\n${USAGE}`
		: USAGE;
	send({ id: requestId, stream: 'delta', data: { text, format: 'markdown' } });
	send({ id: requestId, stream: 'done', data: { summary: 'prefs usage' } });
}
