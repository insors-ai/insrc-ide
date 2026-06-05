/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Section assembly (planner-section-task-separation P3.c, part 1).
 *
 * Deterministic extraction of the candidate section markdown from the
 * per-root findings. No LLM call. Per Q3's resolution, only the FINAL
 * reviewable root carries `emit: 'section'`; its finding holds the
 * markdown the orchestrator threads into the section review (P3.c,
 * part 2) and ultimately into the working-memory entry's `detail`
 * slot (Q1).
 *
 * Fallbacks (in order):
 *   1. The reviewable root whose `emit === 'section'` contributes the
 *      markdown.
 *   2. If no root emitted a section but findings exist, use the last
 *      finding's content (defensive -- the section planner's
 *      degenerate-shape check should already have rejected this).
 *   3. If there are no findings, return a structured "(empty)"
 *      marker so the section review surfaces the gap.
 *
 * Assembly does NOT prepend a section header or wrap the markdown
 * with framing -- it returns the content verbatim. The orchestrator
 * (P3.d) decides where the section title comes from (TodoSpec.objective
 * or the tree's intentBrief).
 */

import type { PlannedTree, PlannedNode } from '../content-gen/plan-tree.js';
import type { WorkingMemoryFindings, PerRootFinding } from '../working-memory/types.js';
import type { TodoSpec } from './types.js';
import { getLogger } from '../../shared/logger.js';

const log = getLogger('section-flow:section-assembly');

export interface SectionAssemblyInput {
	readonly todo:     TodoSpec;
	readonly tree:     PlannedTree;
	readonly findings: WorkingMemoryFindings;
}

export interface SectionAssemblyResult {
	readonly markdown:        string;
	/**
	 * Which reviewable root contributed the markdown. Useful for
	 * telemetry / section review prompts (the reviewer can name the
	 * source root in its verdict).
	 */
	readonly sourceRootId:    string;
	/**
	 * True when assembly fell back to the last finding or to the
	 * empty marker. Orchestrator surfaces this to telemetry but does
	 * NOT block the section review (the reviewer might still accept).
	 */
	readonly usedFallback:    boolean;
}

export function assembleSection(input: SectionAssemblyInput): SectionAssemblyResult {
	const sectionRoot = findSectionEmittingRoot(input.tree);
	const findingsByRoot = new Map<string, PerRootFinding>();
	for (const f of input.findings.perRoot) {
		findingsByRoot.set(f.rootId, f);
	}

	if (sectionRoot !== null) {
		const finding = findingsByRoot.get(sectionRoot.id);
		if (finding !== undefined && finding.content.trim().length > 0) {
			log.info({ todoId: input.todo.id, sourceRootId: sectionRoot.id }, 'section assembled from emit:section root');
			return {
				markdown:     finding.content,
				sourceRootId: sectionRoot.id,
				usedFallback: false,
			};
		}
		log.warn({ todoId: input.todo.id, sourceRootId: sectionRoot.id }, 'emit:section root produced no finding; falling back');
	} else {
		log.warn({ todoId: input.todo.id }, 'no emit:section root in tree; falling back');
	}

	// Fallback 2: last NON-EMPTY finding (iterate from the end so the
	// most-recent contribution wins -- typically the synthesize root or
	// whatever produced the latest narrative).
	for (let i = input.findings.perRoot.length - 1; i >= 0; i--) {
		const f = input.findings.perRoot[i]!;
		if (f.content.trim().length > 0) {
			return {
				markdown:     f.content,
				sourceRootId: f.rootId,
				usedFallback: true,
			};
		}
	}

	// Fallback 3: structured empty marker.
	return {
		markdown:     `_(section assembly produced no content for ${input.todo.id})_`,
		sourceRootId: '',
		usedFallback: true,
	};
}

/**
 * Walk the top-level composition's direct children (reviewable roots,
 * per Q3 Option B) looking for the one whose `emit === 'section'`. If
 * the tree has multiple section-emitting roots (which would surprise
 * us; the section planner's prompt forbids it), the LAST one wins.
 */
function findSectionEmittingRoot(tree: PlannedTree): PlannedNode | null {
	const root = tree.root;
	if (root.kind !== 'composition' || root.children === undefined) {
		// Single-leaf top-level (fast-path TODO from Q4) -- the leaf
		// itself emits the section. Treat the leaf as the source.
		if (root.kind === 'leaf' && root.emit === 'section') {
			return root;
		}
		return null;
	}
	let sectionRoot: PlannedNode | null = null;
	for (const child of root.children) {
		if (child.emit === 'section') {
			sectionRoot = child;
		}
	}
	return sectionRoot;
}

export const _findSectionEmittingRootForTest = findSectionEmittingRoot;
