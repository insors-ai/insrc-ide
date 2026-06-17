/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Layer 3 confirm toast widget (memory-context M1.6.c).
 *
 * Rendered inline in the chat panel when the daemon emits an
 * `assertionConfirm` ChatEvent. Three primary affordances per
 * plans/memory-context.md:
 *
 *   [Save]       -> resolveAssertionConfirm('accept')
 *   [Customize…] -> opens an inline text editor on the canonical text;
 *                   Save commits with the edited text
 *   [Discard]    -> resolveAssertionConfirm('discard')
 *
 * G2 no-silent-loss: a toast that's never interacted with doesn't get
 * its pending row removed. The daemon already staged it; the user can
 * revisit later via `/prefs confirm list`. The 60-second auto-stage
 * timer mentioned in the plan is therefore implicit: the row IS staged
 * the moment the toast appears.
 *
 * The widget is structured so the state machine is decoupled from
 * DOM mutation -- the same machine drives the renderer here and the
 * `__tests__/chatLayer3ConfirmToast.test.ts` unit tests, which exercise
 * transitions without a workbench host.
 */

import * as dom from '../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import type { AssertionConfirmInfo, IInsrcChatService } from '../../common/chatService.js';

const $ = dom.$;


// ---------------------------------------------------------------------------
// State machine (pure -- unit-testable without a DOM host)
// ---------------------------------------------------------------------------

export type ToastState =
	| { readonly kind: 'showing'; readonly canonicalText: string }
	| { readonly kind: 'editing'; readonly canonicalText: string }
	| { readonly kind: 'submitting'; readonly verdict: 'accept' | 'discard'; readonly canonicalText?: string }
	| { readonly kind: 'persisted'; readonly verdict: 'accept' | 'discard' }
	| { readonly kind: 'failed'; readonly error: string };

export type ToastAction =
	| { readonly kind: 'save' }
	| { readonly kind: 'customize' }
	| { readonly kind: 'editor-cancel' }
	| { readonly kind: 'editor-save'; readonly canonicalText: string }
	| { readonly kind: 'discard' }
	| { readonly kind: 'submit-ok' }
	| { readonly kind: 'submit-failed'; readonly error: string };

/**
 * Pure transition function. Returns the next state given the current
 * state + an action. Unknown / invalid transitions are no-ops -- the
 * caller's state stays put.
 */
export function nextState(state: ToastState, action: ToastAction): ToastState {
	switch (state.kind) {
		case 'showing':
			switch (action.kind) {
				case 'save': return { kind: 'submitting', verdict: 'accept' };
				case 'customize': return { kind: 'editing', canonicalText: state.canonicalText };
				case 'discard': return { kind: 'submitting', verdict: 'discard' };
				default: return state;
			}
		case 'editing':
			switch (action.kind) {
				case 'editor-cancel': return { kind: 'showing', canonicalText: state.canonicalText };
				case 'editor-save':
					return action.canonicalText.length === 0
						? state
						: { kind: 'submitting', verdict: 'accept', canonicalText: action.canonicalText };
				case 'discard': return { kind: 'submitting', verdict: 'discard' };
				default: return state;
			}
		case 'submitting':
			switch (action.kind) {
				case 'submit-ok': return { kind: 'persisted', verdict: state.verdict };
				case 'submit-failed': return { kind: 'failed', error: action.error };
				default: return state;
			}
		// terminal -- ignore further actions
		case 'persisted':
		case 'failed':
		default:
			return state;
	}
}


// ---------------------------------------------------------------------------
// DOM renderer
// ---------------------------------------------------------------------------

export interface ChatLayer3ConfirmToastOpts {
	readonly container: HTMLElement;
	readonly confirm: AssertionConfirmInfo;
	readonly chatService: IInsrcChatService;
}

/**
 * Mounts a single toast card into the supplied container. Owns the
 * card's lifetime; dispose() clears the DOM and detaches listeners.
 * Multiple toasts can co-exist (the daemon may emit one per pending
 * assertion in a single classify pass) -- the container appends them
 * in arrival order and each one is independently dismissible.
 */
export class ChatLayer3ConfirmToast extends Disposable {

	private state: ToastState;
	private readonly card: HTMLElement;
	private readonly body: HTMLElement;
	private readonly actions: HTMLElement;
	private readonly subject: string;
	private readonly key: string;

	constructor(private readonly opts: ChatLayer3ConfirmToastOpts) {
		super();
		this.state = { kind: 'showing', canonicalText: opts.confirm.canonicalText };
		this.subject = opts.confirm.subject;
		this.key = opts.confirm.key;

		this.card = $('.insrc-chat-assertion-confirm');
		this.card.setAttribute('data-assertion-key', this.key);
		this.card.setAttribute('role', 'group');
		this.card.setAttribute('aria-label', `Confirm captured preference: ${this.subject}`);

		const header = dom.append(this.card, $('.insrc-chat-assertion-confirm-header'));
		header.textContent = `Captured preference (${opts.confirm.subject})`;

		this.body = dom.append(this.card, $('.insrc-chat-assertion-confirm-body'));

		this.actions = dom.append(this.card, $('.insrc-chat-assertion-confirm-actions'));

		dom.append(opts.container, this.card);
		this.render();
	}

	override dispose(): void {
		try { this.card.remove(); } catch { /* idempotent */ }
		super.dispose();
	}

	/** Apply an action via the pure transition + re-render. Async side-effects (RPC) are kicked off in render(). */
	private apply(action: ToastAction): void {
		const next = nextState(this.state, action);
		if (next === this.state) { return; }
		this.state = next;
		this.render();
	}

	/** Imperative effect for the 'submitting' state: fire the RPC, then transition out. */
	private async submit(verdict: 'accept' | 'discard', canonicalText?: string): Promise<void> {
		try {
			await this.opts.chatService.resolveAssertionConfirm(this.key, verdict, canonicalText);
			this.apply({ kind: 'submit-ok' });
		} catch (err) {
			this.apply({ kind: 'submit-failed', error: (err as Error).message ?? String(err) });
		}
	}

	private render(): void {
		dom.clearNode(this.body);
		dom.clearNode(this.actions);

		switch (this.state.kind) {
			case 'showing': {
				const text = dom.append(this.body, $('.insrc-chat-assertion-confirm-text'));
				text.textContent = this.state.canonicalText;
				this.button(this.actions, 'Save', true, () => this.apply({ kind: 'save' }));
				this.button(this.actions, 'Customize…', false, () => this.apply({ kind: 'customize' }));
				this.button(this.actions, 'Discard', false, () => this.apply({ kind: 'discard' }));
				return;
			}
			case 'editing': {
				const editor = dom.append(this.body, $('textarea.insrc-chat-assertion-confirm-editor')) as HTMLTextAreaElement;
				editor.rows = 3;
				editor.value = this.state.canonicalText;
				editor.setAttribute('aria-label', 'Customize captured preference');

				this.button(this.actions, 'Save', true, () => {
					const value = editor.value.trim();
					this.apply({ kind: 'editor-save', canonicalText: value });
				});
				this.button(this.actions, 'Cancel', false, () => {
					this.apply({ kind: 'editor-cancel' });
				});
				return;
			}
			case 'submitting': {
				this.body.textContent = this.state.verdict === 'accept' ? 'Saving…' : 'Discarding…';
				// Kick off the RPC effect once -- guard with a sentinel
				// attribute so re-renders during the same submit don't
				// double-fire it.
				if (this.card.getAttribute('data-submitted') !== '1') {
					this.card.setAttribute('data-submitted', '1');
					void this.submit(this.state.verdict, this.state.canonicalText);
				}
				return;
			}
			case 'persisted': {
				this.body.textContent = this.state.verdict === 'accept'
					? '✓ Saved'
					: '✓ Discarded';
				this.card.classList.add('insrc-chat-assertion-confirm-persisted');
				return;
			}
			case 'failed': {
				this.body.textContent = `Error: ${this.state.error}`;
				this.card.classList.add('insrc-chat-assertion-confirm-failed');
				// Surface a retry affordance via a fresh Save button -- the
				// staging row is still in substrate, so re-clicking just
				// re-fires resolveAssertionConfirm.
				this.button(this.actions, 'Retry', true, () => {
					this.card.removeAttribute('data-submitted');
					this.state = { kind: 'showing', canonicalText: this.opts.confirm.canonicalText };
					this.render();
				});
				return;
			}
		}
	}

	private button(parent: HTMLElement, label: string, primary: boolean, onClick: () => void): void {
		const btn = dom.append(parent, $('button.insrc-chat-assertion-confirm-btn')) as HTMLButtonElement;
		btn.textContent = label;
		if (primary) { btn.classList.add('primary'); }
		this._register(dom.addDisposableListener(btn, 'click', () => onClick()));
	}
}
