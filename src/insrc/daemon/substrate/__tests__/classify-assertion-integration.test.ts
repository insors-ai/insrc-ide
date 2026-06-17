/**
 * `runtime.classifyAssertion` integration tests -- part of P5.6.
 *
 * Exercises the full P5 flow end-to-end:
 *   classifier -> index lookup -> per-target persist + bus dispatch.
 *
 * Coverage:
 *   - Accepted Layer-1 assertion routes through the assertion index
 *     to a registered skill; the constraint is persisted to that
 *     owner's user-assertions namespace; applyFeedback fires.
 *   - Payload with explicit targetOwners bypasses the index lookup.
 *   - Subject with no matching index entry -> no persist, no dispatch.
 *   - Rejected span never reaches the index or the bus.
 *   - Skill without an applyFeedback handler still gets the memory
 *     write; the bus dispatch is a no-op.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryStore } from '../memory-store.js';
import { createSubstrateRuntime, type SubstrateRuntime } from '../runtime.js';
import type { FeedbackEvent, SubstrateSkillExtension } from '../types.js';
import type { Skill } from '../../skills/types.js';

// ---------------------------------------------------------------------------

interface Fx {
	readonly substrate: SubstrateRuntime;
	dispose(): void;
}

function fx(): Fx {
	const root = mkdtempSync(join(tmpdir(), 'insrc-substrate-p5int-'));
	const memory = createMemoryStore({ workspaceId: 'wsP5', rootDir: root });
	// G1+G3 reframing: Layer 1 now defers all plausible assertions to Layer 2.
	// Provide a scripted Layer 2 hook that pulls the Layer 1-extracted heuristic
	// subject out of the prompt span so the integration tests' assertion-routing
	// behaviour remains intact.
	const llmClassify: import('../classifier/user-assertion.js').LlmClassifyHook = async (span, hints) => {
		const subj = extractHeuristicSubjectFromSpan(span);
		if (subj === undefined) {
			return { kind: 'defer', reason: 'no subject extractable' };
		}
		return {
			kind: 'accept',
			payload: {
				text:         span,
				subject:      subj,
				polarity:     'preference',
				scope:        'workspace',
				targetOwners: [],
				confidence:   0.9,
				...(hints.layer1 === 'defer' ? {} : {}),
			},
		};
	};
	const substrate = createSubstrateRuntime({ memory, classifier: { llmClassify } });
	return {
		substrate,
		dispose: () => rmSync(root, { recursive: true, force: true }),
	};
}

/** Layer-1-equivalent subject extraction used by the scripted Layer 2 in tests. */
function extractHeuristicSubjectFromSpan(span: string): string | undefined {
	const useFor = span.match(/use\s+([a-z0-9_-]+)\s+for\s+([a-z0-9_-]+)/i);
	if (useFor !== null) {
		return `${useFor[1]!.toLowerCase()}-for-${useFor[2]!.toLowerCase()}`;
	}
	const verb = span.match(/^(always|never|avoid|do not|don't|prefer|require)\s+([a-z0-9_-]+)/i);
	if (verb !== null) {
		return verb[2]!.toLowerCase();
	}
	return undefined;
}

function makeSkill(opts: {
	readonly id:                  string;
	readonly assertionInterests?: SubstrateSkillExtension['assertionInterests'];
	readonly applyFeedback?:      (events: readonly FeedbackEvent[]) => void;
}): Skill {
	const stub: Record<string, unknown> = {
		id:                  opts.id,
		name:                opts.id,
		family:              'test',
		ownerId:             `skill:${opts.id}`,
		...(opts.assertionInterests !== undefined
			? { assertionInterests: opts.assertionInterests }
			: {}),
		...(opts.applyFeedback !== undefined
			? { applyFeedback: async (events: readonly FeedbackEvent[]) => { opts.applyFeedback!(events); } }
			: {}),
	};
	return stub as unknown as Skill;
}

// ---------------------------------------------------------------------------

test('integration: assertion routes through index, persists + dispatches', async () => {
	const f = fx();
	try {
		const received: FeedbackEvent[] = [];
		// The classifier's "use X for Y" extractor emits subject of the
		// form `<x>-for-<y>`, so style.linter declares interest in that
		// canonical shape.
		const skill = makeSkill({
			id:                 'style.linter',
			assertionInterests: [{ subjectPattern: 'snake_case-for-python', description: 'snake_case style rule for python' }],
			applyFeedback:      (events) => { received.push(...events); },
		});
		f.substrate.registerSkill(skill);

		const r = await f.substrate.classifyAssertion({
			turnId: 'turn-1',
			text:   'always use snake_case for python variables.',
		});

		assert.equal(r.classification.accepted.length, 1);
		assert.equal(r.persisted.length, 1);
		assert.equal(r.persisted[0]!.owner, 'skill:style.linter');
		assert.equal(r.dispatched.length, 1);

		// Verify memory write.
		const stored = await f.substrate.memory
			.scope('skill:style.linter', 'user-assertions')
			.get('turn-1::snake_case-for-python');
		assert.ok(stored, 'constraint should be persisted under user-assertions');
		assert.equal(stored.kind, 'constraint');

		// Verify feedback dispatch.
		assert.equal(received.length, 1);
		assert.equal(received[0]!.kind, 'user-correction');
		assert.equal(received[0]!.targetOwner, 'skill:style.linter');
	} finally { f.dispose(); }
});

test('integration: explicit targetOwners on payload bypasses index lookup', async () => {
	const f = fx();
	try {
		const received: FeedbackEvent[] = [];
		// Register a skill but DON'T declare assertionInterests; we'll
		// route to it explicitly via custom classifier.
		const skill = makeSkill({
			id:            'explicit-target',
			applyFeedback: (events) => { received.push(...events); },
		});
		f.substrate.registerSkill(skill);

		// Custom classifier that names a specific owner.
		const substrate = createSubstrateRuntime({
			memory: f.substrate.memory,
			customClassifier: {
				async classify({ turnId, text }) {
					return {
						accepted: [{
							text,
							subject:      'whatever',
							polarity:     'preference',
							scope:        'workspace',
							targetOwners: ['skill:explicit-target'],
							confidence:   1.0,
						}],
						rejected:  [],
						deferred:  [],
						decisions: [{ turnId, span: text, layer: 1, decision: 'accept', confidence: 1.0 }],
					};
				},
			},
		});
		substrate.registerSkill(skill);

		const r = await substrate.classifyAssertion({ turnId: 'turn-2', text: 'route to explicit target' });
		assert.equal(r.persisted.length,  1);
		assert.equal(r.dispatched.length, 1);
		assert.equal(r.dispatched[0]!.owner, 'skill:explicit-target');
		assert.equal(received.length, 1);
	} finally { f.dispose(); }
});

test('integration: subject with no index match -> no persist, no dispatch', async () => {
	const f = fx();
	try {
		// No skill registered with assertionInterests for the subject.
		const r = await f.substrate.classifyAssertion({
			turnId: 'turn-3',
			text:   'always use snake_case for variables.',  // 'use' subject not claimed
		});
		assert.equal(r.classification.accepted.length, 1, 'classifier still accepted');
		assert.equal(r.persisted.length,  0);
		assert.equal(r.dispatched.length, 0);
	} finally { f.dispose(); }
});

test('integration: rejected span never persists', async () => {
	const f = fx();
	try {
		const received: FeedbackEvent[] = [];
		const skill = makeSkill({
			id:                 'style.linter',
			assertionInterests: [{ subjectPattern: 'naming', description: '' }],
			applyFeedback:      (events) => { received.push(...events); },
		});
		f.substrate.registerSkill(skill);

		const r = await f.substrate.classifyAssertion({
			turnId: 'turn-4',
			text:   'for this PR, do not change the naming convention.',
		});
		assert.equal(r.classification.accepted.length, 0);
		assert.equal(r.classification.rejected.length, 1);
		assert.equal(r.persisted.length,  0);
		assert.equal(r.dispatched.length, 0);
		assert.equal(received.length,     0);
	} finally { f.dispose(); }
});

test('integration: skill without applyFeedback still gets the memory write', async () => {
	const f = fx();
	try {
		// 'always use ruff for linting' -> extracted subject 'ruff-for-linting'.
		const skill = makeSkill({
			id:                 'silent.skill',
			assertionInterests: [{ subjectPattern: 'ruff-for-linting', description: '' }],
		});
		f.substrate.registerSkill(skill);

		const r = await f.substrate.classifyAssertion({
			turnId: 'turn-5',
			text:   'always use ruff for linting.',
		});
		assert.equal(r.persisted.length,  1);
		// dispatched still 1 -- the bus.emit completes with delivered:0
		// but the runtime still reports it as dispatched (the event was
		// sent to the bus regardless of whether anyone was subscribed).
		assert.equal(r.dispatched.length, 1);

		const stored = await f.substrate.memory
			.scope('skill:silent.skill', 'user-assertions')
			.get('turn-5::ruff-for-linting');
		assert.ok(stored, 'persisted regardless of feedback subscription');
	} finally { f.dispose(); }
});
