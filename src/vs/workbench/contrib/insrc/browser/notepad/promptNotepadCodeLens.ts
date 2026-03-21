/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import type { CodeLens, CodeLensList } from '../../../../../editor/common/languages.js';
import { Range } from '../../../../../editor/common/core/range.js';

const SCHEME = 'insrc-prompt';

/**
 * CodeLens provider for prompt notepad files.
 * Shows Run All, Run Selection, Clear, Save as Template at the top.
 */
export class PromptNotepadCodeLensProvider {

	get onDidChange() { return undefined; }

	provideCodeLenses(model: ITextModel, _token: CancellationToken): CodeLensList | undefined {
		if (model.uri.scheme !== SCHEME) {
			return undefined;
		}

		const topRange = new Range(1, 1, 1, 1);

		const lenses: CodeLens[] = [
			{
				range: topRange,
				command: {
					id: 'insrc.promptNotepad.runAll',
					title: '$(play) Run All',
				},
			},
			{
				range: topRange,
				command: {
					id: 'insrc.promptNotepad.runSelection',
					title: '$(play) Run Selection',
				},
			},
			{
				range: topRange,
				command: {
					id: 'insrc.promptNotepad.clear',
					title: '$(trash) Clear',
				},
			},
			{
				range: topRange,
				command: {
					id: 'insrc.promptNotepad.saveTemplate',
					title: '$(save) Save as Template',
				},
			},
		];

		return { lenses, dispose: () => { } };
	}

	resolveCodeLens(_model: ITextModel, codeLens: CodeLens, _token: CancellationToken): CodeLens {
		return codeLens;
	}
}
