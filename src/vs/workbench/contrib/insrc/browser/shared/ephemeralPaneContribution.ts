/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import type { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import type { IWorkbenchContribution } from '../../../../common/contributions.js';
import { EphemeralEditorInput } from './ephemeralEditorInput.js';

const EPHEMERAL_TMP_SUBPATH = ['.insrc', 'tmp'] as const;

/**
 * Resolve the URI of the ephemeral-pane temp directory
 * (`<localUserHome>/.insrc/tmp/`). Mirrors `PATHS.tmp` from
 * `insors-ai/insrc:src/shared/paths.ts` -- the daemon side imports that
 * constant directly; the workbench side computes the URI from
 * `IPathService.userHome({ preferLocal: true })` because the
 * workbench can't depend on node:os/node:path at this layer.
 *
 * `preferLocal: true` is the synchronous form of `userHome` and is
 * the right answer for ephemeral-pane backing files: we want the
 * local home dir even on remote / web workbenches, since the daemon
 * side stores the matching `~/.insrc/tmp/` on the local box too.
 */
export function getInsrcTmpDirUri(pathService: IPathService): URI {
	return joinPath(pathService.userHome({ preferLocal: true }), ...EPHEMERAL_TMP_SUBPATH);
}

/**
 * Workbench-startup contribution that initialises the ephemeral-pane
 * tmp dir BEFORE editor restoration runs. Registered at `BlockStartup`
 * so the static singleton on `EphemeralEditorInput` is set before any
 * deserialize() call can fire (deserialize accesses `resource`, which
 * reads the singleton).
 *
 * Folder creation is fire-and-forget: the synchronous setTmpDir() is
 * the load-bearing call. Even if mkdir somehow fails, individual
 * `ensureBackingFile()` calls would create the dir lazily through
 * IFileService's createFile path-creation behaviour.
 */
export class EphemeralPaneInitContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.insrcEphemeralPaneInit';

	constructor(
		@IPathService pathService: IPathService,
		@IFileService fileService: IFileService,
		@ILogService logService: ILogService,
	) {
		super();
		const tmpDir = getInsrcTmpDirUri(pathService);
		EphemeralEditorInput.setTmpDir(tmpDir);

		// Best-effort folder creation; createFile() will recreate intermediate
		// dirs anyway, but creating it up front means the reconciler's
		// resolve() doesn't error on a missing root.
		fileService.createFolder(tmpDir).then(
			() => { /* ok */ },
			err => logService.warn(`[insrc:ephemeral] mkdir ${tmpDir.fsPath} failed (will retry on first write): ${err.message}`),
		);
	}
}

/**
 * Workbench-restore contribution that prunes orphan backing files
 * from `~/.insrc/tmp/` -- i.e. files that aren't referenced by any
 * currently-open editor. Runs at `AfterRestored` so editor
 * restoration is complete and `IEditorService.editors` reflects the
 * actual open tab set.
 *
 * One-shot: scans once on startup and disposes itself. We don't
 * watch for closes -- the cleanup is a startup hygiene measure, not
 * a continuous garbage collector. A pane that's open across a
 * restart will hold its backing file alive; a pane that the user
 * closed before restart leaves an orphan, which this run removes.
 */
export class EphemeralPaneOrphanReconcilerContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.insrcEphemeralPaneReconciler';

	constructor(
		@IPathService pathService: IPathService,
		@IFileService fileService: IFileService,
		@IEditorService editorService: IEditorService,
		@ILogService logService: ILogService,
	) {
		super();
		const tmpDir = getInsrcTmpDirUri(pathService);
		void this._reconcile(tmpDir, fileService, editorService, logService);
	}

	private async _reconcile(
		tmpDir: URI,
		fileService: IFileService,
		editorService: IEditorService,
		logService: ILogService,
	): Promise<void> {
		// 1. Snapshot of all currently-open editor URIs that live under
		//    the tmp dir. Different editors that share the same backing
		//    file (split groups, side-by-side) collapse to one entry.
		const referenced = new Set<string>();
		for (const editor of editorService.editors) {
			const uri = editor.resource;
			if (uri === undefined) {
				continue;
			}
			if (this._isUnderTmpDir(uri, tmpDir)) {
				referenced.add(uri.toString());
			}
		}

		// 2. Walk the tmp dir; delete any file the open-editor set
		//    doesn't claim.
		let stat;
		try {
			stat = await fileService.resolve(tmpDir);
		} catch (err) {
			// Dir doesn't exist yet (first-ever startup) -- nothing to reconcile.
			logService.trace(`[insrc:ephemeral] tmp dir not present, skipping reconcile: ${(err as Error).message}`);
			return;
		}
		if (stat.children === undefined || stat.children.length === 0) {
			return;
		}

		let deleted = 0;
		let kept = 0;
		for (const child of stat.children) {
			if (child.isDirectory) {
				// Subdirs aren't part of the ephemeral-pane contract.
				// Leave them alone (some other tooling might use them).
				continue;
			}
			if (referenced.has(child.resource.toString())) {
				kept++;
				continue;
			}
			try {
				await fileService.del(child.resource, { useTrash: false });
				deleted++;
			} catch (err) {
				logService.warn(`[insrc:ephemeral] failed to delete orphan ${child.resource.fsPath}: ${(err as Error).message}`);
			}
		}
		if (deleted > 0 || kept > 0) {
			logService.info(`[insrc:ephemeral] reconciled tmp dir: kept=${kept} deleted=${deleted}`);
		}
	}

	private _isUnderTmpDir(uri: URI, tmpDir: URI): boolean {
		if (uri.scheme !== tmpDir.scheme) {
			return false;
		}
		const tmpPath = tmpDir.path.endsWith('/') ? tmpDir.path : tmpDir.path + '/';
		return uri.path.startsWith(tmpPath);
	}
}
