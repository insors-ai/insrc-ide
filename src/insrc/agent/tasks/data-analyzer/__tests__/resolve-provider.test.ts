/**
 * Tests for `resolve-provider.ts`.
 *
 * Pins the cloud-by-default routing decision + the shared
 * `analyzer.useLocal` config opt-out (replacing the legacy
 * INSRC_DATA_ANALYZER_USE_LOCAL env var).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	resolveDataAnalyzerProvider,
	isAnalyzerLocalOptIn,
	isDataAnalyzerLocalOptIn,
} from '../resolve-provider.js';
import type { Session } from '../../../session.js';
import type { AgentConfig, LLMProvider } from '../../../../shared/types.js';

function fakeSession(opts: {
	local:    LLMProvider;
	cloud:    LLMProvider | null;
	useLocal?: boolean;
}): Session {
	const config = {
		analyzer: opts.useLocal !== undefined ? { useLocal: opts.useLocal } : undefined,
	} as unknown as AgentConfig;
	return {
		ollamaProvider: opts.local,
		claudeProvider: opts.cloud,
		config,
	} as unknown as Session;
}

const localProvider: LLMProvider = { name: () => 'local' } as unknown as LLMProvider;
const cloudProvider: LLMProvider = { name: () => 'cloud' } as unknown as LLMProvider;

test('resolveDataAnalyzerProvider: defaults to cloud when configured', () => {
	const s = fakeSession({ local: localProvider, cloud: cloudProvider });
	const p = resolveDataAnalyzerProvider(s, 'summarize-result');
	assert.equal(p, cloudProvider);
});

test('resolveDataAnalyzerProvider: falls back to local when cloud is unconfigured', () => {
	const s = fakeSession({ local: localProvider, cloud: null });
	const p = resolveDataAnalyzerProvider(s, 'summarize-result');
	assert.equal(p, localProvider);
});

test('resolveDataAnalyzerProvider: analyzer.useLocal: true opts into local even when cloud is available', () => {
	const s = fakeSession({ local: localProvider, cloud: cloudProvider, useLocal: true });
	const p = resolveDataAnalyzerProvider(s, 'summarize-result');
	assert.equal(p, localProvider);
});

test('resolveDataAnalyzerProvider: analyzer.useLocal: false stays on cloud', () => {
	const s = fakeSession({ local: localProvider, cloud: cloudProvider, useLocal: false });
	const p = resolveDataAnalyzerProvider(s, 'summarize-result');
	assert.equal(p, cloudProvider);
});

test('resolveDataAnalyzerProvider: missing analyzer config defaults to cloud', () => {
	// fakeSession without useLocal -> analyzer field is undefined entirely
	const s = fakeSession({ local: localProvider, cloud: cloudProvider });
	assert.equal(resolveDataAnalyzerProvider(s, 'summarize-result'), cloudProvider);
});

test('resolveDataAnalyzerProvider: step label does not affect today\'s routing', () => {
	const s = fakeSession({ local: localProvider, cloud: cloudProvider });
	const steps = ['plan', 'analyzer', 'review', 'synthesise', 'meta', 'summarize-result', 'cycle-review', 'writer', 'claim-grounding'] as const;
	for (const step of steps) {
		assert.equal(resolveDataAnalyzerProvider(s, step), cloudProvider);
	}
});

test('isAnalyzerLocalOptIn: reports config state', () => {
	assert.equal(isAnalyzerLocalOptIn(fakeSession({ local: localProvider, cloud: cloudProvider                       })), false);
	assert.equal(isAnalyzerLocalOptIn(fakeSession({ local: localProvider, cloud: cloudProvider, useLocal: true       })), true);
	assert.equal(isAnalyzerLocalOptIn(fakeSession({ local: localProvider, cloud: cloudProvider, useLocal: false      })), false);
});

test('isDataAnalyzerLocalOptIn: back-compat alias delegates to isAnalyzerLocalOptIn', () => {
	const s = fakeSession({ local: localProvider, cloud: cloudProvider, useLocal: true });
	assert.equal(isDataAnalyzerLocalOptIn(s), true);
});
