/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { Event } from '../../../../base/common/event.js';

// ---------------------------------------------------------------------------
// Types -- mirror the structured payloads the brainstorm controller emits.
// Kept loose (strings instead of unions) so the browser side doesn't break
// when the backend introduces new statuses / phases.
// ---------------------------------------------------------------------------

export interface BrainstormIdeaRef {
	readonly type: 'code' | 'doc' | 'url';
	readonly path: string;
	readonly label: string;
	readonly line?: number | undefined;
	readonly snippet?: string | undefined;
}

export interface BrainstormIdea {
	readonly id: string;
	readonly index: number;
	readonly title: string;
	readonly body: string;
	readonly references: readonly BrainstormIdeaRef[];
	readonly status: string;
	readonly source: string;
	readonly round: number;
	readonly tags: readonly string[];
	readonly reviewVerdict?: string | undefined;
	readonly reviewRationale?: string | undefined;
	readonly userComment?: string | undefined;
}

export interface BrainstormTheme {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly ideaIds: readonly string[];
	readonly status: string;
	readonly priority?: string | undefined;
	readonly userComment?: string | undefined;
}

export interface BrainstormSpecSection {
	readonly themeIndex: number;
	readonly themeId?: string | undefined;
	readonly themeName: string;
	readonly content: string;
	readonly reviewed: boolean;
}

export type BrainstormPhase =
	| 'waiting'
	| 'ideation'
	| 'convergence'
	| 'specify'
	| 'finalize';

/** Which pane the flow contribution should open for the active gate. */
export type BrainstormGateKind =
	| 'idea'
	| 'idea-list'
	| 'idea-discussion'
	| 'convergence-review'
	| 'theme-spec'
	| 'presentation'
	| 'unknown';

export interface BrainstormGateSnapshot {
	readonly gateId: string;
	readonly kind: BrainstormGateKind;
	readonly phase: BrainstormPhase;
	readonly itemId?: string | undefined;
	/** Raw item payload from the gate (shape depends on kind). */
	readonly item: unknown;
	readonly actions: readonly string[];
	readonly title?: string | undefined;
	readonly content?: string | undefined;
	readonly progress?: Readonly<Record<string, number>> | undefined;
}

// ---------------------------------------------------------------------------
// IInsrcBrainstormSessionService
// ---------------------------------------------------------------------------
// Browser-side accumulator. Listens to chat events, picks out brainstorm
// gates / progress messages, and maintains a canonical view of the session
// (ideas decided so far, themes, spec sections, current phase, current gate)
// so every per-step pane can read from one place instead of reconstructing
// state from the latest gate payload.
// ---------------------------------------------------------------------------

export const IInsrcBrainstormSessionService =
	createDecorator<IInsrcBrainstormSessionService>('insrcBrainstormSessionService');

export interface IInsrcBrainstormSessionService {
	readonly _serviceBrand: undefined;

	/** Session the accumulator is currently tracking (mirrors chatService.activeSessionId). */
	readonly sessionId: string | undefined;
	/** Brainstorm sub-intent ('general', 'design', 'requirements', ...) -- populated from Intent progress events. */
	readonly category: string | undefined;
	readonly phase: BrainstormPhase;

	/** Accumulated across all ideation gates. Ordered by arrival. */
	readonly ideas: readonly BrainstormIdea[];
	/** Populated during convergence. */
	readonly themes: readonly BrainstormTheme[];
	/** Populated during per-theme spec review. */
	readonly specSections: readonly BrainstormSpecSection[];
	/** Final assembled HTML once the presentation gate arrives. */
	readonly finalDocument: string | undefined;

	/** The most recent gate the controller asked the user to act on. */
	readonly activeGate: BrainstormGateSnapshot | undefined;

	/** Fires whenever any of the fields above change. */
	readonly onDidChange: Event<void>;
	/** Fires specifically when a new gate arrives (so the flow contribution can swap panes). */
	readonly onDidChangeActiveGate: Event<BrainstormGateSnapshot>;
	/** Fires when the phase changes. */
	readonly onDidChangePhase: Event<BrainstormPhase>;
}
