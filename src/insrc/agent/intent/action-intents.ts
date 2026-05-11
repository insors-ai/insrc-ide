/**
 * Per-action intent resolution for the decomposer's output (Phase 6
 * of plans/intent-classification-consolidation.md).
 *
 * The decomposer splits a message into structural pieces (primary +
 * attached); intent classification was historically also done in
 * that prompt and led to misclassifications (the trigger bug). Per
 * the plan, intent is now picked SOLELY by `resolveIntent` against
 * each action's text.
 *
 * Why a helper instead of inline calls in chat-handler:
 *   1. Tag-stamping rule: `[intent:current]` is supposed to land on
 *      the PRIMARY action's intent and nothing else. If chat-handler
 *      called `resolveIntent` for every attached action without
 *      coordination, each call would re-stamp the tag and the last
 *      attached action would "win", leaving the next turn's tag
 *      pointing at an attached aside instead of the primary topic.
 *      This helper resolves the primary with stamping ON and the
 *      attached actions with `noStamp: true`.
 *   2. Parallelism: attached resolutions are independent. The
 *      helper fans them out via `Promise.all` while keeping the
 *      primary on the hot path (so the chat-handler's UI updates
 *      don't wait on attached classifications).
 *   3. Mutation contract: the helper mutates each action's
 *      `.intent` field in place so downstream code that still
 *      reads `action.intent` (task-builder.ts:25, _runSingleAction
 *      at chat-handler.ts:2585+) sees the resolver's answer
 *      without signature plumbing. The original decomposer-emitted
 *      intent is overwritten -- per Phase 5's banner it was
 *      advisory only.
 */

import { resolveIntent, type ResolvedIntent } from './resolver.js';
import type { Session } from '../session.js';
import type { DecomposedAction, AttachedAction } from '../decompose.js';

export interface ResolveActionIntentsInput {
	readonly session:  Session;
	readonly primary:  DecomposedAction;
	readonly attached: readonly AttachedAction[];
}

export interface ResolveActionIntentsResult {
	/** Resolver result for the primary action (this is what stamped the tag). */
	readonly primary:  ResolvedIntent;
	/** Resolver results for the attached actions, in the same order. */
	readonly attached: readonly ResolvedIntent[];
}

/**
 * Resolve intents for a primary + attached action set in one pass.
 * Stamps the session tag once with the primary's intent; attached
 * actions resolve in parallel with stamping suppressed.
 *
 * Side effects:
 *   - Mutates `primary.intent` and each `attached[i].intent` to the
 *     resolver's answer, so legacy `action.intent` readers
 *     downstream pick up the canonical intent without further
 *     plumbing.
 *   - Stamps `[intent:current]` exactly once via the primary
 *     resolveIntent call.
 */
export async function resolveActionIntents(
	input: ResolveActionIntentsInput,
): Promise<ResolveActionIntentsResult> {
	const { session, primary, attached } = input;

	// Run the primary on the hot path first so the tag is stamped
	// before any attached resolution can race (attached calls run
	// with noStamp anyway, but ordering keeps the log readable).
	const primaryResolved = await resolveIntent(session, primary.action);
	primary.intent = primaryResolved.id;

	const attachedResolved = attached.length === 0
		? []
		: await Promise.all(
			attached.map(a => resolveIntent(session, a.action, { noStamp: true })),
		);
	for (let i = 0; i < attached.length; i++) {
		const a = attached[i]!;
		const r = attachedResolved[i]!;
		a.intent = r.id;
	}

	return { primary: primaryResolved, attached: attachedResolved };
}

/**
 * Resolve a single decomposer action (used when the decomposer
 * returned the legacy `actions[]` shape without primary/attached
 * separation). Stamps the tag.
 */
export async function resolveSingleActionIntent(
	session: Session,
	action: DecomposedAction,
): Promise<ResolvedIntent> {
	const resolved = await resolveIntent(session, action.action);
	action.intent = resolved.id;
	return resolved;
}
