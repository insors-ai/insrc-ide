/**
 * Tests for discovery-pipeline.ts (Phase F of
 * plans/analyzers/data-analyzer-parity.md).
 *
 * The pipeline composes Phase A summarizer + Phase C.2 discovery-flow +
 * Phase E writer/grounding into a DataAnalyzerResult-shaped output.
 * Most pipeline behaviour is exercised by the unit tests on each
 * composed piece; these tests pin the ADAPTER logic that converts
 * discovery output -> DataAnalyzerResult fields:
 *
 *   - isDataDiscoveryFlowEnabled: env-flag toggle
 *   - synthesiseFindings: per-evidence finding, downgrade on grounding,
 *     citation-invariant (skip evidence with empty citations),
 *     empty-evidence placeholder
 *   - aggregateConfidence: low-wins clamp; redraft caps at medium
 *   - flattenEvidenceCitations: dedup across evidence entries
 *   - synthesiseToolCalls: flatten + count
 *   - familyToConcern: skill family -> concern mapping
 *   - combineSeverity: confidence + grounding -> severity
 *   - citationKey: per-kind uniqueness key
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	isDataDiscoveryFlowEnabled,
	synthesiseFindings,
	aggregateConfidence,
	flattenEvidenceCitations,
	synthesiseToolCalls,
	_familyToConcernForTest    as familyToConcern,
	_combineSeverityForTest    as combineSeverity,
	_citationKeyForTest        as citationKey,
} from '../discovery-pipeline.js';
import type { DataEvidenceEntry, DataCitation, ConnectionSummary } from '../types.js';
import type { DataClaimGroundingResponse } from '../claim-grounding-reviewer.js';
import type { ExecuteDataStepOutput } from '../execute-step.js';
import type { DataDiscoveryFlowResult } from '../discovery-flow.js';

void {} as ConnectionSummary | undefined;  // silence unused import in pure-helper tests

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
	const prior = process.env[key];
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
	try {
		return fn();
	} finally {
		if (prior === undefined) delete process.env[key];
		else process.env[key] = prior;
	}
}

function entry(
	citations: DataCitation[],
	confidence: 'high' | 'medium' | 'low',
	facts: string[] = ['some fact'],
	skillId = 'data.source.rdbms.describe-table',
): DataEvidenceEntry {
	return { skillId, args: {}, facts, citations, confidence };
}

function grounding(verdict: 'accept' | 'redraft'): DataClaimGroundingResponse {
	return { claims: [], verdict, notes: [] };
}

// ---------------------------------------------------------------------------
// isDataDiscoveryFlowEnabled
// ---------------------------------------------------------------------------

test('isDataDiscoveryFlowEnabled: false when flag unset', () => {
	withEnv('INSRC_DATA_ANALYZER_FLOW', undefined, () => {
		assert.equal(isDataDiscoveryFlowEnabled(), false);
	});
});

test('isDataDiscoveryFlowEnabled: true when flag = "discovery"', () => {
	withEnv('INSRC_DATA_ANALYZER_FLOW', 'discovery', () => {
		assert.equal(isDataDiscoveryFlowEnabled(), true);
	});
});

test('isDataDiscoveryFlowEnabled: false for unrecognised flag values', () => {
	withEnv('INSRC_DATA_ANALYZER_FLOW', 'legacy', () => {
		assert.equal(isDataDiscoveryFlowEnabled(), false);
	});
	withEnv('INSRC_DATA_ANALYZER_FLOW', 'true', () => {
		assert.equal(isDataDiscoveryFlowEnabled(), false);
	});
	withEnv('INSRC_DATA_ANALYZER_FLOW', '', () => {
		assert.equal(isDataDiscoveryFlowEnabled(), false);
	});
});

// ---------------------------------------------------------------------------
// synthesiseFindings
// ---------------------------------------------------------------------------

test('synthesiseFindings: empty evidence -> single placeholder finding', () => {
	const out = synthesiseFindings([], grounding('accept'));
	assert.equal(out.length, 1);
	assert.equal(out[0]!.severity, 'info');
	assert.equal(out[0]!.citations.length, 0);
	assert.match(out[0]!.issue, /No evidence/);
});

test('synthesiseFindings: skips evidence entries with empty citations (invariant)', () => {
	const cited   = entry([{ kind: 'rdbms', connectionId: 'pg', table: 'orders' }], 'high');
	const uncited = entry([], 'high');
	const out = synthesiseFindings([cited, uncited], grounding('accept'));
	assert.equal(out.length, 1);
	assert.equal(out[0]!.citations.length, 1);
});

test('synthesiseFindings: one finding per cited evidence entry', () => {
	const a = entry([{ kind: 'rdbms', connectionId: 'pg', table: 'a' }], 'high');
	const b = entry([{ kind: 'rdbms', connectionId: 'pg', table: 'b' }], 'medium');
	const c = entry([{ kind: 'rdbms', connectionId: 'pg', table: 'c' }], 'low');
	const out = synthesiseFindings([a, b, c], grounding('accept'));
	assert.equal(out.length, 3);
});

test('synthesiseFindings: severity downgrades on grounding redraft', () => {
	const high = entry([{ kind: 'rdbms', connectionId: 'pg', table: 'a' }], 'high');
	const acceptOut  = synthesiseFindings([high], grounding('accept'));
	const redraftOut = synthesiseFindings([high], grounding('redraft'));
	assert.equal(acceptOut[0]!.severity,  'warn');  // high + accept -> warn
	assert.equal(redraftOut[0]!.severity, 'info');  // high + redraft (downgrade) -> info
});

test('synthesiseFindings: issue uses first fact when available', () => {
	const e = entry(
		[{ kind: 'rdbms', connectionId: 'pg', table: 'orders' }],
		'high',
		['orders has 1.2M rows', 'amount is numeric'],
	);
	const out = synthesiseFindings([e], grounding('accept'));
	assert.equal(out[0]!.issue, 'orders has 1.2M rows');
});

test('synthesiseFindings: falls back to skill-id phrasing when no facts', () => {
	const e = entry([{ kind: 'rdbms', connectionId: 'pg', table: 'orders' }], 'high', []);
	const out = synthesiseFindings([e], grounding('accept'));
	assert.match(out[0]!.issue, /evidence from data\.source\.rdbms\.describe-table/);
});

// ---------------------------------------------------------------------------
// aggregateConfidence
// ---------------------------------------------------------------------------

test('aggregateConfidence: empty evidence -> low', () => {
	assert.equal(aggregateConfidence([], grounding('accept')), 'low');
});

test('aggregateConfidence: all high + accept -> high', () => {
	const evs = [
		entry([{ kind: 'rdbms', connectionId: 'pg', table: 'a' }], 'high'),
		entry([{ kind: 'rdbms', connectionId: 'pg', table: 'b' }], 'high'),
	];
	assert.equal(aggregateConfidence(evs, grounding('accept')), 'high');
});

test('aggregateConfidence: any low signal -> low (clamps down)', () => {
	const evs = [
		entry([{ kind: 'rdbms', connectionId: 'pg', table: 'a' }], 'high'),
		entry([{ kind: 'rdbms', connectionId: 'pg', table: 'b' }], 'low'),
	];
	assert.equal(aggregateConfidence(evs, grounding('accept')), 'low');
});

test('aggregateConfidence: medium signal -> medium', () => {
	const evs = [
		entry([{ kind: 'rdbms', connectionId: 'pg', table: 'a' }], 'high'),
		entry([{ kind: 'rdbms', connectionId: 'pg', table: 'b' }], 'medium'),
	];
	assert.equal(aggregateConfidence(evs, grounding('accept')), 'medium');
});

test('aggregateConfidence: grounding redraft caps at medium', () => {
	const evs = [
		entry([{ kind: 'rdbms', connectionId: 'pg', table: 'a' }], 'high'),
		entry([{ kind: 'rdbms', connectionId: 'pg', table: 'b' }], 'high'),
	];
	assert.equal(aggregateConfidence(evs, grounding('redraft')), 'medium');
});

test('aggregateConfidence: low + redraft stays low (no upgrade)', () => {
	const evs = [
		entry([{ kind: 'rdbms', connectionId: 'pg', table: 'a' }], 'low'),
	];
	assert.equal(aggregateConfidence(evs, grounding('redraft')), 'low');
});

// ---------------------------------------------------------------------------
// flattenEvidenceCitations
// ---------------------------------------------------------------------------

test('flattenEvidenceCitations: dedups identical citations across entries', () => {
	const c1: DataCitation = { kind: 'rdbms', connectionId: 'pg', table: 'orders' };
	const c2: DataCitation = { kind: 'rdbms', connectionId: 'pg', table: 'users'  };
	const evs = [
		entry([c1, c2], 'high'),
		entry([c1     ], 'high'),  // dupe of c1
	];
	const out = flattenEvidenceCitations(evs);
	assert.equal(out.length, 2);
});

test('flattenEvidenceCitations: keeps distinct kinds separate', () => {
	const evs = [
		entry([
			{ kind: 'rdbms', connectionId: 'pg', table: 'orders' },
			{ kind: 'kv',    connectionId: 'pg', keyPattern: 'orders' },  // unrelated despite name overlap
		], 'high'),
	];
	const out = flattenEvidenceCitations(evs);
	assert.equal(out.length, 2);
});

test('flattenEvidenceCitations: empty evidence -> empty', () => {
	assert.deepEqual([...flattenEvidenceCitations([])], []);
});

// ---------------------------------------------------------------------------
// synthesiseToolCalls
// ---------------------------------------------------------------------------

function fakeDiscoveryResult(steps: { stepId: string; calledSkillIds: string[] }[]): DataDiscoveryFlowResult {
	const retainedSteps: ExecuteDataStepOutput[] = steps.map(s => ({
		stepId:         s.stepId,
		status:         'ok' as const,
		evidence:       [],
		calledSkillIds: s.calledSkillIds,
		durationMs:     0,
	}));
	return {
		retainedSteps,
		retainedEvidence: [],
		cyclesRun:        1,
		perCycleSummary:  [],
	};
}

test('synthesiseToolCalls: flattens called skills across all retained steps', () => {
	const d = fakeDiscoveryResult([
		{ stepId: 's1', calledSkillIds: ['data.source.rdbms.list-tables', 'data.profile.numeric.rdbms'] },
		{ stepId: 's2', calledSkillIds: ['data.quality.scorecard.rdbms'] },
	]);
	const out = synthesiseToolCalls(d);
	assert.equal(out.length, 3);
	assert.equal(out[0]!.name, 'data.source.rdbms.list-tables');
	assert.equal(out[2]!.name, 'data.quality.scorecard.rdbms');
});

test('synthesiseToolCalls: empty discovery -> empty', () => {
	const d = fakeDiscoveryResult([]);
	assert.deepEqual([...synthesiseToolCalls(d)], []);
});

// ---------------------------------------------------------------------------
// familyToConcern
// ---------------------------------------------------------------------------

test('familyToConcern: lineage -> lineage-gap', () => {
	assert.equal(familyToConcern('data.lineage.read-write-callsites'), 'lineage-gap');
});

test('familyToConcern: pii -> pii-exposure', () => {
	assert.equal(familyToConcern('data.pii.detect-patterns'), 'pii-exposure');
});

test('familyToConcern: drift -> schema-drift', () => {
	assert.equal(familyToConcern('data.drift.volume'), 'schema-drift');
});

test('familyToConcern: cardinality -> capacity-risk', () => {
	assert.equal(familyToConcern('data.cardinality.join-key'), 'capacity-risk');
});

test('familyToConcern: unknown -> consistency (default)', () => {
	assert.equal(familyToConcern('data.something.new'), 'consistency');
});

// ---------------------------------------------------------------------------
// combineSeverity
// ---------------------------------------------------------------------------

test('combineSeverity: high + no downgrade -> warn', () => {
	assert.equal(combineSeverity('high', 0), 'warn');
});

test('combineSeverity: high + downgrade -> info', () => {
	assert.equal(combineSeverity('high', 1), 'info');
});

test('combineSeverity: medium -> info', () => {
	assert.equal(combineSeverity('medium', 0), 'info');
});

test('combineSeverity: low -> info', () => {
	assert.equal(combineSeverity('low', 0), 'info');
});

// ---------------------------------------------------------------------------
// citationKey
// ---------------------------------------------------------------------------

test('citationKey: rdbms is unique by (connection, schema, table, column)', () => {
	const k1 = citationKey({ kind: 'rdbms', connectionId: 'pg', table: 'orders' });
	const k2 = citationKey({ kind: 'rdbms', connectionId: 'pg', table: 'users' });
	const k3 = citationKey({ kind: 'rdbms', connectionId: 'pg', table: 'orders', column: 'amount' });
	assert.notEqual(k1, k2);
	assert.notEqual(k1, k3);
});

test('citationKey: ignores sampleValue (drift across calls is fine)', () => {
	const k1 = citationKey({ kind: 'rdbms', connectionId: 'pg', table: 'orders', sampleValue: 'A' });
	const k2 = citationKey({ kind: 'rdbms', connectionId: 'pg', table: 'orders', sampleValue: 'B' });
	assert.equal(k1, k2);
});

test('citationKey: kv vs rdbms with overlapping table/keyPattern names are distinct', () => {
	const k1 = citationKey({ kind: 'rdbms', connectionId: 'pg', table: 'orders' });
	const k2 = citationKey({ kind: 'kv',    connectionId: 'pg', keyPattern: 'orders' });
	assert.notEqual(k1, k2);
});
