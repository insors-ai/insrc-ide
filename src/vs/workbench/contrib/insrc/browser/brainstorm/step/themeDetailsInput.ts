/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BrainstormStepInputBase } from './brainstormStepInput.js';

export class BrainstormThemeDetailsInput extends BrainstormStepInputBase {
	static readonly ID = 'insrc.brainstormThemeDetailsInput';

	protected override get stepPath(): string { return '/theme-spec'; }
	override get typeId(): string { return BrainstormThemeDetailsInput.ID; }
	override getName(): string { return 'Brainstorm: Theme Spec'; }
}
