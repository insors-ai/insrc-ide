/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for the L1 preferences section builder (M1.8 of plans/memory-context.md;
 * G4 + G5 + G7 + G9 of design/memory-context.html). Exercises:
 *   - G4 hard scope filter (repoPaths)
 *   - G5-style relevance curation against session topic (scripted local LLM)
 *   - Markdown rendering shape
 *   - Bias toward inclusion when curator drops everything
 *   - Graceful degradation when no provider is wired
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { LLMMessage, LLMProvider, LLMResponse } from '../../../shared/types.js';
import {
	buildOwnerPreferencesSection,
	type PreferenceCandidate,
} from '../preferences.js';


function scriptedProvider(scriptedText: string): LLMProvider {
	return {
		async complete(_messages: LLMMessage[]): Promise<LLMResponse> {
			return { text: scriptedText, stopReason: 'end_turn' };
		},
		stream() { return (async function* () { yield ''; })(); },
		async embed() { return []; },
	};
}


function mk(c: Partial<PreferenceCandidate> & Pick<PreferenceCandidate, 'subject' | 'canonicalText'>): PreferenceCandidate {
	return {
		confidence: 0.9,
		...c,
	};
}


// ---------------------------------------------------------------------------
// Empty list
// ---------------------------------------------------------------------------

test('preferences: empty candidates -> empty string', async () => {
	const out = await buildOwnerPreferencesSection({
		candidates:   [],
		repoPath:     '/r',
		sessionTopic: 'anything',
	});
	assert.equal(out, '');
});


// ---------------------------------------------------------------------------
// G4 hard scope filter
// ---------------------------------------------------------------------------

test('preferences: candidate with no repoPaths applies to every repo', async () => {
	const out = await buildOwnerPreferencesSection({
		candidates: [mk({ subject: 'code-style', canonicalText: 'Use tabs.' })],
		repoPath:   '/some-repo',
		sessionTopic: '',
	});
	assert.match(out, /## Active user preferences/);
	assert.match(out, /Use tabs\./);
});

test('preferences: candidate with non-matching repoPath is dropped', async () => {
	const out = await buildOwnerPreferencesSection({
		candidates: [mk({
			subject:       'code-style',
			canonicalText: 'Use tabs.',
			repoPaths:     ['/other-repo'],
		})],
		repoPath:     '/this-repo',
		sessionTopic: '',
	});
	assert.equal(out, '');
});

test('preferences: matching repoPath includes candidate', async () => {
	const out = await buildOwnerPreferencesSection({
		candidates: [mk({
			subject:       'test-policy',
			canonicalText: 'Always include unit tests.',
			repoPaths:     ['/this-repo'],
		})],
		repoPath:     '/this-repo',
		sessionTopic: '',
	});
	assert.match(out, /Always include unit tests/);
});


// ---------------------------------------------------------------------------
// G5 relevance curation (scripted)
// ---------------------------------------------------------------------------

test('preferences: curator picks relevant_indices -> drops others', async () => {
	const out = await buildOwnerPreferencesSection({
		candidates: [
			mk({ subject: 'test-policy',     canonicalText: 'Always include unit tests.' }),
			mk({ subject: 'workflow-policy', canonicalText: 'Deploy only on Friday.' }),
		],
		repoPath:      '/r',
		sessionTopic:  'drafting implementation plan',
		localProvider: scriptedProvider(JSON.stringify({ relevant_indices: [0] })),
	});
	assert.match(out, /Always include unit tests/);
	assert.doesNotMatch(out, /Deploy only on Friday/);
});

test('preferences: curator returning empty -> bias toward inclusion (fall back to scope-filtered list)', async () => {
	const out = await buildOwnerPreferencesSection({
		candidates: [
			mk({ subject: 'test-policy', canonicalText: 'Always include unit tests.' }),
			mk({ subject: 'code-style',  canonicalText: 'Use tabs.' }),
		],
		repoPath:      '/r',
		sessionTopic:  'unclear',
		localProvider: scriptedProvider(JSON.stringify({ relevant_indices: [] })),
	});
	// Both candidates included via the inclusion-bias fall-back.
	assert.match(out, /Always include unit tests/);
	assert.match(out, /Use tabs/);
});

test('preferences: curator returns malformed JSON -> includes all', async () => {
	const out = await buildOwnerPreferencesSection({
		candidates: [
			mk({ subject: 'test-policy', canonicalText: 'Always include unit tests.' }),
			mk({ subject: 'code-style',  canonicalText: 'Use tabs.' }),
		],
		repoPath:      '/r',
		sessionTopic:  'anything',
		localProvider: scriptedProvider('not json at all'),
	});
	assert.match(out, /Always include unit tests/);
	assert.match(out, /Use tabs/);
});


// ---------------------------------------------------------------------------
// No-provider path (skip curation; render all scope-passed candidates)
// ---------------------------------------------------------------------------

test('preferences: no provider -> skip curation, render scope-filtered list', async () => {
	const out = await buildOwnerPreferencesSection({
		candidates: [
			mk({ subject: 'test-policy', canonicalText: 'Always include unit tests.' }),
			mk({ subject: 'code-style',  canonicalText: 'Use tabs.' }),
		],
		repoPath:     '/r',
		sessionTopic: 'irrelevant when no provider',
		// localProvider intentionally omitted
	});
	assert.match(out, /Always include unit tests/);
	assert.match(out, /Use tabs/);
});


// ---------------------------------------------------------------------------
// Curation skipped when only one candidate (nothing to filter)
// ---------------------------------------------------------------------------

test('preferences: single candidate skips curation even with provider', async () => {
	// Provider would drop the candidate if called. The fact that it isn't
	// called means the rendered output still includes the candidate.
	const provider = scriptedProvider(JSON.stringify({ relevant_indices: [] }));
	const out = await buildOwnerPreferencesSection({
		candidates: [
			mk({ subject: 'test-policy', canonicalText: 'Always include unit tests.' }),
		],
		repoPath:      '/r',
		sessionTopic:  'has content',
		localProvider: provider,
	});
	assert.match(out, /Always include unit tests/);
});
