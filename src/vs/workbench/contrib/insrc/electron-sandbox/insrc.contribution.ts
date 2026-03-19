/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInsrcDaemonService } from '../common/daemonService.js';
import { IInsrcSessionService } from '../common/sessionService.js';
import { InsrcDaemonServiceImpl } from './daemonServiceImpl.js';
import { InsrcSessionServiceImpl } from './sessionServiceImpl.js';

// Register services (desktop/Electron only)
registerSingleton(IInsrcDaemonService, InsrcDaemonServiceImpl, InstantiationType.Delayed);
registerSingleton(IInsrcSessionService, InsrcSessionServiceImpl, InstantiationType.Delayed);
