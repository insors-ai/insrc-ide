/**
 * Real-Ollama integration test for the shape-resolver writer (Phase 0
 * sample / template). Demonstrates the structural-assertion pattern
 * the rest of the redesign's integration tests follow.
 *
 * Gated on `INSRC_TEST_OLLAMA=1`. Skips cleanly when the env var is
 * unset or Ollama isn't reachable. Run via:
 *
 *   INSRC_TEST_OLLAMA=1 npx tsx --test \
 *     src/insrc/agent/prompts/__tests__/shape-resolver.ollama.test.ts
 *
 * Or via the package script: `npm run test:ollama`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	_resetPromptRegistryForTest,
	registerAllPromptWriters,
	getPromptRegistry,
} from '../index.js';
import {
	ollamaTest,
	buildOllamaTestProvider,
} from './ollama-harness.js';
import type { LLMMessage } from '../../../shared/types.js';
import type { ShapeResolverWriterInput } from '../writers/shape-resolver.js';

test.beforeEach(() => {
	_resetPromptRegistryForTest();
	registerAllPromptWriters();
});

// Sample integration test: shape-resolver against a real qwen3.6
// instance. Asserts STRUCTURAL properties only -- the model's exact
// phrasing of args may vary across runs, but the constraint "the
// entityId argument matches the real hex from prior outputs" is
// stable.
ollamaTest(test, 'shape-resolver: real qwen3.6 picks the entityId from prior outputs (not fabricated)', async () => {
	const writer = getPromptRegistry().get<ShapeResolverWriterInput, readonly LLMMessage[]>('shape-resolver');
	const messages = [...writer.build({
		skillId:          'code.entity.summary',
		skillDescription: 'Summarise a code entity by 32-char hex entityId.',
		objective:        'Summarise the INGRN class to understand its declared fields.',
		userQuestion:     'Map the GRN JSON files to the INGRN Pydantic class.',
		priorOutputs: {
			'locate': JSON.stringify({
				entityId:  'b2097ef0ba38110e005d437d6b0c8442',
				filePath:  '/repo/insors/core/model/invoice/regions/IN/grn.py',
				kind:      'class',
				name:      'INGRN',
				lineStart: 40,
				lineEnd:   207,
			}),
		},
		contextBag: {},
	})];

	const provider = buildOllamaTestProvider();
	const response = await provider.complete(messages, {
		maxTokens:       1024,
		temperature:     0,
		disableThinking: true,
		tools: [{
			name:        'submit_skill_args',
			description: 'Submit the args dict for invoking code.entity.summary.',
			inputSchema: {
				type:                 'object',
				required:             ['entityId'],
				additionalProperties: false,
				properties: {
					entityId: { type: 'string', minLength: 32, maxLength: 32 },
					scope:    { type: 'string', enum: ['closure', 'file'] },
				},
			},
		}],
		toolChoice: { name: 'submit_skill_args' },
	});

	const tc = response.toolCalls?.[0];
	assert.ok(tc !== undefined, 'expected one submit_skill_args tool_call');
	assert.equal(tc.name, 'submit_skill_args');
	const args = tc.input as Record<string, unknown>;
	assert.equal(
		args['entityId'],
		'b2097ef0ba38110e005d437d6b0c8442',
		'shape-resolver must emit the real hex entityId from prior outputs, not invent one',
	);
});
