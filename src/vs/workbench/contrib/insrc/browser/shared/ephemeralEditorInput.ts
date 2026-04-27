/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput } from '../../../../common/editor/editorInput.js';
import { URI } from '../../../../../base/common/uri.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import type { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import type { IDisposable } from '../../../../../base/common/lifecycle.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { EditorExtensions, type IEditorFactoryRegistry, type IEditorSerializer } from '../../../../common/editor.js';

/**
 * Shared base for ephemeral insrc panes (notepad, artifacts, analysis
 * report, brainstorm presentation, ...).
 *
 * Ephemeral panes used to mount their content under custom URI schemes
 * (`insrc-notepad:`, `insrc-artifacts:`, ...) backed by in-memory
 * providers. The workbench would persist tabs across restarts but the
 * scheme provider hadn't initialised by the time editor restoration
 * tried to resolve content -- so the user got an "error pane" on
 * every reopened ephemeral tab.
 *
 * This base class fixes that by giving each ephemeral pane a real
 * `file://` URI under `~/.insrc/tmp/`. The URI resolves to an actual
 * file on disk that survives restarts; the workbench's standard
 * editor restoration finds something concrete to open. A startup
 * reconciler (registered in `ephemeralPaneContribution.ts`) prunes
 * any backing file that no open editor references on startup, so
 * orphan temp files don't accumulate.
 *
 * Subclasses provide:
 *   - a stable `paneId` for the file-name prefix (e.g. 'notepad').
 *   - a per-instance `instanceId` (e.g. notepadId, sessionId).
 *   - optionally an `extension` (default '.md') and
 *     `getInitialContent()` (default '').
 *
 * Open commands MUST `await input.ensureBackingFile(fileService)`
 * before passing the input to `editorService.openEditor(input)` --
 * otherwise the workbench tries to read a file that doesn't exist
 * yet on first open. Restoration after a restart already has the
 * file on disk from the previous session, so deserialize() doesn't
 * need to call ensureBackingFile (the reconciler runs after
 * restoration anyway, so concurrent deletion is impossible).
 */
export abstract class EphemeralEditorInput extends EditorInput {

	// -- Static singleton: tmp-dir URI -------------------------------------

	private static _tmpDir: URI | undefined;

	/**
	 * Set by `EphemeralPaneInitContribution` at workbench BlockStartup
	 * phase, before any pane's deserialize() can fire. Throws if any
	 * subclass tries to compute `resource` before this is set.
	 */
	static setTmpDir(uri: URI): void {
		EphemeralEditorInput._tmpDir = uri;
	}

	static getTmpDir(): URI {
		if (EphemeralEditorInput._tmpDir === undefined) {
			throw new Error(
				'EphemeralEditorInput.tmpDir not initialised. ' +
				'EphemeralPaneInitContribution must run before any ephemeral pane is constructed.',
			);
		}
		return EphemeralEditorInput._tmpDir;
	}

	// -- Per-instance state -------------------------------------------------

	constructor(
		readonly paneId: string,
		readonly instanceId: string,
		protected readonly extension: string = '.md',
	) {
		super();
	}

	override get resource(): URI {
		return joinPath(EphemeralEditorInput.getTmpDir(), `${this.paneId}-${this.instanceId}${this.extension}`);
	}

	/**
	 * Initial content the backing file is populated with on first
	 * creation. Default: empty string. Subclasses override to seed a
	 * template (e.g. the prompt notepad's "# Prompt Notepad ..." header).
	 */
	protected getInitialContent(): string {
		return '';
	}

	/**
	 * Ensure the backing file exists on disk. Idempotent: leaves an
	 * existing file alone (so we don't clobber a user's notepad
	 * content with the template). Open commands call this before
	 * `editorService.openEditor(input)`.
	 */
	async ensureBackingFile(fileService: IFileService): Promise<void> {
		const uri = this.resource;
		if (await fileService.exists(uri)) {
			return;
		}
		const content = this.getInitialContent();
		await fileService.createFile(uri, VSBuffer.fromString(content), { overwrite: false });
	}
}

/**
 * Register an `IEditorSerializer` for an ephemeral input subclass so
 * the workbench can restore it across IDE restarts. The serializer is
 * trivial -- it stores `instanceId` only; `paneId`, `extension`, and
 * any DI dependencies are baked into the subclass constructor and
 * the factory closure.
 *
 * Pass `factory(instanceId, instantiationService)` because some
 * subclasses (brainstorm) take service injections via decorator and
 * must therefore be built through `instantiationService.createInstance`.
 * Subclasses without DI can ignore the second arg.
 */
export function registerEphemeralEditorSerializer<TInput extends EphemeralEditorInput>(
	typeId: string,
	factory: (instanceId: string, instantiationService: IInstantiationService) => TInput,
): IDisposable {

	class Serializer implements IEditorSerializer {

		canSerialize(): boolean {
			return true;
		}

		serialize(editor: EditorInput): string | undefined {
			if (!(editor instanceof EphemeralEditorInput)) {
				return undefined;
			}
			return JSON.stringify({ instanceId: editor.instanceId });
		}

		deserialize(instantiationService: IInstantiationService, serialized: string): EditorInput | undefined {
			try {
				const parsed = JSON.parse(serialized) as { instanceId?: unknown };
				if (typeof parsed.instanceId !== 'string') {
					return undefined;
				}
				return factory(parsed.instanceId, instantiationService);
			} catch {
				return undefined;
			}
		}
	}

	return Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)
		.registerEditorSerializer(typeId, Serializer);
}
