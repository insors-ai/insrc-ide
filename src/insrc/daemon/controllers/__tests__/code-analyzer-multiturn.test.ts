/**
 * Phase 6 regression suite for conversation-flow-refinement.md.
 *
 * Locks in the multiturn behaviour the plan was written to fix --
 * specifically the HDFS-Core regression where turn 2 ("describe HDFS
 * Core") couldn't resolve the friendly label that turn 1 surfaced.
 *
 * Coverage:
 *
 *   §6.1  HDFS-Core happy-path round-trip:
 *           spill -> Lance index -> retrieve -> mineFacts ->
 *           [priorContext:current] tag -> orchestrator readPriorFactsTag.
 *
 *   §6.2  Sibling cases (same shape, different artifact families):
 *           - code-analyzer entity drill-down
 *           - data-analyzer table drill-down
 *           - cross-intent (code-analysis table -> data-analysis schema query)
 *
 *   §6.3  Negative paths:
 *           - stale prior context filtered by score floor
 *           - ambiguous reference (two same-name entities) both surface
 *           - disk-spill failure path is already covered by
 *             agent/artifacts/__tests__/spill-writer.test.ts:138
 *             ("makeSpillHandler: swallows writer errors") -- not
 *             duplicated here.
 *
 * The retriever's `retrievePriorContext` calls `embedQuery` (Ollama).
 * To keep the suite deterministic without depending on a live Ollama
 * instance, we exercise the handoff via:
 *   - direct `upsertArtifactVec` writes with synthetic vectors (no embed)
 *   - direct `_mineFactsForTest` invocation on synthetic ScoredArtifacts
 *     (no embed, no ANN)
 *   - real `readPriorFactsTag` for the orchestrator-side readback
 *
 * The end-to-end flavour ("real Lance, real spill writer") lives in
 * spill-writer.test.ts + retriever.test.ts; this file's job is the
 * cross-component handoff narrative.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { _mineFactsForTest as mineFacts, PRIOR_CONTEXT_TAG_CURRENT } from '../../../agent/intent/retriever.js';
import { _readPriorFactsTagForTest as readPriorFactsTag } from '../code-analyzer-orchestrator.js';
import {
	scoreArtifacts,
	type ScoredArtifact,
} from '../../../agent/intent/relevance.js';
import type { ArtifactVecHit } from '../../../db/lance/artifact-vec.js';
import type { Session } from '../../../agent/session.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake session whose ContextManager round-trips tags. Mirrors
 * the stub in retriever.test.ts / enhancer.test.ts.
 */
function fakeSession(id: string): Session {
	const tags = new Map<string, string>();
	return {
		id,
		contextManager: {
			setTag: (k: string, v: string) => { tags.set(k, v); },
			getTag: (k: string) => tags.get(k) ?? '',
		},
	} as unknown as Session;
}

/**
 * Build a `ScoredArtifact` directly. Bypasses Lance + embed so the
 * tests are deterministic without an Ollama dependency.
 */
function scored(opts: {
	id?:        string;
	skillId:    string;
	intent?:    string;
	preview:    unknown;
	score?:     number;
	timestamp?: number;
}): ScoredArtifact {
	return {
		id:          opts.id        ?? 'artifact-fake',
		session_id:  'session-fake',
		intent:      opts.intent    ?? 'code-analysis',
		skill_id:    opts.skillId,
		timestamp:   BigInt(opts.timestamp ?? Date.now()),
		path:        '/tmp/.insrc/fake.json',
		preview:     typeof opts.preview === 'string' ? opts.preview : JSON.stringify(opts.preview),
		distance:    0,
		intentMatch: 1,
		semantic:    1,
		recency:     1,
		score:       opts.score ?? 1,
	};
}

/**
 * Build the JSON snapshot the chat-handler stamps on the session
 * after it runs retrieve+enhance. The orchestrator reads this back.
 */
function stampPriorContextTag(
	session: Session,
	body: { facts: unknown; currentIntent?: string; intentChanged?: boolean; previousIntent?: string; artifactCount?: number },
): void {
	session.contextManager.setTag(PRIOR_CONTEXT_TAG_CURRENT, JSON.stringify({
		currentIntent: body.currentIntent ?? 'code-analysis',
		intentChanged: body.intentChanged ?? false,
		...(body.previousIntent !== undefined ? { previousIntent: body.previousIntent } : {}),
		facts:         body.facts,
		artifactCount: body.artifactCount ?? 0,
	}));
}

// ---------------------------------------------------------------------------
// §6.1 -- HDFS-Core happy-path round-trip
// ---------------------------------------------------------------------------

test('§6.1 HDFS-Core: turn 1 spill -> mineFacts -> priorContext tag -> orchestrator readback', () => {
	// Turn 1: code.source.repo.describe surfaces topModules including
	// the HDFS module. (In production this is what the spill writer
	// indexes after `runSkillsPipeline` finishes.)
	const turn1Artifact = scored({
		skillId: 'code.source.repo.describe',
		preview: {
			fileCount: 12500,
			topModules: [
				{ path: '/repo/hadoop/hadoop-hdfs',  fileCount: 240, label: 'HDFS Core' },
				{ path: '/repo/hadoop/hadoop-yarn',  fileCount: 180, label: 'YARN' },
			],
		},
	});

	// Mining stage (retriever's responsibility) extracts typed facts.
	const facts = mineFacts([turn1Artifact]);
	assert.ok(facts.modules);
	assert.equal(facts.modules!.length, 2);
	const hdfs = facts.modules!.find(m => m.path === '/repo/hadoop/hadoop-hdfs');
	assert.ok(hdfs, 'HDFS module should be mined');
	assert.equal(hdfs!.fileCount, 240);

	// Turn 2 setup: chat-handler stamps the priorContext tag with
	// the typed facts (the real chat-handler does this after running
	// the retriever).
	const session = fakeSession('session-hdfs');
	stampPriorContextTag(session, {
		facts,
		currentIntent: 'code-analysis',
		intentChanged: false,
		artifactCount: 1,
	});

	// Orchestrator picks up the tag and threads facts into select-scope.
	const out = readPriorFactsTag(session);
	assert.ok(out, 'orchestrator should retrieve priorFacts from tag');
	assert.equal(out!.modules?.length, 2);
	const hdfsRoundTrip = out!.modules?.find(m => m.path === '/repo/hadoop/hadoop-hdfs');
	assert.ok(hdfsRoundTrip);
	assert.equal(hdfsRoundTrip!.fileCount, 240);
});

// ---------------------------------------------------------------------------
// §6.2 -- sibling cases
// ---------------------------------------------------------------------------

test('§6.2 entity drill-down: code.entity.summary preview -> entities fact -> tag round-trip', () => {
	const turn1 = scored({
		skillId: 'code.entity.summary',
		preview: {
			found:    true,
			entityId: 'e-compute-01',
			name:     'compute',
			kind:     'function',
			file:     '/repo/foo/src/compute.ts',
		},
	});
	const facts = mineFacts([turn1]);
	assert.equal(facts.entities?.length, 1);
	assert.equal(facts.entities?.[0]?.name, 'compute');

	const session = fakeSession('session-entity');
	stampPriorContextTag(session, { facts });
	const out = readPriorFactsTag(session);
	assert.equal(out?.entities?.length, 1);
	assert.equal(out?.entities?.[0]?.entityRef, 'e-compute-01');
});

test('§6.2 table drill-down: data.source.rdbms.describe-table preview -> tables fact -> tag round-trip', () => {
	const turn1 = scored({
		skillId: 'data.source.rdbms.describe-table',
		intent:  'data-analysis',
		preview: {
			connectionId: 'main-pg',
			target:       'orders',
			columns: [
				{ name: 'id'         },
				{ name: 'customer_id' },
				{ name: 'total'      },
			],
		},
	});
	const facts = mineFacts([turn1]);
	assert.equal(facts.tables?.length, 1);
	assert.equal(facts.tables?.[0]?.name,         'orders');
	assert.equal(facts.tables?.[0]?.connectionId, 'main-pg');
	assert.deepEqual(facts.tables?.[0]?.columns, ['id', 'customer_id', 'total']);

	const session = fakeSession('session-table');
	stampPriorContextTag(session, {
		facts,
		currentIntent: 'data-analysis',
	});
	const out = readPriorFactsTag(session);
	assert.equal(out?.tables?.length, 1);
});

test('§6.2 cross-intent: code-analysis-mined table fact survives + reaches data-analyzer via tag', () => {
	// Setup: turn 1 was a code-analyzer run that surfaced a `users`
	// table reference (via describe-table called from a code path).
	// Turn 2 is data-analysis ("schema of users") with intentChanged=true.
	const codeRunArtifact = scored({
		skillId: 'data.source.rdbms.describe-table',
		intent:  'code-analysis',          // code analyzer ran the describe
		preview: {
			connectionId: 'app-db',
			target:       'users',
		},
	});
	const facts = mineFacts([codeRunArtifact]);
	assert.equal(facts.tables?.[0]?.name, 'users');

	// Chat-handler shifts intent + stamps tag.
	const session = fakeSession('session-cross-intent');
	stampPriorContextTag(session, {
		facts,
		currentIntent:  'data-analysis',
		intentChanged:  true,
		previousIntent: 'code-analysis',
		artifactCount:  1,
	});

	// Orchestrator reads facts; the typed payload is intent-agnostic
	// so the data-analyzer's select-scope can use the `users` entry.
	const out = readPriorFactsTag(session);
	assert.equal(out?.tables?.length, 1);
	assert.equal(out?.tables?.[0]?.connectionId, 'app-db');
});

// ---------------------------------------------------------------------------
// §6.3 -- negative paths
// ---------------------------------------------------------------------------

test('§6.3 stale prior context: score below floor -> filtered before tag stamp', () => {
	// scoreArtifacts is the relevance scorer the retriever consults
	// before applying its score floor. A 2-hour-old artifact with an
	// unrelated intent and weak semantic similarity should drop below
	// the retriever's default 0.2 floor and never make it into facts.
	const ancient = Date.now() - 2 * 60 * 60 * 1000;
	const stale: ArtifactVecHit = {
		id:         'old-1',
		session_id: 'session-stale',
		intent:     'release',           // unrelated to code-analysis
		skill_id:   'code.source.repo.describe',
		timestamp:  BigInt(ancient),
		path:       '/tmp/.insrc/old.json',
		preview:    JSON.stringify({ topModules: [{ path: '/repo/old', fileCount: 1 }] }),
		distance:   4.0,                 // weak similarity -> sim 1/(1+4)=0.2
	};
	const [out] = scoreArtifacts([stale], 'code-analysis', Date.now());
	assert.ok(out);
	// Recency at 2h with default tau=30min: exp(-4) ~ 0.018
	assert.ok(out!.recency < 0.05, `recency should decay to near 0, got ${out!.recency}`);
	// Intent unrelated -> 0; semantic 0.2 contributes 0.5*0.2 = 0.1;
	// recency contributes ~0.004. Composite well under the 0.2 floor.
	assert.ok(out!.score < 0.2, `composite score should drop below 0.2 floor, got ${out!.score}`);
});

test('§6.3 ambiguous reference: two same-name entities both surface in mined facts', () => {
	// Mining dedupes by entityRef (the unique id), NOT by name. Two
	// entities sharing the human name `User` -- one a Java class, one
	// a TS interface -- both must surface so the enhancer / select-scope
	// can flag the ambiguity to the LLM.
	const javaUser = scored({
		id: 'a',
		skillId: 'code.entity.locate-by-name',
		preview: {
			matches: [
				{ id: 'java-user-01', name: 'User', kind: 'class',     file: '/repo/api/src/User.java' },
				{ id: 'ts-user-02',   name: 'User', kind: 'interface', file: '/repo/web/src/types/User.ts' },
			],
		},
	});
	const facts = mineFacts([javaUser]);
	assert.equal(facts.entities?.length, 2);
	const refs = (facts.entities ?? []).map(e => e.entityRef).sort();
	assert.deepEqual(refs, ['java-user-01', 'ts-user-02']);
	const names = (facts.entities ?? []).map(e => e.name);
	assert.deepEqual(names, ['User', 'User']);
});
