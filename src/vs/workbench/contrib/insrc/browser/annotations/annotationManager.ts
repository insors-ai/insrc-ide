/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, type Event } from '../../../../../base/common/event.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { Action2, registerAction2, MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { localize2 } from '../../../../../nls.js';
import { EditorContextKeys } from '../../../../../editor/common/editorContextKeys.js';
import { IInsrcChatService, type CodeAnnotation } from '../../common/chatService.js';
import { Range } from '../../../../../editor/common/core/range.js';
import type { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import type { IModelDeltaDecoration, ITextModel } from '../../../../../editor/common/model.js';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import type { CodeLens, CodeLensList } from '../../../../../editor/common/languages.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Annotation {
	id: string;
	file: string;
	range: Range;
	text: string;
	note: string;
	createdAt: string;
}

// ---------------------------------------------------------------------------
// Annotation manager contribution
// ---------------------------------------------------------------------------

export class InsrcAnnotationContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.insrcAnnotations';

	private readonly _annotations: Annotation[] = [];
	private _nextId = 1;
	private _decorationIds = new Map<string, string[]>(); // file -> decoration IDs


	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
		@IInsrcChatService private readonly chatService: IInsrcChatService,
	) {
		super();

		this._registerCommands();
		this._registerCodeLens();

		// Refresh decorations when active editor changes
		this._register(this.editorService.onDidActiveEditorChange(() => this._refreshDecorations()));
	}

	// ---------------------------------------------------------------------------
	// Commands
	// ---------------------------------------------------------------------------

	private _registerCommands(): void {
		this._register(CommandsRegistry.registerCommand('insrc.addAnnotation', async () => {
			await this._addAnnotation();
		}));

		this._register(CommandsRegistry.registerCommand('insrc.editAnnotation', async (_accessor, id: string) => {
			await this._editAnnotation(id);
		}));

		this._register(CommandsRegistry.registerCommand('insrc.removeAnnotation', (_accessor, id: string) => {
			this._removeAnnotation(id);
		}));

		this._register(CommandsRegistry.registerCommand('insrc.sendAnnotations', async () => {
			await this._sendAnnotations();
		}));

		this._register(CommandsRegistry.registerCommand('insrc.clearAnnotations', () => {
			this._clearAll();
		}));

		// Editor context menu: "Annotate Selection" shows when text is selected
		this._register(MenuRegistry.appendMenuItem(MenuId.EditorContext, {
			command: { id: 'insrc.addAnnotation', title: 'insrc: Add Note to Selection' },
			group: '9_insrc',
			order: 1,
			when: EditorContextKeys.hasNonEmptySelection,
		}));
	}

	// ---------------------------------------------------------------------------
	// CodeLens
	// ---------------------------------------------------------------------------

	private _codeLensChangeEmitter: Emitter<unknown> | undefined;

	private _registerCodeLens(): void {
		this._codeLensChangeEmitter = this._register(new Emitter<unknown>());
		const changeEvent = this._codeLensChangeEmitter.event;
		const annotations = this._annotations;

		this._register(this.languageFeaturesService.codeLensProvider.register(
			{ scheme: 'file' },
			{
				onDidChange: changeEvent as Event<never>,
				provideCodeLenses: (model: ITextModel, _token: CancellationToken): CodeLensList => {
					const lenses: CodeLens[] = [];
					for (const ann of annotations) {
						if (ann.file !== model.uri.fsPath) {
							continue;
						}
						lenses.push({
							range: ann.range,
							command: {
								id: 'insrc.editAnnotation',
								title: `$(pin) ${ann.note.slice(0, 60)}${ann.note.length > 60 ? '...' : ''}`,
								tooltip: `${ann.note}\n\nClick to edit | Right-click to remove`,
								arguments: [ann.id],
							},
						});
					}
					return { lenses, dispose: () => { } };
				},
			},
		));
	}

	private _fireCodeLensChange(): void {
		this._codeLensChangeEmitter?.fire(undefined);
	}

	// ---------------------------------------------------------------------------
	// Add / Edit / Remove
	// ---------------------------------------------------------------------------

	private async _addAnnotation(): Promise<void> {
		const editor = this._getActiveCodeEditor();
		if (!editor) {
			this.notificationService.info('No active editor. Open a file first.');
			return;
		}

		const selection = editor.getSelection();
		if (!selection || selection.isEmpty()) {
			this.notificationService.info('Select some code to annotate.');
			return;
		}

		const note = await this.quickInputService.input({
			prompt: 'What should the agent know about this code?',
			placeHolder: 'e.g. "this is the entry point", "bug is here", "needs refactoring"',
		});

		if (!note) {
			return;
		}

		const model = editor.getModel();
		if (!model) {
			return;
		}

		const ann: Annotation = {
			id: String(this._nextId++),
			file: model.uri.fsPath,
			range: Range.lift(selection),
			text: model.getValueInRange(selection),
			note,
			createdAt: new Date().toISOString(),
		};

		this._annotations.push(ann);
		this._refreshDecorations();
		this._fireCodeLensChange();
		this.logService.info('[insrc-annotations] Added:', ann.file, 'line', ann.range.startLineNumber, ann.note.slice(0, 50));
	}

	private async _editAnnotation(id: string): Promise<void> {
		const ann = this._annotations.find(a => a.id === id);
		if (!ann) {
			return;
		}

		const note = await this.quickInputService.input({
			prompt: 'Edit annotation',
			value: ann.note,
		});

		if (note !== undefined) {
			ann.note = note;
			this._refreshDecorations();
			this._fireCodeLensChange();
		}
	}

	private _removeAnnotation(id: string): void {
		const idx = this._annotations.findIndex(a => a.id === id);
		if (idx >= 0) {
			this._annotations.splice(idx, 1);
			this._refreshDecorations();
			this._fireCodeLensChange();
		}
	}

	// ---------------------------------------------------------------------------
	// Send to chat
	// ---------------------------------------------------------------------------

	private async _sendAnnotations(): Promise<void> {
		if (this._annotations.length === 0) {
			this.notificationService.info('No annotations to send. Select code and use "insrc: Annotate Selection" first.');
			return;
		}

		const codeAnnotations: CodeAnnotation[] = this._annotations.map(ann => ({
			file: ann.file,
			line: ann.range.startLineNumber,
			text: ann.text,
			note: ann.note,
		}));

		try {
			await this.chatService.sendAnnotations(codeAnnotations);
			this.notificationService.info(`Sent ${codeAnnotations.length} annotation(s) to chat.`);
			this._clearAll();
		} catch (err) {
			this.notificationService.warn(`Failed to send annotations: ${(err as Error).message}`);
		}
	}

	private _clearAll(): void {
		this._annotations.length = 0;
		this._refreshDecorations();
		this._fireCodeLensChange();
	}

	// ---------------------------------------------------------------------------
	// Decorations
	// ---------------------------------------------------------------------------

	private _refreshDecorations(): void {
		// Group annotations by file
		const byFile = new Map<string, Annotation[]>();
		for (const ann of this._annotations) {
			const list = byFile.get(ann.file) ?? [];
			list.push(ann);
			byFile.set(ann.file, list);
		}

		// Apply decorations to each visible editor
		for (const editor of this.codeEditorService.listCodeEditors()) {
			const model = editor.getModel();
			if (!model) {
				continue;
			}

			const file = model.uri.fsPath;
			const fileAnns = byFile.get(file) ?? [];
			const oldIds = this._decorationIds.get(file) ?? [];

			const newDecorations: IModelDeltaDecoration[] = fileAnns.map(ann => ({
				range: ann.range,
				options: {
					description: 'insrc-annotation',
					className: 'insrc-annotation-highlight',
					glyphMarginClassName: 'codicon codicon-pin insrc-annotation-gutter',
					overviewRuler: {
						color: 'rgba(255, 191, 0, 0.6)',
						position: 4, // OverviewRulerLane.Right
					},
					hoverMessage: {
						value: `**Annotation:** ${fileAnns.find(a => a.range.equalsRange(ann.range))?.note ?? ''}\n\n[Remove](command:insrc.removeAnnotation?${encodeURIComponent(JSON.stringify(ann.id))})`,
						isTrusted: true,
					},
					minimap: {
						color: 'rgba(255, 191, 0, 0.6)',
						position: 1, // MinimapPosition.Inline
					},
				},
			}));

			const newIds = editor.deltaDecorations(oldIds, newDecorations);
			this._decorationIds.set(file, newIds);
		}

		// Clear decorations for files with no annotations
		for (const [file, ids] of this._decorationIds) {
			if (!byFile.has(file) && ids.length > 0) {
				for (const editor of this.codeEditorService.listCodeEditors()) {
					if (editor.getModel()?.uri.fsPath === file) {
						editor.deltaDecorations(ids, []);
					}
				}
				this._decorationIds.delete(file);
			}
		}
	}

	private _getActiveCodeEditor(): ICodeEditor | null {
		return this.codeEditorService.getActiveCodeEditor();
	}

	override dispose(): void {
		this._clearAll();
		super.dispose();
	}
}

// ---------------------------------------------------------------------------
// Command palette entries (f1: true)
// ---------------------------------------------------------------------------

const INSRC_CATEGORY = localize2('insrc', 'insrc');

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.addAnnotation.palette',
			title: localize2('insrc.addAnnotation', 'Add Note to Selection'),
			category: INSRC_CATEGORY,
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);
		await commandService.executeCommand('insrc.addAnnotation');
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.sendAnnotations.palette',
			title: localize2('insrc.sendAnnotations', 'Send Annotations to Chat'),
			category: INSRC_CATEGORY,
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);
		await commandService.executeCommand('insrc.sendAnnotations');
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.clearAnnotations.palette',
			title: localize2('insrc.clearAnnotations', 'Clear All Annotations'),
			category: INSRC_CATEGORY,
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);
		await commandService.executeCommand('insrc.clearAnnotations');
	}
});
