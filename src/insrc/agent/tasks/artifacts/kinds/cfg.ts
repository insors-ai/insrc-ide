/**
 * On-demand control-flow walk for the `flow:code` artifact branch.
 *
 * Plan §4.2: rather than retain a graph-resident `BRANCHES` relation,
 * the kind reads the function entity's `body` (already captured by the
 * indexer at extract time) and runs a fresh tree-sitter parse scoped
 * to the body. The walker recognises a small fixed set of structural
 * CST nodes and emits a Mermaid `flowchart TD`. This is "AST-shaped
 * flowchart", not a real compiler CFG -- no SSA, no basic-block
 * analysis, no flow-path enumeration.
 *
 * v1 covers TypeScript / TSX / JavaScript via tree-sitter-typescript.
 * Python and Go will land as follow-up walkers (per-language node
 * names differ).
 *
 * Caps: 200 step-tree nodes per function. Overflow throws so the
 * caller can fall through to the phase-1 LLM approximation with a
 * `(truncated)` annotation.
 */

import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);

const Parser        = _require('tree-sitter')            as typeof import('tree-sitter');
const TSGrammars    = _require('tree-sitter-typescript') as { typescript: unknown; tsx: unknown };
const JSGrammar     = _require('tree-sitter-javascript') as unknown;
const PythonGrammar = _require('tree-sitter-python')     as unknown;
const GoGrammar     = _require('tree-sitter-go')         as unknown;
const JavaGrammar   = _require('tree-sitter-java')       as unknown;
const ScalaGrammar  = _require('tree-sitter-scala')      as unknown;

import type { Entity, Language } from '../../../../shared/types.js';

type SyntaxNode = import('tree-sitter').SyntaxNode;

/** Cap on step-tree node count. Beyond this the walker throws. */
export const CFG_NODE_CAP = 200;

const PREDICATE_TRUNC = 40;

// ---------------------------------------------------------------------------
// Step tree -- the intermediate representation between AST walk + Mermaid
// ---------------------------------------------------------------------------

export type CfgStep =
	| { readonly kind: 'enter'; readonly label: string }
	| { readonly kind: 'stmt'; readonly label: string }
	| { readonly kind: 'call'; readonly callee: string }
	| { readonly kind: 'return'; readonly label: string }
	| { readonly kind: 'break' }
	| { readonly kind: 'continue' }
	| { readonly kind: 'throw'; readonly label: string }
	| {
		readonly kind: 'branch';
		readonly predicate: string;
		readonly consequent: readonly CfgStep[];
		readonly alternative: readonly CfgStep[] | null;
	}
	| {
		readonly kind: 'loop';
		readonly loopKind: 'for' | 'for-in' | 'for-of' | 'while' | 'do-while';
		readonly predicate: string;
		readonly body: readonly CfgStep[];
	}
	| {
		readonly kind: 'switch';
		readonly subject: string;
		readonly cases: readonly {
			readonly label: string;
			readonly body: readonly CfgStep[];
		}[];
	}
	| {
		readonly kind: 'try';
		readonly tryBody: readonly CfgStep[];
		readonly catchBody: readonly CfgStep[] | null;
		readonly finallyBody: readonly CfgStep[] | null;
	};

export interface CfgWalkResult {
	readonly steps: readonly CfgStep[];
	readonly nodeCount: number;
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript walker
// ---------------------------------------------------------------------------

type WalkLang = 'typescript' | 'javascript' | 'python' | 'go' | 'java' | 'scala';

interface WalkCtx {
	count: number;
	lang: WalkLang;
}

function bump(ctx: WalkCtx): void {
	ctx.count++;
	if (ctx.count > CFG_NODE_CAP) {
		throw new Error(
			`cfg: function exceeds ${CFG_NODE_CAP}-node cap; caller should fall through`,
		);
	}
}

function trunc(s: string, n = PREDICATE_TRUNC): string {
	const flat = s.replace(/\s+/g, ' ').trim();
	return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

function pickLanguageGrammar(language: Language, file: string): unknown {
	if (language === 'typescript') {
		return file.endsWith('.tsx') ? TSGrammars.tsx : TSGrammars.typescript;
	}
	if (language === 'javascript') { return JSGrammar; }
	if (language === 'python') { return PythonGrammar; }
	if (language === 'go') { return GoGrammar; }
	if (language === 'java') { return JavaGrammar; }
	if (language === 'scala') { return ScalaGrammar; }
	throw new Error(`cfg: language '${language}' not yet supported`);
}

/**
 * Find the function/method body node inside a parsed tree-sitter root.
 * The entity.body string is the function declaration itself, so the
 * tree's root will typically be `program` -> `function_declaration` ->
 * `statement_block` (TS/JS) or `module` -> `function_definition` ->
 * `block` (Python). Return the body block so the walker iterates its
 * top-level statements.
 */
function findBodyBlock(root: SyntaxNode, lang: WalkLang): SyntaxNode | null {
	const fnTypes = lang === 'python'
		? new Set(['function_definition'])
		: lang === 'go'
			? new Set(['function_declaration', 'method_declaration'])
			: lang === 'java'
				? new Set(['method_declaration', 'constructor_declaration', 'compact_constructor_declaration'])
				: lang === 'scala'
					? new Set(['function_definition'])
					: new Set([
						'function_declaration',
						'method_definition',
						'arrow_function',
						'function',
						'function_expression',
						'generator_function',
						'generator_function_declaration',
					]);

	let cur: SyntaxNode | null = root;
	const queue: SyntaxNode[] = [root];
	while (queue.length > 0) {
		cur = queue.shift() ?? null;
		if (cur === null) { break; }
		if (fnTypes.has(cur.type)) {
			const body = cur.childForFieldName('body');
			if (body !== null) { return body; }
		}
		for (let i = 0; i < cur.namedChildCount; i++) {
			const child = cur.namedChild(i);
			if (child !== null) { queue.push(child); }
		}
	}
	return null;
}

function walkBlock(block: SyntaxNode, ctx: WalkCtx): CfgStep[] {
	const out: CfgStep[] = [];
	for (let i = 0; i < block.namedChildCount; i++) {
		const stmt = block.namedChild(i);
		if (stmt === null) { continue; }
		const step = walkStatement(stmt, ctx);
		if (step === null) { continue; }
		if (Array.isArray(step)) { out.push(...step); }
		else { out.push(step); }
	}
	return out;
}

function walkStatement(node: SyntaxNode, ctx: WalkCtx): CfgStep | CfgStep[] | null {
	if (ctx.lang === 'python') { return walkStatementPython(node, ctx); }
	if (ctx.lang === 'go') { return walkStatementGo(node, ctx); }
	if (ctx.lang === 'java') { return walkStatementJava(node, ctx); }
	if (ctx.lang === 'scala') { return walkStatementScala(node, ctx); }
	return walkStatementTs(node, ctx);
}

function walkStatementTs(node: SyntaxNode, ctx: WalkCtx): CfgStep | CfgStep[] | null {
	switch (node.type) {
		case 'if_statement': {
			bump(ctx);
			const condition = stripParens(node.childForFieldName('condition')?.text ?? 'cond');
			const consequence = node.childForFieldName('consequence');
			const alternative = node.childForFieldName('alternative');
			return {
				kind: 'branch',
				predicate: trunc(condition),
				consequent: walkBranch(consequence, ctx),
				alternative: alternative === null ? null : walkBranch(alternative, ctx),
			};
		}
		case 'switch_statement': {
			bump(ctx);
			const subject = node.childForFieldName('value')?.text ?? 'subject';
			const cases: { label: string; body: CfgStep[] }[] = [];
			const caseBlock = node.childForFieldName('body');
			if (caseBlock !== null) {
				for (let i = 0; i < caseBlock.namedChildCount; i++) {
					const c = caseBlock.namedChild(i);
					if (c === null) { continue; }
					if (c.type === 'switch_case' || c.type === 'switch_default') {
						bump(ctx);
						const label = c.type === 'switch_default'
							? 'default'
							: trunc(c.childForFieldName('value')?.text ?? 'case');
						const caseBody: CfgStep[] = [];
						for (let j = 0; j < c.namedChildCount; j++) {
							const child = c.namedChild(j);
							if (child === null || child === c.childForFieldName('value')) { continue; }
							const sub = walkStatement(child, ctx);
							if (sub === null) { continue; }
							if (Array.isArray(sub)) { caseBody.push(...sub); }
							else { caseBody.push(sub); }
						}
						cases.push({ label, body: caseBody });
					}
				}
			}
			return { kind: 'switch', subject: trunc(subject), cases };
		}
		case 'for_statement': {
			bump(ctx);
			const condition = node.childForFieldName('condition')?.text
				?? node.childForFieldName('initializer')?.text
				?? 'for';
			const body = node.childForFieldName('body');
			return {
				kind: 'loop', loopKind: 'for', predicate: trunc(condition),
				body: walkBranch(body, ctx),
			};
		}
		case 'for_in_statement': {
			bump(ctx);
			const left = node.childForFieldName('left')?.text ?? 'item';
			const right = node.childForFieldName('right')?.text ?? 'iter';
			const opNode = node.children.find(
				c => c.type === 'in' || c.type === 'of',
			);
			const op = opNode?.type === 'of' ? 'of' : 'in';
			return {
				kind: 'loop', loopKind: op === 'of' ? 'for-of' : 'for-in',
				predicate: trunc(`${left} ${op} ${right}`),
				body: walkBranch(node.childForFieldName('body'), ctx),
			};
		}
		case 'while_statement': {
			bump(ctx);
			const condition = node.childForFieldName('condition')?.text ?? 'cond';
			return {
				kind: 'loop', loopKind: 'while', predicate: trunc(condition),
				body: walkBranch(node.childForFieldName('body'), ctx),
			};
		}
		case 'do_statement': {
			bump(ctx);
			const condition = node.childForFieldName('condition')?.text ?? 'cond';
			return {
				kind: 'loop', loopKind: 'do-while', predicate: trunc(condition),
				body: walkBranch(node.childForFieldName('body'), ctx),
			};
		}
		case 'try_statement': {
			bump(ctx);
			const tryBlock = node.childForFieldName('body');
			const handler = node.children.find(c => c.type === 'catch_clause');
			const finally_ = node.children.find(c => c.type === 'finally_clause');
			return {
				kind: 'try',
				tryBody: walkBranch(tryBlock, ctx),
				catchBody: handler === undefined ? null : walkBranch(
					handler.childForFieldName('body') ?? handler, ctx,
				),
				finallyBody: finally_ === undefined ? null : walkBranch(
					finally_.childForFieldName('body') ?? finally_, ctx,
				),
			};
		}
		case 'return_statement': {
			bump(ctx);
			const arg = node.namedChild(0)?.text;
			return { kind: 'return', label: arg !== undefined ? trunc(`return ${arg}`) : 'return' };
		}
		case 'break_statement': {
			bump(ctx);
			return { kind: 'break' };
		}
		case 'continue_statement': {
			bump(ctx);
			return { kind: 'continue' };
		}
		case 'throw_statement': {
			bump(ctx);
			const arg = node.namedChild(0)?.text ?? '';
			return { kind: 'throw', label: trunc(`throw ${arg}`) };
		}
		case 'expression_statement': {
			// Render only call expressions (`foo(...)`, `obj.method(...)`)
			// as their own step; everything else (assignments, member
			// expressions, etc.) collapses into the implicit straight-
			// line flow.
			const expr = node.namedChild(0);
			if (expr === null) { return null; }
			if (expr.type === 'call_expression' || expr.type === 'await_expression') {
				bump(ctx);
				return { kind: 'call', callee: trunc(expr.text) };
			}
			return null;
		}
		case 'statement_block':
		case 'block': {
			// Bare nested block -- inline its contents.
			return walkBlock(node, ctx);
		}
		default:
			return null;
	}
}

// ---------------------------------------------------------------------------
// Python walker (tree-sitter-python node names)
// ---------------------------------------------------------------------------

function walkStatementPython(node: SyntaxNode, ctx: WalkCtx): CfgStep | CfgStep[] | null {
	switch (node.type) {
		case 'if_statement': {
			bump(ctx);
			const condition = node.childForFieldName('condition')?.text ?? 'cond';
			const consequence = node.childForFieldName('consequence');
			// Python `else_clause` (with `body` field) or chained `elif`
			// rendered as a sub-`if_statement` inside the alternative.
			const altNode = node.childForFieldName('alternative');
			let alternative: CfgStep[] | null = null;
			if (altNode !== null) {
				if (altNode.type === 'else_clause') {
					const body = altNode.childForFieldName('body');
					alternative = walkBranch(body, ctx);
				} else if (altNode.type === 'elif_clause') {
					// Chained `elif`: render as a single nested branch in
					// the alternative.
					const nested = walkStatementPython(altNode, ctx);
					alternative = Array.isArray(nested) ? nested : (nested === null ? [] : [nested]);
				} else {
					alternative = walkBranch(altNode, ctx);
				}
			}
			return {
				kind: 'branch',
				predicate: trunc(condition),
				consequent: walkBranch(consequence, ctx),
				alternative,
			};
		}
		case 'elif_clause': {
			// Treat as a branch: condition + body + (optional) further
			// alternative inside the parent's chain. The parent
			// if_statement passes us in via the alternative slot.
			bump(ctx);
			const condition = node.childForFieldName('condition')?.text ?? 'cond';
			const body = node.childForFieldName('body');
			// elif_clause does NOT carry an alternative field directly
			// in tree-sitter-python; chained elifs / else are siblings.
			return {
				kind: 'branch',
				predicate: trunc(condition),
				consequent: walkBranch(body, ctx),
				alternative: null,
			};
		}
		case 'match_statement': {
			bump(ctx);
			const subject = node.childForFieldName('subject')?.text ?? 'subject';
			const cases: { label: string; body: CfgStep[] }[] = [];
			const body = node.childForFieldName('body');
			if (body !== null) {
				for (let i = 0; i < body.namedChildCount; i++) {
					const c = body.namedChild(i);
					if (c === null || c.type !== 'case_clause') { continue; }
					bump(ctx);
					const pattern = c.children.find(n => n.type !== 'block')?.text ?? 'case';
					const caseBody = c.childForFieldName('consequence') ?? c.children.find(n => n.type === 'block') ?? null;
					cases.push({
						label: trunc(pattern),
						body: caseBody === null ? [] : walkBlock(caseBody, ctx),
					});
				}
			}
			return { kind: 'switch', subject: trunc(subject), cases };
		}
		case 'for_statement': {
			bump(ctx);
			const left = node.childForFieldName('left')?.text ?? 'item';
			const right = node.childForFieldName('right')?.text ?? 'iter';
			return {
				kind: 'loop', loopKind: 'for-of',
				predicate: trunc(`${left} in ${right}`),
				body: walkBranch(node.childForFieldName('body'), ctx),
			};
		}
		case 'while_statement': {
			bump(ctx);
			const condition = node.childForFieldName('condition')?.text ?? 'cond';
			return {
				kind: 'loop', loopKind: 'while', predicate: trunc(condition),
				body: walkBranch(node.childForFieldName('body'), ctx),
			};
		}
		case 'try_statement': {
			bump(ctx);
			const tryBody = node.childForFieldName('body');
			const exceptClauses = node.children.filter(c => c.type === 'except_clause');
			const finallyClause = node.children.find(c => c.type === 'finally_clause');

			// Multiple `except` clauses collapse into a single catch body
			// containing each as an inner branch.
			let catchBody: CfgStep[] | null = null;
			if (exceptClauses.length > 0) {
				catchBody = [];
				for (const ec of exceptClauses) {
					bump(ctx);
					const exType = ec.children.find(n => n.type !== 'block')?.text ?? 'Exception';
					const ecBody = ec.children.find(n => n.type === 'block');
					catchBody.push({
						kind: 'branch',
						predicate: trunc(`except ${exType}`),
						consequent: ecBody === undefined ? [] : walkBlock(ecBody, ctx),
						alternative: null,
					});
				}
			}

			let finallyBody: CfgStep[] | null = null;
			if (finallyClause !== undefined) {
				const fb = finallyClause.children.find(n => n.type === 'block');
				finallyBody = fb === undefined ? [] : walkBlock(fb, ctx);
			}

			return {
				kind: 'try',
				tryBody: tryBody === null ? [] : walkBlock(tryBody, ctx),
				catchBody,
				finallyBody,
			};
		}
		case 'return_statement': {
			bump(ctx);
			const arg = node.namedChild(0)?.text;
			return { kind: 'return', label: arg !== undefined ? trunc(`return ${arg}`) : 'return' };
		}
		case 'break_statement': {
			bump(ctx);
			return { kind: 'break' };
		}
		case 'continue_statement': {
			bump(ctx);
			return { kind: 'continue' };
		}
		case 'raise_statement': {
			bump(ctx);
			const arg = node.namedChild(0)?.text ?? '';
			return { kind: 'throw', label: trunc(`raise ${arg}`) };
		}
		case 'with_statement': {
			// Python `with` is a context-manager block. Inline its body
			// statements rather than render a dedicated step (the manager
			// itself doesn't shape control flow visibly enough to warrant
			// a node).
			const body = node.childForFieldName('body');
			return body === null ? null : walkBlock(body, ctx);
		}
		case 'expression_statement': {
			// Render only call expressions; everything else collapses
			// into the implicit straight-line flow.
			const expr = node.namedChild(0);
			if (expr === null) { return null; }
			if (expr.type === 'call' || expr.type === 'await') {
				bump(ctx);
				return { kind: 'call', callee: trunc(expr.text) };
			}
			return null;
		}
		case 'block': {
			return walkBlock(node, ctx);
		}
		default:
			return null;
	}
}

// ---------------------------------------------------------------------------
// Go walker (tree-sitter-go node names)
// ---------------------------------------------------------------------------

function walkStatementGo(node: SyntaxNode, ctx: WalkCtx): CfgStep | CfgStep[] | null {
	switch (node.type) {
		case 'if_statement': {
			bump(ctx);
			const condition = node.childForFieldName('condition')?.text ?? 'cond';
			const consequence = node.childForFieldName('consequence');
			const altNode = node.childForFieldName('alternative');
			let alternative: CfgStep[] | null = null;
			if (altNode !== null) {
				if (altNode.type === 'if_statement') {
					// Chained `else if`: render as a nested branch in
					// the alternative slot.
					const nested = walkStatementGo(altNode, ctx);
					alternative = Array.isArray(nested) ? nested : (nested === null ? [] : [nested]);
				} else {
					// `else { ... }` or `else single_stmt`.
					alternative = walkBranch(altNode, ctx);
				}
			}
			return {
				kind: 'branch',
				predicate: trunc(condition),
				consequent: walkBranch(consequence, ctx),
				alternative,
			};
		}
		case 'for_statement': {
			bump(ctx);
			// Three Go for variants:
			//   1. `for cond { }`             -> while-like
			//   2. `for init; cond; post { }` -> C-style
			//   3. `for x := range xs { }`    -> range
			//   4. `for { }`                  -> infinite
			const rangeClause = node.children.find(c => c.type === 'range_clause');
			const forClause = node.children.find(c => c.type === 'for_clause');
			let predicate = 'for';
			if (rangeClause !== undefined) {
				const left = rangeClause.children.find(c => c.type !== 'range')?.text ?? '_';
				const right = rangeClause.childForFieldName('right')?.text ?? 'iter';
				predicate = `${left} := range ${right}`;
			} else if (forClause !== undefined) {
				const cond = forClause.childForFieldName('condition')?.text;
				if (typeof cond === 'string' && cond !== '') { predicate = cond; }
			} else {
				// Bare `for cond { }` -- the condition (if present) is
				// the first non-block child.
				const condChild = node.children.find(
					c => c.type !== 'for' && c.type !== 'block',
				);
				if (condChild !== undefined) { predicate = condChild.text; }
			}
			return {
				kind: 'loop',
				loopKind: rangeClause !== undefined ? 'for-of' : (forClause !== undefined ? 'for' : 'while'),
				predicate: trunc(predicate),
				body: walkBranch(node.childForFieldName('body'), ctx),
			};
		}
		case 'expression_switch_statement':
		case 'type_switch_statement': {
			bump(ctx);
			const subject = node.children.find(
				c => c.type !== 'switch' && c.type !== '{' && c.type !== '}'
					&& c.type !== 'expression_case' && c.type !== 'default_case'
					&& c.type !== 'type_case' && c.type !== 'type_switch_header',
			);
			const subjectText = subject !== undefined ? subject.text : 'subject';
			const cases: { label: string; body: CfgStep[] }[] = [];
			for (let i = 0; i < node.namedChildCount; i++) {
				const c = node.namedChild(i);
				if (c === null) { continue; }
				if (c.type === 'expression_case' || c.type === 'type_case' || c.type === 'default_case') {
					bump(ctx);
					const label = c.type === 'default_case'
						? 'default'
						: trunc(
							c.children.find(
								n => n.type !== 'case' && n.type !== ':' && n.type !== ',',
							)?.text ?? 'case',
						);
					const caseBody: CfgStep[] = [];
					for (let j = 0; j < c.namedChildCount; j++) {
						const cc = c.namedChild(j);
						if (cc === null) { continue; }
						if (cc.type === 'expression_list' || cc.type === 'type_case_clause') { continue; }
						const sub = walkStatement(cc, ctx);
						if (sub === null) { continue; }
						if (Array.isArray(sub)) { caseBody.push(...sub); }
						else { caseBody.push(sub); }
					}
					cases.push({ label, body: caseBody });
				}
			}
			return { kind: 'switch', subject: trunc(subjectText), cases };
		}
		case 'select_statement': {
			bump(ctx);
			const cases: { label: string; body: CfgStep[] }[] = [];
			for (let i = 0; i < node.namedChildCount; i++) {
				const c = node.namedChild(i);
				if (c === null || c.type !== 'communication_case') { continue; }
				bump(ctx);
				const comm = c.children.find(n => n.type !== 'case' && n.type !== ':');
				const label = trunc(comm !== undefined ? comm.text : 'case');
				const caseBody: CfgStep[] = [];
				for (let j = 0; j < c.namedChildCount; j++) {
					const cc = c.namedChild(j);
					if (cc === null) { continue; }
					const sub = walkStatement(cc, ctx);
					if (sub === null) { continue; }
					if (Array.isArray(sub)) { caseBody.push(...sub); }
					else { caseBody.push(sub); }
				}
				cases.push({ label, body: caseBody });
			}
			return { kind: 'switch', subject: 'select', cases };
		}
		case 'defer_statement': {
			// Render as a regular call step labelled `defer X`. The
			// fan-out-to-deferred-call rendering the plan sketched
			// would need post-processing; this simpler form preserves
			// the sketch fidelity target.
			bump(ctx);
			const inner = node.namedChild(0);
			const callee = inner !== null ? `defer ${inner.text}` : 'defer';
			return { kind: 'call', callee: trunc(callee) };
		}
		case 'go_statement': {
			// `go foo()` -- render as a regular call step. Goroutine
			// concurrency isn't a control-flow construct in the
			// sketch-fidelity sense.
			bump(ctx);
			const inner = node.namedChild(0);
			const callee = inner !== null ? `go ${inner.text}` : 'go';
			return { kind: 'call', callee: trunc(callee) };
		}
		case 'return_statement': {
			bump(ctx);
			const arg = node.namedChild(0)?.text;
			return { kind: 'return', label: arg !== undefined ? trunc(`return ${arg}`) : 'return' };
		}
		case 'break_statement': {
			bump(ctx);
			return { kind: 'break' };
		}
		case 'continue_statement': {
			bump(ctx);
			return { kind: 'continue' };
		}
		case 'goto_statement': {
			// Rare but legal; render as a continue-like terminator.
			bump(ctx);
			return { kind: 'continue' };
		}
		case 'expression_statement': {
			const expr = node.namedChild(0);
			if (expr === null) { return null; }
			if (expr.type === 'call_expression') {
				bump(ctx);
				// Special-case `panic(...)` -> throw step. Recognised
				// by the callee being a bare identifier `panic`.
				const fn = expr.childForFieldName('function');
				if (fn !== null && fn.text === 'panic') {
					return { kind: 'throw', label: trunc(`panic ${expr.text}`) };
				}
				return { kind: 'call', callee: trunc(expr.text) };
			}
			return null;
		}
		case 'block': {
			return walkBlock(node, ctx);
		}
		case 'short_var_declaration':
		case 'var_declaration':
		case 'assignment_statement':
		case 'inc_statement':
		case 'dec_statement':
		case 'send_statement':
			// Plain statements collapse into the implicit straight-line
			// flow; only their containing call expressions (if any)
			// would be worth rendering, but we deliberately skip them
			// to avoid noise.
			return null;
		default:
			return null;
	}
}

// ---------------------------------------------------------------------------
// Java walker (tree-sitter-java node names)
// ---------------------------------------------------------------------------

function walkStatementJava(node: SyntaxNode, ctx: WalkCtx): CfgStep | CfgStep[] | null {
	switch (node.type) {
		case 'if_statement': {
			bump(ctx);
			const condition = stripParens(node.childForFieldName('condition')?.text ?? 'cond');
			const consequence = node.childForFieldName('consequence');
			const alternative = node.childForFieldName('alternative');
			return {
				kind: 'branch',
				predicate: trunc(condition),
				consequent: walkBranch(consequence, ctx),
				alternative: alternative === null ? null : walkBranch(alternative, ctx),
			};
		}
		case 'switch_expression':
		case 'switch_statement': {
			bump(ctx);
			const subject = stripParens(node.childForFieldName('condition')?.text
				?? node.namedChild(0)?.text ?? 'subject');
			const cases: { label: string; body: CfgStep[] }[] = [];
			const switchBlock = node.namedChildren.find(c => c.type === 'switch_block');
			if (switchBlock !== undefined) {
				for (let i = 0; i < switchBlock.namedChildCount; i++) {
					const c = switchBlock.namedChild(i);
					if (c === null) { continue; }
					if (c.type === 'switch_block_statement_group' || c.type === 'switch_rule') {
						bump(ctx);
						const labels: string[] = [];
						const bodyStmts: SyntaxNode[] = [];
						for (let j = 0; j < c.namedChildCount; j++) {
							const cc = c.namedChild(j);
							if (cc === null) { continue; }
							if (cc.type === 'switch_label' || cc.type === 'switch_case_label') {
								labels.push(stripParens(cc.text.replace(/^case\s+/, '').replace(/:$/, '').trim()));
							} else {
								bodyStmts.push(cc);
							}
						}
						const caseBody: CfgStep[] = [];
						for (const stmt of bodyStmts) {
							const sub = walkStatement(stmt, ctx);
							if (sub === null) { continue; }
							if (Array.isArray(sub)) { caseBody.push(...sub); }
							else { caseBody.push(sub); }
						}
						cases.push({
							label: trunc(labels.length === 0 ? 'case' : labels.join(' / ')),
							body: caseBody,
						});
					}
				}
			}
			return { kind: 'switch', subject: trunc(subject), cases };
		}
		case 'for_statement': {
			bump(ctx);
			const condition = node.childForFieldName('condition')?.text ?? 'for';
			return {
				kind: 'loop', loopKind: 'for', predicate: trunc(condition),
				body: walkBranch(node.childForFieldName('body'), ctx),
			};
		}
		case 'enhanced_for_statement': {
			bump(ctx);
			const itemNode = node.namedChildren.find(
				c => c.type === 'identifier' || c.type === 'variable_declarator',
			);
			// Collection sits between the item declarator and the body
			// block. Walk children right-to-left to find the last
			// non-body, non-itemNode child.
			let collectionNode: SyntaxNode | null = null;
			for (let i = node.namedChildCount - 1; i >= 0; i--) {
				const c = node.namedChild(i);
				if (c === null) { continue; }
				if (c === itemNode) { continue; }
				if (c.type === 'block' || c.type === 'expression_statement') { continue; }
				collectionNode = c;
				break;
			}
			const item = itemNode?.text ?? 'item';
			const coll = collectionNode?.text ?? 'iter';
			return {
				kind: 'loop', loopKind: 'for-of',
				predicate: trunc(`${item} : ${coll}`),
				body: walkBranch(node.childForFieldName('body'), ctx),
			};
		}
		case 'while_statement': {
			bump(ctx);
			const condition = stripParens(node.childForFieldName('condition')?.text ?? 'cond');
			return {
				kind: 'loop', loopKind: 'while', predicate: trunc(condition),
				body: walkBranch(node.childForFieldName('body'), ctx),
			};
		}
		case 'do_statement': {
			bump(ctx);
			const condition = stripParens(node.childForFieldName('condition')?.text ?? 'cond');
			return {
				kind: 'loop', loopKind: 'do-while', predicate: trunc(condition),
				body: walkBranch(node.childForFieldName('body'), ctx),
			};
		}
		case 'try_statement':
		case 'try_with_resources_statement': {
			bump(ctx);
			const tryBlock = node.namedChildren.find(c => c.type === 'block');
			const catchClauses = node.namedChildren.filter(c => c.type === 'catch_clause');
			const finallyClause = node.namedChildren.find(c => c.type === 'finally_clause');

			let catchBody: CfgStep[] | null = null;
			if (catchClauses.length > 0) {
				catchBody = [];
				for (const cc of catchClauses) {
					bump(ctx);
					const formal = cc.namedChildren.find(c => c.type === 'catch_formal_parameter');
					const exType = formal?.namedChildren.find(
						c => c.type === 'type_identifier' || c.type === 'union_type' || c.type === 'catch_type',
					)?.text ?? 'Throwable';
					const ccBody = cc.namedChildren.find(c => c.type === 'block');
					catchBody.push({
						kind: 'branch',
						predicate: trunc(`catch ${exType}`),
						consequent: ccBody === undefined ? [] : walkBlock(ccBody, ctx),
						alternative: null,
					});
				}
			}

			let finallyBody: CfgStep[] | null = null;
			if (finallyClause !== undefined) {
				const fb = finallyClause.namedChildren.find(c => c.type === 'block');
				finallyBody = fb === undefined ? [] : walkBlock(fb, ctx);
			}

			return {
				kind: 'try',
				tryBody: tryBlock === undefined ? [] : walkBlock(tryBlock, ctx),
				catchBody,
				finallyBody,
			};
		}
		case 'synchronized_statement': {
			// Inline the body as a column under the parent; emit a
			// note-call step indicating the lock object.
			bump(ctx);
			const lockExpr = node.namedChildren.find(c => c.type === 'parenthesized_expression');
			const lockText = stripParens(lockExpr?.text ?? '');
			const block = node.namedChildren.find(c => c.type === 'block');
			const inner = block === undefined ? [] : walkBlock(block, ctx);
			return [
				{ kind: 'call', callee: trunc(`synchronized ${lockText}`) },
				...inner,
			];
		}
		case 'return_statement': {
			bump(ctx);
			const arg = node.namedChild(0)?.text;
			return { kind: 'return', label: arg !== undefined ? trunc(`return ${arg}`) : 'return' };
		}
		case 'break_statement': {
			bump(ctx);
			return { kind: 'break' };
		}
		case 'continue_statement': {
			bump(ctx);
			return { kind: 'continue' };
		}
		case 'yield_statement': {
			// Java switch-expression `yield` -- terminator that returns
			// a value out of a case.
			bump(ctx);
			const arg = node.namedChild(0)?.text ?? '';
			return { kind: 'return', label: trunc(`yield ${arg}`) };
		}
		case 'throw_statement': {
			bump(ctx);
			const arg = node.namedChild(0)?.text ?? '';
			return { kind: 'throw', label: trunc(`throw ${arg}`) };
		}
		case 'expression_statement': {
			const expr = node.namedChild(0);
			if (expr === null) { return null; }
			if (expr.type === 'method_invocation' || expr.type === 'object_creation_expression') {
				bump(ctx);
				return { kind: 'call', callee: trunc(expr.text) };
			}
			return null;
		}
		case 'block': {
			return walkBlock(node, ctx);
		}
		case 'local_variable_declaration':
		case 'assignment_expression':
			return null;
		default:
			return null;
	}
}

// ---------------------------------------------------------------------------
// Scala walker (tree-sitter-scala node names)
//
// Scala's control-flow constructs are expressions (if / match / try /
// for all return values), so `if_expression` / `match_expression` /
// `try_expression` show up wherever a value can. The walker treats
// them as control-flow steps regardless of whether their result is
// consumed.
// ---------------------------------------------------------------------------

function walkStatementScala(node: SyntaxNode, ctx: WalkCtx): CfgStep | CfgStep[] | null {
	switch (node.type) {
		case 'if_expression': {
			bump(ctx);
			const condition = stripParens(node.childForFieldName('condition')?.text ?? 'cond');
			const consequence = node.childForFieldName('consequence');
			const alternative = node.childForFieldName('alternative');
			return {
				kind: 'branch',
				predicate: trunc(condition),
				consequent: walkBranch(consequence, ctx),
				alternative: alternative === null ? null : walkBranch(alternative, ctx),
			};
		}
		case 'match_expression': {
			bump(ctx);
			const subject = node.childForFieldName('value')?.text ?? 'subject';
			const body = node.childForFieldName('body');
			const cases: { label: string; body: CfgStep[] }[] = [];
			if (body !== null) {
				for (let i = 0; i < body.namedChildCount; i++) {
					const c = body.namedChild(i);
					if (c === null || c.type !== 'case_clause') { continue; }
					bump(ctx);
					// Pattern + optional guard, then the body block.
					const pattern = c.namedChildren[0]?.text ?? 'case';
					const guard = c.namedChildren.find(n => n.type === 'guard');
					const label = trunc(
						`${pattern}${guard !== undefined ? ` ${guard.text}` : ''}`,
					);
					// Collect the body steps -- everything after the
					// pattern / guard, before the matching `=>` token.
					const bodyChildren: SyntaxNode[] = [];
					let pastArrow = false;
					for (let j = 0; j < c.namedChildCount; j++) {
						const cc = c.namedChild(j);
						if (cc === null) { continue; }
						if (!pastArrow) {
							// First non-pattern, non-guard child is body.
							if (cc === c.namedChildren[0]) { continue; }
							if (cc.type === 'guard') { continue; }
							pastArrow = true;
						}
						bodyChildren.push(cc);
					}
					const caseBody: CfgStep[] = [];
					for (const stmt of bodyChildren) {
						const sub = walkStatement(stmt, ctx);
						if (sub === null) { continue; }
						if (Array.isArray(sub)) { caseBody.push(...sub); }
						else { caseBody.push(sub); }
					}
					cases.push({ label, body: caseBody });
				}
			}
			return { kind: 'switch', subject: trunc(subject), cases };
		}
		case 'while_expression': {
			bump(ctx);
			const condition = stripParens(node.childForFieldName('condition')?.text
				?? node.namedChildren[0]?.text ?? 'cond');
			return {
				kind: 'loop', loopKind: 'while', predicate: trunc(condition),
				body: walkBranch(node.childForFieldName('body') ?? node.namedChildren[1] ?? null, ctx),
			};
		}
		case 'for_expression': {
			bump(ctx);
			const enums = node.namedChildren.find(c => c.type === 'enumerators');
			const predicate = enums?.text.split(/[\r\n;]/)[0]?.trim() ?? 'for';
			const bodyExpr = node.namedChildren.find(
				c => c.type !== 'enumerators' && c.type !== 'yield',
			) ?? null;
			return {
				kind: 'loop', loopKind: 'for-of', predicate: trunc(predicate),
				body: bodyExpr === null ? [] : walkBranch(bodyExpr, ctx),
			};
		}
		case 'try_expression': {
			bump(ctx);
			const tryBlock = node.namedChildren.find(c => c.type === 'block');
			const catchClause = node.namedChildren.find(c => c.type === 'catch_clause');
			const finallyClause = node.namedChildren.find(c => c.type === 'finally_clause');

			let catchBody: CfgStep[] | null = null;
			if (catchClause !== undefined) {
				catchBody = [];
				// Catch body in Scala is a `case_block` with one or
				// more `case_clause`s.
				const caseBlock = catchClause.namedChildren.find(c => c.type === 'case_block');
				if (caseBlock !== undefined) {
					for (let i = 0; i < caseBlock.namedChildCount; i++) {
						const cc = caseBlock.namedChild(i);
						if (cc === null || cc.type !== 'case_clause') { continue; }
						bump(ctx);
						const pattern = cc.namedChildren[0]?.text ?? 'case';
						catchBody.push({
							kind: 'branch',
							predicate: trunc(`catch ${pattern}`),
							consequent: walkBranch(cc, ctx),
							alternative: null,
						});
					}
				}
			}

			let finallyBody: CfgStep[] | null = null;
			if (finallyClause !== undefined) {
				const fb = finallyClause.namedChildren.find(
					c => c.type === 'block' || c.type !== 'finally',
				);
				finallyBody = fb === undefined ? [] : walkBranch(fb, ctx);
			}

			return {
				kind: 'try',
				tryBody: tryBlock === undefined ? [] : walkBlock(tryBlock, ctx),
				catchBody,
				finallyBody,
			};
		}
		case 'return_expression': {
			bump(ctx);
			const arg = node.namedChild(0)?.text;
			return { kind: 'return', label: arg !== undefined ? trunc(`return ${arg}`) : 'return' };
		}
		case 'throw_expression': {
			bump(ctx);
			const arg = node.namedChild(0)?.text ?? '';
			return { kind: 'throw', label: trunc(`throw ${arg}`) };
		}
		case 'call_expression': {
			bump(ctx);
			return { kind: 'call', callee: trunc(node.text) };
		}
		case 'block': {
			return walkBlock(node, ctx);
		}
		case 'val_definition':
		case 'var_definition':
		case 'assignment_expression':
		case 'infix_expression':
			return null;
		default:
			return null;
	}
}

function stripParens(text: string): string {
	const t = text.trim();
	return t.startsWith('(') && t.endsWith(')') ? t.slice(1, -1).trim() : t;
}

/**
 * Walk a branch / loop body, which may be either a `statement_block`
 * (in `{ ... }`), Python `block`, or a single statement (no braces).
 * Either way, return a flat list of steps.
 *
 * Also drills into wrapper nodes the grammars emit around blocks:
 * `else_clause` (TypeScript / JavaScript), where the field-named
 * alternative slot returns the wrapper, not the contained block.
 */
function walkBranch(node: SyntaxNode | null, ctx: WalkCtx): CfgStep[] {
	if (node === null) { return []; }
	if (node.type === 'statement_block' || node.type === 'block') {
		return walkBlock(node, ctx);
	}
	// `else_clause` / `else_clause` (TS) / `finally_clause` wraps a
	// block. Drill into the inner block + recurse.
	if (node.type === 'else_clause' || node.type === 'finally_clause') {
		const inner = node.namedChildren.find(
			c => c.type === 'statement_block' || c.type === 'block',
		);
		if (inner !== undefined) { return walkBlock(inner, ctx); }
		// When the inner is a single statement (e.g. `else if (...) ...`),
		// recurse into the first non-keyword child.
		const firstStmt = node.namedChildren[0];
		if (firstStmt !== undefined) { return walkBranch(firstStmt, ctx); }
		return [];
	}
	const single = walkStatement(node, ctx);
	if (single === null) { return []; }
	return Array.isArray(single) ? single : [single];
}

// ---------------------------------------------------------------------------
// Public entry: function body -> step tree
// ---------------------------------------------------------------------------

export interface CfgFromEntityResult extends CfgWalkResult {
	readonly entryLabel: string;
	readonly language: Language;
}

/**
 * Run the walker against a code entity (function / method). The
 * entity's `body` carries the full source already (extracted at index
 * time -- see indexer/parser/typescript.ts). Throws when the language
 * isn't supported, the entity isn't a function-shaped entity, or the
 * body exceeds the 200-node cap.
 */
export function walkCfgFromEntity(entity: Entity): CfgFromEntityResult {
	if (entity.kind !== 'function' && entity.kind !== 'method') {
		throw new Error(
			`cfg: entity '${entity.name}' is a ${entity.kind}, not a function or method`,
		);
	}
	if (
		entity.language !== 'typescript'
		&& entity.language !== 'javascript'
		&& entity.language !== 'python'
		&& entity.language !== 'go'
		&& entity.language !== 'java'
		&& entity.language !== 'scala'
	) {
		throw new Error(
			`cfg: language '${entity.language}' not yet supported`,
		);
	}
	if (entity.body === '') {
		throw new Error(`cfg: entity '${entity.name}' has empty body`);
	}

	const grammar = pickLanguageGrammar(entity.language, entity.file);
	const parser = new Parser();
	(parser as { setLanguage(l: unknown): void }).setLanguage(grammar);
	const tree = (parser as {
		parse(s: string): { rootNode: SyntaxNode };
	}).parse(entity.body);

	const lang: WalkLang = entity.language;
	const block = findBodyBlock(tree.rootNode, lang);
	if (block === null) {
		throw new Error(`cfg: could not locate function body in '${entity.name}'`);
	}

	const ctx: WalkCtx = { count: 0, lang };
	const isBlock = block.type === 'statement_block' || block.type === 'block';
	let steps: CfgStep[];
	if (isBlock) {
		steps = walkBlock(block, ctx);
	} else {
		// Scala expression-bodied functions (`def m = if (x) y else z`)
		// have a non-block body. Walk it as a single statement to get
		// the appropriate step.
		const single = walkStatement(block, ctx);
		steps = single === null ? [] : (Array.isArray(single) ? single : [single]);
	}

	return {
		steps,
		nodeCount: ctx.count,
		entryLabel: entity.name,
		language: entity.language,
	};
}

// ---------------------------------------------------------------------------
// Mermaid rendering
// ---------------------------------------------------------------------------

/** Mermaid node ids must match `[A-Za-z_][A-Za-z0-9_]*`. */
function nodeId(prefix: string, seen: Set<string>): string {
	let i = 1;
	let id = `${prefix}_${i}`;
	while (seen.has(id)) { i++; id = `${prefix}_${i}`; }
	seen.add(id);
	return id;
}

/** Sanitise a label for a Mermaid `["..."]` slot. */
function nodeLabel(raw: string): string {
	return raw.replace(/[[\]"`]/g, '').replace(/\|/g, '/').trim();
}

/**
 * Linearise the step tree into a Mermaid `flowchart TD`. Branches
 * re-converge to whichever node comes after them (the renderer
 * threads `nextId` through the recursion so each terminal step
 * points at the right successor).
 */
export function renderCfgMermaid(result: CfgFromEntityResult): string {
	const lines: string[] = ['flowchart TD'];
	const seen = new Set<string>();

	const enterId = nodeId('Enter', seen);
	lines.push(`  ${enterId}([${nodeLabel(result.entryLabel)}])`);

	const exitId = nodeId('Exit', seen);

	const lastId = renderSteps(result.steps, enterId, exitId, lines, seen);
	if (lastId !== null) {
		lines.push(`  ${lastId} --> ${exitId}`);
	}

	lines.push(`  ${exitId}([end])`);
	return lines.join('\n');
}

/**
 * Render a sequential list of steps. Returns the id of the last
 * "fall-through" node -- callers chain a `--> <next>` from it.
 * Returns null if the sequence ends with a terminator (return,
 * throw) and so has no fall-through.
 */
function renderSteps(
	steps: readonly CfgStep[],
	prevId: string,
	exitId: string,
	lines: string[],
	seen: Set<string>,
): string | null {
	let cursor: string | null = prevId;
	for (const step of steps) {
		if (cursor === null) { break; }
		cursor = renderStep(step, cursor, exitId, lines, seen);
	}
	return cursor;
}

function renderStep(
	step: CfgStep,
	prevId: string,
	exitId: string,
	lines: string[],
	seen: Set<string>,
): string | null {
	switch (step.kind) {
		case 'enter':
		case 'stmt': {
			const id = nodeId('Stmt', seen);
			lines.push(`  ${id}["${nodeLabel(step.label)}"]`);
			lines.push(`  ${prevId} --> ${id}`);
			return id;
		}
		case 'call': {
			const id = nodeId('Call', seen);
			lines.push(`  ${id}["${nodeLabel(step.callee)}"]`);
			lines.push(`  ${prevId} --> ${id}`);
			return id;
		}
		case 'return': {
			const id = nodeId('Return', seen);
			lines.push(`  ${id}([${nodeLabel(step.label)}])`);
			lines.push(`  ${prevId} --> ${id}`);
			lines.push(`  ${id} --> ${exitId}`);
			return null;     // terminator: no fall-through
		}
		case 'break': {
			const id = nodeId('Break', seen);
			lines.push(`  ${id}([break])`);
			lines.push(`  ${prevId} --> ${id}`);
			return null;
		}
		case 'continue': {
			const id = nodeId('Continue', seen);
			lines.push(`  ${id}([continue])`);
			lines.push(`  ${prevId} --> ${id}`);
			return null;
		}
		case 'throw': {
			const id = nodeId('Throw', seen);
			lines.push(`  ${id}([${nodeLabel(step.label)}])`);
			lines.push(`  ${prevId} --> ${id}`);
			lines.push(`  ${id} --> ${exitId}`);
			return null;
		}
		case 'branch': {
			const decisionId = nodeId('If', seen);
			lines.push(`  ${decisionId}{${nodeLabel(step.predicate)}}`);
			lines.push(`  ${prevId} --> ${decisionId}`);

			const trueTail = renderSteps(step.consequent, decisionId, exitId, lines, seen);
			let falseTail: string | null;
			if (step.alternative === null) {
				// Empty else: implicit edge from decision to next.
				falseTail = decisionId;
			} else {
				falseTail = renderSteps(step.alternative, decisionId, exitId, lines, seen);
			}

			// If both branches terminate (return/throw), the branch as a
			// whole has no fall-through.
			if (trueTail === null && falseTail === null) { return null; }

			// Re-converge into a join node so the next step has a single
			// predecessor.
			const joinId = nodeId('Join', seen);
			lines.push(`  ${joinId}[ ]`);
			lines.push(`  ${joinId}@{ shape: framed-circle }`);
			if (trueTail !== null) { lines.push(`  ${trueTail} -->|true| ${joinId}`); }
			if (falseTail !== null) { lines.push(`  ${falseTail} -->|false| ${joinId}`); }
			return joinId;
		}
		case 'switch': {
			const switchId = nodeId('Switch', seen);
			lines.push(`  ${switchId}{${nodeLabel(step.subject)}}`);
			lines.push(`  ${prevId} --> ${switchId}`);

			const tails: string[] = [];
			for (const c of step.cases) {
				const caseHead = nodeId('Case', seen);
				lines.push(`  ${caseHead}[${nodeLabel(c.label)}]`);
				lines.push(`  ${switchId} --> ${caseHead}`);
				const tail = renderSteps(c.body, caseHead, exitId, lines, seen);
				if (tail !== null) { tails.push(tail); }
			}
			if (tails.length === 0) { return null; }
			const joinId = nodeId('SwitchJoin', seen);
			lines.push(`  ${joinId}[ ]`);
			for (const t of tails) { lines.push(`  ${t} --> ${joinId}`); }
			return joinId;
		}
		case 'loop': {
			const headId = nodeId('Loop', seen);
			lines.push(`  ${headId}{${nodeLabel(`${step.loopKind} ${step.predicate}`)}}`);
			lines.push(`  ${prevId} --> ${headId}`);

			const bodyTail = renderSteps(step.body, headId, exitId, lines, seen);
			if (bodyTail !== null) {
				lines.push(`  ${bodyTail} --> ${headId}`);
			}
			return headId;
		}
		case 'try': {
			const tryHeadId = nodeId('Try', seen);
			lines.push(`  ${tryHeadId}[try]`);
			lines.push(`  ${prevId} --> ${tryHeadId}`);

			const tryTail = renderSteps(step.tryBody, tryHeadId, exitId, lines, seen);

			let catchTail: string | null = null;
			if (step.catchBody !== null) {
				const catchHeadId = nodeId('Catch', seen);
				lines.push(`  ${catchHeadId}[catch]`);
				lines.push(`  ${tryHeadId} -.->|throw| ${catchHeadId}`);
				catchTail = renderSteps(step.catchBody, catchHeadId, exitId, lines, seen);
			}

			let finalEntry: string | null = null;
			if (step.finallyBody !== null) {
				const finallyHeadId = nodeId('Finally', seen);
				lines.push(`  ${finallyHeadId}[finally]`);
				if (tryTail !== null) { lines.push(`  ${tryTail} --> ${finallyHeadId}`); }
				if (catchTail !== null) { lines.push(`  ${catchTail} --> ${finallyHeadId}`); }
				finalEntry = renderSteps(step.finallyBody, finallyHeadId, exitId, lines, seen);
			} else {
				// Without finally: re-converge directly.
				if (tryTail === null && catchTail === null) { return null; }
				const joinId = nodeId('TryJoin', seen);
				lines.push(`  ${joinId}[ ]`);
				if (tryTail !== null) { lines.push(`  ${tryTail} --> ${joinId}`); }
				if (catchTail !== null) { lines.push(`  ${catchTail} --> ${joinId}`); }
				return joinId;
			}

			return finalEntry;
		}
	}
}
