/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';

// Insrc-shared styles (CSS variables + shared widget classes used by
// every insrc pane). Loaded once at contribution registration.
import './media/insrc-shared.css';

// Heroicons outline overrides for selected codicons. Unmapped codicons
// keep the stock codicon font glyph (fallback via CSS). Regenerate
// `insrc-icons.css` with `node scripts/build-insrc-icons.mjs` after
// editing `scripts/insrc-icons-map.json`.
import './media/insrc-icons.css';

// Service interfaces (common layer - browser safe)
import '../common/daemonService.js';
import '../common/sessionService.js';
import '../common/workspaceService.js';
import '../common/repoService.js';
import '../common/agentRunService.js';
import { IInsrcChatService } from '../common/chatService.js';
import '../common/diffService.js';
import '../common/configService.js';
import '../common/keychainService.js';
import '../common/insrcConfiguration.js';
import '../common/lspToolService.js';

// Sidebar: register insrc panes into Explorer container
import './sidebar/insrcViewContainer.js';

// Commands: add repo, remove repo, re-index, refresh, resume/discard runs, set step provider
import './sidebar/insrcCommands.js';

// Workspace sync: keep Explorer folders in sync with daemon repos
import { InsrcWorkspaceSyncContribution } from './sidebar/insrcWorkspaceSync.js';
registerWorkbenchContribution2(InsrcWorkspaceSyncContribution.ID, InsrcWorkspaceSyncContribution, WorkbenchPhase.AfterRestored);

// File decorations: show repo indexing status on folder roots in Explorer
import { InsrcFileDecorationsContribution } from './sidebar/insrcFileDecorations.js';
registerWorkbenchContribution2(InsrcFileDecorationsContribution.ID, InsrcFileDecorationsContribution, WorkbenchPhase.AfterRestored);

// Chat: register chat panel in auxiliary bar (right sidebar)
import './chat/chatRegistration.js';

// Diff manager: CodeLens accept/reject/edit on proposed diffs, chat integration
import { InsrcDiffContribution } from './diff/diffRegistration.js';
registerWorkbenchContribution2(InsrcDiffContribution.ID, InsrcDiffContribution, WorkbenchPhase.AfterRestored);

// Status bar: daemon/agent status indicator
import { InsrcStatusBarContribution } from './insrcStatusBar.js';
registerWorkbenchContribution2(InsrcStatusBarContribution.ID, InsrcStatusBarContribution, WorkbenchPhase.AfterRestored);

// Annotations: code selection + notes, compile to chat context
import { InsrcAnnotationContribution } from './annotations/annotationManager.js';
registerWorkbenchContribution2(InsrcAnnotationContribution.ID, InsrcAnnotationContribution, WorkbenchPhase.AfterRestored);

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
import { StepProviderEditorPane } from './setup/stepProviderEditorPane.js';
import { StepProviderEditorInput } from './setup/stepProviderEditorInput.js';

const editorPaneRegistry = Registry.as<import('../../../browser/editor.js').IEditorPaneRegistry>(EditorExtensions.EditorPane);

editorPaneRegistry.registerEditorPane(
	EditorPaneDescriptor.create(SetupWizardPane, SetupWizardPane.ID, 'insrc Setup'),
	[new SyncDescriptor(SetupWizardInput)],
);

editorPaneRegistry.registerEditorPane(
	EditorPaneDescriptor.create(StepProviderEditorPane, StepProviderEditorPane.ID, 'Step Providers'),
	[new SyncDescriptor(StepProviderEditorInput)],
);

// Brainstorm EditorPane (legacy monolithic pane -- kept as fallback until
// every per-step pane has been migrated; see BrainstormFlowContribution).
import { BrainstormEditorPane } from './brainstorm/brainstormEditorPane.js';
import { BrainstormEditorInput } from './brainstorm/brainstormEditorInput.js';
editorPaneRegistry.registerEditorPane(
	EditorPaneDescriptor.create(BrainstormEditorPane, BrainstormEditorPane.ID, 'Brainstorm'),
	[new SyncDescriptor(BrainstormEditorInput)],
);

// Brainstorm per-step panes (incremental migration).
import { BrainstormIdeasPane } from './brainstorm/step/ideasPane.js';
import { BrainstormIdeasInput } from './brainstorm/step/ideasInput.js';
editorPaneRegistry.registerEditorPane(
	EditorPaneDescriptor.create(BrainstormIdeasPane, BrainstormIdeasPane.ID, 'Brainstorm: Ideas'),
	[new SyncDescriptor(BrainstormIdeasInput)],
);

// Model Providers EditorPane + palette command + NOT_CONFIGURED auto-open
import { ModelProvidersPane } from './models/modelProvidersPane.js';
import { ModelProvidersInput } from './models/modelProvidersInput.js';
import './models/modelProvidersCommands.js';
editorPaneRegistry.registerEditorPane(
	EditorPaneDescriptor.create(ModelProvidersPane, ModelProvidersPane.ID, 'Model Providers'),
	[new SyncDescriptor(ModelProvidersInput)],
);

// Brainstorm flow: routes gates to the matching per-step editor pane, falling
// back to the legacy pane for kinds that haven't been migrated yet.
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { BrainstormFlowContribution } from './brainstorm/brainstormFlowContribution.js';
registerWorkbenchContribution2(BrainstormFlowContribution.ID, BrainstormFlowContribution, WorkbenchPhase.AfterRestored);

// Model Providers auto-open: listens for NOT_CONFIGURED from chat.start
// and opens the pane. If 'local' or 'both' is missing, opens the Local tab;
// 'provider' missing -> opens Anthropic by default (see pane for rationale).
class ModelProvidersAutoOpenContribution extends Disposable {
	static readonly ID = 'insrc.modelProvidersAutoOpen';

	constructor(
		@IInsrcChatService chatService: IInsrcChatService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();
		this._register(chatService.onDidRequireConfig(({ missing }) => {
			const startTab = missing === 'provider' ? 'anthropic' : 'local';
			this.editorService.openEditor(ModelProvidersInput.getInstance(startTab));
		}));
	}
}
registerWorkbenchContribution2(ModelProvidersAutoOpenContribution.ID, ModelProvidersAutoOpenContribution, WorkbenchPhase.AfterRestored);

// Prompt Notepad: full editor for composing large prompts
import './notepad/promptNotepadCommands.js';
import { PromptNotepadContribution } from './notepad/promptNotepadRegistration.js';
registerWorkbenchContribution2(PromptNotepadContribution.ID, PromptNotepadContribution, WorkbenchPhase.AfterRestored);
