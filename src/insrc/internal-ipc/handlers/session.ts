/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `internal.session.append-turn` -- persist a turn into LMDB +
 * turn_vec (the latter goes through `saveTurn`'s embed-on-write
 * path).
 *
 * Wraps `db/conversations.ts:saveTurn`. The `_db` parameter is
 * unused by the underlying function (graph store is global) but the
 * function signature still requires a DbClient placeholder.
 */

import { saveTurn } from '../../db/conversations.js';
import type { TurnRecord } from '../../db/conversations.js';
import type { DbClient } from '../../db/client.js';
import type { InternalIpcHandler } from '../types.js';

export interface SessionAppendTurnInput {
	readonly db:   DbClient;
	readonly turn: TurnRecord;
}

export const sessionAppendTurn: InternalIpcHandler<SessionAppendTurnInput, void> = {
	name: 'internal.session.append-turn',
	async invoke(input) {
		await saveTurn(input.db, input.turn);
	},
};
