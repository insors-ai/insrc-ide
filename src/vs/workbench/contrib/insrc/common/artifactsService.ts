/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { ArtifactKind } from './insrcArtifacts.js';

/**
 * Browser-side interface for daemon-backed artifact operations
 * (plans/artifact-tasks.md section 2.3).
 *
 * Today it surfaces only the template-override flows used by the
 * palette commands; as future phases add direct browser operations
 * (regenerate from a button in the Artifacts pane, template preview,
 * etc.) those methods land here alongside.
 *
 * Unlike IInsrcTodosService, this one does NOT hold a local cache --
 * every call round-trips to the daemon. The surface is small + rarely
 * invoked; caching would add complexity for no benefit.
 */

export type TemplateLayer = 'repo' | 'user' | 'bundled';

export interface TemplateInfo {
	readonly kind: ArtifactKind;
	readonly layer: TemplateLayer;
	readonly path: string;
}

export interface EnsureUserTemplateResult {
	readonly kind: ArtifactKind;
	readonly userPath: string;
	/** True when the file was just seeded from the bundled template;
	 *  false when it already existed. */
	readonly seeded: boolean;
}

export interface ResetUserTemplateResult {
	readonly kind: ArtifactKind;
	/** Absolute path that was deleted, or null when no override
	 *  existed. */
	readonly removedPath: string | null;
}

/**
 * Offline-bundle status + operations
 * (plans/artifact-tasks.md section 3.3).
 */

export interface OfflineBundleStatus {
	readonly version: string;
	readonly scriptUrl: string;
	readonly cachePath: string;
	readonly present: boolean;
	readonly valid: boolean;
	readonly sizeBytes?: number;
}

export interface DownloadOfflineBundleResult {
	readonly version: string;
	readonly cachePath: string;
	readonly sizeBytes: number;
	readonly alreadyPresent: boolean;
}

export interface RemoveOfflineBundleResult {
	readonly version: string;
	readonly removedPath: string | null;
}

export interface IInsrcArtifactsService {
	readonly _serviceBrand: undefined;

	/** Resolve the current template layer per kind. Read-only. */
	listTemplates(opts?: { repoRoot?: string }): Promise<readonly TemplateInfo[]>;

	/**
	 * Ensure a user-override file exists for `kind` -- seeds from the
	 * bundled template when missing. Returns the absolute path so the
	 * caller can open it in the editor.
	 */
	ensureUserTemplate(kind: ArtifactKind): Promise<EnsureUserTemplateResult>;

	/**
	 * Delete the user-override file for `kind`. No-op when none
	 * exists. Returns the path removed (or null).
	 */
	resetUserTemplate(kind: ArtifactKind): Promise<ResetUserTemplateResult>;

	/** Status of the cached Mermaid bundle used for offline standalone
	 *  rendering. */
	getOfflineBundleStatus(): Promise<OfflineBundleStatus>;

	/** Fetch the pinned Mermaid bundle from the CDN, verify its SRI
	 *  hash, and cache it locally. Idempotent; re-uses the existing
	 *  cache when still valid. */
	downloadOfflineBundle(): Promise<DownloadOfflineBundleResult>;

	/** Delete the cached bundle so subsequent renders fall back to
	 *  the CDN. */
	removeOfflineBundle(): Promise<RemoveOfflineBundleResult>;
}

export const IInsrcArtifactsService = createDecorator<IInsrcArtifactsService>('insrcArtifactsService');
