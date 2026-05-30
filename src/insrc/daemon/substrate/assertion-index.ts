/**
 * Assertion-interest index -- P5.2 of plans/skills/substrate-implementation-status.md.
 *
 * Implements substrate D14 (assertion routing). The lookup table is
 * built from every registered consumer's `assertionInterests` -- no
 * separate registry, just the catalog. The classifier (D6) consults
 * this index to find candidate `targetOwners` for an assertion's
 * subject; the LLM has final say on which it actually keeps.
 *
 * Lookup pipeline (per D14):
 *   1. Exact match on `subjectPattern`.
 *   2. Embedding similarity against `description` (deferred -- needs
 *      the substrate's embedder + a small per-owner embed cache).
 *
 * P5 ships step 1 only. Step 2 is gated on the substrate having an
 * embedder wired (P2 made that opt-in via runtime opts) and on a
 * skill consumer actually needing fuzzy routing. The exact-match
 * path is sufficient for the day-one classifier that emits
 * canonicalized subjects.
 *
 * Priority (`AssertionInterest.priority`) is informational only --
 * the index returns matches in priority-descending order to give
 * callers a stable ranking; it doesn't exclude any match.
 */

import { getLogger } from '../../shared/logger.js';

import type {
	AssertionInterest,
	OwnerId,
} from './types.js';

const log = getLogger('substrate:assertion-index');

// ---------------------------------------------------------------------------

/**
 * One matched interest. The classifier turns these into target
 * owners and the substrate fan-outs FeedbackEvents one per match.
 */
export interface AssertionMatch {
	readonly owner:    OwnerId;
	readonly interest: AssertionInterest;
}

export interface AssertionIndex {
	/**
	 * Register an owner's interests. Re-registering for the same
	 * owner replaces the prior set (the catalog is the truth; we
	 * don't merge across registrations).
	 */
	register(owner: OwnerId, interests: readonly AssertionInterest[]): void;

	/** Remove every registration for this owner. */
	deregister(owner: OwnerId): void;

	/**
	 * Find owners interested in `subject`. Exact match on
	 * `subjectPattern` for MVP. Returns matches in priority-descending
	 * order (undefined priority sorts last; ties broken by owner id).
	 */
	lookup(subject: string): readonly AssertionMatch[];

	/** Introspection: list every (owner, interest) currently registered. */
	all(): readonly AssertionMatch[];
}

export function createAssertionIndex(): AssertionIndex {
	// owner -> declared interests (snapshot per registration).
	const byOwner = new Map<OwnerId, readonly AssertionInterest[]>();

	// Cache the inverted (subject -> match[]) view so lookup is O(1).
	// Invalidated on every register/deregister; cheap to rebuild on
	// next lookup.
	let inverted: Map<string, AssertionMatch[]> | undefined;

	function invalidate(): void {
		inverted = undefined;
	}

	function rebuild(): Map<string, AssertionMatch[]> {
		const next = new Map<string, AssertionMatch[]>();
		for (const [owner, interests] of byOwner) {
			for (const interest of interests) {
				const list = next.get(interest.subjectPattern);
				if (list === undefined) {
					next.set(interest.subjectPattern, [{ owner, interest }]);
				} else {
					list.push({ owner, interest });
				}
			}
		}
		// Stable ordering: priority DESC (undefined = lowest), then owner ASC.
		for (const list of next.values()) {
			list.sort(compareMatches);
		}
		return next;
	}

	return {
		register(owner: OwnerId, interests: readonly AssertionInterest[]): void {
			if (interests.length === 0) {
				byOwner.delete(owner);
			} else {
				byOwner.set(owner, interests.slice());
			}
			invalidate();
			log.debug({ owner, count: interests.length }, 'assertion-index:register');
		},

		deregister(owner: OwnerId): void {
			byOwner.delete(owner);
			invalidate();
		},

		lookup(subject: string): readonly AssertionMatch[] {
			if (inverted === undefined) { inverted = rebuild(); }
			return inverted.get(subject) ?? [];
		},

		all(): readonly AssertionMatch[] {
			const out: AssertionMatch[] = [];
			for (const [owner, interests] of byOwner) {
				for (const interest of interests) {
					out.push({ owner, interest });
				}
			}
			out.sort(compareMatches);
			return out;
		},
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function compareMatches(a: AssertionMatch, b: AssertionMatch): number {
	const aPrio = a.interest.priority;
	const bPrio = b.interest.priority;
	// undefined sorts after any defined priority.
	if (aPrio !== bPrio) {
		if (aPrio === undefined) { return 1; }
		if (bPrio === undefined) { return -1; }
		return bPrio - aPrio;
	}
	return a.owner.localeCompare(b.owner);
}
