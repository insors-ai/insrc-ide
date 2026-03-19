/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IInsrcKeychainService = createDecorator<IInsrcKeychainService>('insrcKeychainService');

export interface IInsrcKeychainService {
	readonly _serviceBrand: undefined;

	/** List all keys (values are masked) */
	listKeys(): Promise<Array<{ name: string; masked: string }>>;

	/** Store a key in the OS keychain */
	setKey(name: string, value: string): Promise<void>;

	/** Delete a key from the OS keychain */
	deleteKey(name: string): Promise<void>;
}
