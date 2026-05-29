/**
 * Provider registry + assembler routing tests -- P4.7 of
 * plans/skills/substrate-implementation-status.md.
 *
 * Coverage:
 *   - register / get / deregister round-trips.
 *   - resolve returns [] for a non-provider owner (memory path).
 *   - resolve returns [] for an unknown provider id (no provider
 *     registered).
 *   - resolve stamps `source.kind: 'provider'` + `providerId` on every
 *     entry the provider returns -- the contract per D5a.
 *   - Assembler routes `provider:<id>` slots through the registry
 *     instead of memory.
 *   - Assembler without a registry: provider slots resolve empty.
 *   - Active-session + user-config providers integrated through the
 *     assembler.
 *   - Registry replacement (re-registering same id replaces).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createProviderRegistry } from '../provider-registry.js';
import { createContextAssembler } from '../context-assembler.js';
import { createActiveSessionProvider } from '../providers/active-session.js';
import { createUserConfigProvider } from '../providers/user-config.js';
import { createMemoryStore } from '../memory-store.js';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
	AssembleRequest,
	ContextProvider,
	ContextSlotRequest,
	MemoryEntry,
} from '../types.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakeProvider(id: string, entries: readonly MemoryEntry<unknown>[]): ContextProvider {
	return {
		id,
		schemaVersion: 1,
		async read(_slot: ContextSlotRequest): Promise<readonly MemoryEntry<unknown>[]> {
			return entries;
		},
	};
}

function entry(key: string, value: unknown): MemoryEntry<unknown> {
	return {
		key,
		value,
		kind:       'fact',
		// Whatever a sloppy provider hands back -- the registry should
		// overwrite this on the way out.
		source:     { kind: 'test', note: 'fake' },
		confidence: 0.5,
		writtenAt:  Date.now(),
	};
}

function memoryFx() {
	const root = mkdtempSync(join(tmpdir(), 'insrc-substrate-p4-'));
	const memory = createMemoryStore({ workspaceId: 'wsP4', rootDir: root });
	return {
		memory,
		dispose: () => rmSync(root, { recursive: true, force: true }),
	};
}

const ABORT = new AbortController().signal;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test('registry: register / get / deregister round-trip', () => {
	const reg = createProviderRegistry();
	const p = fakeProvider('demo', []);
	reg.register(p);
	assert.equal(reg.get('demo'), p);
	reg.deregister('demo');
	assert.equal(reg.get('demo'), undefined);
});

test('registry: re-registering same id replaces', async () => {
	const reg = createProviderRegistry();
	reg.register(fakeProvider('demo', [entry('first', 1)]));
	reg.register(fakeProvider('demo', [entry('second', 2)]));

	const slot: ContextSlotRequest = {
		name: 's', fromOwner: 'provider:demo', namespace: '_',
		query: { kind: 'byKey', key: 'whatever' },
	};
	const out = await reg.resolve(slot, { signal: ABORT });
	assert.equal(out.length, 1);
	assert.equal(out[0]!.key, 'second');
});

test('registry: non-provider owner -> []', async () => {
	const reg = createProviderRegistry();
	const slot: ContextSlotRequest = {
		name: 's', fromOwner: 'skill:foo', namespace: 'bar',
		query: { kind: 'byKey', key: 'k' },
	};
	const out = await reg.resolve(slot, { signal: ABORT });
	assert.equal(out.length, 0);
});

test('registry: unknown provider id -> []', async () => {
	const reg = createProviderRegistry();
	const slot: ContextSlotRequest = {
		name: 's', fromOwner: 'provider:missing', namespace: '_',
		query: { kind: 'byKey', key: 'k' },
	};
	const out = await reg.resolve(slot, { signal: ABORT });
	assert.equal(out.length, 0);
});

test('registry: stamps source.kind=provider + providerId on every entry', async () => {
	const reg = createProviderRegistry();
	reg.register(fakeProvider('demo', [entry('a', 1), entry('b', 2)]));
	const slot: ContextSlotRequest = {
		name: 's', fromOwner: 'provider:demo', namespace: '_',
		query: { kind: 'byKey', key: 'k' },
	};
	const out = await reg.resolve(slot, { signal: ABORT });
	assert.equal(out.length, 2);
	for (const e of out) {
		assert.equal(e.source.kind, 'provider');
		if (e.source.kind === 'provider') {
			assert.equal(e.source.providerId, 'demo');
		}
	}
});

// ---------------------------------------------------------------------------
// Assembler routing
// ---------------------------------------------------------------------------

test('assembler: provider:* slot routes through the registry', async () => {
	const fx = memoryFx();
	try {
		const reg = createProviderRegistry();
		reg.register(fakeProvider('demo', [entry('hit', 42)]));

		const assembler = createContextAssembler({ memory: fx.memory, providers: reg });
		const req: AssembleRequest = {
			owner: 'skill:test', task: undefined, session: undefined, budget: {},
			slots: [{
				name:      'demoSlot',
				fromOwner: 'provider:demo',
				namespace: '_',
				query:     { kind: 'byKey', key: 'hit' },
			}],
		};
		const ctx = await assembler.assemble(req);
		const entries = ctx.slots.get('demoSlot') ?? [];
		assert.equal(entries.length, 1);
		assert.equal(entries[0]!.value, 42);
		assert.equal(entries[0]!.source.kind, 'provider');
	} finally { fx.dispose(); }
});

test('assembler without a registry: provider slots resolve empty', async () => {
	const fx = memoryFx();
	try {
		const assembler = createContextAssembler({ memory: fx.memory }); // no providers
		const req: AssembleRequest = {
			owner: 'skill:test', task: undefined, session: undefined, budget: {},
			slots: [{
				name:      'demoSlot',
				fromOwner: 'provider:demo',
				namespace: '_',
				query:     { kind: 'byKey', key: 'hit' },
			}],
		};
		const ctx = await assembler.assemble(req);
		const entries = ctx.slots.get('demoSlot') ?? [];
		assert.equal(entries.length, 0);
	} finally { fx.dispose(); }
});

test('assembler: memory and provider slots coexist in one request', async () => {
	const fx = memoryFx();
	try {
		// Pre-populate memory.
		await fx.memory.scope('skill:owner', 'cache').put(
			'memKey',
			{ payload: 'from-memory' },
			{ kind: 'fact', source: { kind: 'test' }, confidence: 0.9 },
		);

		const reg = createProviderRegistry();
		reg.register(fakeProvider('demo', [entry('hit', 'from-provider')]));

		const assembler = createContextAssembler({ memory: fx.memory, providers: reg });
		const req: AssembleRequest = {
			owner: 'skill:test', task: undefined, session: undefined, budget: {},
			slots: [
				{ name: 'mem',  fromOwner: 'skill:owner',  namespace: 'cache', query: { kind: 'byKey', key: 'memKey' } },
				{ name: 'prov', fromOwner: 'provider:demo', namespace: '_',     query: { kind: 'byKey', key: 'hit' } },
			],
		};
		const ctx = await assembler.assemble(req);
		assert.equal(ctx.slots.get('mem')!.length,  1);
		assert.equal(ctx.slots.get('prov')!.length, 1);
		const mem  = ctx.slots.get('mem')![0]!;
		const prov = ctx.slots.get('prov')![0]!;
		assert.deepEqual(mem.value,  { payload: 'from-memory' });
		assert.equal(prov.value, 'from-provider');
		// memory entry's source.kind is whatever it was written with.
		assert.equal(mem.source.kind,  'test');
		// provider entry's source.kind is stamped.
		assert.equal(prov.source.kind, 'provider');
	} finally { fx.dispose(); }
});

// ---------------------------------------------------------------------------
// Day-one providers
// ---------------------------------------------------------------------------

test('provider:active-session: byKey on a whitelisted field', async () => {
	const fx = memoryFx();
	try {
		const reg = createProviderRegistry();
		reg.register(createActiveSessionProvider());

		const assembler = createContextAssembler({ memory: fx.memory, providers: reg });
		const session = {
			id: 'sess-1', repoPath: '/repo/foo', closureRepos: ['/repo/foo', '/repo/dep'],
			turnIndex: 7, startedAt: 123, permissionMode: 'validate',
			// non-whitelisted (must NOT leak):
			cost: { input: 1, output: 2 },
		};

		const req: AssembleRequest = {
			owner: 'skill:test', task: undefined, session, budget: {},
			slots: [
				{ name: 'repo',  fromOwner: 'provider:active-session', namespace: '_', query: { kind: 'byKey', key: 'repoPath' } },
				{ name: 'cost',  fromOwner: 'provider:active-session', namespace: '_', query: { kind: 'byKey', key: 'cost' } },
			],
		};
		const ctx = await assembler.assemble(req, { session });
		const repo = ctx.slots.get('repo') ?? [];
		const cost = ctx.slots.get('cost') ?? [];
		assert.equal(repo.length, 1);
		assert.equal(repo[0]!.value, '/repo/foo');
		// Non-whitelisted field is filtered out -- privacy boundary.
		assert.equal(cost.length, 0);
	} finally { fx.dispose(); }
});

test('provider:active-session: prefix scan returns only whitelisted matches', async () => {
	const fx = memoryFx();
	try {
		const reg = createProviderRegistry();
		reg.register(createActiveSessionProvider());

		const assembler = createContextAssembler({ memory: fx.memory, providers: reg });
		const session = { id: 'sess', repoPath: '/r', closureRepos: ['/r'], startedAt: 1 };
		const req: AssembleRequest = {
			owner: 'skill:test', task: undefined, session, budget: {},
			slots: [{
				name: 'started',
				fromOwner: 'provider:active-session',
				namespace: '_',
				query: { kind: 'prefix', prefix: 'start' },
			}],
		};
		const ctx = await assembler.assemble(req, { session });
		const hits = ctx.slots.get('started') ?? [];
		assert.equal(hits.length, 1);
		assert.equal(hits[0]!.key, 'startedAt');
	} finally { fx.dispose(); }
});

test('provider:active-session: missing session in deps -> []', async () => {
	const fx = memoryFx();
	try {
		const reg = createProviderRegistry();
		reg.register(createActiveSessionProvider());

		const assembler = createContextAssembler({ memory: fx.memory, providers: reg });
		const req: AssembleRequest = {
			owner: 'skill:test', task: undefined, session: undefined, budget: {},
			slots: [{
				name: 'r',
				fromOwner: 'provider:active-session',
				namespace: '_',
				query: { kind: 'byKey', key: 'repoPath' },
			}],
		};
		// Deliberately omit session from AssembleDeps -- provider gets no
		// session and must degrade gracefully.
		const ctx = await assembler.assemble(req);
		assert.equal((ctx.slots.get('r') ?? []).length, 0);
	} finally { fx.dispose(); }
});

test('provider:user-config: byKey on a nested path', async () => {
	const fx = memoryFx();
	try {
		const reg = createProviderRegistry();
		reg.register(createUserConfigProvider());

		const assembler = createContextAssembler({ memory: fx.memory, providers: reg });
		const req: AssembleRequest = {
			owner: 'skill:test', task: undefined, session: undefined, budget: {},
			slots: [{
				name: 'dim',
				fromOwner: 'provider:user-config',
				namespace: '_',
				// This path exists on the default AgentConfig; we just want
				// to verify the provider can resolve a nested dot-path.
				query: { kind: 'byKey', key: 'models.providers.local.embeddingDim' },
			}],
		};
		const ctx = await assembler.assemble(req);
		const hits = ctx.slots.get('dim') ?? [];
		assert.equal(hits.length, 1);
		assert.equal(typeof hits[0]!.value, 'number');
		assert.equal(hits[0]!.source.kind, 'provider');
	} finally { fx.dispose(); }
});

test('provider:user-config: missing path -> []', async () => {
	const fx = memoryFx();
	try {
		const reg = createProviderRegistry();
		reg.register(createUserConfigProvider());

		const assembler = createContextAssembler({ memory: fx.memory, providers: reg });
		const req: AssembleRequest = {
			owner: 'skill:test', task: undefined, session: undefined, budget: {},
			slots: [{
				name: 'nope',
				fromOwner: 'provider:user-config',
				namespace: '_',
				query: { kind: 'byKey', key: 'this.path.does.not.exist' },
			}],
		};
		const ctx = await assembler.assemble(req);
		assert.equal((ctx.slots.get('nope') ?? []).length, 0);
	} finally { fx.dispose(); }
});
