/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BrainstormStepInputBase } from './brainstormStepInput.js';

export class BrainstormIdeaListInput extends BrainstormStepInputBase {
	static readonly ID = 'insrc.brainstormIdeaListInput';

	protected override get stepPath(): string { return '/idea-list'; }
	override get typeId(): string { return BrainstormIdeaListInput.ID; }
	override getName(): string { return 'Brainstorm: Idea List'; }
}
