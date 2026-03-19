/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IInsrcDiffService, type InsrcFileDiff, type DiffAction } from '../common/diffService.js';
import { ProposedContentProvider, INSRC_PROPOSED_SCHEME } from '../browser/diff/proposedContentProvider.js';
import { DiffCodeLensProvider } from '../browser/diff/diffCodeLens.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { DiffEditorInput } from '../../../common/editor/diffEditorInput.js';
import { basename } from '../../../../base/common/resources.js';

// ---------------------------------------------------------------------------
// Active diff tracking
// ---------------------------------------------------------------------------

interface ActiveDiff {
	filePath: string;
	proposedUri: URI;
	gateId: string;
	proposedContent: string;
}

// ---------------------------------------------------------------------------
// DiffService implementation
// ---------------------------------------------------------------------------

export class InsrcDiffServiceImpl extends Disposable implements IInsrcDiffService {
	declare readonly _serviceBrand: undefined;

	private readonly _activeDiffs = new Map<string, ActiveDiff>();
	private readonly _contentProvider: ProposedContentProvider;
	private readonly _codeLensProvider: DiffCodeLensProvider;

	private readonly _onDidAction = this._register(new Emitter<DiffAction>());
	readonly onDidAction: Event<DiffAction> = this._onDidAction.event;

	get activeDiffCount(): number {
		return this._activeDiffs.size;
	}

	constructor(
		@ILogService private readonly logService: ILogService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IEditorService private readonly editorService: IEditorService,
		@IFileService private readonly fileService: IFileService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
	) {
		super();

		this._contentProvider = this._register(this.instantiationService.createInstance(ProposedContentProvider));
		this._codeLensProvider = this._register(new DiffCodeLensProvider());
	}

	// ---------------------------------------------------------------------------
	// Register CodeLens (called from browser contribution)
	// ---------------------------------------------------------------------------

	registerCodeLens(languageFeaturesService: unknown): void {
		const svc = languageFeaturesService as ILanguageFeaturesService;
		const provider = this._codeLensProvider;
		this._register(svc.codeLensProvider.register(
			{ scheme: INSRC_PROPOSED_SCHEME },
			{
				onDidChange: provider.onDidChange,
				provideCodeLenses: (model, token) => provider.provideCodeLenses(model, token),
			},
		));
	}

	// ---------------------------------------------------------------------------
	// Show diffs
	// ---------------------------------------------------------------------------

	async showDiffs(diffs: InsrcFileDiff[], gateId: string): Promise<void> {
		this.closeAll();

		for (const diff of diffs) {
			const proposedUri = this._contentProvider.set(diff.filePath, diff.proposedContent);

			this._activeDiffs.set(diff.filePath, {
				filePath: diff.filePath,
				proposedUri,
				gateId,
				proposedContent: diff.proposedContent,
			});

			this._codeLensProvider.setActive(diff.filePath);

			const originalUri = URI.file(diff.filePath);
			const label = `${basename(originalUri)} (proposed)`;

			try {
				await this.editorService.openEditor({
					original: { resource: originalUri },
					modified: { resource: proposedUri },
					label,
					options: {
						pinned: true,
						preserveFocus: false,
					},
				});
			} catch (err) {
				this.logService.warn('[insrc-diff] Failed to open diff editor for', diff.filePath, err);
			}
		}

		this.logService.info('[insrc-diff] Opened', diffs.length, 'diff tab(s) for gate', gateId);
	}

	// ---------------------------------------------------------------------------
	// Accept / Reject / Edit
	// ---------------------------------------------------------------------------

	async acceptFile(filePath: string): Promise<void> {
		const active = this._activeDiffs.get(filePath);
		if (!active) {
			return;
		}

		try {
			const uri = URI.file(filePath);
			await this.fileService.writeFile(uri, VSBuffer.fromString(active.proposedContent));
			this.logService.info('[insrc-diff] Accepted:', filePath);
		} catch (err) {
			this.logService.error('[insrc-diff] Failed to write accepted file:', filePath, err);
			return;
		}

		this._closeDiff(filePath);
		this._onDidAction.fire({ type: 'accept', filePath, gateId: active.gateId });
	}

	rejectFile(filePath: string): void {
		const active = this._activeDiffs.get(filePath);
		if (!active) {
			return;
		}

		this.logService.info('[insrc-diff] Rejected:', filePath);
		this._closeDiff(filePath);
		this._onDidAction.fire({ type: 'reject', filePath, gateId: active.gateId });
	}

	async editFile(filePath: string): Promise<string | undefined> {
		const active = this._activeDiffs.get(filePath);
		if (!active) {
			return undefined;
		}

		const feedback = await this.quickInputService.input({
			placeHolder: 'Describe what to change...',
			prompt: 'Edit feedback for the agent',
		});

		if (feedback === undefined) {
			return undefined;
		}

		this.logService.info('[insrc-diff] Edit requested:', filePath, feedback);
		this._closeDiff(filePath);
		this._onDidAction.fire({ type: 'edit', filePath, gateId: active.gateId, feedback });
		return feedback;
	}

	async acceptAll(): Promise<void> {
		const files = [...this._activeDiffs.keys()];
		for (const filePath of files) {
			await this.acceptFile(filePath);
		}
	}

	rejectAll(): void {
		const files = [...this._activeDiffs.keys()];
		for (const filePath of files) {
			this.rejectFile(filePath);
		}
	}

	closeAll(): void {
		const files = [...this._activeDiffs.keys()];
		for (const filePath of files) {
			this._closeDiff(filePath);
		}
	}

	// ---------------------------------------------------------------------------
	// Internal
	// ---------------------------------------------------------------------------

	private _closeDiff(filePath: string): void {
		const active = this._activeDiffs.get(filePath);
		if (!active) {
			return;
		}

		this._closeDiffTab(active.proposedUri);
		this._contentProvider.remove(filePath);
		this._codeLensProvider.removeActive(filePath);
		this._activeDiffs.delete(filePath);
	}

	private _closeDiffTab(proposedUri: URI): void {
		for (const group of this.editorGroupsService.groups) {
			for (const editor of group.editors) {
				if (editor instanceof DiffEditorInput) {
					const modifiedUri = editor.modified.resource;
					if (modifiedUri && modifiedUri.scheme === INSRC_PROPOSED_SCHEME && modifiedUri.toString() === proposedUri.toString()) {
						group.closeEditor(editor);
						return;
					}
				}
			}
		}
	}

	override dispose(): void {
		this.closeAll();
		super.dispose();
	}
}
