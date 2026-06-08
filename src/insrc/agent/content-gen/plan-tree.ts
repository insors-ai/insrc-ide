/**
 * Skill-tree planner schema + validator (P1 of
 * plans/planner-skill-tree.md).
 *
 * The planner emits a typed tree of skill invocations. Each node is
 * either a `leaf` (one skill call) or a `composition` (children execute
 * in declared order, their outputs visible to siblings/parent via a
 * small wiring DSL). The orchestrator walks the tree, builds the input
 * context bag per node from ancestor outputs, calls the skill, stores
 * the output, and continues.
 *
 * This module exposes:
 *   - Type definitions for the tree (`PlannedTree`, `PlannedNode`,
 *     `InputBinding`).
 *   - The JSON schema (`PLANNED_TREE_SCHEMA`) the LLM's tool call is
 *     validated against server-side.
 *   - `validatePlannedTree(parsed)` which runs structural checks beyond
 *     the JSON schema -- duplicate ids, leaf/composition exclusivity,
 *     ancestor-only `fromNode` refs, hard caps (leaves <= 32, depth <= 4,
 *     branching <= 8).
 *
 * What this does NOT do (intentionally deferred to later phases):
 *   - Path-against-outputPaths validation -- depends on the P2 skill
 *     catalog enrichment. The validator stops at "the referenced
 *     `nodeId` exists and the wire shape is well-formed."
 *   - Tree execution -- that's P3.
 */

import type { SkillOwner } from '../../daemon/skills/types.js';

// ---------------------------------------------------------------------------
// Hard caps (Q3 of plans/planner-skill-tree.md)
// ---------------------------------------------------------------------------

export const MAX_LEAVES        = 32;
export const MAX_DEPTH         = 4;
export const MAX_BRANCHING     = 8;
export const MAX_ID_LENGTH     = 64;
export const MAX_TITLE_LENGTH  = 200;
export const MAX_OBJECTIVE_LEN = 1000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type NodeKind        = 'leaf' | 'composition';
export type CompositionKind = 'sequence' | 'parallel';
export type EmitKind        = 'section' | 'intermediate' | 'discard';

/**
 * Wire source -- where this argument's value comes from at execution
 * time. The four variants form a discriminated union the validator
 * matches on by `source`.
 */
export type InputBinding =
	/** Pull a value from another node's resolved output via JSON path. */
	| {
		readonly source: 'node';
		readonly nodeId: string;
		/**
		 * Dotted path against the source node's output value. Examples:
		 *   - "fields[*].name"
		 *   - "tables[0].columns"
		 *   - "shape"
		 * Path syntax is validated in P2 against the source skill's
		 * registered outputPaths; in P1 we only check the path is a
		 * non-empty string.
		 */
		readonly path: string;
	  }
	/** Hardcoded literal value, copied verbatim into the skill's args. */
	| {
		readonly source: 'literal';
		readonly value:  unknown;
	  }
	/**
	 * Extract a substring from the user's question via regex. The first
	 * capturing group's match is the value (or the whole match if there
	 * are no groups). Empty match -> the wire resolves to undefined.
	 */
	| {
		readonly source:  'question';
		readonly extract: string;   // regex, escaped JS-compatible
	  }
	/**
	 * Pull from the session-derived context bag (active repo path,
	 * primary connection, etc.). Keys are a small reserved set:
	 *   - "codeRepoPath"     -- session.repoPath of the code analyzer
	 *   - "primaryConnection" -- ephemeral or registered data connection id
	 *   - "sessionId"        -- current session id (rarely useful)
	 */
	| {
		readonly source: 'context';
		readonly key:    string;
	  };

/**
 * One node in the planner's emitted tree. A node is either a leaf
 * (one skill invocation, identified by `skill`) or a composition
 * (children execute in declared order; `skill` undefined). The two
 * variants are kept on one shape because the LLM's tool-call schema is
 * easier to author and validate as a single recursive type than as a
 * discriminated union.
 */
export interface PlannedNode {
	readonly id:        string;
	readonly title:     string;
	readonly objective: string;

	readonly kind:        NodeKind;
	/** Required when kind === 'leaf'. Forbidden when kind === 'composition'. */
	readonly skill?:      string | undefined;
	/** Required when kind === 'composition' (>= 1 child). Forbidden when kind === 'leaf'. */
	readonly children?:   readonly PlannedNode[] | undefined;
	/** Defaults to 'sequence' when kind === 'composition'. */
	readonly composition?: CompositionKind | undefined;

	/**
	 * Wiring map keyed by the skill's inputSchema property names (leaf)
	 * or by argument names that composition children expect (composition).
	 * Empty `{}` is valid -- some leaves take no arguments.
	 */
	readonly inputs: Readonly<Record<string, InputBinding>>;

	readonly emit: EmitKind;
	/** Section-only rendering hint. */
	readonly render?: { readonly kind: 'auto' } | { readonly kind: 'template'; readonly template: string } | undefined;
}

export interface PlannedTree {
	readonly intentBrief: string;
	readonly root:        PlannedNode;
	/**
	 * Optional planner-emitted notes (uncertainty, alternatives considered
	 * and rejected, etc.). Surfaced to the user as a tail block in the
	 * report so they understand what the planner chose and why.
	 */
	readonly notes?:      readonly string[] | undefined;
}

// ---------------------------------------------------------------------------
// JSON schema -- handed to the LLM tool call as inputSchema
// ---------------------------------------------------------------------------

// Recursive schema requires a $defs / $ref pair. The cloud provider
// tool-call validators (Anthropic + OpenAI) support this since 2024.
export const PLANNED_TREE_SCHEMA = {
	$defs: {
		InputBinding: {
			oneOf: [
				{
					type: 'object',
					properties: {
						source: { type: 'string', const: 'node' },
						nodeId: { type: 'string', minLength: 1, maxLength: MAX_ID_LENGTH },
						path:   { type: 'string', minLength: 1, maxLength: 200 },
					},
					required: ['source', 'nodeId', 'path'],
					additionalProperties: false,
				},
				{
					type: 'object',
					properties: {
						source: { type: 'string', const: 'literal' },
						value:  {},   // any
					},
					required: ['source', 'value'],
					additionalProperties: false,
				},
				{
					type: 'object',
					properties: {
						source:  { type: 'string', const: 'question' },
						extract: { type: 'string', minLength: 1, maxLength: 400 },
					},
					required: ['source', 'extract'],
					additionalProperties: false,
				},
				{
					type: 'object',
					properties: {
						source: { type: 'string', const: 'context' },
						key:    { type: 'string', minLength: 1, maxLength: 64 },
					},
					required: ['source', 'key'],
					additionalProperties: false,
				},
			],
		},
		PlannedNode: {
			type: 'object',
			properties: {
				id:          { type: 'string', minLength: 1, maxLength: MAX_ID_LENGTH },
				title:       { type: 'string', minLength: 1, maxLength: MAX_TITLE_LENGTH },
				objective:   { type: 'string', minLength: 1, maxLength: MAX_OBJECTIVE_LEN },
				kind:        { type: 'string', enum: ['leaf', 'composition'] },
				skill:       { type: 'string', minLength: 1, maxLength: 100 },
				children: {
					type: 'array',
					minItems: 0,
					maxItems: MAX_BRANCHING,
					items: { $ref: '#/$defs/PlannedNode' },
				},
				composition: { type: 'string', enum: ['sequence', 'parallel'] },
				inputs: {
					type: 'object',
					additionalProperties: { $ref: '#/$defs/InputBinding' },
				},
				emit:   { type: 'string', enum: ['section', 'intermediate', 'discard'] },
				render: {
					oneOf: [
						{
							type: 'object',
							properties: { kind: { type: 'string', const: 'auto' } },
							required: ['kind'],
							additionalProperties: false,
						},
						{
							type: 'object',
							properties: {
								kind:     { type: 'string', const: 'template' },
								template: { type: 'string', minLength: 1, maxLength: 2000 },
							},
							required: ['kind', 'template'],
							additionalProperties: false,
						},
					],
				},
			},
			required: ['id', 'title', 'objective', 'kind', 'inputs', 'emit'],
			additionalProperties: false,
		},
	},
	type: 'object',
	properties: {
		intentBrief: { type: 'string', minLength: 1, maxLength: 1000 },
		root:        { $ref: '#/$defs/PlannedNode' },
		notes:       { type: 'array', items: { type: 'string', maxLength: 400 }, maxItems: 8 },
	},
	required: ['intentBrief', 'root'],
	additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

export type ValidationError = string;

/**
 * Optional caller-supplied lookups that turn structural validation into
 * strict plan-time validation (Q1 of plans/planner-skill-tree.md).
 *
 * When provided, the validator additionally enforces:
 *   - Every leaf node's `skill` resolves to a registered skill.
 *   - Every `inputs.<arg>` with `source: 'node'` has a `path` that
 *     exists in the source skill's `outputPaths` registry entry.
 *
 * Omitting these (P1 / unit-test mode) preserves the structural-only
 * validation contract so plan-tree tests don't need a skill registry.
 */
export interface ValidationLookups {
	readonly skillExists?:        (skillId: string) => boolean;
	readonly skillOutputPaths?:   (skillId: string) => readonly string[];
}

/**
 * Validate a parsed-from-JSON candidate tree. Returns the strongly-typed
 * `PlannedTree` on success, or an error string suitable for the LLM
 * retry path. Run after JSON-schema validation has already accepted the
 * shape; this layer checks invariants the JSON schema can't express:
 *
 *   - Every node id is unique within the tree.
 *   - kind === 'leaf'        => `skill` set, `children` absent.
 *   - kind === 'composition' => `children.length >= 1`, `skill` absent.
 *   - Every `inputs.<arg>` with `source: 'node'` references a node that
 *     exists in the tree, is not the wiring node itself, and is reachable
 *     via the dispatch order (ancestor or already-resolved earlier sibling).
 *   - Leaf count <= MAX_LEAVES, depth <= MAX_DEPTH, branching <= MAX_BRANCHING.
 *
 * When `lookups` is provided, additionally enforces strict skill-id and
 * wire-path validation (P2 of plans/planner-skill-tree.md).
 */
export function validatePlannedTree(parsed: unknown, lookups?: ValidationLookups): PlannedTree | ValidationError {
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return 'tree root is not a JSON object';
	}
	const obj = parsed as Record<string, unknown>;

	const intentBrief = typeof obj['intentBrief'] === 'string' ? obj['intentBrief'].trim() : '';
	if (intentBrief.length === 0) return '`intentBrief` missing or empty';

	const rootRaw = obj['root'];
	if (rootRaw === undefined || rootRaw === null) return '`root` missing';

	const ids       = new Set<string>();
	const leafCount = { count: 0 };
	const nodeIdToSkill = new Map<string, string>();

	const rootResult = validateNode(rootRaw, {
		ids,
		leafCount,
		depth:           0,
		visibleNodeIds:  new Set(),
		nodeIdToSkill,
		idToVisibilityList: [],
		lookups,
	});
	if (typeof rootResult === 'string') return rootResult;

	if (leafCount.count === 0)         return 'tree contains zero leaf nodes';
	if (leafCount.count > MAX_LEAVES)  return `tree has ${leafCount.count} leaves; cap is ${MAX_LEAVES}`;

	const notes = Array.isArray(obj['notes'])
		? (obj['notes'] as unknown[]).filter((n): n is string => typeof n === 'string').map(n => n.trim()).filter(n => n.length > 0)
		: undefined;

	return {
		intentBrief,
		root: rootResult,
		...(notes !== undefined && notes.length > 0 ? { notes } : {}),
	};
}

interface ValidationCtx {
	readonly ids:                Set<string>;
	readonly leafCount:          { count: number };
	readonly depth:              number;
	/**
	 * Set of node ids reachable by the current wiring point: ancestors +
	 * earlier (already-validated) siblings in the same composition.
	 * Forward refs (later sibling, descendant) are rejected because the
	 * orchestrator can't resolve them when the current node runs.
	 */
	readonly visibleNodeIds:     Set<string>;
	/**
	 * Map of node id -> skill id for every leaf node validated so far.
	 * Composition nodes are deliberately absent: wires to compositions
	 * are rejected under strict lookups because a composition has no
	 * structured output value to path-address.
	 */
	readonly nodeIdToSkill:      Map<string, string>;
	/**
	 * Stack of (compositionId -> ordered list of already-visible child
	 * ids). Used to grow `visibleNodeIds` as siblings finish validating.
	 * Empty stack = root context.
	 */
	readonly idToVisibilityList: readonly string[];
	/** Caller-supplied strict-lookup hooks; undefined => structural-only. */
	readonly lookups?:           ValidationLookups | undefined;
}

function validateNode(rawNode: unknown, ctx: ValidationCtx): PlannedNode | ValidationError {
	if (rawNode === null || typeof rawNode !== 'object' || Array.isArray(rawNode)) {
		return `node at depth ${ctx.depth} is not an object`;
	}
	const n = rawNode as Record<string, unknown>;

	if (ctx.depth >= MAX_DEPTH) return `tree depth exceeds cap of ${MAX_DEPTH}`;

	const id = typeof n['id'] === 'string' ? n['id'].trim() : '';
	if (id.length === 0) return `node at depth ${ctx.depth} missing id`;
	if (ctx.ids.has(id)) return `duplicate node id "${id}"`;
	ctx.ids.add(id);

	const title = typeof n['title'] === 'string' ? n['title'].trim() : '';
	if (title.length === 0) return `node "${id}" missing title`;

	const objective = typeof n['objective'] === 'string' ? n['objective'].trim() : '';
	if (objective.length === 0) return `node "${id}" missing objective`;

	const kind = n['kind'];
	if (kind !== 'leaf' && kind !== 'composition') {
		return `node "${id}" has invalid kind (expected 'leaf' or 'composition')`;
	}

	const emit = n['emit'];
	if (emit !== 'section' && emit !== 'intermediate' && emit !== 'discard') {
		return `node "${id}" has invalid emit (expected 'section' | 'intermediate' | 'discard')`;
	}

	const rawInputs = n['inputs'];
	if (rawInputs === null || rawInputs === undefined || typeof rawInputs !== 'object' || Array.isArray(rawInputs)) {
		return `node "${id}" missing inputs (use {} if no args)`;
	}
	// Validate every wire BEFORE walking into children: this node's own
	// wires can only reference ancestors / earlier siblings, and that's
	// exactly the current `visibleNodeIds` set.
	const inputsObj = rawInputs as Record<string, unknown>;
	const inputs: Record<string, InputBinding> = {};
	for (const [arg, binding] of Object.entries(inputsObj)) {
		const wireResult = validateBinding(binding, ctx, id, arg);
		if (typeof wireResult === 'string') return `node "${id}".inputs.${arg}: ${wireResult}`;
		inputs[arg] = wireResult;
	}

	if (kind === 'leaf') {
		if (n['children'] !== undefined) return `leaf node "${id}" must not have children`;
		if (n['composition'] !== undefined) return `leaf node "${id}" must not declare composition`;
		const skill = typeof n['skill'] === 'string' ? n['skill'].trim() : '';
		if (skill.length === 0) return `leaf node "${id}" missing skill`;
		// Strict lookup: skill must be a registered id. Reserved for the
		// orchestrator's plan-time check; structural-only validation
		// (e.g. unit tests) skips this.
		if (ctx.lookups?.skillExists !== undefined && !ctx.lookups.skillExists(skill)) {
			return `leaf node "${id}" references unregistered skill "${skill}"`;
		}
		ctx.leafCount.count += 1;
		ctx.nodeIdToSkill.set(id, skill);

		const render = parseRender(n['render'], id);
		if (typeof render === 'string') return render;

		return {
			id, title, objective, kind: 'leaf',
			skill,
			inputs,
			emit,
			...(render !== undefined ? { render } : {}),
		};
	}

	// composition
	if (n['skill'] !== undefined) return `composition node "${id}" must not declare skill`;
	const childrenRaw = n['children'];
	if (!Array.isArray(childrenRaw) || childrenRaw.length === 0) {
		return `composition node "${id}" must have at least one child`;
	}
	if (childrenRaw.length > MAX_BRANCHING) {
		return `composition node "${id}" has ${childrenRaw.length} children; cap is ${MAX_BRANCHING}`;
	}

	const composition: CompositionKind = n['composition'] === 'parallel' ? 'parallel' : 'sequence';

	// Visibility for children: ancestors of this composition (= parent's
	// visibility) PLUS this composition's id PLUS earlier siblings.
	// The composition node's own id is visible so child nodes can declare
	// `source: 'node', nodeId: '<composition-id>'` if a future renderer
	// wants to reference the composition output (we treat it as the
	// concatenation of children for now -- P3 implementation detail).
	const childVisibility = new Set(ctx.visibleNodeIds);
	childVisibility.add(id);

	const childNodes: PlannedNode[] = [];
	for (const [i, c] of childrenRaw.entries()) {
		const childResult = validateNode(c, {
			ids:                ctx.ids,
			leafCount:          ctx.leafCount,
			depth:              ctx.depth + 1,
			visibleNodeIds:     childVisibility,
			nodeIdToSkill:      ctx.nodeIdToSkill,
			idToVisibilityList: ctx.idToVisibilityList,
			...(ctx.lookups !== undefined ? { lookups: ctx.lookups } : {}),
		});
		if (typeof childResult === 'string') return `composition "${id}".children[${i}]: ${childResult}`;
		childNodes.push(childResult);
		childVisibility.add(childResult.id);
	}

	const render = parseRender(n['render'], id);
	if (typeof render === 'string') return render;

	return {
		id, title, objective, kind: 'composition',
		children:    childNodes,
		composition,
		inputs,
		emit,
		...(render !== undefined ? { render } : {}),
	};
}

function validateBinding(
	raw: unknown,
	ctx: ValidationCtx,
	wiringNodeId: string,
	argName: string,
): InputBinding | ValidationError {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		return 'binding is not an object';
	}
	const b = raw as Record<string, unknown>;
	const source = b['source'];
	switch (source) {
		case 'node': {
			const nodeId = typeof b['nodeId'] === 'string' ? b['nodeId'].trim() : '';
			if (nodeId.length === 0) return 'source=node requires `nodeId`';
			if (nodeId === wiringNodeId) return `source=node nodeId "${nodeId}" refers to the wiring node itself`;
			if (!ctx.visibleNodeIds.has(nodeId)) {
				// Distinguish two cases for a more actionable retry hint:
				//   (a) `nodeId` exists elsewhere in the tree (seen on a
				//       previous branch) but is not visible here -> the
				//       caller put it in the wrong order or wrong sibling
				//       group. Tell them to move it earlier.
				//   (b) `nodeId` doesn't exist at all -> typo / wrong id.
				// `ctx.ids` accumulates EVERY id validated so far across
				// the whole tree (added top-down DFS); a forward ref to a
				// later sibling we haven't reached yet is genuinely absent
				// from `ctx.ids` at this moment. So an id present in
				// `ctx.ids` but not in `visibleNodeIds` means case (a) on a
				// non-ancestor branch; absence means either case (a) on a
				// later sibling OR case (b). Sample the visible set so the
				// retry can correct against the actual choice.
				const exists  = ctx.ids.has(nodeId);
				const visible = [...ctx.visibleNodeIds];
				const visibleList = visible.length === 0
					? '(none -- this wiring node is the first leaf to run)'
					: visible.slice(0, 12).join(', ') + (visible.length > 12 ? `, ...(+${visible.length - 12} more)` : '');
				const cause = exists
					? `node "${nodeId}" exists in another branch but is not an ancestor or earlier sibling here`
					: `node "${nodeId}" was not defined before this wiring point (either a typo or a node that comes later in execution order)`;
				return `source=node ${cause}. Visible nodes you CAN wire from: [${visibleList}]. Fix: either correct the nodeId to one of these, OR reorder the tree so the wired-from node appears earlier in execution (ancestor of, or earlier child than, this node).`;
			}
			const path = typeof b['path'] === 'string' ? b['path'].trim() : '';
			if (path.length === 0) return 'source=node requires `path`';
			// Strict path validation (P2): only runs when lookups supplied.
			// Wires to composition nodes are rejected because compositions
			// have no structured output to path-address; if the planner
			// needs a value from "inside" a composition, it should wire
			// directly to the leaf that produced it.
			if (ctx.lookups?.skillOutputPaths !== undefined) {
				const sourceSkill = ctx.nodeIdToSkill.get(nodeId);
				if (sourceSkill === undefined) {
					return `source=node nodeId "${nodeId}" is a composition; wires must target leaf nodes`;
				}
				const paths = ctx.lookups.skillOutputPaths(sourceSkill);
				if (!paths.includes(path)) {
					const preview = paths.slice(0, 12).join(', ');
					return `source=node path "${path}" is not in "${sourceSkill}" outputPaths` +
						(paths.length > 0 ? ` (valid: ${preview}${paths.length > 12 ? ', ...' : ''})` : ' (skill has no addressable outputs)');
				}
			}
			void argName;   // reserved for future per-arg path-shape checks
			return { source: 'node', nodeId, path };
		}
		case 'literal': {
			if (!('value' in b)) return 'source=literal requires `value` (any type, may be null)';
			return { source: 'literal', value: b['value'] };
		}
		case 'question': {
			const extract = typeof b['extract'] === 'string' ? b['extract'].trim() : '';
			if (extract.length === 0) return 'source=question requires `extract` (regex string)';
			try { new RegExp(extract); }
			catch (err) { return `source=question.extract is not a valid regex: ${(err as Error).message}`; }
			return { source: 'question', extract };
		}
		case 'context': {
			const key = typeof b['key'] === 'string' ? b['key'].trim() : '';
			if (key.length === 0) return 'source=context requires `key`';
			return { source: 'context', key };
		}
		default:
			return `unknown source "${String(source)}"; expected node | literal | question | context`;
	}
}

function parseRender(raw: unknown, nodeId: string): PlannedNode['render'] | undefined | ValidationError {
	if (raw === undefined) return undefined;
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		return `node "${nodeId}".render is not an object`;
	}
	const r = raw as Record<string, unknown>;
	if (r['kind'] === 'auto')     return { kind: 'auto' };
	if (r['kind'] === 'template') {
		const template = typeof r['template'] === 'string' ? r['template'] : '';
		if (template.length === 0) return `node "${nodeId}".render template missing`;
		return { kind: 'template', template };
	}
	return `node "${nodeId}".render.kind must be 'auto' or 'template'`;
}

// ---------------------------------------------------------------------------
// Helpers for downstream phases
// ---------------------------------------------------------------------------

/** Iterate every node in a tree depth-first (parent before children). */
export function* walkTree(tree: PlannedTree): IterableIterator<PlannedNode> {
	function* walk(n: PlannedNode): IterableIterator<PlannedNode> {
		yield n;
		if (n.children !== undefined) {
			for (const c of n.children) yield* walk(c);
		}
	}
	yield* walk(tree.root);
}

/** Count leaves in a tree (used by execution telemetry + cap re-check). */
export function countLeaves(tree: PlannedTree): number {
	let n = 0;
	for (const node of walkTree(tree)) {
		if (node.kind === 'leaf') n += 1;
	}
	return n;
}

/** Compute max depth (root = 0). */
export function maxDepth(tree: PlannedTree): number {
	function depth(n: PlannedNode): number {
		if (n.children === undefined || n.children.length === 0) return 0;
		return 1 + Math.max(...n.children.map(depth));
	}
	return depth(tree.root);
}

/**
 * Convenience: the planner LLM occasionally needs to know what
 * categories a tree spans (for prompt rendering on stage-1 pre-filter,
 * etc.). Returns the SkillOwner-shaped union of every leaf's skill id
 * prefix (`code.* -> code-analyzer`, `data.* -> data-analyzer`,
 * `shared.* -> shared`).
 */
// ---------------------------------------------------------------------------
// Degenerate-shape detector (Q2 / P3.a)
// ---------------------------------------------------------------------------

export interface DegenerateShapeOpts {
	/**
	 * Minimum number of direct children the top-level composition must
	 * have (the "reviewable roots" of Q3's Option B). Defaults to 2 --
	 * the section orchestrator wants at least discover + synthesize.
	 */
	readonly minTopLevelChildren?: number;
	/** Minimum total leaves across the whole tree. Default 2. */
	readonly minLeaves?: number;
}

/**
 * Detect degenerate tree shapes the live-test failure mode produces
 * (one linear chain `root -> A -> B -> C`, single emit:section leaf,
 * losing all narrative sections). Returns a human-readable reason
 * string when degenerate, or `null` when the tree shape is acceptable.
 *
 * Run AFTER `validatePlannedTree` succeeds. The orchestrator routes
 * a non-null result into one corrective LLM retry with the reason
 * surfaced verbatim (Q2's backstop validator rule).
 *
 * Fast-path single-TODO trees (P3.d trivial branch) are constructed
 * directly without invoking the section planner, so they never
 * encounter this check.
 */
export function isDegenerateShape(
	tree: PlannedTree,
	opts: DegenerateShapeOpts = {},
): string | null {
	const minTopChildren = opts.minTopLevelChildren ?? 2;
	const minLeaves      = opts.minLeaves ?? 2;

	if (tree.root.kind === 'leaf') {
		return `degenerate: top-level node is a leaf ("${tree.root.id}"); expected a composition with >=${minTopChildren} reviewable-root children`;
	}

	const topChildren = tree.root.children?.length ?? 0;
	if (topChildren < minTopChildren) {
		return `degenerate: top-level composition has ${topChildren} child(ren); expected >=${minTopChildren} reviewable roots (discover / analyze / synthesize phases)`;
	}

	const leaves = countLeaves(tree);
	if (leaves < minLeaves) {
		return `degenerate: tree has ${leaves} leaf(s); expected >=${minLeaves}`;
	}

	// Thin-chain rule: a multi-level tree with fewer leaves than its
	// depth is the live-test failure mode (deep chain, no breadth).
	const depth = maxDepth(tree);
	if (depth > 2 && leaves < depth) {
		return `degenerate: depth ${depth} with only ${leaves} leaf(s); chain-shaped tree, prefer breadth over depth`;
	}

	return null;
}

// ---------------------------------------------------------------------------
// Category inference (legacy helper kept for the stage-1 pre-filter)
// ---------------------------------------------------------------------------

export function inferCategoriesFromTree(tree: PlannedTree): readonly SkillOwner[] {
	const out = new Set<SkillOwner>();
	for (const n of walkTree(tree)) {
		if (n.kind !== 'leaf' || n.skill === undefined) continue;
		const dot = n.skill.indexOf('.');
		if (dot <= 0) continue;
		const prefix = n.skill.slice(0, dot);
		switch (prefix) {
			case 'code':   out.add('code-analyzer'); break;
			case 'data':   out.add('data-analyzer'); break;
			case 'shared': out.add('shared');        break;
			// `deploy.*` / `test.*` -- future.
			default: break;
		}
	}
	return [...out];
}
