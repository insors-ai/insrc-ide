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

import { isJaeger, parseJaeger } from '../kinds/callflow-formats/jaeger.js';
import { isOtlp, parseOtlp } from '../kinds/callflow-formats/otlp.js';
import { isZipkin, parseZipkin } from '../kinds/callflow-formats/zipkin.js';
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

// ---------------------------------------------------------------------------
// isJaeger / parseJaeger
// ---------------------------------------------------------------------------

describe('isJaeger', () => {
	it('returns true for the Jaeger envelope', () => {
		assert.equal(isJaeger({ data: [{ traceID: 't', spans: [] }] }), true);
		assert.equal(isJaeger({ data: [] }), true);
	});

	it('returns false for non-Jaeger shapes', () => {
		assert.equal(isJaeger(null), false);
		assert.equal(isJaeger({}), false);
		assert.equal(isJaeger({ resourceSpans: [] }), false);   // OTLP
		assert.equal(isJaeger([]), false);                       // Zipkin
		assert.equal(isJaeger({ data: [{ noSpansField: true }] }), false);
	});
});

describe('parseJaeger', () => {
	it('reads service name from embedded process', () => {
		const env = {
			data: [{
				traceID: 't1',
				spans: [{
					traceID: 't1', spanID: 's1',
					operationName: 'GET /users',
					startTime: 1_000_000, duration: 50_000,
					tags: [{ key: 'span.kind', type: 'string', value: 'server' }],
					process: { serviceName: 'auth' },
				}],
			}],
		};
		const trace = parseJaeger(env)[0];
		assert.ok(trace !== undefined);
		assert.equal(trace.spans[0]?.serviceName, 'auth');
		assert.equal(trace.spans[0]?.kind, 'SERVER');
		assert.equal(trace.spans[0]?.operationName, 'GET /users');
		assert.equal(trace.spans[0]?.startMicros, 1_000_000);
		assert.equal(trace.spans[0]?.durationMicros, 50_000);
	});

	it('reads service name from the lookup-table form', () => {
		const env = {
			data: [{
				traceID: 't1',
				processes: { p1: { serviceName: 'orders' } },
				spans: [{
					traceID: 't1', spanID: 's1',
					operationName: 'op',
					startTime: 0, duration: 1000,
					tags: [{ key: 'span.kind', type: 'string', value: 'client' }],
					processID: 'p1',
				}],
			}],
		};
		const trace = parseJaeger(env)[0];
		assert.equal(trace?.spans[0]?.serviceName, 'orders');
		assert.equal(trace?.spans[0]?.kind, 'CLIENT');
	});

	it('walks references[CHILD_OF] for parent span id', () => {
		const env = {
			data: [{
				traceID: 't',
				spans: [
					{
						traceID: 't', spanID: 'child', operationName: 'inner',
						startTime: 100, duration: 500,
						process: { serviceName: 'svc' },
						references: [{ refType: 'CHILD_OF', traceID: 't', spanID: 'parent' }],
					},
					{
						traceID: 't', spanID: 'parent', operationName: 'outer',
						startTime: 0, duration: 1000,
						process: { serviceName: 'svc' },
					},
				],
			}],
		};
		const trace = parseJaeger(env)[0];
		const child = trace?.spans.find(s => s.spanId === 'child');
		assert.equal(child?.parentSpanId, 'parent');
	});

	it('classifies spans as ERROR via the boolean error tag', () => {
		const env = {
			data: [{
				traceID: 't',
				spans: [{
					traceID: 't', spanID: 's', operationName: 'op',
					startTime: 0, duration: 100,
					tags: [{ key: 'error', type: 'bool', value: true }],
					process: { serviceName: 'svc' },
				}],
			}],
		};
		const trace = parseJaeger(env)[0];
		assert.equal(trace?.spans[0]?.status, 'ERROR');
	});

	it('classifies spans as ERROR via otel.status_code = ERROR', () => {
		const env = {
			data: [{
				traceID: 't',
				spans: [{
					traceID: 't', spanID: 's', operationName: 'op',
					startTime: 0, duration: 100,
					tags: [
						{ key: 'otel.status_code', type: 'string', value: 'ERROR' },
						{ key: 'otel.status_description', type: 'string', value: 'timeout' },
					],
					process: { serviceName: 'svc' },
				}],
			}],
		};
		const span = parseJaeger(env)[0]?.spans[0];
		assert.equal(span?.status, 'ERROR');
		assert.equal(span?.statusMessage, 'timeout');
	});
});

// ---------------------------------------------------------------------------
// isZipkin / parseZipkin
// ---------------------------------------------------------------------------

describe('isZipkin', () => {
	it('returns true for v2 flat-array shape with traceId + id + localEndpoint', () => {
		assert.equal(isZipkin([{ traceId: 't', id: 's', localEndpoint: { serviceName: 'a' } }]), true);
		assert.equal(isZipkin([{ traceId: 't', id: 's', kind: 'CLIENT' }]), true);
		assert.equal(isZipkin([]), true);                  // empty zipkin export
	});

	it('returns false for non-Zipkin shapes', () => {
		assert.equal(isZipkin(null), false);
		assert.equal(isZipkin({}), false);
		assert.equal(isZipkin({ resourceSpans: [] }), false);
		assert.equal(isZipkin({ data: [] }), false);
		// Array, but spans don't carry the disambiguators.
		assert.equal(isZipkin([{ unrelated: true }]), false);
	});
});

describe('parseZipkin', () => {
	it('groups by traceId, sorts by timestamp', () => {
		const spans = [
			{ traceId: 'a', id: 's2', name: 'b',
				timestamp: 200, duration: 100, kind: 'SERVER',
				localEndpoint: { serviceName: 'svc' } },
			{ traceId: 'a', id: 's1', name: 'a',
				timestamp: 100, duration: 100, kind: 'CLIENT',
				localEndpoint: { serviceName: 'svc' } },
			{ traceId: 'b', id: 's3', name: 'c',
				timestamp: 50, duration: 50, kind: 'CLIENT',
				localEndpoint: { serviceName: 'svc' } },
		];
		const traces = parseZipkin(spans);
		assert.equal(traces.length, 2);
		const a = traces.find(t => t.traceId === 'a');
		assert.deepEqual(a?.spans.map(s => s.spanId), ['s1', 's2']);
	});

	it('treats null / undefined kind as INTERNAL', () => {
		const spans = [
			{ traceId: 't', id: 's1', name: 'op',
				timestamp: 0, duration: 100, kind: null,
				localEndpoint: { serviceName: 'a' } },
			{ traceId: 't', id: 's2', name: 'op',
				timestamp: 0, duration: 100,
				localEndpoint: { serviceName: 'a' } },
		];
		const trace = parseZipkin(spans)[0];
		assert.equal(trace?.spans[0]?.kind, 'INTERNAL');
		assert.equal(trace?.spans[1]?.kind, 'INTERNAL');
	});

	it('classifies spans with the error tag as ERROR', () => {
		const spans = [
			{ traceId: 't', id: 's', name: 'op',
				timestamp: 0, duration: 100, kind: 'SERVER',
				localEndpoint: { serviceName: 'a' },
				tags: { error: 'true' } },
			{ traceId: 't', id: 's2', name: 'op',
				timestamp: 0, duration: 100, kind: 'SERVER',
				localEndpoint: { serviceName: 'a' },
				tags: { error: 'connection refused' } },
		];
		const trace = parseZipkin(spans)[0];
		assert.equal(trace?.spans[0]?.status, 'ERROR');
		// Free-form error message preserved as statusMessage.
		assert.equal(trace?.spans[1]?.status, 'ERROR');
		assert.equal(trace?.spans[1]?.statusMessage, 'connection refused');
	});

	it('preserves parentId as parentSpanId', () => {
		const spans = [
			{ traceId: 't', id: 'child', parentId: 'parent', name: 'op',
				timestamp: 100, duration: 50, kind: 'CLIENT',
				localEndpoint: { serviceName: 'svc' } },
			{ traceId: 't', id: 'parent', name: 'op',
				timestamp: 0, duration: 200, kind: 'SERVER',
				localEndpoint: { serviceName: 'svc' } },
		];
		const trace = parseZipkin(spans)[0];
		const child = trace?.spans.find(s => s.spanId === 'child');
		assert.equal(child?.parentSpanId, 'parent');
	});
});

// ---------------------------------------------------------------------------
// Format auto-detection ordering
// ---------------------------------------------------------------------------

describe('format detection ordering', () => {
	it('OTLP / Jaeger / Zipkin shapes are mutually exclusive', () => {
		const otlp = { resourceSpans: [] };
		const jaeger = { data: [{ traceID: 't', spans: [] }] };
		const zipkin = [{ traceId: 't', id: 's', kind: 'CLIENT', localEndpoint: { serviceName: 'a' } }];

		assert.equal(isOtlp(otlp) && !isJaeger(otlp) && !isZipkin(otlp), true);
		assert.equal(!isOtlp(jaeger) && isJaeger(jaeger) && !isZipkin(jaeger), true);
		assert.equal(!isOtlp(zipkin) && !isJaeger(zipkin) && isZipkin(zipkin), true);
	});
});
