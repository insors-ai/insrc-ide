/**
 * Cross-service callflow artifact kind.
 *
 * Visualises distributed call traces (OpenTelemetry / Jaeger / Zipkin)
 * as a Mermaid `sequenceDiagram` -- services as participants, spans
 * as duration-labelled messages, errors highlighted, async via
 * PRODUCER/CONSUMER spans.
 *
 * Source priority:
 *   1. Caller-supplied Mermaid `source` -- rendered verbatim.
 *   2. Inline trace JSON via `traceJson` -- parsed + auto-detected.
 *   3. Trace file via `tracePath` -- read off disk + parsed.
 *   4. Free-text fallback (default scaffold).
 *
 * v1 ships **OTLP-only** parsing. Jaeger + Zipkin parsers + the
 * `flowchart` layout option will land in a follow-up. The
 * `CallflowSourceFormat` enum already carries all three so adding a
 * format is a parser file + one line in the auto-detection switch.
 *
 * See plans/artifact-tasks.md §4.4.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';

import { getLogger } from '../../../../shared/logger.js';
import type {
	ArtifactResult,
	CallflowOptions,
} from '../../../../shared/artifacts.js';
import type { KindRunOpts } from '../registry.js';
import {
	cleanOneLine,
	runMermaidArtifact,
	truncate,
	type MermaidCommonInput,
} from './shared-mermaid.js';
import { isJaeger, parseJaeger } from './callflow-formats/jaeger.js';
import { isOtlp, parseOtlp } from './callflow-formats/otlp.js';
import { isZipkin, parseZipkin } from './callflow-formats/zipkin.js';
import type {
	CallflowSourceFormat,
	CanonicalSpan,
	CanonicalSpanKind,
	CanonicalTrace,
} from './callflow-formats/types.js';

const log = getLogger('artifact-kind-callflow');

export interface CallflowInput extends MermaidCommonInput, CallflowOptions {}

// ---------------------------------------------------------------------------
// Caps + constants
// ---------------------------------------------------------------------------

/** Max distinct services rendered as participants. */
export const SERVICE_CAP = 20;
/** Max spans rendered as messages. */
export const SPAN_CAP = 50;
/** Wall-clock cap on file reads. */
const FILE_READ_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Format auto-detection + parse
// ---------------------------------------------------------------------------

interface ParseResult {
	readonly format: CallflowSourceFormat;
	readonly traces: readonly CanonicalTrace[];
}

function autoDetectAndParse(parsed: unknown): ParseResult {
	if (isOtlp(parsed)) {
		return { format: 'otlp', traces: parseOtlp(parsed) };
	}
	if (isJaeger(parsed)) {
		return { format: 'jaeger', traces: parseJaeger(parsed) };
	}
	if (isZipkin(parsed)) {
		return { format: 'zipkin', traces: parseZipkin(parsed) };
	}
	throw new Error(
		'Callflow: unrecognised trace JSON shape. Supported formats: ' +
		'OpenTelemetry / OTLP (`resourceSpans` envelope), ' +
		'Jaeger (`data[].spans[]` envelope), ' +
		'Zipkin v2 (flat span array with `traceId` + `id` + `localEndpoint`). ' +
		'Vendor-specific exports (Datadog / Honeycomb / New Relic) -- normalise to OTLP first.',
	);
}

async function readTraceFile(path: string, repoRoot: string | undefined): Promise<string> {
	const abs = isAbsolute(path) ? path : resolvePath(repoRoot ?? process.cwd(), path);
	const buf = await Promise.race([
		readFile(abs, 'utf8'),
		new Promise<never>((_, reject) => setTimeout(() => {
			reject(new Error(`Callflow: trace file read timed out (${FILE_READ_TIMEOUT_MS}ms): ${abs}`));
		}, FILE_READ_TIMEOUT_MS).unref?.()),
	]);
	return buf as string;
}

// ---------------------------------------------------------------------------
// Trace selection + filtering
// ---------------------------------------------------------------------------

interface PreparedTrace {
	readonly trace: CanonicalTrace;
	readonly droppedInternal: number;
	readonly droppedByService: number;
	readonly truncatedSpans: number;
	readonly truncatedServices: readonly string[];
}

function pickTrace(
	traces: readonly CanonicalTrace[],
	traceId: string | undefined,
): CanonicalTrace | null {
	if (traces.length === 0) { return null; }
	if (traceId === undefined || traceId === '') { return traces[0] ?? null; }
	return traces.find(t => t.traceId === traceId) ?? null;
}

function prepareTrace(
	trace: CanonicalTrace,
	opts: { showInternal: boolean; serviceFilter: readonly string[] | null },
): PreparedTrace {
	let droppedInternal = 0;
	let droppedByService = 0;

	const filterSet = opts.serviceFilter !== null && opts.serviceFilter.length > 0
		? new Set(opts.serviceFilter)
		: null;

	const kept: CanonicalSpan[] = [];
	for (const span of trace.spans) {
		if (!opts.showInternal && (span.kind === 'INTERNAL' || span.kind === 'UNKNOWN')) {
			droppedInternal++;
			continue;
		}
		if (filterSet !== null && !filterSet.has(span.serviceName)) {
			droppedByService++;
			continue;
		}
		kept.push(span);
	}

	// Service cap: drop spans on services beyond the first N. "First"
	// = order of first appearance in the start-sorted span list.
	const seenServices = new Map<string, number>();
	for (const s of kept) {
		if (!seenServices.has(s.serviceName)) {
			seenServices.set(s.serviceName, seenServices.size);
		}
	}
	const truncatedServices: string[] = [];
	const inScopeServices = new Set<string>();
	for (const [svc, idx] of seenServices) {
		if (idx < SERVICE_CAP) { inScopeServices.add(svc); }
		else { truncatedServices.push(svc); }
	}
	const afterServiceCap = truncatedServices.length === 0
		? kept
		: kept.filter(s => inScopeServices.has(s.serviceName));

	// Span cap: keep first N spans by start time.
	const truncatedSpans = Math.max(0, afterServiceCap.length - SPAN_CAP);
	const finalSpans = afterServiceCap.slice(0, SPAN_CAP);

	return {
		trace: { traceId: trace.traceId, spans: finalSpans },
		droppedInternal,
		droppedByService,
		truncatedSpans,
		truncatedServices,
	};
}

// ---------------------------------------------------------------------------
// Mermaid sequenceDiagram renderer
// ---------------------------------------------------------------------------

/** Mermaid participant aliases must match `[A-Za-z0-9_]+`. */
function participantAlias(name: string, seen: Map<string, string>): string {
	const existing = seen.get(name);
	if (existing !== undefined) { return existing; }
	let base = name.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
	if (base === '' || /^\d/.test(base)) { base = `svc_${base}`; }
	let alias = base;
	let i = 2;
	while (Array.from(seen.values()).includes(alias)) {
		alias = `${base}_${i}`;
		i++;
	}
	seen.set(name, alias);
	return alias;
}

function operationLabel(span: CanonicalSpan): string {
	const ms = Math.round(span.durationMicros / 1_000);
	return `${escapeLabel(span.operationName)} ${ms}ms`;
}

function escapeLabel(s: string): string {
	return s.replace(/[:\n]/g, ' ').trim();
}

function arrowFor(kind: CanonicalSpanKind, status: CanonicalSpan['status']): string {
	if (status === 'ERROR') { return '--x'; }
	if (kind === 'PRODUCER' || kind === 'CONSUMER') { return '-->>'; }
	return '->>';
}

interface SequenceRenderResult {
	readonly mermaid: string;
	readonly serviceCount: number;
	readonly spanCount: number;
}

function renderSequenceDiagram(prep: PreparedTrace): SequenceRenderResult {
	const { trace } = prep;

	// Build span lookup so we can resolve parent->caller (caller =
	// span whose service is the parent's service).
	const spanById = new Map<string, CanonicalSpan>();
	for (const s of trace.spans) { spanById.set(s.spanId, s); }

	// Participants in order of first appearance.
	const aliases = new Map<string, string>();
	const orderedServices: string[] = [];
	for (const s of trace.spans) {
		if (!aliases.has(s.serviceName)) {
			participantAlias(s.serviceName, aliases);
			orderedServices.push(s.serviceName);
		}
	}

	const lines: string[] = ['sequenceDiagram', '  autonumber'];
	for (const svc of orderedServices) {
		const alias = aliases.get(svc)!;
		lines.push(`  participant ${alias} as ${escapeLabel(svc)}`);
	}

	for (const span of trace.spans) {
		const parent = span.parentSpanId !== undefined
			? spanById.get(span.parentSpanId) : undefined;
		const fromService = parent?.serviceName ?? span.serviceName;
		const toService = span.serviceName;
		const fromAlias = aliases.get(fromService);
		const toAlias = aliases.get(toService);
		if (fromAlias === undefined || toAlias === undefined) { continue; }
		const arrow = arrowFor(span.kind, span.status);
		lines.push(`  ${fromAlias}${arrow}${toAlias}: ${operationLabel(span)}`);
		if (span.status === 'ERROR' && typeof span.statusMessage === 'string'
			&& span.statusMessage !== '') {
			lines.push(`  Note over ${toAlias}: error: ${escapeLabel(span.statusMessage).slice(0, 80)}`);
		}
		if (span.kind === 'PRODUCER') {
			lines.push(`  Note right of ${toAlias}: produced (async)`);
		}
	}

	return {
		mermaid: lines.join('\n'),
		serviceCount: orderedServices.length,
		spanCount: trace.spans.length,
	};
}

// ---------------------------------------------------------------------------
// Mermaid flowchart-layout renderer (topology view)
// ---------------------------------------------------------------------------

/**
 * Topology-only render: each service is a node; each cross-service
 * call (parent.serviceName -> span.serviceName) becomes an edge with
 * a count badge. Useful when a trace has dozens of repeated calls
 * and the timeline reads as noise -- the topology shows who-talks-
 * to-whom without the time axis.
 *
 * Edges are aggregated: ten `auth -> orders` calls render as one
 * edge labelled `×10`. Errors on any span across an edge bump the
 * edge's error count, rendered after the call count.
 */
function renderFlowchartDiagram(prep: PreparedTrace): SequenceRenderResult {
	const { trace } = prep;

	const spanById = new Map<string, CanonicalSpan>();
	for (const s of trace.spans) { spanById.set(s.spanId, s); }

	const aliases = new Map<string, string>();
	const orderedServices: string[] = [];
	for (const s of trace.spans) {
		if (!aliases.has(s.serviceName)) {
			participantAlias(s.serviceName, aliases);
			orderedServices.push(s.serviceName);
		}
	}

	interface EdgeAcc {
		readonly from: string;
		readonly to: string;
		count: number;
		errors: number;
		readonly samples: string[];   // operation names, capped
	}
	const edges = new Map<string, EdgeAcc>();
	for (const span of trace.spans) {
		const parent = span.parentSpanId !== undefined
			? spanById.get(span.parentSpanId) : undefined;
		const fromService = parent?.serviceName ?? span.serviceName;
		const toService = span.serviceName;
		// Self-loops within a single service are noise in the topology
		// view; skip them.
		if (fromService === toService && parent !== undefined) { continue; }
		const key = `${fromService}->${toService}`;
		let acc = edges.get(key);
		if (acc === undefined) {
			acc = { from: fromService, to: toService, count: 0, errors: 0, samples: [] };
			edges.set(key, acc);
		}
		acc.count++;
		if (span.status === 'ERROR') { acc.errors++; }
		if (acc.samples.length < 3) { acc.samples.push(span.operationName); }
	}

	const lines: string[] = ['flowchart LR'];
	for (const svc of orderedServices) {
		const alias = aliases.get(svc)!;
		lines.push(`  ${alias}["${escapeLabel(svc)}"]`);
	}

	for (const edge of edges.values()) {
		const fromAlias = aliases.get(edge.from);
		const toAlias = aliases.get(edge.to);
		if (fromAlias === undefined || toAlias === undefined) { continue; }
		const sampleStr = edge.samples.slice(0, 2).join(' / ');
		const countStr = edge.count > 1 ? ` ×${edge.count}` : '';
		const errStr = edge.errors > 0 ? ` (${edge.errors} err)` : '';
		const arrow = edge.errors > 0 ? '-.->' : '-->';
		lines.push(`  ${fromAlias} ${arrow}|${escapeLabel(sampleStr)}${countStr}${errStr}| ${toAlias}`);
	}

	return {
		mermaid: lines.join('\n'),
		serviceCount: orderedServices.length,
		spanCount: trace.spans.length,
	};
}

// ---------------------------------------------------------------------------
// Free-text fallback scaffold
// ---------------------------------------------------------------------------

function defaultSequenceScaffold(description: string): string {
	const intent = cleanOneLine(description, 'request');
	return [
		'sequenceDiagram',
		'  autonumber',
		'  participant Client',
		'  participant ServiceA',
		'  participant ServiceB',
		`  Client->>ServiceA: ${escapeLabel(intent)}`,
		'  ServiceA->>ServiceB: downstream call',
		'  ServiceB-->>ServiceA: response',
		'  ServiceA-->>Client: response',
	].join('\n');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface RunCallflowOpts extends KindRunOpts {
	readonly input: CallflowInput;
}

export async function runCallflow(opts: RunCallflowOpts): Promise<ArtifactResult> {
	const { input } = opts;
	const warnings: string[] = [];

	let mermaidSource: string;
	let provenance: string;
	let confidence: 'high' | 'medium' | 'low';
	let metaExtra = '';

	const layout = input.layout === 'flowchart' ? 'flowchart' : 'sequence';

	if (input.source !== undefined && input.source.trim() !== '') {
		mermaidSource = input.source;
		provenance = 'caller-supplied Mermaid source';
		confidence = 'high';
	} else {
		const traceJson = await loadTraceJson(input, opts.repoRoot, warnings);
		const prepared = traceJson === null ? null : tryParseAndPrepare(
			traceJson, input, warnings,
		);
		if (prepared !== null) {
			const rendered = layout === 'flowchart'
				? renderFlowchartDiagram(prepared.prep)
				: renderSequenceDiagram(prepared.prep);
			mermaidSource = rendered.mermaid;
			provenance = `${prepared.format} trace · ${layout} layout · ${rendered.serviceCount}/${SERVICE_CAP} services · ${rendered.spanCount}/${SPAN_CAP} spans`;
			confidence = 'high';
			metaExtra = ` · trace ${truncate(prepared.prep.trace.traceId, 12)}`;
			if (prepared.prep.droppedInternal > 0) {
				warnings.push(`Dropped ${prepared.prep.droppedInternal} INTERNAL/UNKNOWN spans (use \`showInternal: true\` to keep).`);
			}
			if (prepared.prep.droppedByService > 0) {
				warnings.push(`Dropped ${prepared.prep.droppedByService} spans outside \`serviceFilter\`.`);
			}
			if (prepared.prep.truncatedSpans > 0) {
				warnings.push(`Span cap (${SPAN_CAP}) hit -- ${prepared.prep.truncatedSpans} additional spans not rendered.`);
			}
			if (prepared.prep.truncatedServices.length > 0) {
				warnings.push(
					`Service cap (${SERVICE_CAP}) hit -- truncated: ${prepared.prep.truncatedServices.join(', ')}`,
				);
			}
		} else {
			mermaidSource = defaultSequenceScaffold(input.description ?? '');
			provenance = 'free-text (default sequence scaffold)';
			confidence = 'low';
		}
	}

	const descLabel = truncate(cleanOneLine(input.description, 'request flow'), 48);
	const title = input.title?.trim() !== undefined && input.title.trim() !== ''
		? input.title.trim()
		: `Callflow: ${descLabel}`;

	const metadata: Record<string, string> = {};
	if (input.tracePath !== undefined) { metadata['tracePath'] = input.tracePath; }
	if (input.traceId !== undefined) { metadata['traceId'] = input.traceId; }
	if (input.serviceFilter !== undefined && input.serviceFilter.length > 0) {
		metadata['serviceFilter'] = input.serviceFilter.join(',');
	}

	log.info({
		sessionId: opts.sessionId,
		provenance,
		confidence,
		hasCallerSource: input.source !== undefined,
	}, 'callflow artifact generated');

	return runMermaidArtifact(
		{
			kind: 'callflow',
			title,
			mermaidSource,
			metaLine: provenance + metaExtra,
			provenance,
			confidence,
			warnings,
			metadata,
		},
		opts,
	);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Load the JSON string from `traceJson` (preferred) or `tracePath`. */
async function loadTraceJson(
	input: CallflowInput,
	repoRoot: string | undefined,
	warnings: string[],
): Promise<string | null> {
	if (input.traceJson !== undefined && input.traceJson.trim() !== '') {
		return input.traceJson;
	}
	if (input.tracePath !== undefined && input.tracePath.trim() !== '') {
		try { return await readTraceFile(input.tracePath, repoRoot); }
		catch (err) {
			warnings.push(`Trace file read failed: ${(err as Error).message}.`);
			return null;
		}
	}
	return null;
}

interface PreparedFromInput {
	readonly format: CallflowSourceFormat;
	readonly prep: PreparedTrace;
}

function tryParseAndPrepare(
	json: string,
	input: CallflowInput,
	warnings: string[],
): PreparedFromInput | null {
	let parsed: unknown;
	try { parsed = JSON.parse(json); }
	catch (err) {
		warnings.push(`Trace JSON parse failed: ${(err as Error).message}.`);
		return null;
	}

	let format: CallflowSourceFormat;
	let traces: readonly CanonicalTrace[];
	try {
		const out = autoDetectAndParse(parsed);
		format = out.format;
		traces = out.traces;
	} catch (err) {
		warnings.push((err as Error).message);
		return null;
	}

	const trace = pickTrace(traces, input.traceId);
	if (trace === null) {
		warnings.push(input.traceId !== undefined
			? `Trace id '${input.traceId}' not found in input.`
			: 'Input contained zero traces.');
		return null;
	}

	const prep = prepareTrace(trace, {
		showInternal: input.showInternal === true,
		serviceFilter: input.serviceFilter ?? null,
	});

	if (prep.trace.spans.length === 0) {
		warnings.push('All spans were filtered out (try `showInternal: true` or relax `serviceFilter`).');
		return null;
	}

	return { format, prep };
}
