/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Live test: step-section-planner -- per-TODO PlannedTree emission.
 * This is the test that validates the GAP A fix end-to-end against
 * the local model.
 *
 *   - Validator must accept the tree.
 *   - Every `leaf.skill` must appear in the catalog (no hallucinated
 *     ids). When the catalog is wired correctly this should pass on
 *     the first attempt; previously the model invented ids because
 *     the catalog was never surfaced.
 *   - At least 2 reviewable roots (no degenerate single-chain).
 *
 * The catalog is built from the live skill registry (data-analyzer +
 * shared owners), matching what `data-analyzer-orchestrator` wires
 * in production after the fix. Importing `built-ins/index` registers
 * every skill side-effect so the registry is populated.
 *
 * Run: source ~/.insors && npx tsx scripts/live-section-flow/02-section-planner.ts
 */

import { runSectionPlanner } from '../../src/insrc/agent/section-flow/step-section-planner.js';
import { buildCatalogFromRegistry } from '../../src/insrc/agent/content-gen/plan-tree-helpers.js';
import type { MemoryShapeBundle } from '../../src/insrc/agent/working-memory/index.js';
import type { TodoSpec } from '../../src/insrc/agent/section-flow/types.js';
import { registerAllSkills } from '../../src/insrc/daemon/skills/index.js';
import {
	buildOllama, parseArgs, runTrials, combineChecks,
	checkContainsAny, checkNotRefusal,
	type TrialResult,
} from './_lib.js';

const TODO: TodoSpec = {
	id:        'todo-grn-mapping',
	objective: 'Compare a sample JSON GRN payload against the INGRN pydantic class to identify field coverage and type-mismatch risks.',
	origin:    'initial',
};

const MEMORY: MemoryShapeBundle = {
	system:   'You analyze data structures against schema definitions.',
	summary:  'The user is investigating mismatches between JSON test fixtures and the Pydantic models that consume them.',
	recent:   '',
	semantic: '',
	code:     '',
};

const SEED_TERMS = ['grn', 'ingrn', 'field', 'mapping', 'compare', 'data', 'class'];

async function main(): Promise<void> {
	const args = parseArgs(process.argv);
	const provider = buildOllama(args);

	registerAllSkills();
	const catalog = buildCatalogFromRegistry({
		owners:            ['data-analyzer', 'shared'],
		includeL2Fallback: true,
	});
	console.log(`(catalog built: ${catalog.length} skills available)`);

	const exit = await runTrials({
		name: 'step-section-planner',
		args,
		trial: async (i): Promise<TrialResult> => {
			const t0 = Date.now();
			try {
				const result = await runSectionPlanner({
					todo:     TODO,
					memory:   MEMORY,
					catalog,
					provider,
				});
				const dur = Date.now() - t0;

				// Catalog membership is enforced inside `validateAll`; if we got
				// here every leaf.skill is in the catalog. Surface the count.
				const leafCount = countLeaves(result.tree.root);
				const reviewableRoots = result.tree.root.kind === 'composition'
					? (result.tree.root.children?.length ?? 0)
					: 0;

				const skillsUsed = collectSkillIds(result.tree.root);
				const allInCatalog = skillsUsed.every(s => catalog.some(c => c.id === s));

				// NOTE on input bindings: prior to the 2-step executor fix the
				// planner's `leaf.inputs` field was authoritative -- mismatches
				// here meant `invalid-input` at exec time. With shape-resolve
				// wired (see scripts/live-section-flow/10-shape-resolve.ts),
				// the planner's bindings are advisory and the executor's
				// shape-resolve stage maps prior outputs + context -> args at
				// run time. We still surface the mismatch count for telemetry
				// but no longer treat it as a hard signal here.
				const leafInputs = collectLeafInputs(result.tree.root);
				const inputMismatches: string[] = [];
				for (const leaf of leafInputs) {
					const catEntry = catalog.find(c => c.id === leaf.skill);
					if (catEntry === undefined) { continue; }
					const required = extractRequired(catEntry.inputs);
					const provided = Object.keys(leaf.inputs);
					const missing = required.filter(r => !provided.includes(r));
					const extra   = provided.filter(p => !Object.keys(extractProperties(catEntry.inputs)).includes(p));
					if (missing.length > 0 || extra.length > 0) {
						inputMismatches.push(`${leaf.id}[${leaf.skill}] missing=[${missing.join(',')}] extra=[${extra.join(',')}]`);
					}
				}

				const treeText = JSON.stringify(result.tree);
				const checks = [
					checkContainsAny(treeText, SEED_TERMS, 'tree-content'),
					checkNotRefusal(treeText, 'tree-content'),
					allInCatalog ? null : `tree has unknown skill ids (validator gap!)`,
					reviewableRoots >= 2 ? null : `only ${reviewableRoots} reviewable root(s) (want >= 2; Q2 backstop should have caught this)`,
				];
				const { outcome, summary } = combineChecks(checks);
				return {
					outcome,
					summary: `${summary}; ${reviewableRoots} roots, ${leafCount} leaves, retried=${result.retried}, planner-input-mismatches=${inputMismatches.length}/${leafInputs.length} (advisory: shape-resolve handles at exec time)`,
					durationMs: dur,
					details: args.verbose ? {
						intentBrief: result.tree.intentBrief,
						skillsUsed,
						leafInputs: leafInputs.map(l => `${l.id}[${l.skill}]: provided=[${Object.keys(l.inputs).join(',')}]`),
						inputMismatchesAdvisory: inputMismatches,
						retried: result.retried,
						firstFailureReason: result.firstFailureReason ?? '(none)',
					} : { skillsUsed: skillsUsed.join(', '), plannerMismatches: inputMismatches.length },
				};
			} catch (err) {
				const msg = (err as Error).message;
				// The most common failure mode we care to distinguish: the
				// model fixed the skill ids on retry but mangled the
				// inputs-binding DSL. That's a separate prompt-quality
				// issue from the GAP A catalog-membership check.
				const isBindingShape = /binding is not an object|inputs\..*\..*binding/i.test(msg);
				const tag = isBindingShape ? 'inputs-binding DSL mismatch (separate from catalog)' : msg;
				return {
					outcome:    'fail',
					summary:    `runSectionPlanner threw: ${tag}`,
					durationMs: Date.now() - t0,
				};
			}
		},
	});

	process.exit(exit);
}

function countLeaves(node: { kind: string; children?: readonly unknown[] }): number {
	if (node.kind === 'leaf') { return 1; }
	const children = (node.children ?? []) as { kind: string; children?: readonly unknown[] }[];
	let n = 0;
	for (const c of children) { n += countLeaves(c); }
	return n;
}

function collectSkillIds(node: { kind: string; skill?: string; children?: readonly unknown[] }): string[] {
	if (node.kind === 'leaf') { return node.skill !== undefined ? [node.skill] : []; }
	const children = (node.children ?? []) as { kind: string; skill?: string; children?: readonly unknown[] }[];
	const ids: string[] = [];
	for (const c of children) { ids.push(...collectSkillIds(c)); }
	return ids;
}

interface LeafSnapshot {
	readonly id:     string;
	readonly skill:  string;
	readonly inputs: Readonly<Record<string, unknown>>;
}

function collectLeafInputs(node: { kind: string; id?: string; skill?: string; inputs?: Readonly<Record<string, unknown>>; children?: readonly unknown[] }): LeafSnapshot[] {
	if (node.kind === 'leaf') {
		return [{
			id:     node.id ?? '<no-id>',
			skill:  node.skill ?? '<no-skill>',
			inputs: node.inputs ?? {},
		}];
	}
	const children = (node.children ?? []) as { kind: string; id?: string; skill?: string; inputs?: Readonly<Record<string, unknown>>; children?: readonly unknown[] }[];
	const out: LeafSnapshot[] = [];
	for (const c of children) { out.push(...collectLeafInputs(c)); }
	return out;
}

// Pull the `required` array from a JSON Schema object (root-level only).
function extractRequired(schema: Readonly<Record<string, unknown>>): string[] {
	const req = schema['required'];
	if (!Array.isArray(req)) { return []; }
	return req.filter((r): r is string => typeof r === 'string');
}

function extractProperties(schema: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
	const props = schema['properties'];
	if (props === null || typeof props !== 'object' || Array.isArray(props)) { return {}; }
	return props as Readonly<Record<string, unknown>>;
}

void main();
