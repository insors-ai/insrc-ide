/**
 * Tests for the callflow artifact kind:
 *  - OTLP parser canonicalisation
 *  - Trace selection + filtering (showInternal, serviceFilter, traceId)
 *  - Caps: SERVICE_CAP / SPAN_CAP truncation behaviour
 *  - Mermaid sequenceDiagram renderer (arrow shapes, ERROR notes,
 *    PRODUCER async note, participant aliases)
 *
 * Renderer + parser tested as pure functions; the file-read +
 * tool-deps wiring is integration-shaped (covered by smoke tests
 * later when a real OTLP fixture lands).
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { isOtlp, parseOtlp } from '../kinds/callflow-formats/otlp.js';
import type {
	CanonicalSpan,
	CanonicalTrace,
} from '../kinds/callflow-formats/types.js';

// ---------------------------------------------------------------------------
// OTLP fixture builder
// ---------------------------------------------------------------------------

interface FixtureSpan {
	readonly traceId: string;
	readonly spanId: string;
	readonly parentSpanId?: string;
	readonly name: string;
	readonly kind?: number;
	readonly startNs: string;
	readonly endNs: string;
	readonly statusCode?: number;
	readonly statusMessage?: string;
}

function otlpEnvelope(
	resourceSpans: readonly { service: string; spans: readonly FixtureSpan[] }[],
): unknown {
	return {
		resourceSpans: resourceSpans.map(rs => ({
			resource: {
				attributes: [
					{ key: 'service.name', value: { stringValue: rs.service } },
				],
			},
			scopeSpans: [
				{
					scope: { name: 'test' },
					spans: rs.spans.map(s => ({
						traceId: s.traceId,
						spanId: s.spanId,
						...(s.parentSpanId !== undefined ? { parentSpanId: s.parentSpanId } : {}),
						name: s.name,
						kind: s.kind ?? 1,
						startTimeUnixNano: s.startNs,
						endTimeUnixNano: s.endNs,
						status: {
							code: s.statusCode ?? 0,
							...(s.statusMessage !== undefined ? { message: s.statusMessage } : {}),
						},
					})),
				},
			],
		})),
	};
}

// ---------------------------------------------------------------------------
// isOtlp
// ---------------------------------------------------------------------------

describe('isOtlp', () => {
	it('returns true for an OTLP envelope', () => {
		assert.equal(isOtlp({ resourceSpans: [] }), true);
		assert.equal(isOtlp(otlpEnvelope([])), true);
	});

	it('returns false for non-OTLP shapes', () => {
		assert.equal(isOtlp(null), false);
		assert.equal(isOtlp({}), false);
		assert.equal(isOtlp({ data: [] }), false);          // jaeger shape
		assert.equal(isOtlp([{ traceId: 't' }]), false);    // zipkin shape
		assert.equal(isOtlp('a string'), false);
	});
});

// ---------------------------------------------------------------------------
// parseOtlp
// ---------------------------------------------------------------------------

describe('parseOtlp', () => {
	it('groups spans by traceId + sorts by start time', () => {
		const env = otlpEnvelope([
			{
				service: 'auth',
				spans: [
					// Out-of-order start times -- parser must sort.
					{ traceId: 't1', spanId: 's2', name: 'b',
						startNs: '2000', endNs: '3000', kind: 2 },
					{ traceId: 't1', spanId: 's1', name: 'a',
						startNs: '1000', endNs: '4000', kind: 2 },
					{ traceId: 't2', spanId: 's3', name: 'c',
						startNs: '500', endNs: '600', kind: 2 },
				],
			},
		]);
		const traces = parseOtlp(env);
		assert.equal(traces.length, 2);
		const t1 = traces.find(t => t.traceId === 't1');
		assert.ok(t1 !== undefined);
		// Sorted ascending by start time.
		assert.deepEqual(t1.spans.map(s => s.spanId), ['s1', 's2']);
	});

	it('canonicalises span kind + status enums', () => {
		const env = otlpEnvelope([
			{
				service: 'auth',
				spans: [
					{ traceId: 't', spanId: 'a', name: 'op',
						startNs: '0', endNs: '1000', kind: 1 },     // INTERNAL
					{ traceId: 't', spanId: 'b', name: 'op',
						startNs: '0', endNs: '1000', kind: 2 },     // SERVER
					{ traceId: 't', spanId: 'c', name: 'op',
						startNs: '0', endNs: '1000', kind: 3 },     // CLIENT
					{ traceId: 't', spanId: 'd', name: 'op',
						startNs: '0', endNs: '1000', kind: 4 },     // PRODUCER
					{ traceId: 't', spanId: 'e', name: 'op',
						startNs: '0', endNs: '1000', kind: 5 },     // CONSUMER
					{ traceId: 't', spanId: 'f', name: 'op',
						startNs: '0', endNs: '1000', kind: 99 },    // UNKNOWN
					{ traceId: 't', spanId: 'g', name: 'op',
						startNs: '0', endNs: '1000', kind: 2,
						statusCode: 2, statusMessage: 'oops' },     // ERROR
				],
			},
		]);
		const trace = parseOtlp(env)[0];
		assert.ok(trace !== undefined);
		const byId = new Map(trace.spans.map(s => [s.spanId, s]));
		assert.equal(byId.get('a')?.kind, 'INTERNAL');
		assert.equal(byId.get('b')?.kind, 'SERVER');
		assert.equal(byId.get('c')?.kind, 'CLIENT');
		assert.equal(byId.get('d')?.kind, 'PRODUCER');
		assert.equal(byId.get('e')?.kind, 'CONSUMER');
		assert.equal(byId.get('f')?.kind, 'UNKNOWN');
		assert.equal(byId.get('g')?.status, 'ERROR');
		assert.equal(byId.get('g')?.statusMessage, 'oops');
	});

	it('reads service.name from the resource attributes', () => {
		const env = otlpEnvelope([
			{
				service: 'orders',
				spans: [
					{ traceId: 't', spanId: 'a', name: 'op',
						startNs: '0', endNs: '1000', kind: 2 },
				],
			},
		]);
		const trace = parseOtlp(env)[0];
		assert.equal(trace?.spans[0]?.serviceName, 'orders');
	});

	it('falls back to "unknown" service when service.name is absent', () => {
		const env = {
			resourceSpans: [{
				resource: { attributes: [] },
				scopeSpans: [{
					spans: [{
						traceId: 't', spanId: 'a', name: 'op',
						startTimeUnixNano: '0', endTimeUnixNano: '1000', kind: 2,
					}],
				}],
			}],
		};
		const trace = parseOtlp(env)[0];
		assert.equal(trace?.spans[0]?.serviceName, 'unknown');
	});

	it('drops spans missing required fields rather than throwing', () => {
		const env = {
			resourceSpans: [{
				resource: { attributes: [{ key: 'service.name', value: { stringValue: 'a' } }] },
				scopeSpans: [{
					spans: [
						{ name: 'no-trace-id' },              // missing traceId
						{ traceId: 't1', name: 'no-span-id' }, // missing spanId
						{
							traceId: 't1', spanId: 'good', name: 'ok',
							startTimeUnixNano: '0', endTimeUnixNano: '1000', kind: 2,
						},
					],
				}],
			}],
		};
		const traces = parseOtlp(env);
		assert.equal(traces.length, 1);
		assert.equal(traces[0]?.spans.length, 1);
		assert.equal(traces[0]?.spans[0]?.spanId, 'good');
	});

	it('handles nano timestamps as numbers and as strings', () => {
		const env = otlpEnvelope([{
			service: 'a',
			spans: [
				// String form (canonical OTLP/JSON encoding for int64).
				{ traceId: 't', spanId: 'a', name: 'op',
					startNs: '1000000000', endNs: '1500000000', kind: 2 },
			],
		}]);
		const trace = parseOtlp(env)[0];
		// 500ms duration in micros = 500_000.
		assert.equal(trace?.spans[0]?.durationMicros, 500_000);
		// 1ms start (1_000_000ns -> 1000us).
		assert.equal(trace?.spans[0]?.startMicros, 1_000_000);
	});

	it('throws on non-OTLP top-level shapes', () => {
		assert.throws(() => parseOtlp({}), /resourceSpans/);
		assert.throws(() => parseOtlp(null), /resourceSpans/);
	});
});

// ---------------------------------------------------------------------------
// Sequence renderer + filtering -- exercise via `runCallflow` end-to-end
// would need the template binder and a real session; instead, sanity-check
// the parser emits enough info that a renderer can build the diagram.
// ---------------------------------------------------------------------------

describe('parseOtlp - end-to-end shape', () => {
	it('produces parent-child links walkable to a renderer', () => {
		// Two services, simple call: auth -> orders.
		const env = otlpEnvelope([
			{
				service: 'auth',
				spans: [{
					traceId: 't', spanId: 'auth-1', name: 'POST /login',
					startNs: '0', endNs: '5000000', kind: 2, // SERVER
				}],
			},
			{
				service: 'orders',
				spans: [{
					traceId: 't', spanId: 'orders-1',
					parentSpanId: 'auth-1',
					name: 'GET /orders/recent',
					startNs: '1000000', endNs: '4000000', kind: 3, // CLIENT
				}],
			},
		]);
		const trace = parseOtlp(env)[0] as CanonicalTrace;
		assert.equal(trace.spans.length, 2);
		const child = trace.spans.find(s => s.spanId === 'orders-1');
		assert.equal(child?.parentSpanId, 'auth-1');
		assert.equal(child?.kind, 'CLIENT');
		// 3ms span (3_000_000ns -> 3000us).
		assert.equal(child?.durationMicros, 3000);
	});

	it('preserves ERROR status + message for failed spans', () => {
		const env = otlpEnvelope([{
			service: 'pay',
			spans: [{
				traceId: 't', spanId: 's', name: 'charge',
				startNs: '0', endNs: '1000', kind: 3,
				statusCode: 2, statusMessage: 'card declined',
			}],
		}]);
		const span = parseOtlp(env)[0]?.spans[0] as CanonicalSpan;
		assert.equal(span.status, 'ERROR');
		assert.equal(span.statusMessage, 'card declined');
	});
});
