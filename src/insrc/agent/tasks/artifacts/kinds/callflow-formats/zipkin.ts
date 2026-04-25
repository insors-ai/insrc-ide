/**
 * Zipkin v2 JSON trace parser.
 *
 * Zipkin v2 is a flat array of spans interleaved across traces:
 *   [
 *     {
 *       traceId, id, parentId,
 *       name,                                  // operation name
 *       kind: 'CLIENT' | 'SERVER' | 'PRODUCER' | 'CONSUMER' | null,
 *       timestamp: <micros since epoch>,
 *       duration: <micros>,
 *       localEndpoint: { serviceName },
 *       tags: { error: 'true', http.status_code: '500' },
 *     },
 *     ...
 *   ]
 *
 * Span kind null / undefined defaults to INTERNAL per Zipkin
 * convention. Errors come from the `error` tag (string).
 */

import type {
	CanonicalSpan,
	CanonicalSpanKind,
	CanonicalSpanStatus,
	CanonicalTrace,
} from './types.js';

interface ZipkinEndpoint {
	readonly serviceName?: string;
}

interface ZipkinSpan {
	readonly traceId?: string;
	readonly id?: string;
	readonly parentId?: string;
	readonly name?: string;
	readonly kind?: string | null;
	readonly timestamp?: number;       // micros
	readonly duration?: number;         // micros
	readonly localEndpoint?: ZipkinEndpoint;
	readonly tags?: Readonly<Record<string, string>>;
}

/** Quick shape sniff for the auto-detection switch. */
export function isZipkin(parsed: unknown): boolean {
	if (!Array.isArray(parsed)) { return false; }
	if (parsed.length === 0) { return true; }
	const first = parsed[0] as ZipkinSpan;
	if (first === null || typeof first !== 'object') { return false; }
	// Zipkin v2 always carries `traceId` + `id` per span; `localEndpoint`
	// (with `serviceName`) is the disambiguator from other flat-array
	// shapes that might also have `traceId`/`id`.
	return typeof first.traceId === 'string'
		&& typeof first.id === 'string'
		&& (first.localEndpoint !== undefined || first.kind !== undefined);
}

export function parseZipkin(parsed: unknown): readonly CanonicalTrace[] {
	if (!isZipkin(parsed)) {
		throw new Error('Zipkin parse: input does not match the v2 flat-array shape');
	}
	const spans = parsed as readonly ZipkinSpan[];
	const byTrace = new Map<string, CanonicalSpan[]>();

	for (const s of spans) {
		const span = toCanonicalSpan(s);
		if (span === null) { continue; }
		let bucket = byTrace.get(span.traceId);
		if (bucket === undefined) {
			bucket = [];
			byTrace.set(span.traceId, bucket);
		}
		bucket.push(span);
	}

	const out: CanonicalTrace[] = [];
	for (const [traceId, ss] of byTrace) {
		const sorted = [...ss].sort((a, b) => a.startMicros - b.startMicros);
		out.push({ traceId, spans: sorted });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toCanonicalSpan(s: ZipkinSpan): CanonicalSpan | null {
	if (typeof s.traceId !== 'string' || s.traceId === '') { return null; }
	if (typeof s.id !== 'string' || s.id === '') { return null; }
	if (typeof s.timestamp !== 'number' || !Number.isFinite(s.timestamp)) { return null; }
	const duration = typeof s.duration === 'number' && Number.isFinite(s.duration)
		? Math.max(0, s.duration) : 0;

	const serviceName = typeof s.localEndpoint?.serviceName === 'string'
		&& s.localEndpoint.serviceName !== ''
		? s.localEndpoint.serviceName
		: 'unknown';

	const kind = readKind(s.kind);
	const status = readStatus(s.tags);

	return {
		traceId: s.traceId,
		spanId: s.id,
		...(typeof s.parentId === 'string' && s.parentId !== '' ? { parentSpanId: s.parentId } : {}),
		serviceName,
		operationName: typeof s.name === 'string' && s.name !== '' ? s.name : '<anon>',
		kind,
		startMicros: Math.trunc(s.timestamp),
		durationMicros: Math.trunc(duration),
		status,
		...(status === 'ERROR' && typeof s.tags?.['error'] === 'string' && s.tags['error'] !== 'true'
			? { statusMessage: s.tags['error'] } : {}),
	};
}

function readKind(kind: string | null | undefined): CanonicalSpanKind {
	if (kind === null || kind === undefined) { return 'INTERNAL'; }
	switch (kind.toUpperCase()) {
		case 'CLIENT':   return 'CLIENT';
		case 'SERVER':   return 'SERVER';
		case 'PRODUCER': return 'PRODUCER';
		case 'CONSUMER': return 'CONSUMER';
		case 'INTERNAL': return 'INTERNAL';
		default:         return 'UNKNOWN';
	}
}

function readStatus(tags?: Readonly<Record<string, string>>): CanonicalSpanStatus {
	if (tags === undefined) { return 'UNSET'; }
	// Zipkin convention: `error` tag present -> error. The value is
	// either 'true' or a free-form error message; either way the span
	// is in ERROR status.
	if (typeof tags['error'] === 'string' && tags['error'] !== '') { return 'ERROR'; }
	return 'UNSET';
}
