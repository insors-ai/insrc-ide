/**
 * Tests for `resolve-provider.ts` (DA-E1 of
 * plans/analyzers/data-analyzer-parity.md).
 *
 * Pins the cloud-by-default routing decision + env-flag opt-out.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	resolveDataAnalyzerProvider,
	isDataAnalyzerLocalOptIn,
} from '../resolve-provider.js';
import type { Session } from '../../../session.js';
import type { LLMProvider } from '../../../../shared/types.js';

function fakeSession(opts: { local: LLMProvider; cloud: LLMProvider | null }): Session {
	return {
		ollamaProvider: opts.local,
		claudeProvider: opts.cloud,
	} as unknown as Session;
}

const localProvider: LLMProvider = { name: () => 'local' } as unknown as LLMProvider;
const cloudProvider: LLMProvider = { name: () => 'cloud' } as unknown as LLMProvider;

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
	const prior = process.env[key];
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
	try {
		return fn();
	} finally {
		if (prior === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = prior;
		}
	}
}

test('resolveDataAnalyzerProvider: defaults to cloud when configured', () => {
	withEnv('INSRC_DATA_ANALYZER_USE_LOCAL', undefined, () => {
		const s = fakeSession({ local: localProvider, cloud: cloudProvider });
		const p = resolveDataAnalyzerProvider(s, 'summarize-result');
		assert.equal(p, cloudProvider);
	});
});

test('resolveDataAnalyzerProvider: falls back to local when cloud is unconfigured', () => {
	withEnv('INSRC_DATA_ANALYZER_USE_LOCAL', undefined, () => {
		const s = fakeSession({ local: localProvider, cloud: null });
		const p = resolveDataAnalyzerProvider(s, 'summarize-result');
		assert.equal(p, localProvider);
	});
});

test('resolveDataAnalyzerProvider: INSRC_DATA_ANALYZER_USE_LOCAL=1 opts into local even when cloud is available', () => {
	withEnv('INSRC_DATA_ANALYZER_USE_LOCAL', '1', () => {
		const s = fakeSession({ local: localProvider, cloud: cloudProvider });
		const p = resolveDataAnalyzerProvider(s, 'summarize-result');
		assert.equal(p, localProvider);
	});
});

test('resolveDataAnalyzerProvider: opt-out only fires on exact "1" (not "true", not "yes")', () => {
	const s = fakeSession({ local: localProvider, cloud: cloudProvider });
	withEnv('INSRC_DATA_ANALYZER_USE_LOCAL', 'true', () => {
		assert.equal(resolveDataAnalyzerProvider(s, 'summarize-result'), cloudProvider);
	});
	withEnv('INSRC_DATA_ANALYZER_USE_LOCAL', 'yes', () => {
		assert.equal(resolveDataAnalyzerProvider(s, 'summarize-result'), cloudProvider);
	});
	withEnv('INSRC_DATA_ANALYZER_USE_LOCAL', '0', () => {
		assert.equal(resolveDataAnalyzerProvider(s, 'summarize-result'), cloudProvider);
	});
});

test('resolveDataAnalyzerProvider: step label does not affect today\'s routing', () => {
	withEnv('INSRC_DATA_ANALYZER_USE_LOCAL', undefined, () => {
		const s = fakeSession({ local: localProvider, cloud: cloudProvider });
		const steps = ['plan', 'analyzer', 'review', 'synthesise', 'meta', 'summarize-result', 'cycle-review', 'writer', 'claim-grounding'] as const;
		for (const step of steps) {
			assert.equal(resolveDataAnalyzerProvider(s, step), cloudProvider);
		}
	});
});

test('isDataAnalyzerLocalOptIn: reports env-flag state', () => {
	withEnv('INSRC_DATA_ANALYZER_USE_LOCAL', undefined, () => {
		assert.equal(isDataAnalyzerLocalOptIn(), false);
	});
	withEnv('INSRC_DATA_ANALYZER_USE_LOCAL', '1', () => {
		assert.equal(isDataAnalyzerLocalOptIn(), true);
	});
	withEnv('INSRC_DATA_ANALYZER_USE_LOCAL', '0', () => {
		assert.equal(isDataAnalyzerLocalOptIn(), false);
	});
});
