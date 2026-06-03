/**
 * Skill-tree executor (P3 of plans/planner-skill-tree.md).
 *
 * Walks a validated `PlannedTree`, resolves each node's `inputs` from
 * the context bag (literals, regex-on-question, session-context,
 * ancestor outputs), invokes leaves via the L1 `runSkill` runtime, and
 * threads outputs forward into descendants.
 *
 * Execution is sequential top-to-bottom: even `composition: 'parallel'`
 * children run serially today (Q4 decision -- parallel is advisory
 * intent; honoring CLAUDE.md's no-parallel-LLM rule).
 *
 * Output emission honors `emit`:
 *   - `section`     -> renderable into the final report; depth-first
 *                      walk order produces the stitching order.
 *   - `intermediate` -> stored in the context bag for downstream wires
 *                       but not surfaced in the report.
 *   - `discard`     -> dropped after children resolve.
 *
 * What this does NOT do (deferred to subsequent phases):
 *   - Planner output coming from an LLM (P4).
 *   - Composition skills (`shared.compare.*`) implementations (P5).
 *   - Orchestrator wiring -- the executor stays caller-agnostic so
 *     both code-analyzer and data-analyzer orchestrators can use it
 *     in P6.
 */

import { getLogger } from '../../../shared/logger.js';
import { runSkill, type SkillRunnerDeps } from '../invoke.js';
import { walkTree, type InputBinding, type PlannedNode, type PlannedTree } from '../../../agent/content-gen/plan-tree.js';
import type { SkillConfidence, SkillResult } from '../types.js';

const log = getLogger('skills:tree-executor');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Session-derived context the executor surfaces to `source: 'context'`
 * bindings. Keys are a small reserved set documented in plan-tree.ts.
 * The orchestrator builds this from the active session before kicking
 * off the executor.
 */
export interface TreeContext {
	readonly question:           string;
	readonly sessionContext:     Readonly<Record<string, unknown>>;
	readonly runnerDeps:         SkillRunnerDeps;
	readonly onEvent?:           ((event: TreeExecutionEvent) => void) | undefined;
	readonly signal?:            AbortSignal | undefined;
}

export type TreeExecutionEvent =
	| { readonly kind: 'tree-start';      readonly leafCount: number; }
	| { readonly kind: 'node-start';      readonly nodeId: string; readonly depth: number; readonly skillId?: string | undefined; }
	| {
		readonly kind:        'node-complete';
		readonly nodeId:      string;
		readonly skillId?:    string | undefined;
		readonly confidence?: SkillConfidence | undefined;
		readonly durationMs:  number;
	  }
	| {
		readonly kind:        'node-failed';
		readonly nodeId:      string;
		readonly skillId?:    string | undefined;
		readonly reason:      string;
		readonly durationMs:  number;
	  }
	| { readonly kind: 'tree-complete';   readonly durationMs: number; readonly executedLeaves: number; readonly failedLeaves: number; };

export interface NodeExecutionRecord {
	readonly nodeId:     string;
	readonly skillId?:   string | undefined;
	readonly kind:       'leaf' | 'composition';
	readonly emit:       PlannedNode['emit'];
	readonly value?:     unknown;
	readonly confidence?: SkillConfidence | undefined;
	readonly notes:      readonly string[];
	readonly durationMs: number;
	readonly failed:     boolean;
	readonly failureReason?: string | undefined;
}

export interface TreeExecutionResult {
	readonly nodes:          ReadonlyMap<string, NodeExecutionRecord>;
	readonly executedLeaves: number;
	readonly failedLeaves:   number;
	readonly durationMs:     number;
}

// ---------------------------------------------------------------------------
// Path resolver -- runtime counterpart to the P2 outputPaths walker
// ---------------------------------------------------------------------------

type PathToken =
	| { kind: 'prop'; name: string }
	| { kind: 'iter' };

/**
 * Tokenize a wire path. Reused by both the runtime resolver and the
 * orchestrator's hindsight diagnostic logs. Rejects index-access
 * (`fields[0]`) by design -- planner outputs should not lock to
 * specific positions.
 */
export function tokenizePath(path: string): readonly PathToken[] | { error: string } {
	const tokens: PathToken[] = [];
	let buf = '';
	let i = 0;
	const flushProp = () => {
		if (buf.length > 0) { tokens.push({ kind: 'prop', name: buf }); buf = ''; }
	};
	while (i < path.length) {
		const c = path[i]!;
		if (c === '.') {
			flushProp();
			i += 1;
		} else if (c === '[') {
			flushProp();
			if (path.slice(i, i + 3) !== '[*]') {
				return { error: `path token at index ${i} is not "[*]"; positional / range indexing is not supported` };
			}
			tokens.push({ kind: 'iter' });
			i += 3;
		} else {
			buf += c;
			i += 1;
		}
	}
	flushProp();
	if (tokens.length === 0) return { error: 'path is empty' };
	return tokens;
}

/**
 * Walk `value` along `path` and return the addressed value. Semantics:
 *   - `prop` segment indexes a record property.
 *   - `iter` (`[*]`) iterates over an array; subsequent prop segments
 *     are applied to every element. Result of any path containing
 *     `[*]` is an array.
 *   - Out-of-shape (e.g. asking for `.foo` on `null`): returns
 *     `undefined` (or an array of undefineds inside an iteration).
 */
export function resolvePath(value: unknown, path: string): unknown | { error: string } {
	const tokensOrError = tokenizePath(path);
	if (!Array.isArray(tokensOrError)) return { error: (tokensOrError as { error: string }).error };
	const tokens = tokensOrError as readonly PathToken[];

	let current: unknown = value;
	let iterating = false;
	for (const tok of tokens) {
		if (tok.kind === 'prop') {
			if (iterating) {
				if (!Array.isArray(current)) {
					return { error: `iterating step expected an array, got ${typeof current}` };
				}
				current = (current as unknown[]).map(v => readProp(v, tok.name));
			} else {
				current = readProp(current, tok.name);
			}
		} else {
			// iter
			if (iterating) {
				return { error: 'nested `[*]` (array of arrays) is not supported in v1' };
			}
			if (!Array.isArray(current)) {
				return { error: `'[*]' expected an array, got ${typeof current}` };
			}
			iterating = true;
		}
	}
	return current;
}

function readProp(value: unknown, name: string): unknown {
	if (value === null || value === undefined) return undefined;
	if (typeof value !== 'object') return undefined;
	return (value as Record<string, unknown>)[name];
}

// ---------------------------------------------------------------------------
// Binding resolver
// ---------------------------------------------------------------------------

export interface BindingResolutionError {
	readonly nodeId:  string;
	readonly argName: string;
	readonly reason:  string;
}

/**
 * Convert one `InputBinding` to a concrete value using the context bag.
 * Returns the resolved value or a typed error. The error is structured
 * so the orchestrator can stream a helpful note to the IDE rather than
 * throwing.
 */
export function resolveBinding(
	binding:    InputBinding,
	wiringNode: PlannedNode,
	argName:    string,
	question:   string,
	sessionContext: Readonly<Record<string, unknown>>,
	nodeValues: ReadonlyMap<string, unknown>,
): { value: unknown } | { error: BindingResolutionError } {
	const fail = (reason: string) => ({ error: { nodeId: wiringNode.id, argName, reason } });

	switch (binding.source) {
		case 'literal':
			return { value: binding.value };

		case 'question': {
			let re: RegExp;
			try { re = new RegExp(binding.extract); }
			catch (err) { return fail(`invalid regex: ${(err as Error).message}`); }
			const m = re.exec(question);
			if (m === null) return { value: undefined };
			return { value: m[1] !== undefined ? m[1] : m[0] };
		}

		case 'context':
			return { value: sessionContext[binding.key] };

		case 'node': {
			if (!nodeValues.has(binding.nodeId)) {
				return fail(`source node "${binding.nodeId}" has no recorded output; it may have failed`);
			}
			const sourceValue = nodeValues.get(binding.nodeId);
			const resolved = resolvePath(sourceValue, binding.path);
			if (typeof resolved === 'object' && resolved !== null && 'error' in resolved) {
				return fail(`path "${binding.path}" on node "${binding.nodeId}": ${(resolved as { error: string }).error}`);
			}
			return { value: resolved };
		}
	}
}

// ---------------------------------------------------------------------------
// Tree executor
// ---------------------------------------------------------------------------

export async function executeTree(
	tree: PlannedTree,
	ctx:  TreeContext,
): Promise<TreeExecutionResult> {
	const startedAt = Date.now();
	const nodeValues = new Map<string, unknown>();
	const records    = new Map<string, NodeExecutionRecord>();
	let executedLeaves = 0;
	let failedLeaves   = 0;

	// Count leaves up front for the tree-start event.
	let leafCount = 0;
	for (const node of walkTree(tree)) if (node.kind === 'leaf') leafCount += 1;
	ctx.onEvent?.({ kind: 'tree-start', leafCount });

	const result = await executeNode(tree.root, 0, {
		ctx,
		nodeValues,
		records,
		onLeafExecuted: (failed) => {
			if (failed) failedLeaves += 1;
			else        executedLeaves += 1;
		},
	});
	void result;   // root's record is stored in `records`

	const durationMs = Date.now() - startedAt;
	ctx.onEvent?.({ kind: 'tree-complete', durationMs, executedLeaves, failedLeaves });

	return { nodes: records, executedLeaves, failedLeaves, durationMs };
}

interface WalkCtx {
	readonly ctx:         TreeContext;
	readonly nodeValues:  Map<string, unknown>;
	readonly records:     Map<string, NodeExecutionRecord>;
	readonly onLeafExecuted: (failed: boolean) => void;
}

async function executeNode(node: PlannedNode, depth: number, w: WalkCtx): Promise<NodeExecutionRecord> {
	const startedAt = Date.now();
	const skillId   = node.kind === 'leaf' ? node.skill : undefined;

	w.ctx.onEvent?.({ kind: 'node-start', nodeId: node.id, depth, ...(skillId !== undefined ? { skillId } : {}) });

	// Resolve every wire on this node up front. A wire failure on a
	// composition node still propagates -- it would only matter if the
	// composition itself somehow consumed inputs, which is rare but
	// allowed by the schema for future template-rendering hooks.
	const resolvedInputs: Record<string, unknown> = {};
	const bindingErrors: BindingResolutionError[] = [];
	for (const [arg, binding] of Object.entries(node.inputs)) {
		const r = resolveBinding(
			binding,
			node,
			arg,
			w.ctx.question,
			w.ctx.sessionContext,
			w.nodeValues,
		);
		if ('error' in r) {
			bindingErrors.push(r.error);
		} else {
			resolvedInputs[arg] = r.value;
		}
	}
	if (bindingErrors.length > 0) {
		const reason = bindingErrors.map(e => `${e.argName}: ${e.reason}`).join('; ');
		return finalizeFailure(node, depth, startedAt, reason, w);
	}

	if (node.kind === 'leaf') {
		// Leaf: invoke the skill.
		if (skillId === undefined) {
			return finalizeFailure(node, depth, startedAt, 'leaf node has no skill id', w);
		}
		let result: SkillResult<unknown>;
		try {
			result = await runSkill<unknown, unknown>(skillId, resolvedInputs, w.ctx.runnerDeps);
		} catch (err) {
			const reason = `runSkill("${skillId}") threw: ${(err as Error).message}`;
			log.warn({ nodeId: node.id, skillId, err: reason }, 'tree node failed');
			return finalizeFailure(node, depth, startedAt, reason, w, skillId);
		}

		// runSkill captures input/feasibility/execute failures and returns
		// a SkillResult with `rejectionReason` set. Treat those as leaf
		// failures so downstream wires get a clean "source failed" note
		// instead of attempting to path into an empty rejection value.
		if (result.rejectionReason !== undefined) {
			const reason = `skill rejected (${result.rejectionReason}): ${(result.notes ?? []).join('; ')}`;
			return finalizeFailure(node, depth, startedAt, reason, w, skillId);
		}

		const durationMs = Date.now() - startedAt;
		const record: NodeExecutionRecord = {
			nodeId:      node.id,
			kind:        'leaf',
			emit:        node.emit,
			value:       result.value,
			notes:       result.notes ?? [],
			durationMs,
			failed:      false,
			...(skillId    !== undefined ? { skillId }                      : {}),
			...(result.confidence       ? { confidence: result.confidence } : {}),
		};
		w.records.set(node.id, record);
		w.nodeValues.set(node.id, result.value);
		w.onLeafExecuted(false);

		w.ctx.onEvent?.({
			kind: 'node-complete',
			nodeId: node.id,
			...(skillId          !== undefined ? { skillId }                      : {}),
			...(result.confidence            ? { confidence: result.confidence } : {}),
			durationMs,
		});
		return record;
	}

	// Composition: walk children in declared order (parallel is advisory
	// per Q4 of plans/planner-skill-tree.md).
	const children = node.children ?? [];
	for (const c of children) {
		await executeNode(c, depth + 1, w);
	}

	const durationMs = Date.now() - startedAt;
	const record: NodeExecutionRecord = {
		nodeId:     node.id,
		kind:       'composition',
		emit:       node.emit,
		// Composition nodes don't have a structured `value` -- wires to
		// them are rejected by the validator (P2). We still record them
		// in `records` so the stitcher can walk them.
		notes:      [],
		durationMs,
		failed:     false,
	};
	w.records.set(node.id, record);

	w.ctx.onEvent?.({ kind: 'node-complete', nodeId: node.id, durationMs });
	return record;
}

function finalizeFailure(
	node:      PlannedNode,
	depth:     number,
	startedAt: number,
	reason:    string,
	w:         WalkCtx,
	skillId?:  string,
): NodeExecutionRecord {
	void depth;
	const durationMs = Date.now() - startedAt;
	const record: NodeExecutionRecord = {
		nodeId:     node.id,
		kind:       node.kind,
		emit:       node.emit,
		notes:      [reason],
		durationMs,
		failed:     true,
		failureReason: reason,
		...(skillId !== undefined ? { skillId } : {}),
	};
	w.records.set(node.id, record);
	if (node.kind === 'leaf') w.onLeafExecuted(true);
	w.ctx.onEvent?.({ kind: 'node-failed', nodeId: node.id, ...(skillId !== undefined ? { skillId } : {}), reason, durationMs });
	return record;
}

// ---------------------------------------------------------------------------
// Section stitcher -- depth-first walk of `emit: 'section'` nodes
// ---------------------------------------------------------------------------

export interface StitchedReport {
	readonly intentBrief: string;
	readonly sections:    readonly RenderedSection[];
	readonly notes:       readonly string[];
}

export interface RenderedSection {
	readonly nodeId:     string;
	readonly title:      string;
	readonly markdown:   string;
	readonly depth:      number;
	readonly confidence?: SkillConfidence | undefined;
	readonly failed:     boolean;
}

/**
 * Walk the tree depth-first and emit one `RenderedSection` per node
 * whose `emit === 'section'`. The orchestrator concatenates these into
 * the final report. Auto-rendering of leaf values is intentionally
 * crude in P3 -- per-skill renderers + template support are P5.
 */
export function stitchTreeSections(tree: PlannedTree, result: TreeExecutionResult): StitchedReport {
	const sections: RenderedSection[] = [];
	const notes:    string[] = [];

	function walk(node: PlannedNode, depth: number): void {
		const record = result.nodes.get(node.id);
		if (node.emit === 'section') {
			sections.push({
				nodeId:    node.id,
				title:     node.title,
				markdown:  renderSectionMarkdown(node, record),
				depth,
				...(record?.confidence !== undefined ? { confidence: record.confidence } : {}),
				failed:    record?.failed ?? false,
			});
		}
		// Even non-section composition nodes have children worth walking.
		if (node.children !== undefined) {
			for (const c of node.children) walk(c, depth + 1);
		}
	}
	walk(tree.root, 0);

	if (tree.notes !== undefined) notes.push(...tree.notes);
	return { intentBrief: tree.intentBrief, sections, notes };
}

function renderSectionMarkdown(node: PlannedNode, record: NodeExecutionRecord | undefined): string {
	if (record === undefined) {
		return `*Node "${node.id}" was not executed.*`;
	}
	if (record.failed) {
		return `*Failed: ${record.failureReason ?? 'unknown error'}.*`;
	}
	if (node.kind === 'composition') {
		// Composition sections are headings only; their children will
		// emit their own nested sections via the walker.
		return '';
	}

	const value = record.value;
	// Convention scaffolding -- per-skill renderers + render.template are P5.
	if (value === null || value === undefined) {
		return '*(no result)*';
	}
	if (typeof value === 'string') return value;
	// L2-fallback shape: { sections: [{title, body}, ...] }
	if (typeof value === 'object' && value !== null && 'sections' in (value as Record<string, unknown>)) {
		const sub = (value as { sections: unknown }).sections;
		if (Array.isArray(sub)) {
			return sub
				.filter((s): s is { title?: string; body?: string } => typeof s === 'object' && s !== null)
				.map(s => {
					const t = typeof s.title === 'string' ? s.title : '';
					const b = typeof s.body  === 'string' ? s.body  : '';
					return t.length > 0 ? `### ${t}\n\n${b}` : b;
				})
				.filter(s => s.length > 0)
				.join('\n\n');
		}
	}
	// Fallback: pretty-printed JSON in a fenced block.
	return '```json\n' + JSON.stringify(value, null, 2) + '\n```';
}
