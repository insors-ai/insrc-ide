/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';

const SCHEME = 'insrc-prompt';
const STORAGE_PREFIX = 'insrc.promptNotepad.';
const DEFAULT_CONTENT = `# Prompt Notepad
# Write your prompt below. Use Run All (or select a section and Run Selection).
# Variables: \${repo}, \${repoName}, \${file}, \${fileName}, \${selection}, \${line}, \${clipboard}

`;

export class PromptNotepadProvider extends Disposable {
	private readonly _models = new Map<string, ITextModel>();

	constructor(
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
	}

	/**
	 * Get or create a text model for the given notepad ID.
	 */
	getOrCreateModel(notepadId: string = '1'): { model: ITextModel; uri: URI } {
		const uri = URI.from({ scheme: SCHEME, path: `/notepad/${notepadId}` });

		let model = this._models.get(notepadId);
		if (model && !model.isDisposed()) {
			return { model, uri };
		}

		// Load persisted content
		const savedContent = this.storageService.get(
			STORAGE_PREFIX + notepadId,
			StorageScope.WORKSPACE,
			DEFAULT_CONTENT,
		);

		// Create model with markdown language
		const languageId = this.languageService.getLanguageIdByLanguageName('markdown') ?? 'markdown';
		model = this.modelService.createModel(savedContent, this.languageService.createById(languageId), uri);

		// Auto-save on change (debounced)
		let saveTimeout: ReturnType<typeof setTimeout> | undefined;
		this._register(model.onDidChangeContent(() => {
			if (saveTimeout) { clearTimeout(saveTimeout); }
			saveTimeout = setTimeout(() => {
				this.storageService.store(
					STORAGE_PREFIX + notepadId,
					model!.getValue(),
					StorageScope.WORKSPACE,
					StorageTarget.MACHINE,
				);
			}, 500);
		}));

		this._models.set(notepadId, model);
		return { model, uri };
	}

	/**
	 * Get the content of a notepad.
	 */
	getContent(notepadId: string = '1'): string {
		const model = this._models.get(notepadId);
		if (model && !model.isDisposed()) {
			return model.getValue();
		}
		return this.storageService.get(
			STORAGE_PREFIX + notepadId,
			StorageScope.WORKSPACE,
			DEFAULT_CONTENT,
		);
	}

	/**
	 * Clear a notepad's content.
	 */
	clear(notepadId: string = '1'): void {
		const model = this._models.get(notepadId);
		if (model && !model.isDisposed()) {
			model.setValue(DEFAULT_CONTENT);
		}
		this.storageService.store(
			STORAGE_PREFIX + notepadId,
			DEFAULT_CONTENT,
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE,
		);
	}

	override dispose(): void {
		for (const model of this._models.values()) {
			if (!model.isDisposed()) {
				model.dispose();
			}
		}
		this._models.clear();
		super.dispose();
	}
}
