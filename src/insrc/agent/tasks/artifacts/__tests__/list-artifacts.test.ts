/**
 * Tests for `listSessionArtifacts` in persistence.ts -- powers the
 * `artifact:list` tool that closes the phase-2 NL regenerate UX gap
 * (see plans/artifact-tasks.md §2.4).
 *
 * Uses a minimal TodosApi stub: only `caller` + `listForSession` are
 * exercised by the function under test, so the stub doesn't need the
 * full create / add / mutate plumbing the regenerate tests build.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type {
	ArtifactItemMeta,
	ArtifactKind,
} from '../../../../shared/artifacts.js';
import type {
	TodoItem,
	TodoList,
	TodosApi,
} from '../../../../shared/todos.js';

import {
	listSessionArtifacts,
	MAX_LIST_ARTIFACTS,
} from '../persistence.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = 'session-fixture';

function metaFor(kind: ArtifactKind): ArtifactItemMeta {
	return {
		kind,
		source: 'fake-source',
		renderedHtml: { embedded: '<div></div>', standalone: '<html></html>' },
		metadata: { provenance: 'test' },
		warnings: [],
		confidence: 'high',
		revisions: [],
	};
}

interface ItemSpec {
	readonly artifactId: string;
	readonly itemId: string;
	readonly title: string;
	readonly kind: ArtifactKind;
	readonly createdAt: string;
	readonly revisionsCount?: number;
	/** Override the description to test malformed-row handling. */
	readonly description?: string;
	/** Override meta to test malformed-meta rows. */
	readonly meta?: unknown;
}

function makeItem(spec: ItemSpec): TodoItem {
	const meta = spec.meta !== undefined
		? spec.meta as Readonly<Record<string, unknown>>
		: {
			...metaFor(spec.kind),
			revisions: Array.from(
				{ length: spec.revisionsCount ?? 0 },
				(_, i) => ({ at: spec.createdAt, edits: `r${i}`, source: 'old' }),
			),
		} as unknown as Readonly<Record<string, unknown>>;

	return {
		id: spec.itemId,
		listId: 'list-fixture',
		title: spec.title,
		description: spec.description ?? `[artifact:${spec.artifactId}] test`,
		status: 'completed',
		order: 1,
		createdAt: spec.createdAt,
		updatedAt: spec.createdAt,
		meta,
	};
}

function makeStubApi(items: readonly TodoItem[]): TodosApi {
	const list: TodoList = {
		id: 'list-fixture',
		sessionId: SESSION_ID,
		title: 'Artifacts',
		description: '[insrc:suppress-comments] test',
		status: 'active',
		owner: 'chat',
		source: 'chat',
		transfers: [],
		createdAt: '2026-04-25T00:00:00Z',
		updatedAt: '2026-04-25T00:00:00Z',
		items,
	};

	const reject = async (): Promise<never> => {
		throw new Error('not exercised by listSessionArtifacts');
	};

	const stub = {
		caller: 'chat' as const,
		async listForSession(sessionId: string) {
			return sessionId === SESSION_ID ? [list] : [];
		},
		// Every other method is unused by the function under test. Cast
		// the partial through `unknown` so the strict TodosApi shape
		// doesn't reject the cast.
		getList: reject, getItem: reject, listCommentsForItem: reject,
		createList: reject, updateListTitle: reject, updateListBody: reject,
		archive: reject, unarchive: reject, transfer: reject, reparent: reject,
		addItem: reject, markInProgress: reject, markComplete: reject,
		markBlocked: reject, markCancelled: reject,
		updateItemTitle: reject, updateItemDescription: reject, updateItemMeta: reject,
		removeItem: reject, ackComment: reject,
	};
	return stub as unknown as TodosApi;
}

// ---------------------------------------------------------------------------
// Empty + happy path
// ---------------------------------------------------------------------------

describe('listSessionArtifacts', () => {
	it('returns empty when the Artifacts list does not exist for the session', async () => {
		const api = makeStubApi([]);
		const out = await listSessionArtifacts(api, 'unknown-session');
		assert.deepEqual(out, []);
	});

	it('returns empty when the session has the list but no items', async () => {
		const api = makeStubApi([]);
		const out = await listSessionArtifacts(api, SESSION_ID);
		assert.deepEqual(out, []);
	});

	it('returns one summary per well-formed item, newest first', async () => {
		const api = makeStubApi([
			makeItem({
				artifactId: 'aaa', itemId: 'i1',
				title: 'old ER', kind: 'er',
				createdAt: '2026-04-20T10:00:00Z',
				revisionsCount: 2,
			}),
			makeItem({
				artifactId: 'bbb', itemId: 'i2',
				title: 'new sequence', kind: 'sequence',
				createdAt: '2026-04-25T10:00:00Z',
				revisionsCount: 0,
			}),
		]);

		const out = await listSessionArtifacts(api, SESSION_ID);

		assert.equal(out.length, 2);
		assert.equal(out[0]?.artifactId, 'bbb');
		assert.equal(out[0]?.kind, 'sequence');
		assert.equal(out[0]?.title, 'new sequence');
		assert.equal(out[0]?.revisionsCount, 0);
		assert.equal(out[1]?.artifactId, 'aaa');
		assert.equal(out[1]?.revisionsCount, 2);
	});

	// ---------------------------------------------------------------------
	// Filtering / cap behaviour
	// ---------------------------------------------------------------------

	it('skips items whose description lacks the [artifact:<id>] prefix', async () => {
		const api = makeStubApi([
			makeItem({
				artifactId: 'aaa', itemId: 'i1',
				title: 'good', kind: 'er',
				createdAt: '2026-04-25T10:00:00Z',
			}),
			// Description missing the sentinel -> skipped.
			makeItem({
				artifactId: 'bbb', itemId: 'i2',
				title: 'bad', kind: 'er',
				createdAt: '2026-04-25T11:00:00Z',
				description: 'no sentinel here',
			}),
		]);

		const out = await listSessionArtifacts(api, SESSION_ID);
		assert.equal(out.length, 1);
		assert.equal(out[0]?.artifactId, 'aaa');
	});

	it('skips items whose meta is not an artifact shape', async () => {
		const api = makeStubApi([
			makeItem({
				artifactId: 'aaa', itemId: 'i1',
				title: 'real', kind: 'er',
				createdAt: '2026-04-25T10:00:00Z',
			}),
			// Random meta blob -> skipped.
			makeItem({
				artifactId: 'bbb', itemId: 'i2',
				title: 'fake', kind: 'er',
				createdAt: '2026-04-25T11:00:00Z',
				meta: { unrelated: 'thing' },
			}),
		]);

		const out = await listSessionArtifacts(api, SESSION_ID);
		assert.equal(out.length, 1);
		assert.equal(out[0]?.artifactId, 'aaa');
	});

	it('caps to opts.limit when supplied', async () => {
		const items: TodoItem[] = [];
		for (let i = 0; i < 10; i++) {
			items.push(makeItem({
				artifactId: `id-${i}`, itemId: `item-${i}`,
				title: `t${i}`, kind: 'er',
				createdAt: `2026-04-${String(10 + i).padStart(2, '0')}T00:00:00Z`,
			}));
		}
		const api = makeStubApi(items);

		const out = await listSessionArtifacts(api, SESSION_ID, { limit: 3 });
		assert.equal(out.length, 3);
		// Newest three: id-9, id-8, id-7.
		assert.deepEqual(out.map(s => s.artifactId), ['id-9', 'id-8', 'id-7']);
	});

	it(`caps to MAX_LIST_ARTIFACTS (${MAX_LIST_ARTIFACTS}) when limit exceeds it`, async () => {
		const overflow = MAX_LIST_ARTIFACTS + 5;
		const items: TodoItem[] = [];
		for (let i = 0; i < overflow; i++) {
			items.push(makeItem({
				artifactId: `id-${i}`, itemId: `item-${i}`,
				title: `t${i}`, kind: 'er',
				// Sortable-as-string ISO dates.
				createdAt: `2026-04-25T${String(i % 24).padStart(2, '0')}:00:00Z`,
			}));
		}
		const api = makeStubApi(items);

		const out = await listSessionArtifacts(api, SESSION_ID, { limit: overflow });
		assert.equal(out.length, MAX_LIST_ARTIFACTS);
	});

	it('clamps non-positive limits to 1', async () => {
		const api = makeStubApi([
			makeItem({
				artifactId: 'aaa', itemId: 'i1', title: 't', kind: 'er',
				createdAt: '2026-04-25T10:00:00Z',
			}),
			makeItem({
				artifactId: 'bbb', itemId: 'i2', title: 't2', kind: 'er',
				createdAt: '2026-04-26T10:00:00Z',
			}),
		]);
		const out = await listSessionArtifacts(api, SESSION_ID, { limit: 0 });
		assert.equal(out.length, 1);
		assert.equal(out[0]?.artifactId, 'bbb');   // newest survives the cap
	});
});
