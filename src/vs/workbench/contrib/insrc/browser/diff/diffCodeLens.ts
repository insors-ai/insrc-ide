/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, type Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import type { ITextModel } from '../../../../../editor/common/model.js';
import type { CodeLens, CodeLensList } from '../../../../../editor/common/languages.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { INSRC_PROPOSED_SCHEME } from './proposedContentProvider.js';

/**
 * Provides Accept / Reject / Edit CodeLens buttons at the top of
 * insrc-proposed documents (the "modified" side of diff editors).
 */
export class DiffCodeLensProvider extends Disposable {

	private readonly _activeFiles = new Set<string>();

	private readonly _onDidChange = this._register(new Emitter<this>());
	readonly onDidChange: Event<this> = this._onDidChange.event;

	/** Mark a file as having an active diff (triggers CodeLens refresh) */
	setActive(filePath: string): void {
		this._activeFiles.add(filePath);
		this._onDidChange.fire(this);
	}

	/** Remove a file from active diffs */
	removeActive(filePath: string): void {
		this._activeFiles.delete(filePath);
		this._onDidChange.fire(this);
	}

	/** Clear all active files */
	clearAll(): void {
		this._activeFiles.clear();
		this._onDidChange.fire(this);
	}

	/** Provide CodeLens for insrc-proposed documents */
	provideCodeLenses(model: ITextModel, _token: CancellationToken): CodeLensList {
		if (model.uri.scheme !== INSRC_PROPOSED_SCHEME) {
			return { lenses: [], dispose: () => { } };
		}

		const filePath = model.uri.path;
		if (!this._activeFiles.has(filePath)) {
			return { lenses: [], dispose: () => { } };
		}

		const topRange = new Range(1, 1, 1, 1);

		const lenses: CodeLens[] = [
			{
				range: topRange,
				command: {
					id: 'insrc.diffAccept',
					title: '$(check) Accept',
					tooltip: 'Accept proposed changes and write to disk',
					arguments: [filePath],
				},
			},
			{
				range: topRange,
				command: {
					id: 'insrc.diffReject',
					title: '$(close) Reject',
					tooltip: 'Reject proposed changes',
					arguments: [filePath],
				},
			},
			{
				range: topRange,
				command: {
					id: 'insrc.diffEdit',
					title: '$(edit) Edit',
					tooltip: 'Request changes with feedback',
					arguments: [filePath],
				},
			},
		];

		return { lenses, dispose: () => { } };
	}
}
