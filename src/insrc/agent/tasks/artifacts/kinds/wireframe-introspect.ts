/**
 * On-demand React-component introspection for the wireframe artifact
 * kind (plan §4.1).
 *
 * Pipeline:
 *   1. Look up the component entity in Kuzu by name (existing
 *      `findEntitiesByName`).
 *   2. Resolve `entity.file` + the source body (`entity.body`) --
 *      already extracted at index time, no graph schema changes.
 *   3. Run a fresh tree-sitter pass scoped to the component's body
 *      (the indexer's TS/TSX parser, just invoked on a single
 *      function / arrow function / class body).
 *   4. Walk the body to find a top-level `return <jsx>` (or arrow-
 *      function expression body), then walk the JSX tree.
 *   5. Map JSX nodes onto a `WireframeSpec` via the per-library
 *      classifier dictionaries.
 *   6. Recurse into in-tree imports up to `maxDepth` (default 3).
 *
 * Fidelity target is layout sketch -- not a faithful render. See
 * plan §4.1 + the design doc planned at
 * `design/artifacts/react-introspection.html`.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
const _require = createRequire(import.meta.url);

const Parser     = _require('tree-sitter')            as typeof import('tree-sitter');
const TSGrammars = _require('tree-sitter-typescript') as { typescript: unknown; tsx: unknown };
const JSGrammar  = _require('tree-sitter-javascript') as unknown;

import type { DbClient } from '../../../../db/client.js';
import { findEntitiesByName } from '../../../../db/entities.js';
import type {
	WireframeCell,
	WireframeRow,
	WireframeSpec,
} from '../../../../shared/artifacts.js';
import type { Entity } from '../../../../shared/types.js';
import {
	classifyTag,
	extractTailwindLayout,
	type LayoutContainerSpec,
	type SemanticElementSpec,
} from './wireframe-classifiers/index.js';

type SyntaxNode = import('tree-sitter').SyntaxNode;

/** Default recursive descent depth into in-tree custom components. */
export const DEFAULT_DEPTH = 3;
/** Max children rendered as cells -- guards runaway descent. */
const MAX_CELLS_PER_ROW = 12;
/** Max nodes touched across the whole walk (catastrophic-input guard). */
const MAX_NODES = 500;

// ---------------------------------------------------------------------------
// Pure walk over a body string -- the testable surface (no DB, no fs)
// ---------------------------------------------------------------------------

export interface WalkBodyOpts {
	readonly body: string;
	readonly language: 'typescript' | 'javascript';
	readonly file: string;
	/** Pre-resolved imports for the file. The outer
	 *  `introspectComponent` populates this from the surrounding
	 *  source file; tests can supply it directly to exercise the
	 *  classifier paths without an fs read. */
	readonly imports?: readonly ImportRecord[] | undefined;
	readonly maxDepth?: number | undefined;
}

export interface WalkBodyResult {
	readonly spec: WireframeSpec;
	readonly nodeCount: number;
	readonly note?: string | undefined;
}

/**
 * Walk over a function body string -- the testable surface. No DB
 * lookup, no fs read; imports come from `opts.imports`. Recursive
 * descent into in-tree imports is skipped on this path (it requires
 * a DB to resolve target entities). Used by tests directly; the
 * production `introspectComponent` builds on top of this for the
 * single-component case.
 */
export async function walkComponentBody(opts: WalkBodyOpts): Promise<WalkBodyResult> {
	const grammar = pickGrammar(opts.language, opts.file);
	const parser = new Parser();
	(parser as { setLanguage(l: unknown): void }).setLanguage(grammar);
	const tree = (parser as { parse(s: string): { rootNode: SyntaxNode } }).parse(opts.body);

	const fnRoot = findFunctionRoot(tree.rootNode);
	if (fnRoot === null) {
		return { spec: { layout: 'desktop', rows: [] }, nodeCount: 0, note: 'no function root in body' };
	}
	const jsxRoot = findReturnedJsx(fnRoot);
	if (jsxRoot === null) {
		return { spec: { layout: 'desktop', rows: [] }, nodeCount: 0, note: 'no JSX return found in body' };
	}

	const ctx: WalkCtx = {
		db: null,
		repoPath: undefined,
		maxDepth: opts.maxDepth !== undefined && opts.maxDepth > 0
			? Math.min(opts.maxDepth, 6) : DEFAULT_DEPTH,
		nodes: 0,
		visited: new Set<string>(),
	};

	const rows = await walkJsxAsRows(jsxRoot, opts.imports ?? [], ctx, 0);
	return {
		spec: { layout: 'desktop', rows },
		nodeCount: ctx.nodes,
		...(ctx.nodes >= MAX_NODES ? { note: `walk truncated at ${MAX_NODES} nodes` } : {}),
	};
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface IntrospectOpts {
	readonly componentName: string;
	readonly depth?: number;
	readonly db: DbClient;
	readonly repoPath?: string | undefined;
}

export interface IntrospectResult {
	readonly spec: WireframeSpec;
	readonly entity: Entity;
	readonly visitedFiles: readonly string[];
	readonly nodeCount: number;
	readonly note?: string;
}

/**
 * Resolve a component entity, parse its source, and emit a
 * WireframeSpec by walking its JSX. Throws when the entity isn't
 * resolvable, isn't a function-shaped entity, or its language
 * isn't TS/TSX/JS. Bounded by `MAX_NODES` -- exceeding it returns
 * a result with the partial spec + a note.
 */
export async function introspectComponent(opts: IntrospectOpts): Promise<IntrospectResult> {
	const candidates = await findEntitiesByName(opts.db, [opts.componentName], {
		kinds: ['function', 'method'],
		...(opts.repoPath !== undefined ? { repo: opts.repoPath } : {}),
		limit: 1,
	}).catch(() => [] as Entity[]);
	const entity = candidates[0];
	if (entity === undefined) {
		throw new Error(`introspectComponent: no function/method entity '${opts.componentName}' in the graph`);
	}
	if (entity.language !== 'typescript' && entity.language !== 'javascript') {
		throw new Error(`introspectComponent: '${opts.componentName}' is ${entity.language}; React introspection requires TS/TSX/JS`);
	}
	if (entity.body === '') {
		throw new Error(`introspectComponent: entity '${opts.componentName}' has empty body`);
	}

	const ctx: WalkCtx = {
		db: opts.db,
		repoPath: opts.repoPath,
		maxDepth: opts.depth !== undefined && opts.depth > 0
			? Math.min(opts.depth, 6) : DEFAULT_DEPTH,
		nodes: 0,
		visited: new Set<string>(),
	};

	const rows = await walkComponent(entity, ctx);
	const note = ctx.nodes >= MAX_NODES
		? `walk truncated at ${MAX_NODES} nodes` : undefined;

	return {
		spec: { layout: 'desktop', rows: rows.length > 0 ? rows : [scaffoldRow(opts.componentName)] },
		entity,
		visitedFiles: Array.from(ctx.visited),
		nodeCount: ctx.nodes,
		...(note !== undefined ? { note } : {}),
	};
}

// ---------------------------------------------------------------------------
// Walk context
// ---------------------------------------------------------------------------

interface WalkCtx {
	/** Null when called from the pure `walkComponentBody` test path;
	 *  the recursive-descent branch is skipped when `db === null`. */
	readonly db: DbClient | null;
	readonly repoPath: string | undefined;
	readonly maxDepth: number;
	nodes: number;
	readonly visited: Set<string>;
}

function bumpNode(ctx: WalkCtx): boolean {
	ctx.nodes++;
	return ctx.nodes < MAX_NODES;
}

function scaffoldRow(label: string): WireframeRow {
	return { height: 'auto', cells: [{ kind: 'placeholder', label: `<${label}/>`, widthRatio: 1 }] };
}

// ---------------------------------------------------------------------------
// Per-component walk
// ---------------------------------------------------------------------------

interface ImportRecord {
	readonly tagName: string;
	readonly importSource: string;
	/** When the import resolves to an in-tree file, the absolute path
	 *  + the imported symbol so the walker can recurse into it. */
	readonly resolvedFile?: string | undefined;
	readonly resolvedSymbol?: string | undefined;
}

async function walkComponent(entity: Entity, ctx: WalkCtx, depth = 0): Promise<WireframeRow[]> {
	if (ctx.visited.has(entity.id)) { return []; }
	ctx.visited.add(entity.id);

	const grammar = pickGrammar(entity.language, entity.file);
	const parser = new Parser();
	(parser as { setLanguage(l: unknown): void }).setLanguage(grammar);
	const tree = (parser as { parse(s: string): { rootNode: SyntaxNode } }).parse(entity.body);

	// Body is the function source; the file's imports live above the
	// function (so they're not in `entity.body`). Read the surrounding
	// file to harvest imports for tag-source disambiguation +
	// recursive descent.
	let imports: readonly ImportRecord[] = [];
	try { imports = await readFileImports(entity.file); }
	catch { /* missing / unreadable file: walker still runs without import disambiguation */ }

	const fnRoot = findFunctionRoot(tree.rootNode);
	if (fnRoot === null) { return []; }
	const jsxRoot = findReturnedJsx(fnRoot);
	if (jsxRoot === null) { return []; }

	return walkJsxAsRows(jsxRoot, imports, ctx, depth);
}

function pickGrammar(language: string, file: string): unknown {
	if (language === 'typescript') {
		return file.endsWith('.tsx') ? TSGrammars.tsx : TSGrammars.typescript;
	}
	return JSGrammar;
}

/**
 * Find the function/method body root inside the parsed tree.
 * `entity.body` was extracted at the function-declaration node so
 * the tree's root has it as a top-level child.
 */
function findFunctionRoot(root: SyntaxNode): SyntaxNode | null {
	const fnTypes = new Set([
		'function_declaration',
		'method_definition',
		'arrow_function',
		'function',
		'function_expression',
		'export_statement',
		'lexical_declaration',
		'variable_declaration',
	]);
	const queue: SyntaxNode[] = [root];
	while (queue.length > 0) {
		const cur = queue.shift()!;
		if (fnTypes.has(cur.type) && cur.childForFieldName('body') !== null) {
			return cur;
		}
		// Drill into wrappers (`export function ...`, `const X = () =>`).
		for (let i = 0; i < cur.namedChildCount; i++) {
			const child = cur.namedChild(i);
			if (child !== null) { queue.push(child); }
		}
	}
	// Arrow functions whose body is JSX directly (no statement_block).
	if (root.type === 'jsx_element' || root.type === 'jsx_self_closing_element' || root.type === 'jsx_fragment') {
		return root;
	}
	return null;
}

/**
 * Inside a function root, find the JSX expression that's returned.
 * Strategy:
 *   - If the body is JSX directly (arrow function), return it.
 *   - Otherwise scan the body's statements and pick the FIRST
 *     return statement at depth 0 (skipping nested if-bodies).
 *     This is "happy path" selection.
 */
function findReturnedJsx(fnRoot: SyntaxNode): SyntaxNode | null {
	if (fnRoot.type === 'jsx_element' || fnRoot.type === 'jsx_self_closing_element' || fnRoot.type === 'jsx_fragment') {
		return fnRoot;
	}
	const body = fnRoot.childForFieldName('body');
	if (body === null) { return null; }
	if (body.type === 'jsx_element' || body.type === 'jsx_self_closing_element' || body.type === 'jsx_fragment') {
		return body;
	}
	// Arrow functions can wrap their JSX body in parentheses:
	// `const X = () => (<jsx/>)` -- unwrap to find the JSX inside.
	if (body.type === 'parenthesized_expression') {
		return unwrapJsx(body);
	}
	if (body.type !== 'statement_block') { return null; }

	for (let i = 0; i < body.namedChildCount; i++) {
		const stmt = body.namedChild(i);
		if (stmt === null) { continue; }
		if (stmt.type !== 'return_statement') { continue; }
		const arg = stmt.namedChild(0);
		if (arg === null) { continue; }
		const jsx = unwrapJsx(arg);
		if (jsx !== null) { return jsx; }
	}
	return null;
}

function unwrapJsx(node: SyntaxNode): SyntaxNode | null {
	let cur: SyntaxNode | null = node;
	while (cur !== null) {
		if (cur.type === 'jsx_element' || cur.type === 'jsx_self_closing_element' || cur.type === 'jsx_fragment') {
			return cur;
		}
		if (cur.type === 'parenthesized_expression') {
			cur = cur.namedChild(0);
			continue;
		}
		return null;
	}
	return null;
}

// ---------------------------------------------------------------------------
// JSX -> rows / cells
// ---------------------------------------------------------------------------

async function walkJsxAsRows(
	node: SyntaxNode,
	imports: readonly ImportRecord[],
	ctx: WalkCtx,
	depth: number,
): Promise<WireframeRow[]> {
	if (!bumpNode(ctx)) { return []; }
	const cell = await walkJsxAsCell(node, imports, ctx, depth);
	if (cell === null) { return []; }
	if (cell.children !== undefined && cell.children.length > 0) {
		// The root JSX expanded into a layout container -- promote
		// its child rows to the top level of the spec.
		return [...cell.children];
	}
	return [{ height: 'auto', cells: [cell] }];
}

async function walkJsxAsCell(
	node: SyntaxNode,
	imports: readonly ImportRecord[],
	ctx: WalkCtx,
	depth: number,
): Promise<WireframeCell | null> {
	if (!bumpNode(ctx)) { return null; }

	if (node.type === 'jsx_fragment') {
		// `<>...</>` -- merge children into a single column-direction
		// stack at the parent's level.
		const childRows = await collectChildRows(node, 'column', imports, ctx, depth);
		return childRows.length > 0
			? { kind: 'placeholder', children: childRows }
			: null;
	}

	if (node.type !== 'jsx_element' && node.type !== 'jsx_self_closing_element') {
		return null;
	}

	const tagName = readTagName(node);
	if (tagName === null) { return null; }

	// Member-access tags (`Layout.Sider`) inherit the importSource from
	// their root namespace (the import is registered as just `Layout`).
	let importSource = imports.find(i => i.tagName === tagName)?.importSource ?? null;
	if (importSource === null && tagName.includes('.')) {
		const root = tagName.split('.')[0];
		if (root !== undefined) {
			importSource = imports.find(i => i.tagName === root)?.importSource ?? null;
		}
	}
	const classification = classifyTag(tagName, importSource);
	const tailwindHint = extractTailwindLayout(readClassNameProp(node));

	// Region-typed layouts (`<aside>` -> sidebar) take priority over a
	// Tailwind hint -- a `<header className="grid">` should still emit
	// the header region.
	if (classification?.layout?.region !== undefined) {
		return cellFromLayout(node, classification.layout, tagName, imports, ctx, depth);
	}
	// Tailwind layout utilities override the classifier's default
	// direction -- `<div className="grid grid-cols-3">` should grid,
	// not stack as native `div`'s default `column` would.
	if (tailwindHint !== null) {
		const layoutSpec: LayoutContainerSpec = {
			direction: tailwindHint.direction,
			...(tailwindHint.cols !== undefined ? { defaultCols: tailwindHint.cols } : {}),
		};
		return cellFromLayout(node, layoutSpec, tagName, imports, ctx, depth);
	}
	if (classification?.layout !== undefined) {
		return cellFromLayout(node, classification.layout, tagName, imports, ctx, depth);
	}
	if (classification?.element !== undefined) {
		return cellFromElement(node, classification.element, tagName);
	}

	// Unknown PascalCase tag -- try recursive descent into its source
	// when it's an in-tree import + we still have depth budget.
	if (/^[A-Z]/.test(tagName) && depth < ctx.maxDepth) {
		const imp = imports.find(i => i.tagName === tagName);
		if (imp?.resolvedFile !== undefined && imp.resolvedSymbol !== undefined) {
			const nestedRows = await maybeDescend(imp.resolvedFile, imp.resolvedSymbol, ctx, depth + 1);
			if (nestedRows !== null && nestedRows.length > 0) {
				return { kind: 'placeholder', label: `<${tagName}/>`, children: nestedRows };
			}
		}
	}

	// Final fallback: labeled placeholder.
	return { kind: 'placeholder', label: `<${tagName}/>` };
}

async function cellFromLayout(
	node: SyntaxNode,
	layout: LayoutContainerSpec,
	tagName: string,
	imports: readonly ImportRecord[],
	ctx: WalkCtx,
	depth: number,
): Promise<WireframeCell> {
	if (layout.region !== undefined) {
		return { kind: layout.region, label: tagName };
	}

	const childRows = await collectChildRows(node, layout.direction, imports, ctx, depth, layout);
	if (childRows.length === 0) {
		return { kind: 'placeholder', label: `<${tagName}/>` };
	}
	return { kind: 'placeholder', label: tagName, children: childRows };
}

function cellFromElement(
	node: SyntaxNode,
	element: SemanticElementSpec,
	tagName: string,
): WireframeCell {
	const inner = readInnerText(node);
	const prefix = element.labelPrefix ?? tagName;
	const label = inner !== null && inner.trim() !== ''
		? `${prefix}: ${trim(inner.trim(), 32)}` : prefix;
	return { kind: element.kind, label };
}

// ---------------------------------------------------------------------------
// Children -> rows
// ---------------------------------------------------------------------------

async function collectChildRows(
	node: SyntaxNode,
	direction: 'row' | 'column' | 'grid',
	imports: readonly ImportRecord[],
	ctx: WalkCtx,
	depth: number,
	layout?: LayoutContainerSpec,
): Promise<WireframeRow[]> {
	const childCells: WireframeCell[] = [];
	for (let i = 0; i < node.namedChildCount; i++) {
		if (childCells.length >= MAX_CELLS_PER_ROW) { break; }
		const child = node.namedChild(i);
		if (child === null) { continue; }
		// Handle `{cond && <X/>}` / ternaries / `.map()` -- render all
		// reachable JSX branches.
		const expanded = expandJsxFromExpression(child);
		for (const jsxNode of expanded) {
			const cell = await walkJsxAsCell(jsxNode, imports, ctx, depth);
			if (cell !== null) { childCells.push(cell); }
			if (childCells.length >= MAX_CELLS_PER_ROW) { break; }
		}
	}

	if (childCells.length === 0) { return []; }

	if (direction === 'column') {
		return childCells.map(c => ({ height: 'auto', cells: [c] }));
	}
	if (direction === 'row') {
		return [{ height: 'auto', cells: childCells }];
	}
	// grid: wrap into rows of N.
	const cols = layout?.defaultCols ?? 2;
	const rows: WireframeRow[] = [];
	for (let i = 0; i < childCells.length; i += cols) {
		rows.push({ height: 'auto', cells: childCells.slice(i, i + cols) });
	}
	return rows;
}

/**
 * Given a JSX-element child (which may itself be wrapped in
 * `{cond && <X/>}` / ternary / `arr.map(x => <X/>)` / fragment),
 * yield the JSX nodes it exposes.
 */
function expandJsxFromExpression(node: SyntaxNode): readonly SyntaxNode[] {
	if (node.type === 'jsx_element' || node.type === 'jsx_self_closing_element' || node.type === 'jsx_fragment') {
		return [node];
	}
	if (node.type === 'jsx_expression') {
		// `{<expr>}`
		const inner = node.namedChild(0);
		return inner === null ? [] : expandJsxFromExpression(inner);
	}
	if (node.type === 'binary_expression') {
		// `cond && <X/>` -- right-hand side is the conditional render.
		const right = node.childForFieldName('right');
		return right === null ? [] : expandJsxFromExpression(right);
	}
	if (node.type === 'ternary_expression') {
		// `cond ? <A/> : <B/>` -- both branches.
		const cons = node.childForFieldName('consequence');
		const alt = node.childForFieldName('alternative');
		const out: SyntaxNode[] = [];
		if (cons !== null) { out.push(...expandJsxFromExpression(cons)); }
		if (alt !== null) { out.push(...expandJsxFromExpression(alt)); }
		return out;
	}
	if (node.type === 'call_expression') {
		// `xs.map(x => <X/>)` -- find arrow-function arg's body.
		const args = node.childForFieldName('arguments');
		if (args === null) { return []; }
		for (let i = 0; i < args.namedChildCount; i++) {
			const arg = args.namedChild(i);
			if (arg === null) { continue; }
			if (arg.type === 'arrow_function' || arg.type === 'function') {
				const body = arg.childForFieldName('body');
				if (body !== null) { return expandJsxFromExpression(body); }
			}
		}
		return [];
	}
	if (node.type === 'parenthesized_expression') {
		const inner = node.namedChild(0);
		return inner === null ? [] : expandJsxFromExpression(inner);
	}
	return [];
}

// ---------------------------------------------------------------------------
// JSX node attribute readers
// ---------------------------------------------------------------------------

function readTagName(node: SyntaxNode): string | null {
	const opening = node.type === 'jsx_self_closing_element'
		? node
		: node.childForFieldName('open_tag') ?? node.namedChild(0);
	if (opening === null) { return null; }
	const name = opening.childForFieldName('name');
	if (name === null) { return null; }
	// Member-access tags like `Layout.Sider` show up as
	// `jsx_member_expression`; reconstruct the dotted name.
	if (name.type === 'jsx_member_expression' || name.type === 'member_expression') {
		return name.text;
	}
	if (name.type === 'jsx_namespace_name') { return name.text; }
	return name.text;
}

function readClassNameProp(node: SyntaxNode): string | undefined {
	const opening = node.type === 'jsx_self_closing_element'
		? node
		: node.childForFieldName('open_tag') ?? node.namedChild(0);
	if (opening === null) { return undefined; }
	for (let i = 0; i < opening.namedChildCount; i++) {
		const attr = opening.namedChild(i);
		if (attr === null || attr.type !== 'jsx_attribute') { continue; }
		const propName = attr.namedChild(0)?.text;
		if (propName !== 'className') { continue; }
		const valueNode = attr.namedChild(1);
		if (valueNode === null) { continue; }
		if (valueNode.type === 'string') {
			// "..."  -> drop quotes
			return valueNode.text.slice(1, -1);
		}
		if (valueNode.type === 'jsx_expression') {
			const inner = valueNode.namedChild(0);
			if (inner !== null && inner.type === 'string') {
				return inner.text.slice(1, -1);
			}
			if (inner !== null && inner.type === 'template_string') {
				// Best-effort: strip the backticks + interpolation
				// markers; we just want layout tokens.
				return inner.text.replace(/^`|`$/g, '').replace(/\$\{[^}]*\}/g, ' ');
			}
		}
	}
	return undefined;
}

function readInnerText(node: SyntaxNode): string | null {
	if (node.type === 'jsx_self_closing_element') { return null; }
	const parts: string[] = [];
	for (let i = 0; i < node.namedChildCount; i++) {
		const child = node.namedChild(i);
		if (child === null) { continue; }
		if (child.type === 'jsx_text') { parts.push(child.text); }
		else if (child.type === 'jsx_expression') {
			const inner = child.namedChild(0);
			if (inner?.type === 'string') {
				parts.push(inner.text.slice(1, -1));
			}
		}
	}
	const joined = parts.join(' ').replace(/\s+/g, ' ').trim();
	return joined === '' ? null : joined;
}

function trim(s: string, n: number): string {
	return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ---------------------------------------------------------------------------
// Imports + recursive descent
// ---------------------------------------------------------------------------

const IMPORT_RE = /^import\s+(?:type\s+)?(?:(\w+)\s*,?\s*)?(?:\{([^}]+)\})?\s*from\s*['"]([^'"]+)['"]/gm;

async function readFileImports(filePath: string): Promise<readonly ImportRecord[]> {
	const text = await readFile(filePath, 'utf8');
	const records: ImportRecord[] = [];

	IMPORT_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = IMPORT_RE.exec(text)) !== null) {
		const defaultImport = m[1];
		const namedImports = m[2];
		const source = m[3];
		if (typeof source !== 'string' || source === '') { continue; }
		const resolvedFile = source.startsWith('.')
			? resolveRelativeImport(filePath, source)
			: undefined;
		if (typeof defaultImport === 'string' && defaultImport !== '') {
			records.push({
				tagName: defaultImport,
				importSource: source,
				...(resolvedFile !== undefined ? { resolvedFile, resolvedSymbol: defaultImport } : {}),
			});
		}
		if (typeof namedImports === 'string') {
			for (const raw of namedImports.split(',')) {
				const trimmed = raw.trim();
				if (trimmed === '') { continue; }
				const aliasParts = trimmed.split(/\s+as\s+/);
				const original = aliasParts[0]?.trim() ?? trimmed;
				const name = (aliasParts[1] ?? aliasParts[0])?.trim() ?? '';
				if (name === '') { continue; }
				records.push({
					tagName: name,
					importSource: source,
					...(resolvedFile !== undefined ? { resolvedFile, resolvedSymbol: original } : {}),
				});
			}
		}
	}
	return records;
}

function resolveRelativeImport(fromFile: string, spec: string): string | undefined {
	const base = isAbsolute(fromFile) ? fromFile : resolvePath(fromFile);
	const candidates = ['', '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.jsx', '/index.js'];
	for (const ext of candidates) {
		const abs = resolvePath(dirname(base), spec + ext);
		if (existsSync(abs)) { return abs; }
	}
	return undefined;
}

async function maybeDescend(
	resolvedFile: string,
	symbol: string,
	ctx: WalkCtx,
	depth: number,
): Promise<readonly WireframeRow[] | null> {
	if (ctx.db === null) { return null; }
	if (ctx.visited.has(resolvedFile + ':' + symbol)) { return null; }
	ctx.visited.add(resolvedFile + ':' + symbol);

	let entityCandidates: Entity[] = [];
	try {
		entityCandidates = await findEntitiesByName(ctx.db, [symbol], {
			kinds: ['function', 'method'],
			...(ctx.repoPath !== undefined ? { repo: ctx.repoPath } : {}),
			limit: 5,
		});
	} catch { return null; }
	const entity = entityCandidates.find(e => e.file === resolvedFile);
	if (entity === undefined) { return null; }
	if (entity.body === '') { return null; }

	return walkComponent(entity, ctx, depth);
}
