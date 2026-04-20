/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BrainstormStepInputBase } from './brainstormStepInput.js';

export class BrainstormThemesInput extends BrainstormStepInputBase {
	static readonly ID = 'insrc.brainstormThemesInput';

	protected override get stepPath(): string { return '/themes'; }
	override get typeId(): string { return BrainstormThemesInput.ID; }
	override getName(): string { return 'Brainstorm: Themes'; }
}
