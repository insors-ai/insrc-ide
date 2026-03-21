/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { WorkbenchPhase, registerWorkbenchContribution2 } from '../../../common/contributions.js';

// Service interfaces (common layer - browser safe)
import '../common/daemonService.js';
import '../common/sessionService.js';
import '../common/workspaceService.js';
import '../common/repoService.js';
import '../common/agentRunService.js';
import '../common/chatService.js';
import '../common/diffService.js';
import '../common/configService.js';
import '../common/keychainService.js';
import '../common/insrcConfiguration.js';

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

// TODO: register brainstorm views (IdeaListView, DiscussionEditor, ConvergenceView)
