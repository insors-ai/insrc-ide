/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IInsrcChatService } from '../../common/chatService.js';
import { IInsrcRepoService } from '../../common/repoService.js';
import { IInsrcDaemonService } from '../../common/daemonService.js';
import { PromptNotepadProvider } from './promptNotepadProvider.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';

let notepadProvider: PromptNotepadProvider | undefined;

export function setNotepadProvider(provider: PromptNotepadProvider): void {
	notepadProvider = provider;
}

// ---------------------------------------------------------------------------
// Variable expansion
// ---------------------------------------------------------------------------

async function expandVariables(
	text: string,
	accessor: ServicesAccessor,
): Promise<string> {
	const editorService = accessor.get(IEditorService);
	const clipboardService = accessor.get(IClipboardService);
	const repoService = accessor.get(IInsrcRepoService);

	// Get active code editor (if any)
	const activeEditor = editorService.activeTextEditorControl as ICodeEditor | undefined;
	const activeModel = activeEditor?.getModel?.();
	const activeSelection = activeEditor?.getSelection?.();

	const repos = repoService.repos;
	const activeRepo = repos.length > 0 ? repos[0] : undefined;

	let result = text;

	result = result.replace(/\$\{repo\}/g, activeRepo?.path ?? '');
	result = result.replace(/\$\{repoName\}/g, activeRepo?.name ?? '');
	result = result.replace(/\$\{file\}/g, activeModel?.uri?.fsPath ?? '');
	const filePath = activeModel?.uri?.fsPath ?? '';
	result = result.replace(/\$\{fileName\}/g, filePath.split('/').pop() ?? '');
	result = result.replace(/\$\{line\}/g, String(activeSelection?.startLineNumber ?? 1));

	if (result.includes('${selection}') && activeModel && activeSelection && !activeSelection.isEmpty()) {
		const selText = activeModel.getValueInRange(activeSelection);
		result = result.replace(/\$\{selection\}/g, selText);
	} else {
		result = result.replace(/\$\{selection\}/g, '');
	}

	if (result.includes('${clipboard}')) {
		const clip = await clipboardService.readText();
		result = result.replace(/\$\{clipboard\}/g, clip);
	}

	return result;
}

// ---------------------------------------------------------------------------
// Strip comment lines
// ---------------------------------------------------------------------------

function stripComments(text: string): string {
	return text
		.split('\n')
		.filter(line => !line.trimStart().startsWith('#'))
		.join('\n')
		.trim();
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

// Open Prompt Notepad
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.promptNotepad.open',
			title: localize2('insrc.promptNotepad.open', 'Open Prompt Notepad'),
			f1: true,
			category: localize2('insrc', 'insrc'),
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyN,
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		if (!notepadProvider) { return; }
		const editorService = accessor.get(IEditorService);
		const { uri } = notepadProvider.getOrCreateModel('1');
		await editorService.openEditor({ resource: uri, options: { pinned: true } });
	}
});

// Run All
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.promptNotepad.runAll',
			title: localize2('insrc.promptNotepad.runAll', 'Run Prompt Notepad'),
			f1: false,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		if (!notepadProvider) { return; }
		const chatService = accessor.get(IInsrcChatService);
		const content = notepadProvider.getContent('1');
		const stripped = stripComments(content);
		if (!stripped) { return; }
		const expanded = await expandVariables(stripped, accessor);
		await chatService.sendMessage(expanded);
	}
});

// Run Selection
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.promptNotepad.runSelection',
			title: localize2('insrc.promptNotepad.runSelection', 'Run Prompt Selection'),
			f1: false,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const chatService = accessor.get(IInsrcChatService);

		const editor = editorService.activeTextEditorControl as ICodeEditor | undefined;
		const model = editor?.getModel?.();
		const selection = editor?.getSelection?.();

		if (model && selection && !selection.isEmpty()) {
			const selectedText = model.getValueInRange(selection);
			const stripped = stripComments(selectedText);
			if (stripped) {
				const expanded = await expandVariables(stripped, accessor);
				await chatService.sendMessage(expanded);
				return;
			}
		}

		// Fall back to run all
		if (!notepadProvider) { return; }
		const content = notepadProvider.getContent('1');
		const stripped = stripComments(content);
		if (!stripped) { return; }
		const expanded = await expandVariables(stripped, accessor);
		await chatService.sendMessage(expanded);
	}
});

// Clear
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.promptNotepad.clear',
			title: localize2('insrc.promptNotepad.clear', 'Clear Prompt Notepad'),
			f1: false,
		});
	}
	run(): void {
		notepadProvider?.clear('1');
	}
});

// Save to file (Ctrl+S when notepad is focused)
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.promptNotepad.saveToFile',
			title: localize2('insrc.promptNotepad.saveToFile', 'Save Prompt to File'),
			f1: true,
			category: localize2('insrc', 'insrc'),
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		if (!notepadProvider) { return; }
		const fileDialogService = accessor.get(IFileDialogService);
		const fileService = accessor.get(IFileService);
		const notificationService = accessor.get(INotificationService);

		const content = notepadProvider.getContent('1');
		if (!content.trim()) {
			notificationService.info('Notepad is empty.');
			return;
		}

		const uri = await fileDialogService.showSaveDialog({
			title: 'Save Prompt',
			filters: [
				{ name: 'Markdown', extensions: ['md'] },
				{ name: 'Text', extensions: ['txt'] },
				{ name: 'All Files', extensions: ['*'] },
			],
		});

		if (!uri) { return; }

		await fileService.writeFile(uri, VSBuffer.fromString(content));
		notificationService.info(`Prompt saved to ${uri.fsPath}`);
	}
});

// Save as Template (uses daemon RPC to write to ~/.insrc/templates/)
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.promptNotepad.saveTemplate',
			title: localize2('insrc.promptNotepad.saveTemplate', 'Save Prompt as Template'),
			f1: true,
			category: localize2('insrc', 'insrc'),
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		if (!notepadProvider) { return; }
		const quickInput = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);
		const daemonService = accessor.get(IInsrcDaemonService);

		const content = notepadProvider.getContent('1');
		const stripped = stripComments(content);
		if (!stripped) {
			notificationService.info('Notepad is empty.');
			return;
		}

		const name = await quickInput.input({
			prompt: 'Template name',
			placeHolder: 'e.g. security-audit, code-review',
		});
		if (!name) { return; }

		try {
			await daemonService.rpc('template.save', { name, content });
			notificationService.info(`Template saved: ${name}`);
		} catch {
			notificationService.error('Failed to save template.');
		}
	}
});

// Load Template (uses daemon RPC to read from ~/.insrc/templates/)
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.promptNotepad.loadTemplate',
			title: localize2('insrc.promptNotepad.loadTemplate', 'Load Prompt Template'),
			f1: true,
			category: localize2('insrc', 'insrc'),
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		if (!notepadProvider) { return; }
		const quickInput = accessor.get(IQuickInputService);
		const editorService = accessor.get(IEditorService);
		const daemonService = accessor.get(IInsrcDaemonService);
		const notificationService = accessor.get(INotificationService);

		let templates: Array<{ name: string; description: string }>;
		try {
			const result = await daemonService.rpc<string[]>('template.list', {});
			templates = (result ?? []).map((name: string) => ({ name, description: name }));
		} catch {
			notificationService.info('No templates found.');
			return;
		}

		if (templates.length === 0) {
			notificationService.info('No templates found. Save one first.');
			return;
		}

		const pick = await quickInput.pick(
			templates.map(t => ({ label: t.name.replace('.md', ''), description: t.description })),
			{ placeHolder: 'Select a template to load' },
		);
		if (!pick) { return; }

		try {
			const content = await daemonService.rpc<string>('template.load', { name: pick.label });
			if (content) {
				const { model, uri } = notepadProvider.getOrCreateModel('1');
				model.setValue(content);
				await editorService.openEditor({ resource: uri, options: { pinned: true } });
			}
		} catch {
			notificationService.error('Failed to load template.');
		}
	}
});
