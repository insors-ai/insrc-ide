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
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import type { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import type { IEditorOpenContext } from '../../../../common/editor.js';
import type { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IInsrcChatService } from '../../common/chatService.js';
import {
	type AccessApprovalInfo,
	type AccessAuditEventInfo,
	IInsrcAccessService,
} from '../../common/accessService.js';
import type { AccessApprovalsInput } from './accessInput.js';

/**
 * Approvals pane (plans/access-gate.md Phase 5.3). Renders the active
 * session's standing access approvals plus the chronological audit
 * trail, with per-row Revoke buttons that round-trip through
 * IInsrcAccessService.
 *
 * Refresh model: the pane fetches a snapshot on open and after every
 * revoke, plus a manual Refresh button. There's no push channel; the
 * audit log changes on every tool call, but a static snapshot is
 * sufficient for the "what was approved / asked this session" use
 * case the pane targets.
 */
export class AccessApprovalsPane extends EditorPane {
	static readonly ID = 'insrc.accessApprovalsPane';

	private _container!: HTMLElement;
	private _body!: HTMLElement;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInsrcChatService private readonly chatService: IInsrcChatService,
		@IInsrcAccessService private readonly accessService: IInsrcAccessService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(AccessApprovalsPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = dom.append(parent, dom.$('.insrc-setup'));

		const hero = dom.append(this._container, dom.$('.insrc-setup-hero'));
		const header = dom.append(hero, dom.$('.insrc-setup-header'));
		const h1 = dom.append(header, dom.$('h1'));
		h1.textContent = 'Access Approvals';
		const subtitle = dom.append(header, dom.$('p'));
		subtitle.textContent =
			'Per-session approvals for filesystem paths, database connections, ' +
			'cloud resources, and shell commands. Approvals die with the chat ' +
			'session; revoking forces the next call to re-prompt.';

		this._body = dom.append(this._container, dom.$('.insrc-setup-content'));
		this._body.style.overflowY = 'auto';
		this._body.style.padding = '16px';
	}

	override async setInput(
		input: AccessApprovalsInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);
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

		const sessionId = this.chatService.activeSessionId;
		if (sessionId === undefined) {
			const empty = dom.append(this._body, dom.$('p'));
			empty.textContent =
				'No active chat session. Approvals are session-scoped; start a chat to populate this pane.';
			empty.style.color = 'var(--vscode-descriptionForeground)';
			return;
		}

		// Header row: session id + refresh button.
		const headerRow = dom.append(this._body, dom.$('div'));
		headerRow.style.display = 'flex';
		headerRow.style.alignItems = 'center';
		headerRow.style.justifyContent = 'space-between';
		headerRow.style.marginBottom = '12px';

		const sessLabel = dom.append(headerRow, dom.$('span'));
		sessLabel.textContent = `Session: ${sessionId.slice(0, 8)}`;
		sessLabel.style.color = 'var(--vscode-descriptionForeground)';
		sessLabel.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
		sessLabel.style.fontSize = '12px';

		const refreshBtn = dom.append(headerRow, dom.$('button')) as HTMLButtonElement;
		refreshBtn.textContent = 'Refresh';
		this._styleSecondaryButton(refreshBtn);
		refreshBtn.onclick = () => { void this._render(); };

		const snapshot = await this.accessService.snapshot(sessionId);
		if (snapshot === undefined) {
			const err = dom.append(this._body, dom.$('p'));
			err.textContent = 'Could not read access state from the daemon (see logs).';
			err.style.color = 'var(--vscode-errorForeground)';
			return;
		}

		this._renderApprovalsSection(sessionId, snapshot.approvals);
		this._renderAuditSection(snapshot.audit);
	}

	private _renderApprovalsSection(sessionId: string, approvals: readonly AccessApprovalInfo[]): void {
		const section = dom.append(this._body, dom.$('section'));
		section.style.marginBottom = '24px';

		const h2 = dom.append(section, dom.$('h2'));
		h2.textContent = `Standing approvals (${approvals.length})`;
		h2.style.fontSize = '14px';
		h2.style.marginBottom = '8px';

		if (approvals.length === 0) {
			const empty = dom.append(section, dom.$('p'));
			empty.textContent = 'No approvals yet. The first tool call against an external resource will prompt for one.';
			empty.style.color = 'var(--vscode-descriptionForeground)';
			empty.style.fontSize = '13px';
			return;
		}

		// Group by kind for readability.
		const byKind = new Map<string, AccessApprovalInfo[]>();
		for (const a of approvals) {
			let bucket = byKind.get(a.kind);
			if (bucket === undefined) {
				bucket = [];
				byKind.set(a.kind, bucket);
			}
			bucket.push(a);
		}
		// Stable ordering: sort kinds alphabetically.
		const kinds = Array.from(byKind.keys()).sort();
		for (const kind of kinds) {
			this._renderKindGroup(section, sessionId, kind, byKind.get(kind)!);
		}
	}

	private _renderKindGroup(
		section: HTMLElement,
		sessionId: string,
		kind: string,
		entries: readonly AccessApprovalInfo[],
	): void {
		const group = dom.append(section, dom.$('div'));
		group.style.marginBottom = '12px';
		group.style.background = 'var(--vscode-editor-background)';
		group.style.border = '1px solid var(--vscode-panel-border)';
		group.style.borderRadius = '4px';
		group.style.padding = '8px 12px';

		const kindLabel = dom.append(group, dom.$('div'));
		kindLabel.textContent = kind;
		kindLabel.style.fontWeight = '600';
		kindLabel.style.fontSize = '12px';
		kindLabel.style.color = 'var(--vscode-descriptionForeground)';
		kindLabel.style.marginBottom = '6px';

		for (const entry of entries) {
			this._renderApprovalRow(group, sessionId, entry);
		}
	}

	private _renderApprovalRow(parent: HTMLElement, sessionId: string, entry: AccessApprovalInfo): void {
		const row = dom.append(parent, dom.$('div'));
		row.style.display = 'flex';
		row.style.alignItems = 'center';
		row.style.gap = '8px';
		row.style.padding = '4px 0';
		row.style.borderTop = '1px solid var(--vscode-panel-border)';

		const tag = dom.append(row, dom.$('span'));
		tag.textContent = entry.prefix ? 'scope' : 'exact';
		tag.style.padding = '1px 6px';
		tag.style.borderRadius = '2px';
		tag.style.background = entry.prefix
			? 'var(--vscode-charts-blue, #2674cc)'
			: 'var(--vscode-badge-background)';
		tag.style.color = entry.prefix ? '#ffffff' : 'var(--vscode-badge-foreground)';
		tag.style.fontSize = '10px';
		tag.style.minWidth = '36px';
		tag.style.textAlign = 'center';

		const key = dom.append(row, dom.$('span'));
		key.textContent = entry.key;
		key.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
		key.style.fontSize = '12px';
		key.style.flex = '1';
		key.style.overflow = 'hidden';
		key.style.textOverflow = 'ellipsis';
		key.style.whiteSpace = 'nowrap';
		key.title = entry.key;

		const age = dom.append(row, dom.$('span'));
		age.textContent = formatRelative(entry.approvedAt);
		age.style.color = 'var(--vscode-descriptionForeground)';
		age.style.fontSize = '11px';
		age.style.minWidth = '70px';
		age.style.textAlign = 'right';

		const revokeBtn = dom.append(row, dom.$('button')) as HTMLButtonElement;
		revokeBtn.textContent = 'Revoke';
		this._styleSecondaryButton(revokeBtn);
		revokeBtn.onclick = async () => {
			revokeBtn.disabled = true;
			try {
				if (entry.prefix) {
					await this.accessService.revokePrefix(sessionId, entry.kind, entry.key);
				} else {
					await this.accessService.revoke(sessionId, entry.kind, entry.key);
				}
				await this._render();
			} catch (err) {
				this.notificationService.error(`Revoke failed: ${(err as Error).message}`);
				revokeBtn.disabled = false;
			}
		};
	}

	private _renderAuditSection(audit: readonly AccessAuditEventInfo[]): void {
		const section = dom.append(this._body, dom.$('section'));

		const h2 = dom.append(section, dom.$('h2'));
		h2.textContent = `Audit log (${audit.length} events)`;
		h2.style.fontSize = '14px';
		h2.style.marginBottom = '8px';

		if (audit.length === 0) {
			const empty = dom.append(section, dom.$('p'));
			empty.textContent = 'No gate decisions recorded yet this session.';
			empty.style.color = 'var(--vscode-descriptionForeground)';
			empty.style.fontSize = '13px';
			return;
		}

		// Most recent first.
		const sorted = audit.slice().sort((a, b) => b.timestamp - a.timestamp);
		const list = dom.append(section, dom.$('div'));
		list.style.background = 'var(--vscode-editor-background)';
		list.style.border = '1px solid var(--vscode-panel-border)';
		list.style.borderRadius = '4px';
		for (const e of sorted) {
			this._renderAuditRow(list, e);
		}
	}

	private _renderAuditRow(parent: HTMLElement, e: AccessAuditEventInfo): void {
		const row = dom.append(parent, dom.$('div'));
		row.style.display = 'flex';
		row.style.alignItems = 'center';
		row.style.gap = '8px';
		row.style.padding = '4px 12px';
		row.style.borderBottom = '1px solid var(--vscode-panel-border)';
		row.style.fontSize = '12px';

		const ts = dom.append(row, dom.$('span'));
		ts.textContent = formatRelative(e.timestamp);
		ts.style.color = 'var(--vscode-descriptionForeground)';
		ts.style.minWidth = '70px';
		ts.style.fontSize = '11px';

		const decisionTag = dom.append(row, dom.$('span'));
		decisionTag.textContent = e.decision;
		decisionTag.style.padding = '1px 6px';
		decisionTag.style.borderRadius = '2px';
		decisionTag.style.fontSize = '10px';
		decisionTag.style.minWidth = '64px';
		decisionTag.style.textAlign = 'center';
		switch (e.decision) {
			case 'approve':
			case 'approve-prefix':
			case 'auto-pass':
				decisionTag.style.background = 'var(--vscode-charts-green, #2e7d32)';
				decisionTag.style.color = '#ffffff';
				break;
			case 'deny':
			case 'auto-deny':
				decisionTag.style.background = 'var(--vscode-charts-red, #c62828)';
				decisionTag.style.color = '#ffffff';
				break;
		}

		if (e.severity === 'destructive') {
			const sev = dom.append(row, dom.$('span'));
			sev.textContent = 'destructive';
			sev.style.padding = '1px 6px';
			sev.style.borderRadius = '2px';
			sev.style.background = 'var(--vscode-inputValidation-warningBackground)';
			sev.style.color = 'var(--vscode-inputValidation-warningForeground)';
			sev.style.fontSize = '10px';
		}

		const tool = dom.append(row, dom.$('span'));
		tool.textContent = e.toolId;
		tool.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
		tool.style.minWidth = '180px';

		const key = dom.append(row, dom.$('span'));
		key.textContent = e.description ?? `${e.kind}: ${e.key}`;
		key.style.flex = '1';
		key.style.overflow = 'hidden';
		key.style.textOverflow = 'ellipsis';
		key.style.whiteSpace = 'nowrap';
		key.title = `${e.kind}: ${e.key}${e.prefix !== undefined ? ` (prefix=${e.prefix})` : ''}`;
	}

	private _styleSecondaryButton(btn: HTMLButtonElement): void {
		btn.style.padding = '2px 10px';
		btn.style.fontSize = '12px';
		btn.style.background = 'transparent';
		btn.style.color = 'var(--vscode-button-foreground)';
		btn.style.border = '1px solid var(--vscode-button-border, var(--vscode-panel-border))';
		btn.style.borderRadius = '2px';
		btn.style.cursor = 'pointer';
	}
}

/** Compact relative time helper -- "5s", "3m", "1h", "2d". */
function formatRelative(ms: number): string {
	const delta = Math.max(0, Date.now() - ms);
	const sec = Math.round(delta / 1000);
	if (sec < 60) { return `${sec}s ago`; }
	const min = Math.round(sec / 60);
	if (min < 60) { return `${min}m ago`; }
	const hr = Math.round(min / 60);
	if (hr < 24) { return `${hr}h ago`; }
	const day = Math.round(hr / 24);
	return `${day}d ago`;
}
