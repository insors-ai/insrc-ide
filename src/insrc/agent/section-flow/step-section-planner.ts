/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Section planner step (planner-section-task-separation P3.a).
 *
 * Per-TODO LLM call that emits a `PlannedTree` shaped per Q3's Option
 * B -- a top-level composition whose direct children are "reviewable
 * roots" the orchestrator iterates over (typically discover / analyze
 * / synthesize phases). Only the FINAL reviewable root has
 * `emit: section`; earlier roots use `emit: finding` so their outputs
 * flow into the working-memory bundle but don't compose the final
 * markdown.
 *
 * Validation runs in two passes:
 *   1. `validatePlannedTree` -- structural constraints (id uniqueness,
 *      wiring source visibility, depth + leaf caps, schema fit).
 *   2. `isDegenerateShape`   -- the Q2 backstop rule that catches the
 *      live-test single-chain failure (the planner mimicking a 3-leaf
 *      single-branch example and producing only 1 section).
 *
 * On either failure, one corrective retry with the rejection reason
 * surfaced verbatim. Second failure throws (Q9 recoverable; the TODO
 * orchestrator's L2 fallback in P3.d takes over).
 *
 * Trivial fast-path TODOs (Q4) bypass this step entirely -- the TODO
 * orchestrator constructs a single-leaf PlannedTree directly.
 */

import {
	validatePlannedTree,
	isDegenerateShape,
	type PlannedTree,
	type PlannedNode,
	type DegenerateShapeOpts,
} from '../content-gen/plan-tree.js';
import type { CatalogSkill } from '../content-gen/plan-tree-runner.js';
import type { LLMMessage, LLMProvider } from '../../shared/types.js';
import type { TodoSpec } from './types.js';
import type { MemoryShapeBundle } from '../working-memory/index.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('section-flow:section-planner');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SectionPlannerInput {
	/** The TODO this section will fulfill (Step 2 output). */
	readonly todo: TodoSpec;
	/** L1-L5 memory bundle for this TODO iteration (P1.c shapeMemory / P1.d incrementalUpdate output). */
	readonly memory: MemoryShapeBundle;
	/**
	 * Skill catalog the planner may compose leaves from. When non-empty,
	 * every emitted `leaf.skill` is validated against this set; unknown
	 * ids trigger the corrective retry with the catalog reiterated in the
	 * rejection reason. When undefined / empty, no id validation runs --
	 * suitable for unit tests using scripted providers; production callers
	 * must always pass a real catalog (see `data-analyzer-orchestrator`).
	 */
	readonly catalog?: readonly CatalogSkill[] | undefined;
	readonly provider: LLMProvider;
	/** Override the degenerate-shape thresholds. Default opts apply when omitted. */
	readonly degenerateOpts?: DegenerateShapeOpts | undefined;
}

export interface SectionPlannerResult {
	readonly tree: PlannedTree;
	/** Whether validation needed a corrective retry. */
	readonly retried: boolean;
	/** First-attempt failure reason (telemetry only; undefined when first pass succeeded). */
	readonly firstFailureReason?: string | undefined;
}

export async function runSectionPlanner(
	input: SectionPlannerInput,
): Promise<SectionPlannerResult> {
	const catalogIds = buildCatalogIdSet(input.catalog);
	const firstAttempt = await callPlanner(input, false, undefined);
	const firstValidation = validateAll(firstAttempt.raw, input.degenerateOpts, catalogIds);
	if (firstValidation.ok) {
		log.info({ todoId: input.todo.id, reviewableRoots: firstValidation.tree.root.children?.length ?? 0 }, 'section planner: first-attempt validated');
		return { tree: firstValidation.tree, retried: false };
	}

	log.warn({ todoId: input.todo.id, reason: firstValidation.reason }, 'section planner: first-attempt rejected; retrying with corrective hint');

	const retry = await callPlanner(input, true, firstValidation.reason);
	const retryValidation = validateAll(retry.raw, input.degenerateOpts, catalogIds);
	if (!retryValidation.ok) {
		throw new Error(`section planner validation failed after retry: ${retryValidation.reason}`);
	}
	log.info({ todoId: input.todo.id, reviewableRoots: retryValidation.tree.root.children?.length ?? 0 }, 'section planner: retry validated');
	return {
		tree: retryValidation.tree,
		retried: true,
		firstFailureReason: firstValidation.reason,
	};
}

function buildCatalogIdSet(catalog: readonly CatalogSkill[] | undefined): ReadonlySet<string> | undefined {
	if (catalog === undefined || catalog.length === 0) { return undefined; }
	return new Set(catalog.map(c => c.id));
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

interface PlannerRaw {
	readonly raw: string;
}

async function callPlanner(
	input: SectionPlannerInput,
	isRetry: boolean,
	priorFailureReason: string | undefined,
): Promise<PlannerRaw> {
	const messages: LLMMessage[] = [
		{ role: 'system', content: PLANNER_ROLE },
		{ role: 'user',   content: buildPlannerUser(input, isRetry, priorFailureReason) },
	];
	const response = await input.provider.complete(messages, {
		maxTokens:       3072,
		temperature:     0,
		responseFormat:  'json',
		disableThinking: true,
	});
	return { raw: response.text };
}

const PLANNER_ROLE = [
	'You are the SECTION PLANNER for one TODO of an investigation report.',
	'You produce a typed task tree (`PlannedTree`) the orchestrator will',
	'execute. The tree\'s top-level node MUST be a composition; its direct',
	'children are REVIEWABLE ROOTS -- the orchestrator iterates over them',
	'and runs the per-root review loop after each finishes.',
	'',
	'You emit a SINGLE JSON object matching the PlannedTree schema. No',
	'prose, no markdown fences, no preamble.',
].join('\n');

function buildPlannerUser(
	input: SectionPlannerInput,
	isRetry: boolean,
	priorFailureReason: string | undefined,
): string {
	const memoryBlock = renderMemory(input.memory);
	const catalogBlock = renderCatalog(input.catalog);
	const catalogRule = catalogBlock.length > 0
		? '  - Every `leaf.skill` MUST be an id listed in the SKILL CATALOG section below. Ids not in the catalog will be rejected.'
		: '';
	const retryAddendum = isRetry
		? [
			'',
			'## RETRY CORRECTION',
			`Your previous tree was rejected with reason:`,
			`  ${priorFailureReason ?? 'unknown'}`,
			'',
			'Fix ONLY the issue cited above. Keep the rest of your previous',
			'emission IDENTICAL -- same composition structure, same ids, same',
			'titles, same objectives, same `inputs` bindings (each binding is',
			'an OBJECT like `{"source":"node","nodeId":"...","path":"..."}` --',
			'do NOT replace it with a string and do NOT confuse it with',
			'`leaf.skill`), same `emit` values. Re-emit the full tree with',
			'just the cited fix applied.',
			'',
		].join('\n')
		: '';

	const workedExampleHeader = catalogBlock.length > 0
		? '## WORKED EXAMPLE (illustrative SHAPE only; the `skill` ids shown\n## below are PLACEHOLDERS. You MUST replace them with ids from the\n## skill catalog section further down.)'
		: '## WORKED EXAMPLE (a TODO about "Analyze GRN field mappings")';

	const lines: string[] = [
		'## TODO OBJECTIVE',
		input.todo.objective,
		'',
		'## WORKING MEMORY (L1-L5 bundle)',
		memoryBlock,
		'',
		'## REVIEWABLE-ROOT CONTRACT (Q3 Option B)',
		'The top-level node MUST be a composition (`kind: "composition"`),',
		'`composition: "sequence"` by default. Each direct child of the',
		'top-level composition is one reviewable root. Prefer 2-5 reviewable',
		'roots covering: discover (find facts) -> analyze (interpret) ->',
		'synthesize (render the section).',
		'',
		'Only the FINAL reviewable root may set `emit: "section"` (it produces',
		'the section markdown). Earlier roots use `emit: "intermediate"` so',
		'their outputs flow into working memory as findings but do not compose',
		'the final markdown.',
		'',
		'Cross-root data flow uses inputs.{nodeId, path}. The id may name an',
		'ancestor OR an earlier reviewable-root composition; deeper nodes in',
		'OTHER reviewable roots are not directly addressable (read the',
		'composition\'s aggregate output instead).',
		'',
		workedExampleHeader,
		WORKED_EXAMPLE_JSON,
		'',
		'## OUTPUT RULES',
		'  - Top-level node MUST be a composition.',
		'  - Top-level composition MUST have >= 2 children (reviewable roots).',
		'  - Each reviewable root MAY itself be a composition (for nested',
		'    discover/analyze phases) or a leaf.',
		'  - `emit: "section"` allowed ONLY on the final reviewable root.',
		'  - Prefer BREADTH (multiple roots) over DEPTH (linear chains).',
		'  - All ids are kebab-case strings, unique within the tree.',
	];
	if (catalogRule.length > 0) { lines.push(catalogRule); }
	lines.push(retryAddendum);
	if (catalogBlock.length > 0) {
		lines.push('');
		lines.push(catalogBlock);
	}
	lines.push('');
	lines.push('## TASK');
	lines.push('Emit the PlannedTree JSON object now. Begin with "{" and end with "}".');
	return lines.join('\n');
}

function renderCatalog(catalog: readonly CatalogSkill[] | undefined): string {
	if (catalog === undefined || catalog.length === 0) { return ''; }
	const lines: string[] = [`## SKILL CATALOG (${catalog.length} skills available; use these ids verbatim in \`leaf.skill\`)`];
	for (const s of catalog) {
		const desc = s.description.replace(/\s+/g, ' ').trim().slice(0, 160);
		lines.push(`- \`${s.id}\` [${s.owner}/${s.family}] -- ${desc}`);
	}
	return lines.join('\n');
}

function renderMemory(memory: MemoryShapeBundle): string {
	const lines: string[] = [];
	if (memory.system.length > 0)   { lines.push('### system\n' + memory.system); }
	if (memory.summary.length > 0)  { lines.push('### summary\n' + memory.summary); }
	if (memory.recent.length > 0)   { lines.push('### recent\n' + memory.recent); }
	if (memory.semantic.length > 0) { lines.push('### semantic\n' + memory.semantic); }
	if (memory.code.length > 0)     { lines.push('### code\n' + memory.code); }
	return lines.length > 0 ? lines.join('\n\n') : '(empty -- this is the first TODO of the report)';
}

// The worked example is deliberately illustrative, not prescriptive.
// It demonstrates: top-level composition, 3 reviewable roots, mixed
// leaf + composition shapes, cross-root data flow via inputs.nodeId,
// emit:section only on the final root.
const WORKED_EXAMPLE_JSON = `\
{
  "intentBrief": "Analyze GRN field mappings",
  "root": {
    "id": "root",
    "title": "Analyze GRN field mappings",
    "objective": "Produce a section comparing GRN data shape against the pydantic class",
    "kind": "composition",
    "composition": "sequence",
    "inputs": {},
    "emit": "intermediate",
    "children": [
      {
        "id": "discover",
        "title": "Discover data shapes",
        "objective": "Surface both source and target shapes",
        "kind": "composition",
        "composition": "sequence",
        "inputs": {},
        "emit": "intermediate",
        "children": [
          {
            "id": "data-shape",
            "title": "Read sample GRN payload",
            "objective": "Extract the field set and types from sample data",
            "kind": "leaf",
            "skill": "data.profile-shape",
            "inputs": {},
            "emit": "intermediate"
          },
          {
            "id": "class-fields",
            "title": "Read pydantic class fields",
            "objective": "Extract the class field set and validators",
            "kind": "leaf",
            "skill": "code.list-class-fields",
            "inputs": {},
            "emit": "intermediate"
          }
        ]
      },
      {
        "id": "analyze",
        "title": "Compare shapes",
        "objective": "Surface mapping gaps and type mismatches",
        "kind": "composition",
        "composition": "sequence",
        "inputs": {},
        "emit": "intermediate",
        "children": [
          {
            "id": "compare",
            "title": "Field-level compare",
            "objective": "Diff the discovered shape vs the class field set",
            "kind": "leaf",
            "skill": "shared.compare-fields-vs-shape",
            "inputs": {
              "discoveries": { "source": "node", "nodeId": "discover", "path": "$" }
            },
            "emit": "intermediate"
          }
        ]
      },
      {
        "id": "synthesize",
        "title": "Write section markdown",
        "objective": "Render the mapping comparison as a report section",
        "kind": "composition",
        "composition": "sequence",
        "inputs": {},
        "emit": "section",
        "children": [
          {
            "id": "write-section",
            "title": "Write the markdown",
            "objective": "Compose the section markdown",
            "kind": "leaf",
            "skill": "shared.write-section",
            "inputs": {
              "analysis": { "source": "node", "nodeId": "analyze", "path": "$" }
            },
            "emit": "section"
          }
        ]
      }
    ]
  }
}`;

// ---------------------------------------------------------------------------
// Validation passes
// ---------------------------------------------------------------------------

interface ValidationOk {
	readonly ok:   true;
	readonly tree: PlannedTree;
}

interface ValidationErr {
	readonly ok:     false;
	readonly reason: string;
}

type ValidationResult = ValidationOk | ValidationErr;

function validateAll(
	raw: string,
	degenerateOpts: DegenerateShapeOpts | undefined,
	catalogIds: ReadonlySet<string> | undefined,
): ValidationResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripFences(raw));
	} catch (err) {
		return { ok: false, reason: `JSON parse failed: ${(err as Error).message}` };
	}

	// Structural validation (id uniqueness, depth + leaf caps, schema fit).
	const structural = validatePlannedTree(parsed);
	if (typeof structural === 'string') {
		return { ok: false, reason: `structural: ${structural}` };
	}

	// Degenerate-shape rule (Q2 backstop).
	const degenerate = isDegenerateShape(structural, degenerateOpts ?? {});
	if (degenerate !== null) {
		return { ok: false, reason: degenerate };
	}

	// Catalog-membership check (GAP A fix). Only runs when the caller
	// supplied a catalog. Listing the unknown ids verbatim is what gives
	// the corrective retry a concrete hint to act on.
	if (catalogIds !== undefined) {
		const unknown = collectUnknownSkillIds(structural, catalogIds);
		if (unknown.length > 0) {
			const list = unknown.map(u => `'${u}'`).join(', ');
			return {
				ok: false,
				reason: `unknown skill id(s) in plan: ${list}. Every \`leaf.skill\` MUST be an id from the SKILL CATALOG section.`,
			};
		}
	}

	return { ok: true, tree: structural };
}

function collectUnknownSkillIds(tree: PlannedTree, catalog: ReadonlySet<string>): readonly string[] {
	const unknown = new Set<string>();
	const visit = (node: PlannedNode): void => {
		if (node.kind === 'leaf') {
			if (typeof node.skill === 'string' && node.skill.length > 0 && !catalog.has(node.skill)) {
				unknown.add(node.skill);
			}
			return;
		}
		for (const child of node.children ?? []) { visit(child); }
	};
	visit(tree.root);
	return [...unknown];
}

function stripFences(text: string): string {
	let out = text.trim();
	if (out.startsWith('```')) {
		out = out.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
	}
	return out.trim();
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _validateAllForTest        = validateAll;
export const _renderMemoryForTest       = renderMemory;
export const _renderCatalogForTest      = renderCatalog;
export const _stripFencesForTest        = stripFences;
export const WORKED_EXAMPLE_JSON_VALUE  = WORKED_EXAMPLE_JSON;
