/**
 * Canonical span / trace shape used by the `callflow` artifact kind.
 *
 * Each per-format parser (OTLP / Jaeger / Zipkin) normalises into
 * this shape; the renderer consumes it without caring which format
 * the caller supplied. New formats land as additional parsers in
 * this directory + a row in the auto-detection switch.
 */

export type CanonicalSpanKind =
	| 'CLIENT'
	| 'SERVER'
	| 'PRODUCER'
	| 'CONSUMER'
	| 'INTERNAL'
	| 'UNKNOWN';

export type CanonicalSpanStatus = 'OK' | 'ERROR' | 'UNSET';

export interface CanonicalSpan {
	readonly traceId: string;
	readonly spanId: string;
	readonly parentSpanId?: string | undefined;
	readonly serviceName: string;
	readonly operationName: string;
	readonly kind: CanonicalSpanKind;
	/** Span start time, microseconds since epoch. */
	readonly startMicros: number;
	/** Span duration, microseconds. */
	readonly durationMicros: number;
	readonly status: CanonicalSpanStatus;
	/** Present when `status === 'ERROR'`. */
	readonly statusMessage?: string | undefined;
}

export interface CanonicalTrace {
	readonly traceId: string;
	readonly spans: readonly CanonicalSpan[];
}

/**
 * Source-format identifier the parser surfaces back to the runner so
 * the provenance string carries the format of the input file.
 */
export type CallflowSourceFormat = 'otlp' | 'jaeger' | 'zipkin';

export interface ParsedTraceFile {
	readonly format: CallflowSourceFormat;
	readonly traces: readonly CanonicalTrace[];
}
