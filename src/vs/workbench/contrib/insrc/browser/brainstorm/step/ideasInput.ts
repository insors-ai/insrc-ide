/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BrainstormStepInputBase } from './brainstormStepInput.js';

export class BrainstormIdeasInput extends BrainstormStepInputBase {
	static readonly ID = 'insrc.brainstormIdeasInput';

	protected override get stepPath(): string { return '/ideas'; }
	override get typeId(): string { return BrainstormIdeasInput.ID; }
	override getName(): string { return 'Brainstorm: Ideas'; }
}
