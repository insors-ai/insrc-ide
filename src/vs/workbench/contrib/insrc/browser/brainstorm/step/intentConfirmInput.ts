/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BrainstormStepInputBase } from './brainstormStepInput.js';

export class BrainstormIntentConfirmInput extends BrainstormStepInputBase {
	static readonly ID = 'insrc.brainstormIntentConfirmInput';

	protected override get stepPath(): string { return '/intent-confirm'; }
	override get typeId(): string { return BrainstormIntentConfirmInput.ID; }
	override getName(): string { return 'Confirm intent'; }
}
