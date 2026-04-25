/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../setup/media/setupWizard.css';
import * as dom from '../../../../../base/browser/dom.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import type { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import type { IEditorOpenContext } from '../../../../common/editor.js';
import type { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IInsrcRepoService, type RepoInfo } from '../../common/repoService.js';
import {
	type DbConnectionInfo,
	IInsrcDbConnectionsService,
} from '../../common/dbConnectionsService.js';
import type { DbDriversInput } from './dbDriversInput.js';

/**
 * Data Sources pane: an accordion-of-repos view, each repo expanding
 * to an inline list of its DB connections + an "Add connection"
 * button. Reuses the Model Providers pane's CSS classes so the
 * visual style matches.
 *
 * Mutating actions delegate to the existing palette commands
 * (`insrc.addDbConnection` / `editDbConnection` / `removeDbConnection`
 * / `testDbConnection`) -- the pane passes preset `{ repoRoot, id }`
 * args so the commands skip the repo + connection pickers.
 */
export class DbDriversPane extends EditorPane {
	static readonly ID = 'insrc.dbDriversPane';

	private _container!: HTMLElement;
	private _body!: HTMLElement;
	private _expandedRepos = new Set<string>();

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInsrcRepoService private readonly repoService: IInsrcRepoService,
		@IInsrcDbConnectionsService private readonly dbService: IInsrcDbConnectionsService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(DbDriversPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = dom.append(parent, dom.$('.insrc-setup'));

		const hero = dom.append(this._container, dom.$('.insrc-setup-hero'));
		const header = dom.append(hero, dom.$('.insrc-setup-header'));
		const h1 = dom.append(header, dom.$('h1'));
		h1.textContent = 'Data Sources';
		const subtitle = dom.append(header, dom.$('p'));
		subtitle.textContent =
			'Per-repo database, key-value store, and data-file connections. ' +
			'Connection URLs have their passwords stored in the OS keychain; ' +
			'only the redacted form lives in db-connections.json.';

		this._body = dom.append(this._container, dom.$('.insrc-setup-content'));
		this._body.style.overflowY = 'auto';
		this._body.style.padding = '16px';

		this._store.add(this.repoService.onDidChangeRepos(() => {
			void this._render();
		}));
	}

	override async setInput(
		input: DbDriversInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);
		await this.repoService.refresh();
		await this._render();
	}

	override layout(dimension: dom.Dimension): void {
		if (this._container) {
			this._container.style.height = `${dimension.height}px`;
			this._container.style.width = `${dimension.width}px`;
		}
	}

	override dispose(): void {
		this._store.dispose();
		super.dispose();
	}

	// ---- Rendering ---------------------------------------------------------

	private async _render(): Promise<void> {
		dom.clearNode(this._body);
		const repos = this.repoService.repos;
		if (repos.length === 0) {
			const empty = dom.append(this._body, dom.$('p'));
			empty.textContent =
				'No repos registered. Use "Add Repository" to register one before adding data sources.';
			empty.style.color = 'var(--vscode-descriptionForeground)';
			return;
		}
		// Render each repo's accordion section in parallel; each section
		// fetches its own connection list so failures don't block siblings.
		await Promise.all(repos.map(repo => this._renderRepoSection(repo)));
	}

	private async _renderRepoSection(repo: RepoInfo): Promise<void> {
		const details = dom.append(this._body, dom.$('details')) as HTMLDetailsElement;
		details.style.marginBottom = '12px';
		details.style.background = 'var(--vscode-editor-background)';
		details.style.border = '1px solid var(--vscode-panel-border)';
		details.style.borderRadius = '4px';
		details.style.padding = '8px 12px';
		if (this._expandedRepos.has(repo.path)) { details.open = true; }
		details.addEventListener('toggle', () => {
			if (details.open) { this._expandedRepos.add(repo.path); }
			else { this._expandedRepos.delete(repo.path); }
		});

		const summary = dom.append(details, dom.$('summary'));
		summary.style.cursor = 'pointer';
		summary.style.fontWeight = '600';
		summary.style.padding = '4px 0';
		summary.style.userSelect = 'none';

		const repoName = dom.append(summary, dom.$('span'));
		repoName.textContent = repo.name;
		const repoPath = dom.append(summary, dom.$('span'));
		repoPath.textContent = ` (${repo.path})`;
		repoPath.style.color = 'var(--vscode-descriptionForeground)';
		repoPath.style.fontWeight = '400';
		repoPath.style.marginLeft = '8px';
		repoPath.style.fontSize = '12px';

		const inner = dom.append(details, dom.$('div'));
		inner.style.padding = '8px 0 4px 16px';

		const conns = await this.dbService.list({ repoRoot: repo.path });

		// Add button (always shown, top of expanded section)
		const addRow = dom.append(inner, dom.$('div'));
		addRow.style.marginBottom = '12px';
		const addBtn = dom.append(addRow, dom.$('button')) as HTMLButtonElement;
		addBtn.textContent = '+ Add connection';
		addBtn.style.padding = '4px 10px';
		addBtn.style.background = 'var(--vscode-button-background)';
		addBtn.style.color = 'var(--vscode-button-foreground)';
		addBtn.style.border = 'none';
		addBtn.style.borderRadius = '2px';
		addBtn.style.cursor = 'pointer';
		addBtn.onclick = async () => {
			await this.commandService.executeCommand('insrc.addDbConnection', { repoRoot: repo.path });
			await this._render();
		};

		if (conns.length === 0) {
			const empty = dom.append(inner, dom.$('p'));
			empty.textContent = 'No connections configured for this repo.';
			empty.style.color = 'var(--vscode-descriptionForeground)';
			empty.style.fontSize = '13px';
			empty.style.margin = '4px 0 0';
			return;
		}

		const list = dom.append(inner, dom.$('div'));
		for (const c of conns) {
			this._renderConnectionRow(list, repo.path, c);
		}
	}

	private _renderConnectionRow(parent: HTMLElement, repoRoot: string, c: DbConnectionInfo): void {
		const row = dom.append(parent, dom.$('div'));
		row.style.display = 'flex';
		row.style.alignItems = 'center';
		row.style.gap = '8px';
		row.style.padding = '6px 0';
		row.style.borderBottom = '1px solid var(--vscode-panel-border)';

		const id = dom.append(row, dom.$('span'));
		id.textContent = c.id;
		id.style.fontWeight = '600';
		id.style.minWidth = '120px';

		const kind = dom.append(row, dom.$('span'));
		kind.textContent = c.kind;
		kind.style.padding = '2px 6px';
		kind.style.borderRadius = '2px';
		kind.style.background = 'var(--vscode-badge-background)';
		kind.style.color = 'var(--vscode-badge-foreground)';
		kind.style.fontSize = '11px';

		const family = dom.append(row, dom.$('span'));
		family.textContent = c.family;
		family.style.color = 'var(--vscode-descriptionForeground)';
		family.style.fontSize = '11px';
		family.style.minWidth = '50px';

		if (c.label !== undefined && c.label !== '') {
			const label = dom.append(row, dom.$('span'));
			label.textContent = c.label;
			label.style.color = 'var(--vscode-descriptionForeground)';
			label.style.fontSize = '12px';
			label.style.flex = '1';
		} else {
			const spacer = dom.append(row, dom.$('span'));
			spacer.style.flex = '1';
		}

		// Action buttons
		const actions = dom.append(row, dom.$('div'));
		actions.style.display = 'flex';
		actions.style.gap = '4px';

		this._actionButton(actions, 'Test', async () => {
			await this.commandService.executeCommand('insrc.testDbConnection', { repoRoot, id: c.id });
		});
		this._actionButton(actions, 'Edit', async () => {
			await this.commandService.executeCommand('insrc.editDbConnection', { repoRoot, id: c.id });
			await this._render();
		});
		this._actionButton(actions, 'Remove', async () => {
			await this.commandService.executeCommand('insrc.removeDbConnection', { repoRoot, id: c.id });
			await this._render();
		});
	}

	private _actionButton(parent: HTMLElement, label: string, onClick: () => Promise<void>): void {
		const btn = dom.append(parent, dom.$('button')) as HTMLButtonElement;
		btn.textContent = label;
		btn.style.padding = '2px 8px';
		btn.style.fontSize = '12px';
		btn.style.background = 'transparent';
		btn.style.color = 'var(--vscode-button-foreground)';
		btn.style.border = '1px solid var(--vscode-button-border, var(--vscode-panel-border))';
		btn.style.borderRadius = '2px';
		btn.style.cursor = 'pointer';
		btn.onclick = async () => {
			btn.disabled = true;
			try { await onClick(); }
			catch (err) {
				this.notificationService.error(`${label} failed: ${(err as Error).message}`);
			}
			finally { btn.disabled = false; }
		};
	}
}
