/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../../nls.js';
import { URI } from '../../../../../base/common/uri.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IInsrcArtifactsService } from '../../common/artifactsService.js';
import {
	ARTIFACT_KINDS,
	type ArtifactKind,
} from '../../common/insrcArtifacts.js';

/**
 * Palette commands for managing artifact template overrides
 * (plans/artifact-tasks.md section 2.3).
 *
 * All three round-trip to the daemon via IInsrcArtifactsService:
 *   - insrc.editArtifactTemplate  -- seed + open in editor
 *   - insrc.resetArtifactTemplate -- delete user override (with confirm)
 *   - insrc.listArtifactTemplates -- quick pick showing resolved layer
 */

const CATEGORY = localize2('insrc', 'insrc');

const KIND_LABELS: Readonly<Record<ArtifactKind, string>> = {
	er: 'ER diagram',
	sequence: 'Sequence diagram',
	flow: 'Flow diagram',
	deployment: 'Deployment diagram',
	wireframe: 'Wireframe',
};

interface KindPickItem extends IQuickPickItem {
	readonly kind: ArtifactKind;
}

/**
 * Prompt the user for an artifact kind. Returns undefined when the
 * user cancels.
 */
async function pickKind(
	accessor: ServicesAccessor,
	placeholder: string,
	layerHints?: Readonly<Record<ArtifactKind, string>>,
): Promise<ArtifactKind | undefined> {
	const quickInput = accessor.get(IQuickInputService);
	const items: KindPickItem[] = ARTIFACT_KINDS.map(kind => {
		const item: KindPickItem = {
			kind,
			label: KIND_LABELS[kind],
			description: kind,
		};
		const hint = layerHints?.[kind];
		if (hint !== undefined) {
			item.detail = hint;
		}
		return item;
	});
	const picked = await quickInput.pick(items, { placeHolder: placeholder });
	return picked?.kind;
}

// ---------------------------------------------------------------------------
// insrc.editArtifactTemplate
// ---------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.editArtifactTemplate',
			title: localize2('insrc.editArtifactTemplate', 'Edit Artifact Template'),
			f1: true,
			category: CATEGORY,
		});
	}

	async run(accessor: ServicesAccessor, argKind?: string): Promise<void> {
		const artifactsService = accessor.get(IInsrcArtifactsService);
		const editorService = accessor.get(IEditorService);
		const notificationService = accessor.get(INotificationService);

		const kind = await resolveKindArg(argKind)
			?? await pickKind(accessor, 'Select an artifact kind to edit');
		if (kind === undefined) { return; }

		try {
			const result = await artifactsService.ensureUserTemplate(kind);
			await editorService.openEditor({
				resource: URI.file(result.userPath),
				options: { preserveFocus: false, pinned: true },
			});
			if (result.seeded) {
				notificationService.notify({
					severity: Severity.Info,
					message: `Seeded ${KIND_LABELS[kind]} template from the bundled default at ${result.userPath}. ` +
						'Save to take effect; the template loader picks it up on the next artifact render.',
				});
			}
		} catch (err) {
			notificationService.error(`Edit artifact template failed: ${(err as Error).message}`);
		}
	}
});

// ---------------------------------------------------------------------------
// insrc.resetArtifactTemplate
// ---------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.resetArtifactTemplate',
			title: localize2('insrc.resetArtifactTemplate', 'Reset Artifact Template'),
			f1: true,
			category: CATEGORY,
		});
	}

	async run(accessor: ServicesAccessor, argKind?: string): Promise<void> {
		const artifactsService = accessor.get(IInsrcArtifactsService);
		const dialogService = accessor.get(IDialogService);
		const notificationService = accessor.get(INotificationService);

		const kind = await resolveKindArg(argKind)
			?? await pickKind(accessor, 'Select an artifact kind whose user template to delete');
		if (kind === undefined) { return; }

		const confirmation = await dialogService.confirm({
			message: `Delete the user-override template for ${KIND_LABELS[kind]}?`,
			detail: 'Future artifacts of this kind will render from the bundled default (or the repo override, if any).',
			primaryButton: 'Delete',
			type: 'warning',
		});
		if (!confirmation.confirmed) { return; }

		try {
			const result = await artifactsService.resetUserTemplate(kind);
			if (result.removedPath === null) {
				notificationService.notify({
					severity: Severity.Info,
					message: `No user override for ${KIND_LABELS[kind]} to delete.`,
				});
			} else {
				notificationService.notify({
					severity: Severity.Info,
					message: `Deleted user override for ${KIND_LABELS[kind]} (${result.removedPath}).`,
				});
			}
		} catch (err) {
			notificationService.error(`Reset artifact template failed: ${(err as Error).message}`);
		}
	}
});

// ---------------------------------------------------------------------------
// insrc.listArtifactTemplates
// ---------------------------------------------------------------------------

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'insrc.listArtifactTemplates',
			title: localize2('insrc.listArtifactTemplates', 'List Artifact Templates'),
			f1: true,
			category: CATEGORY,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const artifactsService = accessor.get(IInsrcArtifactsService);
		const editorService = accessor.get(IEditorService);
		const notificationService = accessor.get(INotificationService);

		const infos = await artifactsService.listTemplates();
		if (infos.length === 0) {
			notificationService.notify({
				severity: Severity.Info,
				message: 'No artifact templates resolved -- daemon may be disconnected.',
			});
			return;
		}

		const layerHints: Partial<Record<ArtifactKind, string>> = {};
		for (const info of infos) {
			layerHints[info.kind] = `${info.layer.toUpperCase()} -- ${info.path}`;
		}

		const picked = await pickKind(
			accessor,
			'Artifact templates (select one to open its resolved file)',
			layerHints as Readonly<Record<ArtifactKind, string>>,
		);
		if (picked === undefined) { return; }

		const info = infos.find(i => i.kind === picked);
		if (info === undefined) { return; }
		try {
			await editorService.openEditor({
				resource: URI.file(info.path),
				options: { preserveFocus: false, pinned: true },
			});
		} catch (err) {
			notificationService.error(`Open template failed: ${(err as Error).message}`);
		}
	}
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Coerce an optional command argument into an ArtifactKind. Commands
 * can be invoked from keybindings / other commands that pass a kind
 * directly; this skips the quick pick when a valid one is supplied.
 */
async function resolveKindArg(arg: unknown): Promise<ArtifactKind | undefined> {
	if (typeof arg !== 'string') { return undefined; }
	if ((ARTIFACT_KINDS as readonly string[]).includes(arg)) {
		return arg as ArtifactKind;
	}
	return undefined;
}
