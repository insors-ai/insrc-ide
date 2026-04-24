/**
 * Tests for agent/tasks/artifacts/regenerate.ts + the revision
 * append flow in persistence.ts.
 *
 * Uses a stubbed TodosApi (no DB) so the suite stays pure-function.
 * Covers:
 *   - Mermaid kind: LLM edit round-trips a new source + pushes a
 *     revision
 *   - Wireframe kind: LLM returns a valid spec JSON, renderer
 *     produces new SVG, revisions appended
 *   - LLM failure paths throw (caller sees the error)
 *   - last-5 eviction on revisions when the item already has >= 5
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';

import type {
	LLMMessage, LLMProvider, LLMResponse,
} from '../../../../shared/types.js';
import type {
	ArtifactItemMeta,
} from '../../../../shared/artifacts.js';
import type {
	TodoItem, TodoList, TodosApi, AddTodoItemOpts, CreateTodoListOpts,
	TodoComment, TodoItemStatus, TodoOwner,
} from '../../../../shared/todos.js';

import { regenerateArtifact } from '../regenerate.js';
import { appendRevision, MAX_REVISIONS } from '../persistence.js';

// ---------------------------------------------------------------------------
// Stub TodosApi -- single list, single session. Good enough for
// regenerate flow tests.
// ---------------------------------------------------------------------------

function nowIso(): string { return new Date().toISOString(); }

function makeStubApi(caller: TodoOwner = 'chat'): TodosApi & {
	// Direct-access helpers the tests use.
	__seedArtifact(sessionId: string, meta: ArtifactItemMeta): Promise<TodoItem>;
	__getItem(itemId: string): TodoItem | undefined;
} {
	const lists: TodoList[] = [];
	const itemsByListId = new Map<string, TodoItem[]>();

	function makeId(): string { return randomBytes(16).toString('hex'); }

	const api: TodosApi = {
		caller,

		async listForSession(sessionId: string): Promise<readonly TodoList[]> {
			return lists
				.filter(l => l.sessionId === sessionId)
				.map(l => ({ ...l, items: itemsByListId.get(l.id) ?? [] }));
		},

		async getList(listId: string): Promise<TodoList | null> {
			const list = lists.find(l => l.id === listId);
			if (list === undefined) { return null; }
			return { ...list, items: itemsByListId.get(list.id) ?? [] };
		},

		async getItem(itemId: string): Promise<TodoItem | null> {
			for (const items of itemsByListId.values()) {
				const hit = items.find(i => i.id === itemId);
				if (hit !== undefined) { return hit; }
			}
			return null;
		},

		async listCommentsForItem(): Promise<readonly TodoComment[]> { return []; },

		async createList(opts: CreateTodoListOpts): Promise<TodoList> {
			const id = makeId();
			const nowIsoStr = nowIso();
			const list: TodoList = {
				id,
				sessionId: opts.sessionId,
				title: opts.title,
				...(opts.description !== undefined ? { description: opts.description } : {}),
				...(opts.parentListId !== undefined ? { parentListId: opts.parentListId } : {}),
				...(opts.body !== undefined ? { body: opts.body } : {}),
				status: 'active',
				owner: caller,
				source: caller,
				transfers: [],
				createdAt: nowIsoStr,
				updatedAt: nowIsoStr,
				items: [],
			};
			lists.push(list);
			itemsByListId.set(id, []);
			return list;
		},

		async updateListTitle(): Promise<TodoList> { throw new Error('not needed'); },
		async updateListBody(): Promise<TodoList> { throw new Error('not needed'); },
		async archive(): Promise<TodoList> { throw new Error('not needed'); },
		async unarchive(): Promise<TodoList> { throw new Error('not needed'); },
		async transfer(): Promise<TodoList> { throw new Error('not needed'); },
		async reparent(): Promise<TodoList> { throw new Error('not needed'); },

		async addItem(listId: string, opts: AddTodoItemOpts): Promise<TodoItem> {
			const list = lists.find(l => l.id === listId);
			if (list === undefined) { throw new Error(`addItem: list ${listId} missing`); }
			const id = makeId();
			const item: TodoItem = {
				id,
				listId,
				title: opts.title,
				...(opts.description !== undefined ? { description: opts.description } : {}),
				...(opts.tags !== undefined ? { tags: opts.tags } : {}),
				...(opts.meta !== undefined ? { meta: opts.meta } : {}),
				status: 'pending',
				order: (itemsByListId.get(listId)?.length ?? 0) + 1,
				createdAt: nowIso(),
				updatedAt: nowIso(),
			};
			itemsByListId.get(listId)!.push(item);
			return item;
		},

		async markInProgress(itemId: string): Promise<TodoItem> {
			return updateStatus(itemId, 'in_progress');
		},
		async markComplete(itemId: string): Promise<TodoItem> {
			return updateStatus(itemId, 'completed');
		},
		async markBlocked(itemId: string, reason: string): Promise<TodoItem> {
			return updateStatus(itemId, 'blocked', { blockedReason: reason });
		},
		async markCancelled(itemId: string): Promise<TodoItem> {
			return updateStatus(itemId, 'cancelled');
		},

		async updateItemTitle(itemId: string, title: string): Promise<TodoItem> {
			return mutate(itemId, item => ({ ...item, title, updatedAt: nowIso() }));
		},
		async updateItemDescription(itemId: string, description: string): Promise<TodoItem> {
			return mutate(itemId, item => ({ ...item, description, updatedAt: nowIso() }));
		},
		async updateItemMeta(itemId: string, meta: Readonly<Record<string, unknown>>): Promise<TodoItem> {
			return mutate(itemId, item => ({ ...item, meta, updatedAt: nowIso() }));
		},

		async removeItem(itemId: string): Promise<void> {
			for (const [listId, items] of itemsByListId) {
				const idx = items.findIndex(i => i.id === itemId);
				if (idx >= 0) { items.splice(idx, 1); void listId; return; }
			}
		},

		async ackComment(): Promise<TodoComment> { throw new Error('not needed'); },
	};

	function mutate(itemId: string, fn: (item: TodoItem) => TodoItem): TodoItem {
		for (const items of itemsByListId.values()) {
			const idx = items.findIndex(i => i.id === itemId);
			if (idx >= 0) {
				const old = items[idx];
				if (old === undefined) { break; }
				const next = fn(old);
				items[idx] = next;
				return next;
			}
		}
		throw new Error(`mutate: item ${itemId} missing`);
	}

	function updateStatus(
		itemId: string,
		status: TodoItemStatus,
		extra: Partial<TodoItem> = {},
	): TodoItem {
		return mutate(itemId, item => ({
			...item,
			...extra,
			status,
			updatedAt: nowIso(),
			...(status === 'completed' ? { completedAt: nowIso() } : {}),
		}));
	}

	// Test-only helper: seed an artifact on a fresh Artifacts list.
	async function __seedArtifact(sessionId: string, meta: ArtifactItemMeta): Promise<TodoItem> {
		const artifactId = (meta.metadata as Record<string, string>)['generatedAt'] ?? 'seed';
		const list = await api.createList({
			sessionId,
			title: 'Artifacts',
			description: '[insrc:suppress-comments] seeded',
		});
		const item = await api.addItem(list.id, {
			title: meta.title ?? meta.kind,
			description: `[artifact:${artifactId}]`,
			meta: meta as unknown as Readonly<Record<string, unknown>>,
		});
		return api.markComplete(item.id);
	}

	function __getItem(itemId: string): TodoItem | undefined {
		for (const items of itemsByListId.values()) {
			const hit = items.find(i => i.id === itemId);
			if (hit !== undefined) { return hit; }
		}
		return undefined;
	}

	return Object.assign(api, { __seedArtifact, __getItem });
}

// ---------------------------------------------------------------------------
// Mock LLM provider
// ---------------------------------------------------------------------------

function mockProvider(text: string): LLMProvider {
	return {
		async complete(_msgs: LLMMessage[]): Promise<LLMResponse> {
			return { text, stopReason: 'end_turn' };
		},
		async *stream(): AsyncIterable<string> { yield text; },
		async embed(): Promise<number[]> { return []; },
		supportsTools: false,
	};
}

// ---------------------------------------------------------------------------
// Mermaid kind regenerate
// ---------------------------------------------------------------------------

describe('regenerateArtifact - Mermaid kind', () => {
	it('swaps in the LLM-produced source and appends a revision', async () => {
		const api = makeStubApi();
		const priorSource =
			'sequenceDiagram\n  participant A\n  participant B\n  A->>B: ping';
		const seed: ArtifactItemMeta = {
			kind: 'sequence',
			source: priorSource,
			renderedHtml: { embedded: '<div>old</div>', standalone: '<div>old</div>' },
			metadata: { generatedAt: 'artifact-v1', provenance: 'test-seed' },
			warnings: [],
			confidence: 'medium',
			revisions: [],
		};
		await api.__seedArtifact('s1', seed);

		const newSource =
			'sequenceDiagram\n  participant A\n  participant B\n  A->>B: ping\n  B-->>A: pong';
		const provider = mockProvider(newSource);

		const result = await regenerateArtifact({
			sessionId: 's1',
			artifactId: 'artifact-v1',
			edits: 'add a return message',
			api,
			provider,
		});

		assert.equal(result.artifact.kind, 'sequence');
		assert.equal(result.artifact.source, newSource);
		assert.ok(result.artifact.renderedHtml.embedded.includes('data-artifact-id='));
		assert.ok(result.artifact.renderedHtml.embedded.includes('B--&gt;&gt;A: pong'));
		assert.equal(result.revisionCount, 1);

		const storedMeta = result.item.meta as unknown as ArtifactItemMeta;
		assert.equal(storedMeta.source, newSource);
		const revisions = storedMeta.revisions ?? [];
		assert.equal(revisions[0]?.source, priorSource);
		assert.equal(revisions[0]?.edits, 'add a return message');
	});

	it('strips markdown fences from the LLM output', async () => {
		const api = makeStubApi();
		await api.__seedArtifact('s2', {
			kind: 'flow',
			source: 'flowchart TD\n  A --> B',
			renderedHtml: { embedded: '', standalone: '' },
			metadata: { generatedAt: 'flow-v1' },
			warnings: [],
			confidence: 'low',
			revisions: [],
		});
		const provider = mockProvider(
			'```mermaid\nflowchart LR\n  A --> B --> C\n```',
		);
		const result = await regenerateArtifact({
			sessionId: 's2',
			artifactId: 'flow-v1',
			edits: 'change to LR and add C',
			api,
			provider,
		});
		assert.ok(!result.artifact.source.includes('```'), 'fences must be stripped');
		assert.match(result.artifact.source, /flowchart LR/);
	});

	it('throws when the LLM returns empty text', async () => {
		const api = makeStubApi();
		await api.__seedArtifact('s3', {
			kind: 'er',
			source: 'erDiagram\n  USER { string id PK }',
			renderedHtml: { embedded: '', standalone: '' },
			metadata: { generatedAt: 'er-v1' },
			warnings: [],
			confidence: 'low',
			revisions: [],
		});
		const provider = mockProvider('   \n');
		await assert.rejects(
			regenerateArtifact({
				sessionId: 's3',
				artifactId: 'er-v1',
				edits: 'rename USER to ACCOUNT',
				api,
				provider,
			}),
			/unparseable/,
		);
	});
});

// ---------------------------------------------------------------------------
// Wireframe kind regenerate
// ---------------------------------------------------------------------------

describe('regenerateArtifact - wireframe kind', () => {
	it('accepts a valid WireframeSpec JSON + produces new SVG', async () => {
		const api = makeStubApi();
		const priorSpecJson = JSON.stringify({
			layout: 'desktop',
			rows: [{ height: 48, cells: [{ kind: 'header', label: 'Old' }] }],
		}, null, 2);
		await api.__seedArtifact('s4', {
			kind: 'wireframe',
			source: priorSpecJson,
			renderedHtml: { embedded: '', standalone: '' },
			metadata: { generatedAt: 'wf-v1' },
			warnings: [],
			confidence: 'high',
			revisions: [],
		});
		const provider = mockProvider(JSON.stringify({
			layout: 'mobile',
			rows: [
				{ height: 48, cells: [{ kind: 'header', label: 'New' }] },
				{ height: 'auto', cells: [{ kind: 'content', label: 'Body' }] },
			],
		}));

		const result = await regenerateArtifact({
			sessionId: 's4',
			artifactId: 'wf-v1',
			edits: 'switch to mobile layout and add a body row',
			api,
			provider,
		});

		assert.equal(result.artifact.kind, 'wireframe');
		const newSpec = JSON.parse(result.artifact.source) as { layout: string; rows: unknown[] };
		assert.equal(newSpec.layout, 'mobile');
		assert.equal(newSpec.rows.length, 2);
		assert.ok(result.artifact.renderedHtml.embedded.includes('<svg '));
	});

	it('throws when the LLM returns shape-invalid wireframe JSON', async () => {
		const api = makeStubApi();
		await api.__seedArtifact('s5', {
			kind: 'wireframe',
			source: '{"layout":"desktop","rows":[{"height":48,"cells":[{"kind":"header"}]}]}',
			renderedHtml: { embedded: '', standalone: '' },
			metadata: { generatedAt: 'wf-v2' },
			warnings: [],
			confidence: 'high',
			revisions: [],
		});
		const provider = mockProvider(
			'{"layout":"desktop","rows":[{"height":"bogus","cells":[]}]}',
		);
		await assert.rejects(
			regenerateArtifact({
				sessionId: 's5',
				artifactId: 'wf-v2',
				edits: 'make it worse',
				api,
				provider,
			}),
			/unparseable/,
		);
	});
});

// ---------------------------------------------------------------------------
// Revision eviction (persistence.appendRevision)
// ---------------------------------------------------------------------------

describe('appendRevision - last-N eviction', () => {
	it('caps revisions at MAX_REVISIONS (drops oldest)', async () => {
		const api = makeStubApi();
		const existing = Array.from({ length: MAX_REVISIONS }, (_, i) => ({
			at: `2026-04-24T10:00:${i.toString().padStart(2, '0')}.000Z`,
			edits: `old-edit-${i}`,
			source: `old-source-${i}`,
		}));
		const seed: ArtifactItemMeta = {
			kind: 'sequence',
			source: 'current-source',
			renderedHtml: { embedded: '', standalone: '' },
			metadata: { generatedAt: 'cap-test' },
			warnings: [],
			confidence: 'medium',
			revisions: existing,
		};
		const seeded = await api.__seedArtifact('s6', seed);

		const newResult = {
			id: 'new-id',
			kind: 'sequence' as const,
			source: 'brand-new-source',
			renderedHtml: { embedded: '', standalone: '' },
			metadata: { generatedAt: 'new' },
			warnings: [],
			confidence: 'medium' as const,
		};

		const updated = await appendRevision(api, seeded.id, {
			edits: 'newest-edit',
			newResult,
		});

		const meta = updated.meta as unknown as ArtifactItemMeta;
		assert.equal(meta.revisions?.length, MAX_REVISIONS);
		// Oldest dropped: index 0 was 'old-edit-0'; after push + slice
		// we keep the last 5 -> 'old-edit-1'..'old-edit-4' + the newest.
		assert.equal(meta.revisions?.[0]?.edits, 'old-edit-1');
		assert.equal(meta.revisions?.[MAX_REVISIONS - 1]?.edits, 'newest-edit');
		assert.equal(meta.source, 'brand-new-source');
	});
});
