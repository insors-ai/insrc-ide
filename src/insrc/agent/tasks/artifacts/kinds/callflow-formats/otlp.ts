/**
 * OpenTelemetry Protocol (OTLP) trace parser.
 *
 * Input shape (per OTLP/JSON spec):
 *   {
 *     resourceSpans: [
 *       {
 *         resource: { attributes: [{key, value: {stringValue,...}}] },
 *         scopeSpans: [
 *           {
 *             scope: { name },
 *             spans: [
 *               {
 *                 traceId, spanId, parentSpanId, name, kind,
 *                 startTimeUnixNano, endTimeUnixNano,
 *                 status: { code, message },
 *                 attributes: [...]
 *               }
 *             ]
 *           }
 *         ]
 *       }
 *     ]
 *   }
 *
 * Notes / quirks:
 *   - OTLP uses int64 for nano timestamps; JSON emitters typically
 *     stringify them to avoid JS number-precision loss. We accept
 *     both string and number, then drop to micros (truncate, not
 *     round) so the canonical times stay in safe-integer range
 *     for traces up to ~285 years long. That's enough for any real
 *     trace.
 *   - Span kind is a 0-5 enum: 0/1 INTERNAL, 2 SERVER, 3 CLIENT,
 *     4 PRODUCER, 5 CONSUMER. Treat 0 as INTERNAL since the spec
 *     says UNSPECIFIED defaults to INTERNAL.
 *   - Status code: 0 UNSET, 1 OK, 2 ERROR.
 *   - service.name lives on the resource, not the span. Spans
 *     inherit it from their parent resourceSpans entry.
 */

import type {
	CanonicalSpan,
	CanonicalSpanKind,
	CanonicalSpanStatus,
	CanonicalTrace,
} from './types.js';

interface OtlpKv {
	readonly key?: string;
	readonly value?: {
		readonly stringValue?: string;
		readonly intValue?: string | number;
		readonly boolValue?: boolean;
		readonly doubleValue?: number;
	};
}

interface OtlpResource {
	readonly attributes?: readonly OtlpKv[];
}

interface OtlpStatus {
	readonly code?: number;
	readonly message?: string;
}

interface OtlpSpan {
	readonly traceId?: string;
	readonly spanId?: string;
	readonly parentSpanId?: string;
	readonly name?: string;
	readonly kind?: number;
	readonly startTimeUnixNano?: string | number;
	readonly endTimeUnixNano?: string | number;
	readonly status?: OtlpStatus;
}

interface OtlpScopeSpans {
	readonly spans?: readonly OtlpSpan[];
}

interface OtlpResourceSpans {
	readonly resource?: OtlpResource;
	readonly scopeSpans?: readonly OtlpScopeSpans[];
}

interface OtlpEnvelope {
	readonly resourceSpans?: readonly OtlpResourceSpans[];
}

const OTLP_KIND: Readonly<Record<number, CanonicalSpanKind>> = {
	0: 'INTERNAL',
	1: 'INTERNAL',
	2: 'SERVER',
	3: 'CLIENT',
	4: 'PRODUCER',
	5: 'CONSUMER',
};

const OTLP_STATUS: Readonly<Record<number, CanonicalSpanStatus>> = {
	0: 'UNSET',
	1: 'OK',
	2: 'ERROR',
};

/**
 * Quick shape sniff -- returns true when the JSON looks like OTLP.
 * Used by the format auto-detection switch.
 */
export function isOtlp(parsed: unknown): boolean {
	if (parsed === null || typeof parsed !== 'object') { return false; }
	return Array.isArray((parsed as { resourceSpans?: unknown }).resourceSpans);
}

/**
 * Parse an OTLP envelope into one or more canonical traces. Spans
 * are grouped by `traceId`. Returns an empty array when the
 * envelope has no spans.
 *
 * Throws on a structurally-invalid envelope (top-level shape wrong);
 * silently drops spans that can't be normalised (missing required
 * fields) so a partial trace still renders.
 */
export function parseOtlp(parsed: unknown): readonly CanonicalTrace[] {
	if (!isOtlp(parsed)) {
		throw new Error('OTLP parse: input lacks resourceSpans');
	}
	const env = parsed as OtlpEnvelope;
	const byTrace = new Map<string, CanonicalSpan[]>();

	for (const rs of env.resourceSpans ?? []) {
		const serviceName = readServiceName(rs.resource);
		for (const ss of rs.scopeSpans ?? []) {
			for (const s of ss.spans ?? []) {
				const span = toCanonicalSpan(s, serviceName);
				if (span === null) { continue; }
				let bucket = byTrace.get(span.traceId);
				if (bucket === undefined) {
					bucket = [];
					byTrace.set(span.traceId, bucket);
				}
				bucket.push(span);
			}
		}
	}

	const traces: CanonicalTrace[] = [];
	for (const [traceId, spans] of byTrace) {
		// Sort each trace's spans by start time so renderers don't have
		// to.
		const sorted = [...spans].sort((a, b) => a.startMicros - b.startMicros);
		traces.push({ traceId, spans: sorted });
	}
	return traces;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readServiceName(resource?: OtlpResource): string {
	if (resource?.attributes === undefined) { return 'unknown'; }
	for (const a of resource.attributes) {
		if (a.key === 'service.name' && typeof a.value?.stringValue === 'string') {
			return a.value.stringValue;
		}
	}
	return 'unknown';
}

function toCanonicalSpan(s: OtlpSpan, serviceName: string): CanonicalSpan | null {
	if (typeof s.traceId !== 'string' || s.traceId === '') { return null; }
	if (typeof s.spanId !== 'string' || s.spanId === '') { return null; }
	const startMicros = nanoToMicros(s.startTimeUnixNano);
	const endMicros = nanoToMicros(s.endTimeUnixNano);
	if (startMicros === null || endMicros === null) { return null; }

	const kindCode = typeof s.kind === 'number' ? s.kind : 0;
	const kind: CanonicalSpanKind = OTLP_KIND[kindCode] ?? 'UNKNOWN';

	const statusCode = typeof s.status?.code === 'number' ? s.status.code : 0;
	const status: CanonicalSpanStatus = OTLP_STATUS[statusCode] ?? 'UNSET';

	return {
		traceId: s.traceId,
		spanId: s.spanId,
		...(typeof s.parentSpanId === 'string' && s.parentSpanId !== ''
			? { parentSpanId: s.parentSpanId } : {}),
		serviceName,
		operationName: typeof s.name === 'string' && s.name !== '' ? s.name : '<anon>',
		kind,
		startMicros,
		durationMicros: Math.max(0, endMicros - startMicros),
		status,
		...(status === 'ERROR' && typeof s.status?.message === 'string'
			? { statusMessage: s.status.message } : {}),
	};
}

/**
 * Convert an OTLP timestamp (nanoseconds since epoch, encoded as
 * either a string or a number) to microseconds. Returns null when
 * the value is missing or unparseable. Integer division truncates.
 */
function nanoToMicros(v: string | number | undefined): number | null {
	if (v === undefined) { return null; }
	if (typeof v === 'number') {
		if (!Number.isFinite(v)) { return null; }
		return Math.trunc(v / 1_000);
	}
	// String form: bigint divide for full int64 range, then Number()
	// once we're back inside safe-integer territory (~9e15 micros =
	// 285 years from epoch).
	if (!/^[0-9]+$/.test(v)) { return null; }
	const micros = BigInt(v) / 1_000n;
	if (micros > BigInt(Number.MAX_SAFE_INTEGER)) { return null; }
	return Number(micros);
}
