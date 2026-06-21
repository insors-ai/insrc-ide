/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';

// Insrc-shared styles (CSS variables + shared widget classes used by
// every insrc pane). Loaded once at contribution registration.
import './media/insrc-shared.css';

// Heroicons outline overrides for selected codicons. Unmapped codicons
// keep the stock codicon font glyph (fallback via CSS).
import './media/insrc-icons.css';

// Service interfaces (common layer - browser safe)
import '../common/daemonService.js';
import '../common/sessionService.js';
import '../common/workspaceService.js';
import '../common/repoService.js';
import '../common/agentRunService.js';
import '../common/chatService.js';
import '../common/configService.js';
import '../common/keychainService.js';
import '../common/insrcConfiguration.js';
import '../common/lspToolService.js';

// Sidebar: register insrc panes into Explorer container
import './sidebar/insrcViewContainer.js';

// Commands: add repo, remove repo, re-index, refresh, resume/discard runs
import './sidebar/insrcCommands.js';

// Workspace sync: keep Explorer folders in sync with daemon repos
import { InsrcWorkspaceSyncContribution } from './sidebar/insrcWorkspaceSync.js';
registerWorkbenchContribution2(InsrcWorkspaceSyncContribution.ID, InsrcWorkspaceSyncContribution, WorkbenchPhase.AfterRestored);

// Ephemeral pane infrastructure: backs notepad / artifacts / report-style
// panes with a real file under ~/.insrc/tmp/.
import { EphemeralPaneInitContribution, EphemeralPaneOrphanReconcilerContribution } from './shared/ephemeralPaneContribution.js';
registerWorkbenchContribution2(EphemeralPaneInitContribution.ID, EphemeralPaneInitContribution, WorkbenchPhase.BlockStartup);
registerWorkbenchContribution2(EphemeralPaneOrphanReconcilerContribution.ID, EphemeralPaneOrphanReconcilerContribution, WorkbenchPhase.AfterRestored);

// File decorations: show repo indexing status on folder roots in Explorer
import { InsrcFileDecorationsContribution } from './sidebar/insrcFileDecorations.js';
registerWorkbenchContribution2(InsrcFileDecorationsContribution.ID, InsrcFileDecorationsContribution, WorkbenchPhase.AfterRestored);

// Chat: register chat panel in auxiliary bar (right sidebar)
import './chat/chatRegistration.js';

// Status bar: daemon/agent status indicator
import { InsrcStatusBarContribution } from './insrcStatusBar.js';
registerWorkbenchContribution2(InsrcStatusBarContribution.ID, InsrcStatusBarContribution, WorkbenchPhase.AfterRestored);

// LSP tool bridge: pushes diagnostics to daemon, handles reverse LSP queries
import { InsrcLSPToolBridge } from './lspToolBridge.js';
registerWorkbenchContribution2(InsrcLSPToolBridge.ID, InsrcLSPToolBridge, WorkbenchPhase.AfterRestored);

// Tool settings bridge: pushes insrc.tools.* settings to daemon on connect + change
import { InsrcToolSettingsBridge } from './toolSettingsBridge.js';
registerWorkbenchContribution2(InsrcToolSettingsBridge.ID, InsrcToolSettingsBridge, WorkbenchPhase.AfterRestored);

// Tool-secret palette commands (Set Brave API Key, Set Slack/Teams/Discord Webhook, etc.)
import './toolSecretCommands.js';

// Setup wizard: EditorPane for first-run onboarding
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor } from '../../../browser/editor.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { EditorExtensions } from '../../../common/editor.js';
import { SetupWizardPane } from './setup/setupWizardPane.js';
import { SetupWizardInput } from './setup/setupWizardInput.js';

const editorPaneRegistry = Registry.as<import('../../../browser/editor.js').IEditorPaneRegistry>(EditorExtensions.EditorPane);

editorPaneRegistry.registerEditorPane(
	EditorPaneDescriptor.create(SetupWizardPane, SetupWizardPane.ID, 'insrc Setup'),
	[new SyncDescriptor(SetupWizardInput)],
);

// Model Providers EditorPane (Ollama + CLI providers after cleanup)
import { ModelProvidersPane } from './models/modelProvidersPane.js';
import { ModelProvidersInput } from './models/modelProvidersInput.js';
import './models/modelProvidersCommands.js';
editorPaneRegistry.registerEditorPane(
	EditorPaneDescriptor.create(ModelProvidersPane, ModelProvidersPane.ID, 'Model Providers'),
	[new SyncDescriptor(ModelProvidersInput)],
);

// Data Sources EditorPane (per-repo db connections)
import { DbDriversPane } from './dbDrivers/dbDriversPane.js';
import { DbDriversInput } from './dbDrivers/dbDriversInput.js';
import './dbDrivers/dbDriversCommands.js';
import './dbDrivers/dbConnectionCommands.js';
editorPaneRegistry.registerEditorPane(
	EditorPaneDescriptor.create(DbDriversPane, DbDriversPane.ID, 'Data Sources'),
	[new SyncDescriptor(DbDriversInput)],
);

// Todos editor pane -- generic todo list surface
import { TodosEditorPane } from './todos/todosPane.js';
import { TodosEditorInput } from './todos/todosInput.js';
import './todos/todosCommands.js';
editorPaneRegistry.registerEditorPane(
	EditorPaneDescriptor.create(TodosEditorPane, TodosEditorPane.ID, 'Todos'),
	[new SyncDescriptor(TodosEditorInput)],
);

// Artifacts editor pane -- per-session durable artifact list
import { ArtifactsEditorPane } from './artifacts/artifactsPane.js';
import { ArtifactsEditorInput } from './artifacts/artifactsInput.js';
import './artifacts/artifactsCommands.js';
import './artifacts/templateCommands.js';
editorPaneRegistry.registerEditorPane(
	EditorPaneDescriptor.create(ArtifactsEditorPane, ArtifactsEditorPane.ID, 'Artifacts'),
	[new SyncDescriptor(ArtifactsEditorInput)],
);

// Unified Notepad pane -- Draft (markdown editor) + TODOs surface
import { NotepadEditorPane } from './notepad/notepadPane.js';
import { NotepadEditorInput } from './notepad/notepadInput.js';
editorPaneRegistry.registerEditorPane(
	EditorPaneDescriptor.create(NotepadEditorPane, NotepadEditorPane.ID, 'Prompt Notepad'),
	[new SyncDescriptor(NotepadEditorInput)],
);

// Prompt Notepad: full editor for composing large prompts
import './notepad/promptNotepadCommands.js';
import { PromptNotepadContribution } from './notepad/promptNotepadRegistration.js';
registerWorkbenchContribution2(PromptNotepadContribution.ID, PromptNotepadContribution, WorkbenchPhase.AfterRestored);
