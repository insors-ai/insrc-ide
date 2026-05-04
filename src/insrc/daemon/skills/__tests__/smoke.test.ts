/**
 * Skill smoke-test gate (plans/analyzers/skills-core.md Phase 8.2).
 *
 * Walks every registered skill, loads its co-located fixture from
 * `daemon/skills/__fixtures__/<id>.json`, runs it through
 * `runSkillIsolated`, and asserts:
 *
 *   - the result.confidence is at least the fixture's
 *     expectedConfidenceFloor (high > medium > low)
 *   - if the fixture sets expectedConfidence exactly, the result
 *     matches it (lets a fixture pin "low" to assert a degraded path)
 *
 * Schema validation of the output value is enforced by runSkill
 * itself: an output that fails the declared output schema clamps the
 * confidence to 'low' (invoke.ts confidence-calibration step), so a
 * confidence-floor of 'medium' or higher transitively asserts a
 * schema-valid output.
 *
 * Every registered skill MUST have a fixture -- a missing fixture
 * fails the test, which is the gate the plan specifies. No silent
 * skipping; that's how `data` family was missing from
 * enabledCategories on 2026-04-30.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerAllSkills } from '../index.js';
import { listSkills } from '../registry.js';
import { runSkillIsolated, type FakeToolMap } from '../test-harness.js';
import type { SkillConfidence } from '../types.js';
// Register the real db tool definitions so the harness can validate
// each skill's tool-call inputs against the actual inputSchemas. This
// catches "skill passes a field the tool's schema doesn't accept"
// regressions (e.g. the 5f.2 drift.volume bug where the skill
// threaded `where` to a tool whose schema was `additionalProperties:
// false`). Pure registrations -- no DB clients or other side effects.
import { registerDbTools } from '../../tools/builtins/db/index.js';
registerDbTools();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const FIXTURES_DIR = resolve(__dirname, '..', '__fixtures__');

const CONFIDENCE_RANK: Record<SkillConfidence, number> = {
  high: 2,
  medium: 1,
  low: 0,
};

interface Fixture {
  input: unknown;
  fakeTools?: FakeToolMap;
  expectedConfidenceFloor: SkillConfidence;
  expectedConfidence?: SkillConfidence;
}

function loadFixture(skillId: string): Fixture {
  const path = resolve(FIXTURES_DIR, `${skillId}.json`);
  assert.ok(
    existsSync(path),
    `missing fixture: ${path}\n` +
    `Every skill must ship a co-located fixture at ` +
    `daemon/skills/__fixtures__/<id>.json with at least ` +
    `{ input, expectedConfidenceFloor }.`,
  );
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as Fixture;
  assert.ok(
    typeof parsed.input === 'object' || typeof parsed.input === 'string',
    `${skillId}: fixture.input is required`,
  );
  assert.ok(
    parsed.expectedConfidenceFloor === 'high'
      || parsed.expectedConfidenceFloor === 'medium'
      || parsed.expectedConfidenceFloor === 'low',
    `${skillId}: fixture.expectedConfidenceFloor must be one of high|medium|low`,
  );
  return parsed;
}

// Register every skill once before generating the per-skill subtests.
// Subsequent calls are idempotent (the registry warns and overwrites)
// but we only want one call per process for cleaner output.
registerAllSkills();

const skills = listSkills();
assert.ok(
  skills.length > 0,
  'no skills registered -- registerAllSkills() did not populate the registry',
);

for (const skill of skills) {
  test(`smoke: ${skill.id}`, async () => {
    const fixture = loadFixture(skill.id);
    const { result, events } = await runSkillIsolated(
      skill.id,
      fixture.input,
      {
        ...(fixture.fakeTools !== undefined ? { fakeTools: fixture.fakeTools } : {}),
      },
    );

    const floor = fixture.expectedConfidenceFloor;
    assert.ok(
      CONFIDENCE_RANK[result.confidence] >= CONFIDENCE_RANK[floor],
      `confidence ${result.confidence} below floor ${floor}\n` +
      `notes: ${(result.notes ?? []).join('; ')}\n` +
      `tool calls: ${result.toolCalls.map(t => `${t.toolId}${t.error !== undefined ? ' (err)' : ''}`).join(', ')}`,
    );

    if (fixture.expectedConfidence !== undefined) {
      assert.equal(
        result.confidence,
        fixture.expectedConfidence,
        `expected exact confidence ${fixture.expectedConfidence}, got ${result.confidence}`,
      );
    }

    // Telemetry sanity: every successful run emits at least skill-start +
    // skill-feasibility + skill-end. A test missing those means the
    // runner short-circuited somewhere unusual -- fail with the trace.
    const kinds = events.map(e => e.kind);
    assert.ok(kinds.includes('skill-start'),  `${skill.id}: no skill-start event (${kinds.join(',')})`);
    assert.ok(kinds.includes('skill-end'),    `${skill.id}: no skill-end event (${kinds.join(',')})`);
  });
}
