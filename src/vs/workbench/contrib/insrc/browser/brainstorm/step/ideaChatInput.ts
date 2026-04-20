/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BrainstormStepInputBase } from './brainstormStepInput.js';

export class BrainstormIdeaChatInput extends BrainstormStepInputBase {
	static readonly ID = 'insrc.brainstormIdeaChatInput';

	protected override get stepPath(): string { return '/discuss'; }
	override get typeId(): string { return BrainstormIdeaChatInput.ID; }
	override getName(): string { return 'Brainstorm: Discuss'; }
}
