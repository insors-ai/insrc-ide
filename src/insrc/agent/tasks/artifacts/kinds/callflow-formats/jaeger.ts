/**
 * Jaeger JSON trace parser.
 *
 * Jaeger UI exports look like:
 *   {
 *     data: [
 *       {
 *         traceID: '...',
 *         spans: [
 *           {
 *             traceID, spanID, operationName,
 *             references: [{ refType: 'CHILD_OF', traceID, spanID }],
 *             startTime: <micros>, duration: <micros>,
 *             tags: [{ key, type, value }],
 *             process: { serviceName, tags: [...] },     // newer
 *             processID: 'p1',                            // older + lookup
 *           }
 *         ],
 *         processes: { p1: { serviceName: '...' } },     // lookup-table form
 *       }
 *     ]
 *   }
 *
 * We accept both forms (embedded `process` + lookup-table
 * `processID`).
 */

import type {
	CanonicalSpan,
	CanonicalSpanKind,
	CanonicalSpanStatus,
	CanonicalTrace,
} from './types.js';

interface JaegerTag {
	readonly key?: string;
	readonly type?: string;
	readonly value?: unknown;
}

interface JaegerProcess {
	readonly serviceName?: string;
	readonly tags?: readonly JaegerTag[];
}

interface JaegerReference {
	readonly refType?: string;
	readonly traceID?: string;
	readonly spanID?: string;
}

interface JaegerSpan {
	readonly traceID?: string;
	readonly spanID?: string;
	readonly operationName?: string;
	readonly references?: readonly JaegerReference[];
	readonly startTime?: number;        // micros since epoch
	readonly duration?: number;          // micros
	readonly tags?: readonly JaegerTag[];
	readonly process?: JaegerProcess;
	readonly processID?: string;
}

interface JaegerTrace {
	readonly traceID?: string;
	readonly spans?: readonly JaegerSpan[];
	readonly processes?: Readonly<Record<string, JaegerProcess>>;
}

interface JaegerEnvelope {
	readonly data?: readonly JaegerTrace[];
}

/** Quick shape sniff for the auto-detection switch. */
export function isJaeger(parsed: unknown): boolean {
	if (parsed === null || typeof parsed !== 'object') { return false; }
	const env = parsed as JaegerEnvelope;
	if (!Array.isArray(env.data)) { return false; }
	if (env.data.length === 0) { return true; }   // empty Jaeger export
	// Look for the `spans` array Jaeger always carries.
	const t = env.data[0] as JaegerTrace;
	return Array.isArray(t.spans);
}

export function parseJaeger(parsed: unknown): readonly CanonicalTrace[] {
	if (!isJaeger(parsed)) {
		throw new Error('Jaeger parse: input does not match the `data[].spans[]` envelope');
	}
	const env = parsed as JaegerEnvelope;
	const out: CanonicalTrace[] = [];

	for (const trace of env.data ?? []) {
		const traceId = typeof trace.traceID === 'string' && trace.traceID !== ''
			? trace.traceID
			: trace.spans?.[0]?.traceID ?? '';
		if (traceId === '') { continue; }

		const processes = trace.processes ?? {};
		const spans: CanonicalSpan[] = [];
		for (const s of trace.spans ?? []) {
			const span = toCanonicalSpan(s, processes);
			if (span !== null) { spans.push(span); }
		}
		if (spans.length === 0) { continue; }
		spans.sort((a, b) => a.startMicros - b.startMicros);
		out.push({ traceId, spans });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toCanonicalSpan(
	s: JaegerSpan,
	processes: Readonly<Record<string, JaegerProcess>>,
): CanonicalSpan | null {
	if (typeof s.traceID !== 'string' || s.traceID === '') { return null; }
	if (typeof s.spanID !== 'string' || s.spanID === '') { return null; }
	if (typeof s.startTime !== 'number' || !Number.isFinite(s.startTime)) { return null; }
	const duration = typeof s.duration === 'number' && Number.isFinite(s.duration)
		? Math.max(0, s.duration) : 0;

	// Service name: embedded `process.serviceName` first, then fall
	// back to the lookup table via `processID`.
	let serviceName = 'unknown';
	if (typeof s.process?.serviceName === 'string' && s.process.serviceName !== '') {
		serviceName = s.process.serviceName;
	} else if (typeof s.processID === 'string') {
		const p = processes[s.processID];
		if (p?.serviceName !== undefined && p.serviceName !== '') {
			serviceName = p.serviceName;
		}
	}

	// Parent span: first CHILD_OF reference.
	let parentSpanId: string | undefined;
	for (const r of s.references ?? []) {
		if (r.refType === 'CHILD_OF' && typeof r.spanID === 'string' && r.spanID !== '') {
			parentSpanId = r.spanID;
			break;
		}
	}

	const tagMap = readTagMap(s.tags);
	const kind = readKind(tagMap);
	const status = readStatus(tagMap);

	return {
		traceId: s.traceID,
		spanId: s.spanID,
		...(parentSpanId !== undefined ? { parentSpanId } : {}),
		serviceName,
		operationName: typeof s.operationName === 'string' && s.operationName !== ''
			? s.operationName : '<anon>',
		kind,
		startMicros: Math.trunc(s.startTime),
		durationMicros: Math.trunc(duration),
		status,
		...(status === 'ERROR' && typeof tagMap['otel.status_description'] === 'string'
			? { statusMessage: tagMap['otel.status_description'] as string } : {}),
	};
}

function readTagMap(tags?: readonly JaegerTag[]): Readonly<Record<string, unknown>> {
	const map: Record<string, unknown> = {};
	for (const t of tags ?? []) {
		if (typeof t.key === 'string' && t.key !== '') { map[t.key] = t.value; }
	}
	return map;
}

function readKind(tags: Readonly<Record<string, unknown>>): CanonicalSpanKind {
	const v = tags['span.kind'];
	if (typeof v !== 'string') { return 'INTERNAL'; }
	switch (v.toLowerCase()) {
		case 'client':   return 'CLIENT';
		case 'server':   return 'SERVER';
		case 'producer': return 'PRODUCER';
		case 'consumer': return 'CONSUMER';
		case 'internal': return 'INTERNAL';
		default:         return 'UNKNOWN';
	}
}

function readStatus(tags: Readonly<Record<string, unknown>>): CanonicalSpanStatus {
	// Two signals can mark error: the boolean `error` tag, and the
	// OpenTelemetry `otel.status_code` string. Either being truthy
	// classifies the span ERROR.
	if (tags['error'] === true || tags['error'] === 'true') { return 'ERROR'; }
	const code = tags['otel.status_code'];
	if (typeof code === 'string' && code.toUpperCase() === 'ERROR') { return 'ERROR'; }
	if (typeof code === 'string' && code.toUpperCase() === 'OK') { return 'OK'; }
	return 'UNSET';
}
