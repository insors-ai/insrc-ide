/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BrainstormStepInputBase } from './brainstormStepInput.js';

export class BrainstormPresentationInput extends BrainstormStepInputBase {
	static readonly ID = 'insrc.brainstormPresentationInput';

	protected override get stepPath(): string { return '/presentation'; }
	override get typeId(): string { return BrainstormPresentationInput.ID; }
	override getName(): string { return 'Brainstorm: Final'; }
}
