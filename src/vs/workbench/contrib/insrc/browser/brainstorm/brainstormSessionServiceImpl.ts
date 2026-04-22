/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IInsrcChatService, type ChatEvent } from '../../common/chatService.js';
import {
	IInsrcBrainstormSessionService,
	type BrainstormGateKind,
	type BrainstormGateSnapshot,
	type BrainstormIdea,
	type BrainstormPhase,
	type BrainstormSpecSection,
	type BrainstormTheme,
} from '../../common/brainstormSessionService.js';

/**
 * Maps the controller's `structured.itemType` to the per-pane gate kind we
 * route on in the flow contribution. `convergence-review` is the explicit
 * backend itemType, we alias it here to the pane key.
 */
function classifyGate(itemType: string | undefined): BrainstormGateKind {
	switch (itemType) {
		case 'intent-confirm': return 'intent-confirm';
		case 'resume-confirm': return 'resume-confirm';
		case 'idea': return 'idea';
		case 'idea-list': return 'idea-list';
		case 'idea-discussion': return 'idea-discussion';
		case 'convergence-review': return 'convergence-review';
		case 'theme-spec': return 'theme-spec';
		case 'presentation': return 'presentation';
		case 'handoff-proposal': return 'handoff-proposal';
		default: return 'unknown';
	}
}

function normalizePhase(phase: string | undefined): BrainstormPhase {
	switch (phase) {
		case 'classify':
		case 'ideation':
		case 'convergence':
		case 'specify':
		case 'finalize':
			return phase;
		default:
			return 'waiting';
	}
}

export class InsrcBrainstormSessionServiceImpl extends Disposable implements IInsrcBrainstormSessionService {
	declare readonly _serviceBrand: undefined;

	private _sessionId: string | undefined;
	private _category: string | undefined;
	private _phase: BrainstormPhase = 'waiting';
	private _isSessionActive = false;
	private _ideasById = new Map<string, BrainstormIdea>();
	private _ideasOrder: string[] = [];
	private _themesById = new Map<string, BrainstormTheme>();
	private _themesOrder: string[] = [];
	private _specSections: BrainstormSpecSection[] = [];
	private _finalDocument: string | undefined;
	private _activeGate: BrainstormGateSnapshot | undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _onDidChangeActiveGate = this._register(new Emitter<BrainstormGateSnapshot>());
	readonly onDidChangeActiveGate: Event<BrainstormGateSnapshot> = this._onDidChangeActiveGate.event;

	private readonly _onDidChangePhase = this._register(new Emitter<BrainstormPhase>());
	readonly onDidChangePhase: Event<BrainstormPhase> = this._onDidChangePhase.event;

	// Item 45: fired when the daemon emits an `OpenPane:<kind>` progress
	// hint (currently only from the resume-confirm Retry path). The flow
	// contribution listens and opens the matching editor pane so the
	// user has a visible pane during the in-flight LLM step that
	// follows, rather than being stuck on the chat panel.
	private readonly _onRequestOpenPane = this._register(new Emitter<BrainstormGateKind>());
	readonly onRequestOpenPane: Event<BrainstormGateKind> = this._onRequestOpenPane.event;

	constructor(
		@IInsrcChatService chatService: IInsrcChatService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._sessionId = chatService.activeSessionId;
		this.logService.info(`[brainstorm:session] init sessionId=${this._sessionId ?? '(none)'}`);
		this._register(chatService.onDidChangeSession(id => this._onSessionChange(id)));
		this._register(chatService.onDidReceiveEvent(event => this._onChatEvent(event)));
	}

	get sessionId(): string | undefined { return this._sessionId; }
	get category(): string | undefined { return this._category; }
	get phase(): BrainstormPhase { return this._phase; }
	get isSessionActive(): boolean { return this._isSessionActive; }

	/**
	 * Item 53: called by the chat panel after the user resolves the
	 * post-save handoff-proposal gate. Flips the session-active flag
	 * off so the composer unlocks for the next turn; leaves accumulated
	 * state (ideas, themes, final document) in place in case the user
	 * opens the Runs sidebar to look at history.
	 */
	markBrainstormFinished(): void {
		if (!this._isSessionActive) { return; }
		this.logService.info('[brainstorm:session] marked finished (handoff-proposal resolved)');
		this._isSessionActive = false;
		this._activeGate = undefined;
		this._onDidChange.fire();
	}
	get ideas(): readonly BrainstormIdea[] { return this._ideasOrder.map(id => this._ideasById.get(id)!).filter(Boolean); }
	get themes(): readonly BrainstormTheme[] { return this._themesOrder.map(id => this._themesById.get(id)!).filter(Boolean); }
	get specSections(): readonly BrainstormSpecSection[] { return this._specSections; }
	get finalDocument(): string | undefined { return this._finalDocument; }
	get activeGate(): BrainstormGateSnapshot | undefined { return this._activeGate; }

	// ---------------------------------------------------------------------------
	// Event handling
	// ---------------------------------------------------------------------------

	private _onSessionChange(id: string | undefined): void {
		if (id === this._sessionId) { return; }
		this.logService.info(`[brainstorm:session] session changed ${this._sessionId ?? '(none)'} -> ${id ?? '(none)'}`);
		this._sessionId = id;
		this._resetSession();
	}

	private _onChatEvent(event: ChatEvent): void {
		if (event.type === 'gate') {
			this._ingestGate(event.gate);
		} else if (event.type === 'progress') {
			this._ingestProgress(event.progress.step);
		}
	}

	private _ingestGate(gate: { gateId: string; actions: string[]; title?: string; content?: string; context?: unknown }): void {
		const ctx = (gate.context ?? {}) as Record<string, unknown>;
		const itemType = typeof ctx['itemType'] === 'string' ? ctx['itemType'] as string : undefined;
		const phase = normalizePhase(typeof ctx['phase'] === 'string' ? ctx['phase'] as string : undefined);
		const kind = classifyGate(itemType);
		const item = ctx['item'];
		const itemId = typeof ctx['itemId'] === 'string' ? ctx['itemId'] as string : undefined;

		// Side-effects: accumulate whichever slice of state this gate carries.
		this._applyGateItem(kind, item);

		// Final presentation carries rendered content in gate.content, not the
		// structured item payload.
		if (kind === 'presentation' && typeof gate.content === 'string') {
			this._finalDocument = gate.content;
		}

		const progress = (ctx['progress'] && typeof ctx['progress'] === 'object')
			? ctx['progress'] as Record<string, number>
			: undefined;

		// Promote `warning` to a first-class field so panes don't need to
		// dig into `extra`. Keep it out of `extra` to avoid duplication.
		const warning = typeof ctx['warning'] === 'string' ? ctx['warning'] as string : undefined;

		// Anything structured carries that isn't one of the well-known fields
		// (phase/itemType/itemId/item/progress/warning) goes into `extra` so panes can
		// read it without having to parse the raw context themselves.
		const extra: Record<string, unknown> = {};
		const WELL_KNOWN = new Set(['phase', 'itemType', 'itemId', 'item', 'progress', 'warning']);
		for (const key of Object.keys(ctx)) {
			if (!WELL_KNOWN.has(key)) {
				extra[key] = ctx[key];
			}
		}

		const snapshot: BrainstormGateSnapshot = {
			gateId: gate.gateId,
			kind,
			phase,
			item,
			actions: gate.actions ?? [],
			...(itemId !== undefined ? { itemId } : {}),
			...(gate.title !== undefined ? { title: gate.title } : {}),
			...(gate.content !== undefined ? { content: gate.content } : {}),
			...(progress !== undefined ? { progress } : {}),
			...(warning !== undefined ? { warning } : {}),
			...(Object.keys(extra).length > 0 ? { extra } : {}),
		};

		const phaseChanged = this._phase !== phase;
		this._phase = phase;
		this._activeGate = snapshot;

		this.logService.info(
			`[brainstorm:session] gate received kind=${kind} phase=${phase} gateId=${gate.gateId} `
			+ `itemId=${itemId ?? '-'} actions=[${snapshot.actions.join(',')}] `
			+ `extras=[${Object.keys(extra).join(',')}] sessionActive=${this._isSessionActive}`
		);

		this._onDidChangeActiveGate.fire(snapshot);
		if (phaseChanged) {
			this.logService.info(`[brainstorm:session] phase changed -> ${phase}`);
			this._onDidChangePhase.fire(phase);
		}
		this._onDidChange.fire();
	}

	private _applyGateItem(kind: BrainstormGateKind, item: unknown): void {
		if (!item || typeof item !== 'object') { return; }
		const obj = item as Record<string, unknown>;

		if (kind === 'idea' || kind === 'idea-discussion') {
			const idea = this._parseIdea(obj);
			if (idea) {
				this._upsertIdea(idea);
			}
		} else if (kind === 'idea-list') {
			// Item 38: idea-list gate carries the full non-rejected idea
			// pool under `item.ideas`. User-added ideas (auto-accepted per
			// Item 20) never fire a per-idea gate, so without this branch
			// the pane renders only the ideas that went through review --
			// dropping the user's own contributions silently.
			const ideas = Array.isArray(obj['ideas']) ? obj['ideas'] as unknown[] : [];
			for (const raw of ideas) {
				if (raw && typeof raw === 'object') {
					const idea = this._parseIdea(raw as Record<string, unknown>);
					if (idea) { this._upsertIdea(idea); }
				}
			}
		} else if (kind === 'convergence-review') {
			// Convergence gate may carry either a single theme (per-theme review)
			// or the whole theme list under an explicit `themes` field. Support
			// both shapes.
			const themes = Array.isArray(obj['themes']) ? obj['themes'] as unknown[] : undefined;
			if (themes) {
				for (const t of themes) {
					if (t && typeof t === 'object') {
						const theme = this._parseTheme(t as Record<string, unknown>);
						if (theme) { this._upsertTheme(theme); }
					}
				}
			} else {
				const theme = this._parseTheme(obj);
				if (theme) { this._upsertTheme(theme); }
			}
		} else if (kind === 'theme-spec') {
			const section = this._parseSpecSection(obj);
			if (section) { this._upsertSpecSection(section); }
		}
	}

	private _ingestProgress(step: string): void {
		this.logService.info(`[brainstorm:session] progress step="${step}"`);
		// Item 45: daemon can piggyback a pane-open hint onto the progress
		// stream via `OpenPane:<kind>` so Retry from the resume-confirm
		// gate reopens the user's prior pane before the retried LLM call
		// starts. Fire a dedicated event + swallow the step so the chat
		// panel doesn't render the raw marker as a progress pill.
		const openMatch = step.match(/^OpenPane:([a-z-]+)$/);
		if (openMatch) {
			const kind = openMatch[1] as BrainstormGateKind;
			this.logService.info(`[brainstorm:session] progress hint: open pane kind=${kind}`);
			this._onRequestOpenPane.fire(kind);
			return;
		}
		// "Intent: brainstorm/<category>" -- the classifier committed; treat
		// the whole turn as brainstorm from here on, even before any gate
		// shows up. This is the earliest moment we can lock the chat panel.
		const bsMatch = step.match(/^Intent:\s*brainstorm\/(\w+)/);
		if (bsMatch) {
			this._category = bsMatch[1]!;
			this._isSessionActive = true;
			this.logService.info(`[brainstorm:session] activated -- category=${this._category}`);
			this._onDidChange.fire();
			return;
		}
		// Top-level "Intent: brainstorm" (before sub-classification) is also
		// enough to activate -- the intent-confirm gate fires between the
		// top-level classify and the sub-category resolve, so without this
		// the confirm pane opens while the session still looks inactive.
		const topLevel = step.match(/^Intent:\s*brainstorm\b(?!\s*\/)/);
		if (topLevel) {
			this._isSessionActive = true;
			this.logService.info(`[brainstorm:session] activated -- top-level (no category yet)`);
			this._onDidChange.fire();
			return;
		}
		// Any non-brainstorm intent in the same session ends the brainstorm lock.
		const otherMatch = step.match(/^Intent:\s*(\w+)(?:\/|$)/);
		if (otherMatch && otherMatch[1] !== 'brainstorm' && this._isSessionActive) {
			this._isSessionActive = false;
			this.logService.info(`[brainstorm:session] deactivated by intent=${otherMatch[1]}`);
			this._onDidChange.fire();
		}
	}

	// ---------------------------------------------------------------------------
	// Mutations
	// ---------------------------------------------------------------------------

	private _upsertIdea(idea: BrainstormIdea): void {
		const op = this._ideasById.has(idea.id) ? 'update' : 'insert';
		if (op === 'insert') { this._ideasOrder.push(idea.id); }
		this._ideasById.set(idea.id, idea);
		this.logService.info(`[brainstorm:session] idea ${op} id=${idea.id.slice(0, 8)} idx=${idea.index} status=${idea.status} title="${idea.title.slice(0, 60)}"`);
	}

	private _upsertTheme(theme: BrainstormTheme): void {
		const op = this._themesById.has(theme.id) ? 'update' : 'insert';
		if (op === 'insert') { this._themesOrder.push(theme.id); }
		this._themesById.set(theme.id, theme);
		this.logService.info(`[brainstorm:session] theme ${op} id=${theme.id.slice(0, 8)} name="${theme.name}" ideaCount=${theme.ideaIds.length}`);
	}

	private _upsertSpecSection(section: BrainstormSpecSection): void {
		// Match on themeId first (stable), fall back to themeIndex so older
		// controllers that don't emit themeId still get dedup'd.
		const idx = this._specSections.findIndex(s =>
			(section.themeId !== undefined && s.themeId === section.themeId) ||
			s.themeIndex === section.themeIndex,
		);
		if (idx >= 0) {
			this._specSections[idx] = section;
		} else {
			this._specSections.push(section);
		}
	}

	private _resetSession(): void {
		this.logService.info('[brainstorm:session] reset');
		this._category = undefined;
		this._phase = 'waiting';
		this._isSessionActive = false;
		this._ideasById.clear();
		this._ideasOrder = [];
		this._themesById.clear();
		this._themesOrder = [];
		this._specSections = [];
		this._finalDocument = undefined;
		this._activeGate = undefined;
		this._onDidChange.fire();
	}

	// ---------------------------------------------------------------------------
	// Parsing -- tolerant of unknown fields; returns undefined for malformed input.
	// ---------------------------------------------------------------------------

	private _parseIdea(obj: Record<string, unknown>): BrainstormIdea | undefined {
		const id = this._asString(obj['id']);
		const title = this._asString(obj['title']);
		if (!id || !title) { return undefined; }
		return {
			id,
			index: this._asNumber(obj['index']) ?? 0,
			title,
			body: this._asString(obj['body']) ?? '',
			summary: this._asString(obj['summary']),
			rationale: this._asString(obj['rationale']),
			references: this._parseRefs(obj['references']),
			status: this._asString(obj['status']) ?? 'proposed',
			source: this._asString(obj['source']) ?? 'seed',
			round: this._asNumber(obj['round']) ?? 1,
			tags: this._parseStringArray(obj['tags']),
			reviewVerdict: this._asString(obj['reviewVerdict']),
			reviewDescription: this._asString(obj['reviewDescription']),
			reviewRationale: this._asString(obj['reviewRationale']),
			userComment: this._asString(obj['userComment']),
		};
	}

	private _parseTheme(obj: Record<string, unknown>): BrainstormTheme | undefined {
		const id = this._asString(obj['id']) ?? this._asString(obj['themeId']);
		const name = this._asString(obj['name']);
		if (!id || !name) { return undefined; }
		return {
			id,
			name,
			description: this._asString(obj['description']) ?? '',
			ideaIds: this._parseStringArray(obj['ideaIds']),
			status: this._asString(obj['status']) ?? 'proposed',
			priority: this._asString(obj['priority']),
			userComment: this._asString(obj['userComment']),
		};
	}

	private _parseSpecSection(obj: Record<string, unknown>): BrainstormSpecSection | undefined {
		const themeName = this._asString(obj['themeName']);
		const themeIndex = this._asNumber(obj['themeIndex']);
		const content = this._asString(obj['content']);
		if (themeIndex === undefined || !themeName || content === undefined) { return undefined; }
		return {
			themeIndex,
			themeName,
			themeId: this._asString(obj['themeId']),
			content,
			reviewed: obj['reviewed'] === true,
		};
	}

	private _parseRefs(value: unknown): BrainstormIdea['references'] {
		if (!Array.isArray(value)) { return []; }
		const out: Array<BrainstormIdea['references'][number]> = [];
		for (const raw of value) {
			if (!raw || typeof raw !== 'object') { continue; }
			const r = raw as Record<string, unknown>;
			const type = this._asString(r['type']);
			const path = this._asString(r['path']);
			const label = this._asString(r['label']);
			if (!type || !path || !label) { continue; }
			if (type !== 'code' && type !== 'doc' && type !== 'url') { continue; }
			out.push({
				type,
				path,
				label,
				line: this._asNumber(r['line']),
				snippet: this._asString(r['snippet']),
			});
		}
		return out;
	}

	private _parseStringArray(value: unknown): string[] {
		if (!Array.isArray(value)) { return []; }
		// Coerce numbers to strings too -- daemon sometimes sends
		// integer idea indices in `theme.ideaIds` (Claude's clustering
		// output references ideas by index, not by UUID). Filtering
		// those out as non-strings was giving every theme ideaCount=0
		// despite the card text showing "linked ideas: 3, 7" (Item 46).
		const out: string[] = [];
		for (const v of value) {
			if (typeof v === 'string') {
				out.push(v);
			} else if (typeof v === 'number' && Number.isFinite(v)) {
				out.push(String(v));
			}
		}
		return out;
	}

	private _asString(value: unknown): string | undefined {
		return typeof value === 'string' ? value : undefined;
	}

	private _asNumber(value: unknown): number | undefined {
		return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
	}
}
