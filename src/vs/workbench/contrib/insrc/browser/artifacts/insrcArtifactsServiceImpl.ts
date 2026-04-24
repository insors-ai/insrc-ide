/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IInsrcDaemonService } from '../../common/daemonService.js';
import {
	IInsrcArtifactsService,
	type EnsureUserTemplateResult,
	type ResetUserTemplateResult,
	type TemplateInfo,
} from '../../common/artifactsService.js';
import type { ArtifactKind } from '../../common/insrcArtifacts.js';

/**
 * Browser-side impl of IInsrcArtifactsService. Every method
 * round-trips to the daemon -- no local cache, no streams. The
 * surface is only called from palette commands that fire
 * interactively (sub-second, rare), so the simpler shape is the
 * right trade-off.
 */
export class InsrcArtifactsServiceImpl extends Disposable implements IInsrcArtifactsService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IInsrcDaemonService private readonly daemonService: IInsrcDaemonService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async listTemplates(opts: { repoRoot?: string } = {}): Promise<readonly TemplateInfo[]> {
		const params: Record<string, unknown> = {};
		if (opts.repoRoot !== undefined) { params['repoRoot'] = opts.repoRoot; }
		try {
			const result = await this.daemonService.rpc<readonly TemplateInfo[]>(
				'artifacts.listTemplates', params,
			);
			return Array.isArray(result) ? result : [];
		} catch (err) {
			this.logService.warn(`[insrc-artifacts] listTemplates failed: ${(err as Error).message}`);
			return [];
		}
	}

	async ensureUserTemplate(kind: ArtifactKind): Promise<EnsureUserTemplateResult> {
		const result = await this.daemonService.rpc<EnsureUserTemplateResult | { error: string }>(
			'artifacts.ensureUserTemplate', { kind },
		);
		if (result !== null && typeof result === 'object' && 'error' in result) {
			throw new Error(`artifacts.ensureUserTemplate: ${(result as { error: string }).error}`);
		}
		return result;
	}

	async resetUserTemplate(kind: ArtifactKind): Promise<ResetUserTemplateResult> {
		const result = await this.daemonService.rpc<ResetUserTemplateResult | { error: string }>(
			'artifacts.resetUserTemplate', { kind },
		);
		if (result !== null && typeof result === 'object' && 'error' in result) {
			throw new Error(`artifacts.resetUserTemplate: ${(result as { error: string }).error}`);
		}
		return result;
	}
}
