/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/analysisReport.css';
import * as dom from '../../../../../base/browser/dom.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { MarkdownRenderer } from '../../../../../editor/browser/widget/markdownRenderer/browser/markdownRenderer.js';
import { IInsrcTodosService, type TodoList } from '../../common/todosService.js';
import { AnalysisReportInput } from './analysisReportInput.js';
import { InsrcEditorPaneBase } from '../shared/workspacePaneBase.js';
import { parseDrillDownFooter, type DrillDownItem } from '../shared/drillDownFooter.js';

/**
 * Code Analyzer Report Pane (plans/analyzers/code-analyzer.md Phase 2.1).
 *
 * Renders the synthesised markdown report for one analysis run. The
 * report content lives in the framework-side TodoList's `body` field
 * -- we render directly from the live service snapshot rather than
 * the backing file so updates land instantly when the orchestrator
 * re-syntheses or appends to the same list. The backing file
 * (`~/.insrc/tmp/code-analysis-report-<listId>.md`, see
 * `EphemeralEditorInput`) is purely a placeholder keeping the URI
 * resolvable.
 *
 * Hard requirement (plan section2.1, memory note `feedback_pane_rendering`):
 * every colour resolves via `var(--vscode-...)` tokens. The
 * `MarkdownRenderer` handles code-fence syntax highlighting through
 * the workbench tokenizer; the surrounding chrome (header, body
 * wrapper) styles are in `media/analysisReport.css`.
 */
export class AnalysisReportPane extends InsrcEditorPaneBase<AnalysisReportInput> {
	static readonly ID = 'insrc.analysisReportPane';

	private _header!: HTMLElement;
	private _titleEl!: HTMLElement;
	private _statusEl!: HTMLElement;
	private _body!: HTMLElement;
	private _emptyEl!: HTMLElement;

	private _listId: string | undefined;
	private _markdownRenderer: MarkdownRenderer | undefined;
	private _renderedBody: string | undefined;

	// Selection-driven UI: a floating pill that surfaces "Annotate"
	// and "Send to chat" actions when the user selects text inside
	// `_body`. Annotations are in-memory only (cleared on pane close
	// or input change) -- highlight + inline note marker.
	private _selectionBar: HTMLElement | undefined;
	private _annotationOverlay: HTMLElement | undefined;
	private _annotationOverlayInput: HTMLTextAreaElement | undefined;
	private _pendingAnnotationRange: Range | undefined;
	private _annotationSeq = 0;
	private _selectionListenerAttached = false;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IInsrcTodosService private readonly todosService: IInsrcTodosService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(AnalysisReportPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = dom.append(parent, dom.$('.insrc-analysis-report'));

		this._header = dom.append(this._container, dom.$('.insrc-analysis-report-header'));
		this._titleEl = dom.append(this._header, dom.$('h2.insrc-analysis-report-title'));
		this._titleEl.textContent = 'Code Analysis Report';
		this._statusEl = dom.append(this._header, dom.$('span.insrc-analysis-report-status'));

		// Save button -- writes the report markdown to a real file
		// under the active repo's docs/code-analysis/. Disabled until
		// `_listId` is set so the click target's args resolve cleanly.
		const saveBtn = dom.append(this._header, dom.$('button.insrc-analysis-report-action'));
		saveBtn.textContent = 'Save...';
		saveBtn.title = 'Save report to file (docs/code-analysis/)';
		this._register(dom.addDisposableListener(saveBtn, dom.EventType.CLICK, () => {
			if (this._listId === undefined) {
				return;
			}
			void this.commandService.executeCommand('insrc.codeAnalyzer.saveReport', { listId: this._listId });
		}));

		this._body = dom.append(this._container, dom.$('.insrc-analysis-report-body.rendered-markdown-host'));
		this._emptyEl = dom.append(this._container, dom.$('.insrc-analysis-report-empty'));
		this._emptyEl.textContent = 'Report not yet ready. The pane will populate when the analysis finishes.';

		this._buildSelectionBar();
		this._buildAnnotationOverlay();
		this._attachSelectionListener();
	}

	protected override onSetInput(input: AnalysisReportInput): void {
		this._listId = input.listId;
		this.registerServiceListener(this.todosService.onDidChangeList(list => {
			if (list.id === this._listId) {
				this._render(list);
			}
		}));
		this.registerServiceListener(this.todosService.onDidRemoveList(id => {
			if (id === this._listId) {
				this._showEmpty('Report list was removed.');
			}
		}));
		const list = this.todosService.lists.find(l => l.id === input.listId);
		this._render(list);
	}

	protected override onClearInput(): void {
		this._listId = undefined;
		this._renderedBody = undefined;
		this._annotationSeq = 0;
		this._hideSelectionBar();
		this._hideAnnotationOverlay();
		dom.clearNode(this._body);
	}

	private _getRenderer(): MarkdownRenderer {
		if (!this._markdownRenderer) {
			this._markdownRenderer = this._register(this.instantiationService.createInstance(MarkdownRenderer, {}));
		}
		return this._markdownRenderer;
	}

	private _render(list: TodoList | undefined): void {
		if (list === undefined) {
			this._showEmpty('Report not available -- the list has rolled out of the active session.');
			return;
		}

		// Status badge: live "K/N items" + a state classifier so the
		// stylesheet can colour in-progress vs complete distinctly.
		const total = list.items.length;
		const completed = list.items.filter(i => i.status === 'completed').length;
		this._statusEl.textContent = total === 0 ? '' : `${completed}/${total} items`;
		this._statusEl.classList.remove('in-progress', 'complete');
		if (list.status === 'completed' || (total > 0 && completed === total)) {
			this._statusEl.classList.add('complete');
		} else {
			this._statusEl.classList.add('in-progress');
		}

		const body = list.body ?? '';
		if (body.length === 0) {
			this._showEmpty('Report still synthesising...');
			return;
		}

		// Avoid re-rendering identical content (the service may emit
		// redundant change events as items mutate around the same
		// snapshot).
		if (this._renderedBody === body) {
			this._emptyEl.style.display = 'none';
			this._body.style.display = '';
			return;
		}
		this._renderedBody = body;
		this._emptyEl.style.display = 'none';
		this._body.style.display = '';
		dom.clearNode(this._body);
		// Body content was just replaced -- any prior in-memory
		// highlights/annotations are now stale (their wrapping <mark>
		// nodes no longer exist). Reset counters and hide the floating
		// UI so leftover overlays don't point at gone-text.
		this._annotationSeq = 0;
		this._hideSelectionBar();
		this._hideAnnotationOverlay();

		// Phase 5.D: split out the trailing `## Drill down` section so
		// each candidate becomes a clickable button rather than plain
		// markdown text. Markdown above the heading still renders
		// through the standard MarkdownRenderer; the footer becomes
		// native DOM with click handlers wired into the
		// `insrc.codeAnalyzer.drillDown` command (parentListId set to
		// THIS list's id, so the daemon stamps the parent edge on the
		// child analysis's TodoList).
		const { main, items } = parseDrillDownFooter(body);
		const renderable = main.length > 0 ? main : body;
		const rendered = this._getRenderer().render(new MarkdownString(renderable));
		this._body.appendChild(rendered.element);

		if (items.length > 0) {
			this._renderDrillDownFooter(list.id, items);
		}
	}

	/**
	 * Render the parsed drill-down footer as a stack of buttons. Each
	 * button fires `insrc.codeAnalyzer.drillDown` with this list's id
	 * threaded as `parentListId` so the daemon's chat.send stamps the
	 * parent edge on the child analysis's TodoList. Button label =
	 * the candidate question (the synthesise prompt keeps these
	 * one-liners). Scope (when present) renders as a dimmed
	 * suffix and is forwarded as the command's `scope` arg.
	 */
	private _renderDrillDownFooter(parentListId: string, items: readonly DrillDownItem[]): void {
		const wrapper = dom.append(this._body, dom.$('.insrc-analysis-report-drilldown'));
		const heading = dom.append(wrapper, dom.$('h2.insrc-analysis-report-drilldown-heading'));
		heading.textContent = 'Drill down';
		const list = dom.append(wrapper, dom.$('.insrc-analysis-report-drilldown-list'));
		for (const item of items) {
			const button = dom.append(list, dom.$('button.insrc-analysis-report-drilldown-button'));
			const questionEl = dom.append(button, dom.$('span.insrc-analysis-report-drilldown-question'));
			questionEl.textContent = item.question;
			if (item.scope.length > 0) {
				const scopeEl = dom.append(button, dom.$('span.insrc-analysis-report-drilldown-scope'));
				scopeEl.textContent = `scope: ${item.scope}`;
			}
			this._register(dom.addDisposableListener(button, dom.EventType.CLICK, () => {
				const args: { parentListId: string; question: string; scope?: string } = {
					parentListId,
					question: item.question,
				};
				if (item.scope.length > 0) {
					args.scope = item.scope;
				}
				void this.commandService.executeCommand('insrc.codeAnalyzer.drillDown', args);
			}));
		}
	}

	private _showEmpty(message: string): void {
		this._renderedBody = undefined;
		dom.clearNode(this._body);
		this._body.style.display = 'none';
		this._emptyEl.textContent = message;
		this._emptyEl.style.display = '';
	}

	// -----------------------------------------------------------------
	// Selection-driven actions: annotate (in-memory highlight + note)
	// and send-to-chat (prefill the chat composer with a quoted block).
	//
	// We use a global `selectionchange` listener filtered to selections
	// contained inside `_body` so the floating bar only appears for
	// report-body text. The bar lives at document.body to escape any
	// transform/overflow on the pane container.
	// -----------------------------------------------------------------

	private _buildSelectionBar(): void {
		this._selectionBar = dom.$('.insrc-analysis-report-selection-bar');
		const annotateBtn = dom.append(this._selectionBar, dom.$('button.insrc-analysis-report-selection-bar-button'));
		annotateBtn.textContent = 'Annotate';
		annotateBtn.title = 'Highlight the selection and attach an inline note';
		this._register(dom.addDisposableListener(annotateBtn, dom.EventType.MOUSE_DOWN, e => {
			// MOUSEDOWN (not CLICK) so we capture the selection before
			// it collapses when the button takes focus.
			e.preventDefault();
			this._openAnnotationOverlay();
		}));
		const sendBtn = dom.append(this._selectionBar, dom.$('button.insrc-analysis-report-selection-bar-button'));
		sendBtn.textContent = 'Send to chat';
		sendBtn.title = 'Insert the selection as a quoted block in the chat composer';
		this._register(dom.addDisposableListener(sendBtn, dom.EventType.MOUSE_DOWN, e => {
			e.preventDefault();
			this._sendSelectionToChat();
		}));
		dom.getWindow(this._body).document.body.appendChild(this._selectionBar);
		this._register({ dispose: () => this._selectionBar?.remove() });
	}

	private _buildAnnotationOverlay(): void {
		this._annotationOverlay = dom.$('.insrc-analysis-report-annotation-overlay');
		this._annotationOverlayInput = dom.append(this._annotationOverlay, dom.$('textarea')) as HTMLTextAreaElement;
		this._annotationOverlayInput.placeholder = 'Note about the highlighted text...';
		this._annotationOverlayInput.rows = 3;
		const actions = dom.append(this._annotationOverlay, dom.$('.insrc-analysis-report-annotation-overlay-actions'));
		const cancelBtn = dom.append(actions, dom.$('button'));
		cancelBtn.textContent = 'Cancel';
		this._register(dom.addDisposableListener(cancelBtn, dom.EventType.CLICK, () => this._hideAnnotationOverlay()));
		const saveBtn = dom.append(actions, dom.$('button.primary'));
		saveBtn.textContent = 'Save';
		this._register(dom.addDisposableListener(saveBtn, dom.EventType.CLICK, () => this._commitAnnotation()));
		// Cmd/Ctrl+Enter shortcut for save while focused in textarea
		this._register(dom.addDisposableListener(this._annotationOverlayInput, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				this._commitAnnotation();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				this._hideAnnotationOverlay();
			}
		}));
		dom.getWindow(this._body).document.body.appendChild(this._annotationOverlay);
		this._register({ dispose: () => this._annotationOverlay?.remove() });
	}

	private _attachSelectionListener(): void {
		if (this._selectionListenerAttached) { return; }
		this._selectionListenerAttached = true;
		const win = dom.getWindow(this._body);
		this._register(dom.addDisposableListener(win.document, 'selectionchange', () => {
			this._refreshSelectionBar();
		}));
		// Hide selection bar when user scrolls or resizes (its absolute
		// position would otherwise float away from the text).
		this._register(dom.addDisposableListener(this._body, 'scroll', () => this._hideSelectionBar()));
		this._register(dom.addDisposableListener(win, 'resize', () => this._hideSelectionBar()));
	}

	private _refreshSelectionBar(): void {
		const win = dom.getWindow(this._body);
		const sel = win.document.getSelection();
		if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
			this._hideSelectionBar();
			return;
		}
		const range = sel.getRangeAt(0);
		// Only show the bar if the selection is INSIDE the report body.
		if (!this._body.contains(range.commonAncestorContainer)) {
			this._hideSelectionBar();
			return;
		}
		const text = sel.toString().trim();
		if (text.length === 0) {
			this._hideSelectionBar();
			return;
		}
		// Position the bar just above the selection rectangle.
		const rect = range.getBoundingClientRect();
		if (rect.width === 0 && rect.height === 0) {
			this._hideSelectionBar();
			return;
		}
		const bar = this._selectionBar!;
		bar.classList.add('visible');
		// Defer position until the bar has measurable width.
		const barRect = bar.getBoundingClientRect();
		const top = Math.max(4, rect.top - barRect.height - 6);
		const left = Math.max(4, Math.min(win.innerWidth - barRect.width - 4, rect.left + rect.width / 2 - barRect.width / 2));
		bar.style.top = `${top}px`;
		bar.style.left = `${left}px`;
	}

	private _hideSelectionBar(): void {
		this._selectionBar?.classList.remove('visible');
	}

	private _hideAnnotationOverlay(): void {
		this._annotationOverlay?.classList.remove('visible');
		this._pendingAnnotationRange = undefined;
		if (this._annotationOverlayInput) {
			this._annotationOverlayInput.value = '';
		}
	}

	private _openAnnotationOverlay(): void {
		const win = dom.getWindow(this._body);
		const sel = win.document.getSelection();
		if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { return; }
		const range = sel.getRangeAt(0);
		if (!this._body.contains(range.commonAncestorContainer)) { return; }
		// Snapshot the range BEFORE the textarea steals focus and
		// collapses the selection.
		this._pendingAnnotationRange = range.cloneRange();

		const rect = range.getBoundingClientRect();
		const overlay = this._annotationOverlay!;
		overlay.classList.add('visible');
		const overlayRect = overlay.getBoundingClientRect();
		const top = Math.min(win.innerHeight - overlayRect.height - 8, rect.bottom + 8);
		const left = Math.max(8, Math.min(win.innerWidth - overlayRect.width - 8, rect.left));
		overlay.style.top = `${top}px`;
		overlay.style.left = `${left}px`;
		this._hideSelectionBar();
		setTimeout(() => this._annotationOverlayInput?.focus(), 0);
	}

	private _commitAnnotation(): void {
		const range = this._pendingAnnotationRange;
		const note = (this._annotationOverlayInput?.value ?? '').trim();
		if (range === undefined || note.length === 0) {
			this._hideAnnotationOverlay();
			return;
		}
		const win = dom.getWindow(this._body);
		this._annotationSeq++;
		const id = `ann-${this._annotationSeq}`;
		const mark = win.document.createElement('mark');
		mark.className = 'insrc-analysis-report-annotation';
		mark.dataset['annotationId'] = id;
		mark.title = note;
		try {
			// surroundContents throws when the range partially selects
			// non-text nodes (e.g. spans a paragraph boundary). Fall
			// back to a clone+wrap that handles cross-element ranges.
			range.surroundContents(mark);
		} catch {
			const fragment = range.extractContents();
			mark.appendChild(fragment);
			range.insertNode(mark);
		}
		// Inline marker: a small superscript badge after the wrapped
		// range, hovering shows the note via the native title attr.
		const marker = win.document.createElement('span');
		marker.className = 'insrc-analysis-report-annotation-marker';
		marker.textContent = String(this._annotationSeq);
		marker.title = note;
		mark.after(marker);
		this._hideAnnotationOverlay();
		// Collapse the selection so the bar doesn't immediately
		// reappear over the just-highlighted text.
		win.document.getSelection()?.removeAllRanges();
	}

	private _sendSelectionToChat(): void {
		const win = dom.getWindow(this._body);
		const sel = win.document.getSelection();
		if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { return; }
		const range = sel.getRangeAt(0);
		if (!this._body.contains(range.commonAncestorContainer)) { return; }
		const text = sel.toString().trim();
		if (text.length === 0) { return; }
		// Prefix every line with `> ` to render as a markdown blockquote
		// in the chat composer. Add a trailing blank line so the user's
		// next keystrokes land OUTSIDE the quote.
		const quoted = text.split('\n').map(line => `> ${line}`).join('\n');
		const payload = `${quoted}\n\n`;
		void this.commandService.executeCommand('insrc.chat.prefillInput', { text: payload, append: true });
		this._hideSelectionBar();
		win.document.getSelection()?.removeAllRanges();
	}
}
