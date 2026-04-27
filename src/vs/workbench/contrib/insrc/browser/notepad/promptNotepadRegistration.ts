/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { PromptNotepadCodeLensProvider } from './promptNotepadCodeLens.js';
import { NotepadEditorInput } from './notepadInput.js';
import { registerEphemeralEditorSerializer } from '../shared/ephemeralEditorInput.js';

// Cross-restart restoration: the workbench's editor restorer calls
// this serializer to round-trip the input across IDE restarts. The
// backing markdown file is already on disk from the previous
// session, so deserialize() just reconstructs the input via the
// public ctor. App-lifetime registration -- intentionally at module
// load (not inside the BelowRestored contribution) so the serializer
// is in place by the time the workbench rehydrates persisted tabs.
// The IDisposable is discarded for the same reason artifacts'
// equivalent does so: the registration lives for the workbench's
// lifetime.
registerEphemeralEditorSerializer(
	NotepadEditorInput.ID,
	(instanceId) => new NotepadEditorInput(instanceId),
);

/**
 * Workbench contribution that wires the prompt-notepad's CodeLens
 * provider.
 *
 * Pre-Phase-9-followup the notepad lived under a custom `insrc-prompt:`
 * scheme backed by an in-memory provider + filesystem provider; the
 * scheme has been retired in favour of a real file under
 * `~/.insrc/tmp/notepad-<id>.md` (see `EphemeralEditorInput`). The
 * serializer registration moved to module load (above); all that's
 * left here is the CodeLens registration, which depends on
 * `ILanguageFeaturesService` and therefore needs DI through a
 * contribution.
 */
export class PromptNotepadContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.insrcPromptNotepad';

	constructor(
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
	) {
		super();

		// CodeLens for any markdown file the notepad backs onto. The
		// pattern intentionally matches the EphemeralEditorInput naming
		// convention (`notepad-*.md`) under any path containing
		// `.insrc/tmp` -- works with both posix (`/home/.../`) and
		// windows (`C:\\Users\\...\\`) home-dir layouts via the
		// language-features matcher.
		this._register(languageFeaturesService.codeLensProvider.register(
			{ scheme: 'file', pattern: '**/.insrc/tmp/notepad-*.md' },
			new PromptNotepadCodeLensProvider(),
		));
	}
}
