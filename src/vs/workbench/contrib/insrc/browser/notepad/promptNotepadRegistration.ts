/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { IFileService, FileSystemProviderCapabilities, type IFileSystemProviderWithFileReadWriteCapability, type IFileChange, type IStat, type FileType } from '../../../../../platform/files/common/files.js';
import type { ITextModel } from '../../../../../editor/common/model.js';
import { PromptNotepadProvider } from './promptNotepadProvider.js';
import { PromptNotepadCodeLensProvider } from './promptNotepadCodeLens.js';
import { setNotepadProvider } from './promptNotepadCommands.js';
import { NotepadEditorPane } from './notepadPane.js';

const SCHEME = 'insrc-prompt';

/**
 * In-memory file system provider for insrc-prompt scheme.
 * Makes the notepad editable (not read-only).
 */
class NotepadFileSystemProvider implements IFileSystemProviderWithFileReadWriteCapability {
	readonly capabilities = FileSystemProviderCapabilities.FileReadWrite;
	readonly onDidChangeCapabilities = Event.None;
	private readonly _onDidChangeFile = new Emitter<readonly IFileChange[]>();
	readonly onDidChangeFile = this._onDidChangeFile.event;

	private _provider: PromptNotepadProvider | undefined;
	setProvider(p: PromptNotepadProvider): void { this._provider = p; }

	async readFile(resource: URI): Promise<Uint8Array> {
		const id = resource.path.split('/').pop() ?? '1';
		const content = this._provider?.getContent(id) ?? '';
		return new TextEncoder().encode(content);
	}

	async writeFile(resource: URI, content: Uint8Array): Promise<void> {
		// Writing is handled by the model directly (auto-save via IStorageService)
		// This method exists to satisfy the provider interface
	}

	async stat(_resource: URI): Promise<IStat> {
		return { type: 1 satisfies FileType, ctime: Date.now(), mtime: Date.now(), size: 0 };
	}

	async mkdir(): Promise<void> { /* noop */ }
	async readdir(): Promise<[string, FileType][]> { return []; }
	async delete(): Promise<void> { /* noop */ }
	async rename(): Promise<void> { /* noop */ }
	watch(): { dispose(): void } { return { dispose() { } }; }
}

export class PromptNotepadContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.insrcPromptNotepad';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@ITextModelService textModelService: ITextModelService,
		@IFileService fileService: IFileService,
	) {
		super();

		// Create the notepad provider
		const provider = this._register(instantiationService.createInstance(PromptNotepadProvider));
		setNotepadProvider(provider);
		// Hand the provider to the unified NotepadEditorPane so it can
		// attach the existing text model to its embedded Monaco editor.
		NotepadEditorPane.setProvider(provider);

		// Register in-memory file system provider (makes editor writable)
		const fsProvider = new NotepadFileSystemProvider();
		fsProvider.setProvider(provider);
		this._register(fileService.registerProvider(SCHEME, fsProvider));

		// Register content provider for resolving models
		this._register(textModelService.registerTextModelContentProvider(SCHEME, {
			provideTextContent: async (resource: URI): Promise<ITextModel | null> => {
				const notepadId = resource.path.split('/').pop() ?? '1';
				const { model } = provider.getOrCreateModel(notepadId);
				return model;
			},
		}));

		// Register CodeLens provider for insrc-prompt scheme
		const codeLensProvider = new PromptNotepadCodeLensProvider();
		this._register(languageFeaturesService.codeLensProvider.register(
			{ scheme: SCHEME },
			codeLensProvider,
		));
	}
}
