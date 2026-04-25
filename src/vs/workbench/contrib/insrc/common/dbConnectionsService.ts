/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * Browser-side interface for daemon-backed data-driver operations
 * (plans/data-driver.md phases 2 + 3).
 *
 * Phase 3 shipped `list()`. Phase 2 adds the four mutating + probing
 * methods used by the palette commands and the Data Sources pane.
 *
 * Every method round-trips to the daemon -- no local cache (matches
 * IInsrcArtifactsService).
 */

export type DriverFamily = 'rdbms' | 'kv' | 'file';

export interface DbConnectionInfo {
	readonly id: string;
	readonly kind: string;
	readonly family: DriverFamily;
	readonly label?: string;
}

export interface DriverKindInfo {
	readonly kind: string;
	readonly family: DriverFamily;
}

/**
 * Plaintext config submitted from the setup UX. The daemon
 * extracts password from `url` into the keychain before
 * persistence. RDBMS / KV use `url`; file uses `path`.
 */
export interface DbConnectionInput {
	readonly id: string;
	readonly kind: string;
	readonly family?: DriverFamily;
	readonly label?: string;
	readonly url?: string;
	readonly path?: string;
	readonly schemaSource?: { readonly type: 'prisma'; readonly path: string };
	readonly namespace?: { readonly allow: readonly string[] };
	readonly options?: Readonly<Record<string, unknown>>;
	readonly pii?: readonly string[];
}

export interface SaveConnectionResult {
	readonly id: string;
	readonly family: DriverFamily;
	readonly redactedUrl?: string;
	readonly wrotePath: string;
}

export interface DeleteConnectionResult {
	readonly id: string;
	readonly removed: boolean;
	readonly removedPath?: string;
}

export interface TestConnectionResult {
	readonly ok: boolean;
	readonly kind: string;
	readonly family: DriverFamily;
	readonly error?: string;
	readonly tookMs: number;
}

export interface IInsrcDbConnectionsService {
	readonly _serviceBrand: undefined;

	/** List every configured connection on the given repo. */
	list(opts: { readonly repoRoot: string }): Promise<readonly DbConnectionInfo[]>;

	/** Discover registered driver kinds for the kind-picker UI. */
	listDriverKinds(): Promise<readonly DriverKindInfo[]>;

	/**
	 * Add or edit. Upserts on `config.id`. The daemon redacts
	 * passwords into the keychain before writing the JSON; the
	 * caller never persists plaintext.
	 */
	save(opts: {
		readonly repoRoot: string;
		readonly config: DbConnectionInput;
	}): Promise<SaveConnectionResult>;

	/** Remove a connection by id; clears its keychain entry too. */
	remove(opts: {
		readonly repoRoot: string;
		readonly id: string;
	}): Promise<DeleteConnectionResult>;

	/**
	 * Build a transient driver from `config`, run the kind-equivalent
	 * probe, close. Does NOT persist; the pane / palette uses this
	 * before save (and again on demand for already-saved entries).
	 */
	test(opts: {
		readonly repoRoot: string;
		readonly config: DbConnectionInput;
	}): Promise<TestConnectionResult>;
}

export const IInsrcDbConnectionsService =
	createDecorator<IInsrcDbConnectionsService>('insrcDbConnectionsService');
