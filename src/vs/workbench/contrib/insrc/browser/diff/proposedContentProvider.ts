/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { Emitter, type Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import type { ITextModel } from '../../../../../editor/common/model.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';

export const INSRC_PROPOSED_SCHEME = 'insrc-proposed';

/**
 * Provides virtual read-only documents for proposed file content.
 * Used as the "modified" side in diff editors.
 */
export class ProposedContentProvider extends Disposable {

	private readonly _contents = new Map<string, string>();

	private readonly _onDidChange = this._register(new Emitter<URI>());
	readonly onDidChange: Event<URI> = this._onDidChange.event;

	constructor(
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
	) {
		super();
	}

	/** Store proposed content for a file path */
	set(filePath: string, content: string): URI {
		const uri = ProposedContentProvider.toUri(filePath);
		const key = uri.toString();
		this._contents.set(key, content);

		// Create or update model
		const existing = this.modelService.getModel(uri);
		if (existing) {
			existing.setValue(content);
		} else {
			const languageId = this.languageService.guessLanguageIdByFilepathOrFirstLine(URI.file(filePath));
			this.modelService.createModel(content, this.languageService.createById(languageId ?? 'plaintext'), uri);
		}

		this._onDidChange.fire(uri);
		return uri;
	}

	/** Get stored content for a URI */
	get(uri: URI): string | undefined {
		return this._contents.get(uri.toString());
	}

	/** Remove proposed content and dispose the model */
	remove(filePath: string): void {
		const uri = ProposedContentProvider.toUri(filePath);
		const key = uri.toString();
		this._contents.delete(key);

		const model = this.modelService.getModel(uri);
		if (model) {
			model.dispose();
		}
	}

	/** Clear all proposed content */
	clear(): void {
		for (const key of this._contents.keys()) {
			const uri = URI.parse(key);
			const model = this.modelService.getModel(uri);
			if (model) {
				model.dispose();
			}
		}
		this._contents.clear();
	}

	/** Provide content for a virtual document */
	provideTextDocumentContent(uri: URI): string {
		return this._contents.get(uri.toString()) ?? '';
	}

	/** Build a URI for a proposed file */
	static toUri(filePath: string): URI {
		return URI.from({ scheme: INSRC_PROPOSED_SCHEME, path: filePath });
	}

	/** Get the original model for language detection */
	getModelForUri(uri: URI): ITextModel | null {
		return this.modelService.getModel(uri);
	}

	override dispose(): void {
		this.clear();
		super.dispose();
	}
}
