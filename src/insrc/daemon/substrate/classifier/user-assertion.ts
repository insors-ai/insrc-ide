/**
 * User-assertion classifier -- P5.3 of plans/skills/substrate-implementation-status.md.
 *
 * Implements substrate D6: detect assertion-shaped spans in a user
 * turn, decide accept/reject/defer per candidate, route accepted
 * assertions to relevant owners.
 *
 * Three-layer pipeline (D6 spec):
 *   1. Detection            -- heuristic scan for assertion shapes.
 *   2. Layer 1              -- heuristic classify on detected spans.
 *   3. Layer 2 (LLM)        -- triggered on ambiguity; structured
 *                              accept/reject + payload. INJECTABLE
 *                              hook -- the default returns 'defer'
 *                              so the substrate stays LLM-free until
 *                              the daemon wires the active provider.
 *   4. Layer 3 (user-confirm) -- triggered when Layer 2 confidence
 *                              is below threshold. INJECTABLE hook --
 *                              default returns 'defer' so the
 *                              chat-UI integration is the wiring
 *                              point (not the substrate).
 *
 * P5 ships:
 *   - The interface + the structured payload (mirrors D6 spec).
 *   - A default classifier whose Layer 1 covers the obvious shapes
 *     ("always X", "never Y", "remember Z", "use A for B", "do not C")
 *     with deterministic regex matching.
 *   - Layer 2 / Layer 3 hooks that callers wire to the LLM + UI.
 *
 * What the classifier does NOT do here:
 *   - Persist its own audit trail. Caller (substrate runtime) writes
 *     decisions into the `classifier:user-assertion` namespace per D6.
 *   - Cache by `hash(span)`. Each turn re-classifies. A cache layer
 *     lands when telemetry shows the same span repeated across turns.
 *   - Fan out to target owners. The runtime owns the index lookup +
 *     bus dispatch; the classifier just emits payloads.
 */

import { getLogger } from '../../../shared/logger.js';

import type { OwnerId } from '../types.js';

const log = getLogger('substrate:classifier:user-assertion');

// ---------------------------------------------------------------------------
// Public types (mirror D6 spec)
// ---------------------------------------------------------------------------

export type AssertionPolarity = 'do' | 'avoid' | 'value-set' | 'preference';
export type AssertionScope    = 'workspace' | 'session' | 'task';

export interface UserAssertionPayload {
	readonly text:         string;
	readonly subject:      string;
	readonly polarity:     AssertionPolarity;
	readonly scope:        AssertionScope;
	readonly targetOwners: readonly OwnerId[];
	readonly confidence:   number;
	readonly reason?:      string;

	// ------------------------------------------------------------------
	// G3 / G4 / G7 extensions (memory-context design). All optional --
	// older callers see these as undefined; the Ollama hook (M1.4) fills
	// them in. The substrate runtime prefers the structured fields when
	// present and falls back to the legacy fields otherwise.
	// ------------------------------------------------------------------

	/**
	 * G3: closed-enum subject from `taxonomy/preference-subjects.ts`. Drives
	 * exact-match routing in `AssertionIndex.lookup`. When present, the runtime
	 * routes by this value rather than the legacy `subject` string.
	 */
	readonly preferenceSubject?: import('../taxonomy/preference-subjects.js').PreferenceSubject | undefined;

	/**
	 * G2: the canonical, user-editable phrasing of the preference. May differ
	 * from `text` (which is the raw user span). Surfaced in the Layer 3
	 * "Customize…" editor and in `/prefs` listings.
	 */
	readonly canonicalText?: string | undefined;

	/** G4: scope refinement -- categories the preference applies to (omit = all). */
	readonly categories?: readonly string[] | undefined;

	/** G4: scope refinement -- repos the preference applies to (omit = all). */
	readonly repoPaths?: readonly string[] | undefined;

	/**
	 * G7: relationship to an existing same-subject same-owner entry. When the
	 * substrate runtime processes an accepted payload with `relationship.kind !==
	 * 'independent'`, it applies the corresponding G7 confidence transformation
	 * (saturating reinforcement OR supersession with decay).
	 */
	readonly relationship?: import('../taxonomy/preference-subjects.js').AssertionRelationship | undefined;
}

export type ClassifierDecision = 'accept' | 'reject' | 'defer';

export interface ClassifierDecisionRecord {
	readonly turnId:        string;
	readonly span:          string;
	readonly layer:         1 | 2 | 3;
	readonly decision:      ClassifierDecision;
	readonly confidence:    number;
	readonly subject?:      string;
	readonly reason?:       string;
}

export interface ClassifyInput {
	readonly turnId: string;
	readonly text:   string;
}

export interface ClassifyResult {
	readonly accepted:  readonly UserAssertionPayload[];
	readonly deferred:  readonly { readonly text: string; readonly reason: string }[];
	readonly rejected:  readonly { readonly text: string; readonly reason: string }[];
	readonly decisions: readonly ClassifierDecisionRecord[];
}

export interface UserAssertionClassifier {
	classify(input: ClassifyInput): Promise<ClassifyResult>;
}

// ---------------------------------------------------------------------------
// Injectable hooks (Layer 2 + Layer 3)
// ---------------------------------------------------------------------------

/**
 * Layer 2 LLM classifier. Receives the detected span + the Layer 1
 * verdict; returns a structured payload + confidence, or 'defer' if
 * still unsure. The substrate ships a no-op that always defers; the
 * daemon's chat flow injects a real implementation that hits the
 * active provider.
 */
export type LlmClassifyHook = (
	span: string,
	hints: { readonly turnId: string; readonly layer1: ClassifierDecision },
) => Promise<
	| { kind: 'accept'; payload: UserAssertionPayload }
	| { kind: 'reject'; reason: string }
	| { kind: 'defer';  reason: string }
>;

/**
 * Layer 3 user-confirmation hook. Receives a span the LLM was unsure
 * about; returns the user's verdict. The substrate ships a no-op
 * that always defers (chat UI is the wiring point).
 */
export type UserConfirmHook = (
	span: string,
	hints: { readonly turnId: string },
) => Promise<
	| { kind: 'accept'; payload: UserAssertionPayload }
	| { kind: 'reject' }
	| { kind: 'defer'  }
>;

export interface CreateClassifierOpts {
	/** Layer 2 LLM hook. Default: always defers. */
	readonly llmClassify?: LlmClassifyHook;
	/** Layer 3 user-confirm hook. Default: always defers. */
	readonly userConfirm?: UserConfirmHook;
	/** Layer 2 confidence threshold below which we escalate to Layer 3. Default: 0.7. */
	readonly layer2Threshold?: number;
}

// ---------------------------------------------------------------------------
// Default classifier
// ---------------------------------------------------------------------------

export function createDefaultClassifier(opts: CreateClassifierOpts = {}): UserAssertionClassifier {
	const llmClassify = opts.llmClassify ?? (async () => ({ kind: 'defer' as const, reason: 'no LLM wired' }));
	const userConfirm = opts.userConfirm ?? (async () => ({ kind: 'defer' as const }));
	const threshold   = opts.layer2Threshold ?? 0.7;

	return {
		async classify(input: ClassifyInput): Promise<ClassifyResult> {
			const spans = detectAssertionSpans(input.text);

			const accepted: UserAssertionPayload[] = [];
			const rejected: { text: string; reason: string }[] = [];
			const deferred: { text: string; reason: string }[] = [];
			const decisions: ClassifierDecisionRecord[] = [];

			for (const span of spans) {
				const layer1 = layer1Classify(span);
				decisions.push({
					turnId:     input.turnId,
					span:       span.text,
					layer:      1,
					decision:   layer1.decision,
					confidence: layer1.confidence,
					...(layer1.subject !== undefined ? { subject: layer1.subject } : {}),
					...(layer1.reason  !== undefined ? { reason:  layer1.reason  } : {}),
				});

				if (layer1.decision === 'reject') {
					rejected.push({ text: span.text, reason: layer1.reason ?? 'layer-1 reject' });
					continue;
				}

				if (layer1.decision === 'accept') {
					// Layer 1 is confident enough to accept; build the payload
					// from the heuristic-detected fields.
					accepted.push({
						text:         span.text,
						subject:      layer1.subject ?? 'unknown',
						polarity:     layer1.polarity ?? 'preference',
						scope:        'workspace',
						targetOwners: [],          // index lookup happens at runtime
						confidence:   layer1.confidence,
						...(layer1.reason !== undefined ? { reason: layer1.reason } : {}),
					});
					continue;
				}

				// Layer 1 deferred -> Layer 2 LLM.
				const l2 = await llmClassify(span.text, { turnId: input.turnId, layer1: layer1.decision });
				if (l2.kind === 'accept') {
					decisions.push({
						turnId: input.turnId, span: span.text, layer: 2,
						decision: 'accept', confidence: l2.payload.confidence,
						subject: l2.payload.subject,
					});
					if (l2.payload.confidence >= threshold) {
						accepted.push(l2.payload);
					} else {
						// Confidence too low -> Layer 3 user-confirm.
						const l3 = await userConfirm(span.text, { turnId: input.turnId });
						decisions.push({
							turnId: input.turnId, span: span.text, layer: 3,
							decision: l3.kind === 'accept' ? 'accept' : l3.kind === 'reject' ? 'reject' : 'defer',
							confidence: l3.kind === 'accept' ? l3.payload.confidence : 0,
						});
						if (l3.kind === 'accept')      { accepted.push(l3.payload); }
						else if (l3.kind === 'reject') { rejected.push({ text: span.text, reason: 'user dismissed' }); }
						else                            { deferred.push({ text: span.text, reason: 'user did not confirm' }); }
					}
				} else if (l2.kind === 'reject') {
					decisions.push({ turnId: input.turnId, span: span.text, layer: 2, decision: 'reject', confidence: 0, reason: l2.reason });
					rejected.push({ text: span.text, reason: l2.reason });
				} else {
					decisions.push({ turnId: input.turnId, span: span.text, layer: 2, decision: 'defer', confidence: 0, reason: l2.reason });
					deferred.push({ text: span.text, reason: l2.reason });
				}
			}

			log.debug(
				{ turnId: input.turnId, spans: spans.length, accepted: accepted.length, rejected: rejected.length, deferred: deferred.length },
				'classifier:classify',
			);

			return { accepted, deferred, rejected, decisions };
		},
	};
}

// ---------------------------------------------------------------------------
// Detection (D6 step 1)
// ---------------------------------------------------------------------------

interface DetectedSpan {
	readonly text: string;
}

/**
 * Heuristic spans: split the input into sentence-ish fragments and
 * keep ones containing assertion-marker phrases. Crude on purpose --
 * Layer 1 + Layer 2 do the real classification.
 */
function detectAssertionSpans(text: string): DetectedSpan[] {
	const ASSERTION_MARKERS = /\b(always|never|remember|use [a-z0-9_-]+ for [a-z0-9_-]+|do not|don't|avoid|prefer|require|must|should not)\b/i;
	// Split on sentence terminators + line breaks.
	const fragments = text.split(/[.!?\n]+/).map(s => s.trim()).filter(s => s.length > 0);
	const out: DetectedSpan[] = [];
	for (const f of fragments) {
		if (ASSERTION_MARKERS.test(f)) {
			out.push({ text: f });
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Layer 1: heuristic classify
// ---------------------------------------------------------------------------

interface Layer1Verdict {
	readonly decision:   ClassifierDecision;
	readonly confidence: number;
	readonly subject?:   string;
	readonly polarity?:  AssertionPolarity;
	readonly reason?:    string;
}

const TASK_LOCAL_PATTERNS = /\b(this (pr|bug|file|function|method|class|task)|for this|in this (file|pr|commit))\b/i;
const IMPERATIVE_GENERAL  = /^(always|never|remember|use|prefer|avoid|do not|don't|require)\b/i;

function layer1Classify(span: DetectedSpan): Layer1Verdict {
	const text = span.text;

	// Strong reject: explicit task-local anchors.
	if (TASK_LOCAL_PATTERNS.test(text)) {
		return { decision: 'reject', confidence: 0.9, reason: 'task-local language' };
	}

	// Strong accept: imperative form at the start AND no task-local anchors.
	if (IMPERATIVE_GENERAL.test(text)) {
		const subject = extractSubject(text);
		const polarity = extractPolarity(text);
		return {
			decision:   'accept',
			confidence: 0.8,
			...(subject  !== undefined ? { subject  } : {}),
			...(polarity !== undefined ? { polarity } : {}),
			reason:     'imperative + general phrasing',
		};
	}

	// Anything else: defer to Layer 2.
	return { decision: 'defer', confidence: 0.3, reason: 'no strong heuristic signal' };
}

/**
 * Best-effort subject extraction. Returns a normalized lowercase
 * phrase that consumer skills can declare as their `subjectPattern`.
 * Heuristic only -- the LLM (Layer 2) does the real subject naming.
 */
function extractSubject(text: string): string | undefined {
	// "use X for Y" -> "X-for-Y"
	const useFor = text.match(/use\s+([a-z0-9_-]+)\s+for\s+([a-z0-9_-]+)/i);
	if (useFor !== null) {
		return `${useFor[1]!.toLowerCase()}-for-${useFor[2]!.toLowerCase()}`;
	}
	// "always|never|avoid|do not <token>"
	const verb = text.match(/^(always|never|avoid|do not|don't|prefer|require)\s+([a-z0-9_-]+)/i);
	if (verb !== null) {
		return verb[2]!.toLowerCase();
	}
	// "remember <token>"
	const remember = text.match(/^remember\s+([a-z0-9_-]+)/i);
	if (remember !== null) {
		return remember[1]!.toLowerCase();
	}
	return undefined;
}

function extractPolarity(text: string): AssertionPolarity | undefined {
	if (/^(never|avoid|do not|don't)\b/i.test(text)) { return 'avoid'; }
	if (/^(always|require|must)\b/i.test(text))      { return 'do'; }
	if (/^(prefer)\b/i.test(text))                    { return 'preference'; }
	if (/^(use)\b/i.test(text))                       { return 'value-set'; }
	return undefined;
}
