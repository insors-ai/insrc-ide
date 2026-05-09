/**
 * Tests for `skill_describe` (data-analyzer-skills §7.1 dependency).
 *
 * The tool is a thin read against the in-memory skill registry. Tests:
 *   - existing skill -> returns manifest with id / name / family / owner
 *     / version / description / inputs / outputs / preconditions /
 *     providerAffinity / toolDeps
 *   - missing skill -> success: false with a clear error
 *   - empty id -> success: false with 'id required'
 *   - version mismatch -> success: false (version pin not satisfied)
 *
 * No daemon, no IPC; the tool's execute() runs against the registry
 * loaded by registerAllSkills().
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerAllSkills } from '../../../../skills/index.js';
import {
	getSkill,
	_resetSkillRegistryForTests,
} from '../../../../skills/registry.js';
import { _resetRegistryForTests, getTool } from '../../../registry.js';
import { registerSkillTools } from '../invoke-skill.js';
import type { Tool, ToolDeps, ToolResult } from '../../../types.js';

// Minimal ToolDeps stub. skill_describe doesn't read anything from
// deps -- its execute signature accepts (input, _deps) and ignores
// the second arg.
const stubDeps = {
	session: {} as ToolDeps['session'],
	send: () => { /* drop */ },
	requestId: 0,
} as unknown as ToolDeps;

let describeSkillTool: Tool;

test.before(() => {
	_resetSkillRegistryForTests();
	_resetRegistryForTests();
	registerAllSkills();
	registerSkillTools();
	const t = getTool('skill_describe');
	assert.ok(t, 'skill_describe must be registered after registerSkillTools()');
	describeSkillTool = t;
});

test('skill_describe: returns full manifest for an existing skill', async () => {
	const known = 'data.profile.numeric.rdbms';
	// Pre-flight: the registry must actually have the skill we're asking about.
	assert.ok(getSkill(known), `${known} must be in the test registry`);

	const result: ToolResult = await describeSkillTool.execute({ id: known }, stubDeps);

	assert.equal(result.success, true);
	assert.equal(result.format, 'markdown');
	assert.match(result.output, new RegExp(`\\*\\*skill:${known.replace(/\./g, '\\.')}\\*\\*`));

	const data = result.data as Record<string, unknown>;
	assert.equal(data['id'], known);
	assert.equal(typeof data['name'], 'string');
	assert.equal(typeof data['family'], 'string');
	assert.equal(typeof data['owner'], 'string');
	assert.equal(typeof data['version'], 'number');
	assert.equal(typeof data['description'], 'string');
	assert.ok(typeof data['inputs'] === 'object' && data['inputs'] !== null);
	assert.ok(typeof data['outputs'] === 'object' && data['outputs'] !== null);
	assert.ok(['local', 'cloud', 'auto'].includes(String(data['providerAffinity'])));
	assert.ok(Array.isArray(data['preconditions']));
	assert.ok(Array.isArray(data['toolDeps']));
});

test('skill_describe: skillDeps surfaces only when the skill has them', async () => {
	// Composite skill -- has skillDeps.
	const composite = 'data.quality.scorecard.rdbms';
	assert.ok(getSkill(composite), `${composite} must be in the test registry`);
	const compResult = await describeSkillTool.execute({ id: composite }, stubDeps);
	assert.equal(compResult.success, true);
	const compData = compResult.data as Record<string, unknown>;
	assert.ok(Array.isArray(compData['skillDeps']));
	assert.ok((compData['skillDeps'] as readonly unknown[]).length > 0,
		'composite skill must have non-empty skillDeps');

	// Atomic skill -- no skillDeps key in the manifest.
	const atomic = 'data.profile.numeric.rdbms';
	const atomicResult = await describeSkillTool.execute({ id: atomic }, stubDeps);
	const atomicData = atomicResult.data as Record<string, unknown>;
	assert.equal(atomicData['skillDeps'], undefined,
		'atomic skill must not surface a skillDeps field');
});

test('skill_describe: unknown skill id returns a clear error', async () => {
	const result = await describeSkillTool.execute({ id: 'data.does.not.exist' }, stubDeps);
	assert.equal(result.success, false);
	assert.match(result.error ?? '', /unknown skill/);
	assert.match(result.output, /no skill registered/);
});

test('skill_describe: empty id returns 400-shape error', async () => {
	const result = await describeSkillTool.execute({ id: '' }, stubDeps);
	assert.equal(result.success, false);
	assert.equal(result.error, 'id required');
});

test('skill_describe: version pin mismatches return unknown', async () => {
	// Ask for v999 of a real skill -- should miss.
	const result = await describeSkillTool.execute(
		{ id: 'data.profile.numeric.rdbms', version: 999 },
		stubDeps,
	);
	assert.equal(result.success, false);
	assert.match(result.output, /no skill registered with id 'data\.profile\.numeric\.rdbms@999'/);
});

test('skill_describe: version pin matches when correct version supplied', async () => {
	const known = 'data.profile.numeric.rdbms';
	const skill = getSkill(known);
	assert.ok(skill);
	const result = await describeSkillTool.execute(
		{ id: known, version: skill.version },
		stubDeps,
	);
	assert.equal(result.success, true);
	const data = result.data as Record<string, unknown>;
	assert.equal(data['version'], skill.version);
});
