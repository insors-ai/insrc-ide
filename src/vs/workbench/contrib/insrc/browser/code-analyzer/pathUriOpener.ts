/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IOpener, IOpenerService, OpenInternalOptions, OpenExternalOptions } from '../../../../../platform/opener/common/opener.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';

/**
 * Resolves citation links emitted by the code-analyzer's synthesise prompt.
 *
 * Citation format (from src/insrc/agent/tasks/code-analyzer/prompts/synthesise-multipass.ts:37):
 *
 *     [`src/auth/token.ts:42-58`](path:src/auth/token.ts#L42-L58)
 *
 * Also handles file-level / directory citations which the XXL tier
 * explicitly emits per analyzer-system.ts (`{ "path": "src/auth/" }`
 * is valid; lineStart / lineEnd are optional and usually absent at
 * sub-system altitude). Files open in the editor at the cited line
 * range; directories reveal in the Explorer view.
 *
 * The `path:` URI scheme is custom -- VS Code's openerService doesn't know
 * what to do with it on its own, so without this opener clicks fall
 * through and do nothing. Standard markdown / file: URIs would also work,
 * but keeping citations workspace-relative means saved reports stay
 * portable across machines (the absolute path is resolved at click time
 * against the active workspace).
 *
 * URI shape: `path:<relative-path>(#L<startLine>(-L<endLine>)?)?`
 *   - scheme:    'path'
 *   - path:      workspace-relative file or directory path
 *   - fragment:  'L42-L58' | 'L42' | (empty -> top of file / directory)
 *
 * Resolution: scan the active workspace's folders, prefer the first one
 * whose joined URI exists. Single-folder workspaces (the common case)
 * skip the scan entirely.
 */
class PathUriOpener implements IOpener {

	constructor(
		private readonly editorService: IEditorService,
		private readonly workspaceContextService: IWorkspaceContextService,
		private readonly fileService: IFileService,
		private readonly commandService: ICommandService,
	) { }

	async open(resource: URI | string, _options?: OpenInternalOptions | OpenExternalOptions): Promise<boolean> {
		const uri = typeof resource === 'string' ? URI.parse(resource) : resource;
		if (uri.scheme !== 'path') {
			return false;
		}

		const relPath = uri.path;
		if (!relPath) {
			return false;
		}

		const target = await this._resolveAgainstWorkspace(relPath);
		if (!target) {
			return false;
		}

		// Branch on file vs directory. Stat catches the kind cheaply
		// (workspace files; the result is hot in the file-watcher cache
		// for anything we just rendered a citation for). On stat failure
		// we fall back to the file-open path -- the editor service will
		// surface a clean "file not found" notification, which is more
		// informative than silently doing nothing.
		let isDirectory = false;
		try {
			const stat = await this.fileService.stat(target);
			isDirectory = stat.isDirectory;
		} catch {
			// File doesn't exist or stat failed; treat as file so the
			// editor's not-found notification fires.
		}

		if (isDirectory) {
			// Reveal the folder in the Explorer view. `revealInExplorer`
			// is the workbench command that mirrors the Explorer's
			// own "Reveal in File Explorer" action -- it handles
			// activating the view, expanding ancestors, and selecting
			// the target node. Line-range fragments are ignored for
			// directories (they don't apply).
			await this.commandService.executeCommand('revealInExplorer', target);
			return true;
		}

		const { startLineNumber, endLineNumber } = parseLineRange(uri.fragment);

		await this.editorService.openEditor({
			resource: target,
			options: {
				selection: {
					startLineNumber,
					startColumn: 1,
					endLineNumber,
					endColumn: 1,
				},
				revealIfOpened: true,
				preserveFocus: false,
			},
		});

		return true;
	}

	private async _resolveAgainstWorkspace(relPath: string): Promise<URI | undefined> {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			return undefined;
		}

		// Strip a trailing `/` so URI.joinPath doesn't produce a
		// double-slash and so the existence checks below match
		// regardless of whether the citation is `src/auth` or `src/auth/`.
		const normalised = relPath.replace(/\/+$/, '');

		// Single-folder fast path: don't pay for an existence check.
		if (folders.length === 1) {
			return URI.joinPath(folders[0]!.uri, normalised);
		}

		// Multi-folder workspace: pick the first folder where the file
		// or directory actually exists. Falls back to the first folder
		// if none match, so the editor service / Explorer reveal
		// surfaces a clean "not found" rather than the click silently
		// doing nothing.
		for (const folder of folders) {
			const candidate = URI.joinPath(folder.uri, normalised);
			if (await this.fileService.exists(candidate)) {
				return candidate;
			}
		}
		return URI.joinPath(folders[0]!.uri, normalised);
	}
}

/**
 * Parse `#L42-L58` / `#L42` / `` -> { startLineNumber, endLineNumber }.
 * Falls back to line 1 / line 1 on missing or malformed fragments so a
 * citation with a broken anchor still opens the file at the top instead
 * of the click silently doing nothing.
 */
function parseLineRange(fragment: string | undefined): { startLineNumber: number; endLineNumber: number } {
	if (!fragment) {
		return { startLineNumber: 1, endLineNumber: 1 };
	}
	const match = /^L(\d+)(?:-L(\d+))?$/.exec(fragment);
	if (!match) {
		return { startLineNumber: 1, endLineNumber: 1 };
	}
	const startLineNumber = Math.max(1, parseInt(match[1]!, 10));
	const endLineNumber = match[2] ? Math.max(startLineNumber, parseInt(match[2], 10)) : startLineNumber;
	return { startLineNumber, endLineNumber };
}

/**
 * Workbench contribution that wires the `path:` URI opener into the
 * global IOpenerService. Registered at AfterRestored so the openerService
 * is fully initialised by the time we attach.
 */
export class PathUriOpenerContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'insrc.pathUriOpener';

	constructor(
		@IOpenerService openerService: IOpenerService,
		@IEditorService editorService: IEditorService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@IFileService fileService: IFileService,
		@ICommandService commandService: ICommandService,
	) {
		super();
		this._register(openerService.registerOpener(new PathUriOpener(editorService, workspaceContextService, fileService, commandService)));
	}
}
