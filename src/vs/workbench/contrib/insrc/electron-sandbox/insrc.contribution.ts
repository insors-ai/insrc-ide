/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInsrcDaemonService } from '../common/daemonService.js';
import { IInsrcSessionService } from '../common/sessionService.js';
import { IInsrcWorkspaceService } from '../common/workspaceService.js';
import { IInsrcRepoService } from '../common/repoService.js';
import { IInsrcAgentRunService } from '../common/agentRunService.js';
import { IInsrcChatService } from '../common/chatService.js';
import { IInsrcDiffService } from '../common/diffService.js';
import { IInsrcConfigService } from '../common/configService.js';
import { IInsrcKeychainService } from '../common/keychainService.js';
import { IInsrcLSPToolService } from '../common/lspToolService.js';
import { IInsrcBrainstormSessionService } from '../common/brainstormSessionService.js';
import { InsrcBrainstormSessionServiceImpl } from '../browser/brainstorm/brainstormSessionServiceImpl.js';
import { IInsrcTodosService } from '../common/todosService.js';
import { InsrcTodosServiceImpl } from '../browser/todos/todosServiceImpl.js';
import { IInsrcArtifactsService } from '../common/artifactsService.js';
import { InsrcArtifactsServiceImpl } from '../browser/artifacts/insrcArtifactsServiceImpl.js';
import { IInsrcDbConnectionsService } from '../common/dbConnectionsService.js';
import { InsrcDbConnectionsServiceImpl } from '../browser/dbDrivers/insrcDbConnectionsServiceImpl.js';
import { IInsrcAccessService } from '../common/accessService.js';
import { InsrcAccessServiceImpl } from '../browser/access/accessServiceImpl.js';
import { InsrcDaemonServiceImpl } from './daemonServiceImpl.js';
import { InsrcSessionServiceImpl } from './sessionServiceImpl.js';
import { InsrcWorkspaceServiceImpl } from './workspaceServiceImpl.js';
import { InsrcRepoServiceImpl } from './repoServiceImpl.js';
import { InsrcAgentRunServiceImpl } from './agentRunServiceImpl.js';
import { InsrcChatServiceImpl } from './chatServiceImpl.js';
import { InsrcDiffServiceImpl } from './diffServiceImpl.js';
import { InsrcConfigServiceImpl } from './configServiceImpl.js';
import { InsrcKeychainServiceImpl } from './keychainServiceImpl.js';
import { InsrcLSPToolServiceImpl } from './lspToolServiceImpl.js';

// Register services (desktop/Electron only)
registerSingleton(IInsrcDaemonService, InsrcDaemonServiceImpl, InstantiationType.Eager);
registerSingleton(IInsrcSessionService, InsrcSessionServiceImpl, InstantiationType.Delayed);
registerSingleton(IInsrcWorkspaceService, InsrcWorkspaceServiceImpl, InstantiationType.Delayed);
registerSingleton(IInsrcRepoService, InsrcRepoServiceImpl, InstantiationType.Delayed);
registerSingleton(IInsrcAgentRunService, InsrcAgentRunServiceImpl, InstantiationType.Delayed);
registerSingleton(IInsrcChatService, InsrcChatServiceImpl, InstantiationType.Delayed);
registerSingleton(IInsrcDiffService, InsrcDiffServiceImpl, InstantiationType.Delayed);
registerSingleton(IInsrcConfigService, InsrcConfigServiceImpl, InstantiationType.Delayed);
registerSingleton(IInsrcKeychainService, InsrcKeychainServiceImpl, InstantiationType.Delayed);
registerSingleton(IInsrcLSPToolService, InsrcLSPToolServiceImpl, InstantiationType.Delayed);
registerSingleton(IInsrcBrainstormSessionService, InsrcBrainstormSessionServiceImpl, InstantiationType.Eager);
registerSingleton(IInsrcTodosService, InsrcTodosServiceImpl, InstantiationType.Eager);
registerSingleton(IInsrcArtifactsService, InsrcArtifactsServiceImpl, InstantiationType.Delayed);
registerSingleton(IInsrcDbConnectionsService, InsrcDbConnectionsServiceImpl, InstantiationType.Delayed);
registerSingleton(IInsrcAccessService, InsrcAccessServiceImpl, InstantiationType.Delayed);
