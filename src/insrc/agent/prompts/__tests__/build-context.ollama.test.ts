/**
 * Real-Ollama integration test for the build-context writer + caller
 * (Phase 3 of plans/section-flow-architecture-redesign.md).
 *
 * Scripted unit tests assert the validation flow; this test closes the
 * loop: a real qwen3.6 instance reads a representative prompt against
 * a small TOC + step + skill schema, and the validator must agree with
 * what the model picked. Catches:
 *
 *   - The model emitting prose instead of JSON.
 *   - The model inventing artifact ids that aren't in the TOC.
 *   - The model fetching everything when it should fetch one thing.
 *   - The model fetching nothing when the schema clearly wants a
 *     value the TOC contains.
 *
 * Gated on `INSRC_TEST_OLLAMA=1` + an Ollama daemon serving
 * `qwen3.6:35b-a3b`. Skips cleanly otherwise.
 *
 *   INSRC_TEST_OLLAMA=1 npx tsx --test \
 *     src/insrc/agent/prompts/__tests__/build-context.ollama.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	_resetPromptRegistryForTest,
	registerAllPromptWriters,
} from '../index.js';
import {
	ollamaTest,
	buildOllamaTestProvider,
} from './ollama-harness.js';
import { runBuildContext } from '../../section-flow/step-build-context.js';

test.beforeEach(() => {
	_resetPromptRegistryForTest();
	registerAllPromptWriters();
});

// ---------------------------------------------------------------------------
// Fixture: a small TOC carrying the locate artifact PLUS two distractors
// (a fs.list-files and a fs.peek). The step asks for INGRN's fields, so
// the right call is `fetch: [<locate id>]` -- the entityId required by
// extract-fields is in the locate artifact and nowhere else.
// ---------------------------------------------------------------------------

const LOCATE_ID    = 'sess-1:1700000000100:code.entity.locate-by-name';
const LIST_FILES_ID = 'sess-1:1700000000200:shared.fs.list-files';
const PEEK_ID      = 'sess-1:1700000000300:shared.fs.peek';

const TOC = [
	'## TABLE OF CONTENTS (artifacts available; call shared.memory.get-artifact({id}) to fetch)',
	'',
	`${LOCATE_ID}: located INGRN at insors/grn.py:40, entityId b2097ef0ba38110e005d437d6b0c8442. CLOSES ingrn-locate fully`,
	`${LIST_FILES_ID}: 25 GRN JSON paths under test/integration/data/BB/GRN. CLOSES enumerate-grn-fixtures fully`,
	`${PEEK_ID}: first 50 lines of test/integration/data/BB/GRN/176055.json showing the top-level JSON shape. PARTIALLY supports json-shape`,
].join('\n');

const TOC_IDS = new Set([LOCATE_ID, LIST_FILES_ID, PEEK_ID]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

ollamaTest(test, 'build-context: real qwen3.6 picks the locate artifact for an extract-fields step', async () => {
	const provider = buildOllamaTestProvider();
	const r = await runBuildContext({
		stepIntent:       'Extract the declared fields of the INGRN Pydantic class by entityId.',
		skillId:          'code.class.extract-fields',
		skillDescription: 'Extract declared fields of a class entity given its 32-char hex entityId.',
		skillSchema: JSON.stringify({
			type:       'object',
			required:   ['entityId'],
			properties: {
				entityId: { type: 'string', minLength: 32, maxLength: 32 },
				scope:    { type: 'string', enum: ['closure', 'file'] },
			},
		}),
		todoObjective: 'Map the GRN JSON files to the INGRN Pydantic class.',
		toc:           TOC,
		tocIds:        TOC_IDS,
		provider,
	});

	// Structural: response must validate (no graceful degrade).
	assert.equal(r.gracefulDegrade, false, `unexpected graceful degrade; notes=${r.notes}`);

	// Selectivity: the model should pick the LOCATE artifact at minimum;
	// fetching everything is failure (the writer prompt teaches "two or
	// three is usually enough; eight is almost always wrong").
	assert.ok(
		r.fetchIds.includes(LOCATE_ID),
		`expected build-context to include the locate artifact (entityId source); got fetchIds=${JSON.stringify(r.fetchIds)} notes="${r.notes}"`,
	);
	assert.ok(
		r.fetchIds.length <= 3,
		`expected <=3 fetches; got ${r.fetchIds.length}: ${JSON.stringify(r.fetchIds)}`,
	);
});

ollamaTest(test, 'build-context: emits fetch:[] when no artifact carries what the step needs', async () => {
	const provider = buildOllamaTestProvider();
	// Empty TOC -> the model has nothing to fetch, MUST emit fetch:[].
	const r = await runBuildContext({
		stepIntent:       'Grep the repo for occurrences of the class name "INGRN".',
		skillId:          'code.source.grep',
		skillDescription: 'Grep the active repository for a literal string.',
		skillSchema: JSON.stringify({
			type:       'object',
			required:   ['query'],
			properties: { query: { type: 'string', minLength: 1 } },
		}),
		todoObjective: 'Map the GRN JSON files to the INGRN Pydantic class.',
		toc: '## TABLE OF CONTENTS (artifacts available; call shared.memory.get-artifact({id}) to fetch)\n(no artifacts persisted yet)',
		tocIds: new Set<string>(),
		provider,
	});

	assert.equal(r.gracefulDegrade, false, `unexpected graceful degrade; notes=${r.notes}`);
	assert.deepEqual(
		r.fetchIds, [],
		`expected fetch:[] for an empty TOC; got ${JSON.stringify(r.fetchIds)} notes="${r.notes}"`,
	);
});
