/**
 * Tests for the on-demand CFG walker (`walkCfgFromEntity`) +
 * Mermaid renderer (`renderCfgMermaid`) used by the `flow:code`
 * artifact branch (plan §4.2).
 *
 * v1 covers TS / TSX / JS only; Python + Go fall through and are
 * tested elsewhere when those walkers land.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { Entity } from '../../../../shared/types.js';
import {
	CFG_NODE_CAP,
	renderCfgMermaid,
	walkCfgFromEntity,
} from '../kinds/cfg.js';

// ---------------------------------------------------------------------------
// Entity-fixture builder
// ---------------------------------------------------------------------------

function fnEntity(name: string, body: string, language: 'typescript' | 'javascript' = 'typescript'): Entity {
	return {
		id: `id-${name}`,
		kind: 'function',
		name,
		language,
		repo: '/repo',
		file: '/repo/src/file.ts',
		startLine: 1,
		endLine: 1,
		body,
		embedding: [],
		indexedAt: '2026-04-25T00:00:00Z',
	};
}

// ---------------------------------------------------------------------------
// Walker -- step-tree shape
// ---------------------------------------------------------------------------

describe('walkCfgFromEntity - step tree', () => {
	it('handles a straight-line function with calls + return', () => {
		const ent = fnEntity('foo', `
function foo(user) {
  audit(user);
  notify(user);
  return done();
}
		`);
		const result = walkCfgFromEntity(ent);
		assert.equal(result.entryLabel, 'foo');
		assert.equal(result.steps.length, 3);
		assert.equal(result.steps[0]?.kind, 'call');
		assert.equal(result.steps[1]?.kind, 'call');
		assert.equal(result.steps[2]?.kind, 'return');
	});

	it('captures if/else as a branch step', () => {
		const ent = fnEntity('foo', `
function foo(user) {
  if (user.isAdmin) {
    return adminPath();
  } else {
    return userPath();
  }
}
		`);
		const result = walkCfgFromEntity(ent);
		assert.equal(result.steps.length, 1);
		const branch = result.steps[0];
		assert.equal(branch?.kind, 'branch');
		if (branch?.kind !== 'branch') { return; }
		assert.match(branch.predicate, /user\.isAdmin/);
		assert.equal(branch.consequent[0]?.kind, 'return');
		assert.notEqual(branch.alternative, null);
		assert.equal(branch.alternative?.[0]?.kind, 'return');
	});

	it('captures bare-if (no else) with null alternative', () => {
		const ent = fnEntity('foo', `
function foo(user) {
  if (user.isAdmin) audit('admin');
  return done();
}
		`);
		const result = walkCfgFromEntity(ent);
		assert.equal(result.steps[0]?.kind, 'branch');
		if (result.steps[0]?.kind === 'branch') {
			assert.equal(result.steps[0].alternative, null);
		}
	});

	it('captures for-of loops with body steps', () => {
		const ent = fnEntity('foo', `
function foo(items) {
  for (const item of items) {
    process(item);
  }
}
		`);
		const result = walkCfgFromEntity(ent);
		assert.equal(result.steps[0]?.kind, 'loop');
		if (result.steps[0]?.kind === 'loop') {
			assert.equal(result.steps[0].loopKind, 'for-of');
			assert.equal(result.steps[0].body[0]?.kind, 'call');
		}
	});

	it('captures while loops', () => {
		const ent = fnEntity('foo', `
function foo() {
  while (cond()) {
    work();
  }
}
		`);
		const result = walkCfgFromEntity(ent);
		assert.equal(result.steps[0]?.kind, 'loop');
		if (result.steps[0]?.kind === 'loop') {
			assert.equal(result.steps[0].loopKind, 'while');
		}
	});

	it('captures try/catch/finally', () => {
		const ent = fnEntity('foo', `
function foo() {
  try {
    risky();
  } catch (e) {
    handle(e);
  } finally {
    cleanup();
  }
}
		`);
		const result = walkCfgFromEntity(ent);
		assert.equal(result.steps[0]?.kind, 'try');
		if (result.steps[0]?.kind === 'try') {
			assert.equal(result.steps[0].tryBody[0]?.kind, 'call');
			assert.notEqual(result.steps[0].catchBody, null);
			assert.notEqual(result.steps[0].finallyBody, null);
		}
	});

	it('captures switch statements with case bodies', () => {
		const ent = fnEntity('foo', `
function foo(state) {
  switch (state) {
    case 'a': return 1;
    case 'b': return 2;
    default: return 0;
  }
}
		`);
		const result = walkCfgFromEntity(ent);
		assert.equal(result.steps[0]?.kind, 'switch');
		if (result.steps[0]?.kind === 'switch') {
			assert.equal(result.steps[0].cases.length, 3);
			assert.equal(result.steps[0].cases[2]?.label, 'default');
		}
	});

	it('captures throw / break / continue terminators', () => {
		const ent = fnEntity('foo', `
function foo(items) {
  for (const item of items) {
    if (!item) continue;
    if (item.bad) break;
    if (item.fatal) throw new Error('nope');
    process(item);
  }
}
		`);
		const result = walkCfgFromEntity(ent);
		assert.equal(result.steps[0]?.kind, 'loop');
		if (result.steps[0]?.kind !== 'loop') { return; }
		const loopBody = result.steps[0].body;
		// First three branches are continue / break / throw guards.
		assert.equal(loopBody[0]?.kind, 'branch');
		if (loopBody[0]?.kind === 'branch') {
			assert.equal(loopBody[0].consequent[0]?.kind, 'continue');
		}
		assert.equal(loopBody[1]?.kind, 'branch');
		if (loopBody[1]?.kind === 'branch') {
			assert.equal(loopBody[1].consequent[0]?.kind, 'break');
		}
		assert.equal(loopBody[2]?.kind, 'branch');
		if (loopBody[2]?.kind === 'branch') {
			assert.equal(loopBody[2].consequent[0]?.kind, 'throw');
		}
	});

	it('truncates long predicate text', () => {
		const longCond = 'a.veryLong.predicate.that.exceeds.forty.characters.surely.does';
		const ent = fnEntity('foo', `
function foo(a) {
  if (${longCond}) return 1;
}
		`);
		const result = walkCfgFromEntity(ent);
		if (result.steps[0]?.kind === 'branch') {
			assert.ok(result.steps[0].predicate.length <= 40);
			assert.match(result.steps[0].predicate, /…$/);
		}
	});
});

// ---------------------------------------------------------------------------
// Walker -- failure modes
// ---------------------------------------------------------------------------

describe('walkCfgFromEntity - failure modes', () => {
	it('rejects non-function entities', () => {
		const ent: Entity = {
			id: 'id-c',
			kind: 'class',
			name: 'C',
			language: 'typescript',
			repo: '/repo',
			file: '/repo/src/c.ts',
			startLine: 1,
			endLine: 1,
			body: 'class C {}',
			embedding: [],
			indexedAt: '2026-04-25T00:00:00Z',
		};
		assert.throws(() => walkCfgFromEntity(ent), /not a function or method/);
	});

	it('rejects unsupported languages', () => {
		// All four indexer-supported languages (TS/JS/Python/Go) are
		// now wired into the walker. Use an unrecognised language to
		// exercise the rejection path.
		const ent: Entity = {
			id: 'id-rs',
			kind: 'function',
			name: 'foo',
			language: 'rust' as Entity['language'],
			repo: '/repo',
			file: '/repo/src/foo.rs',
			startLine: 1,
			endLine: 1,
			body: 'fn foo() {}',
			embedding: [],
			indexedAt: '2026-04-25T00:00:00Z',
		};
		assert.throws(() => walkCfgFromEntity(ent), /not yet supported/);
	});

	it('rejects an empty body', () => {
		const ent = fnEntity('foo', '');
		assert.throws(() => walkCfgFromEntity(ent), /empty body/);
	});

	it('throws when body exceeds the node cap', () => {
		// Build a function whose body has way more than CFG_NODE_CAP
		// distinct branches.
		const branches = Array.from({ length: CFG_NODE_CAP + 5 }, (_, i) =>
			`if (cond_${i}) return ${i};`,
		).join('\n  ');
		const ent = fnEntity('big', `function big() {\n  ${branches}\n}`);
		assert.throws(() => walkCfgFromEntity(ent), /node cap/);
	});
});

// ---------------------------------------------------------------------------
// Renderer -- Mermaid output
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Python walker
// ---------------------------------------------------------------------------

function pyEntity(name: string, body: string): Entity {
	return {
		id: `id-${name}`,
		kind: 'function',
		name,
		language: 'python',
		repo: '/repo',
		file: '/repo/src/file.py',
		startLine: 1,
		endLine: 1,
		body,
		embedding: [],
		indexedAt: '2026-04-25T00:00:00Z',
	};
}

describe('walkCfgFromEntity - Python step tree', () => {
	it('handles a straight-line def with calls + return', () => {
		const ent = pyEntity('foo', `
def foo(user):
    audit(user)
    notify(user)
    return done()
`);
		const result = walkCfgFromEntity(ent);
		assert.equal(result.entryLabel, 'foo');
		assert.equal(result.steps.length, 3);
		assert.equal(result.steps[0]?.kind, 'call');
		assert.equal(result.steps[1]?.kind, 'call');
		assert.equal(result.steps[2]?.kind, 'return');
	});

	it('captures if/else as a branch with else_clause', () => {
		const ent = pyEntity('foo', `
def foo(user):
    if user.is_admin:
        return admin_path()
    else:
        return user_path()
`);
		const result = walkCfgFromEntity(ent);
		const branch = result.steps[0];
		assert.equal(branch?.kind, 'branch');
		if (branch?.kind !== 'branch') { return; }
		assert.match(branch.predicate, /user\.is_admin/);
		assert.equal(branch.consequent[0]?.kind, 'return');
		assert.notEqual(branch.alternative, null);
		assert.equal(branch.alternative?.[0]?.kind, 'return');
	});

	it('captures bare-if (no else) with null alternative', () => {
		const ent = pyEntity('foo', `
def foo(user):
    if user.is_admin:
        audit('admin')
    return done()
`);
		const result = walkCfgFromEntity(ent);
		assert.equal(result.steps[0]?.kind, 'branch');
		if (result.steps[0]?.kind === 'branch') {
			assert.equal(result.steps[0].alternative, null);
		}
	});

	it('captures elif chains in the alternative slot', () => {
		const ent = pyEntity('foo', `
def foo(state):
    if state == 'a':
        return 1
    elif state == 'b':
        return 2
    else:
        return 0
`);
		const result = walkCfgFromEntity(ent);
		assert.equal(result.steps[0]?.kind, 'branch');
		if (result.steps[0]?.kind !== 'branch') { return; }
		// Alternative is a chained branch (the `elif`).
		const alt = result.steps[0].alternative;
		assert.notEqual(alt, null);
		assert.equal(alt?.[0]?.kind, 'branch');
	});

	it('captures for loops with body steps', () => {
		const ent = pyEntity('foo', `
def foo(items):
    for item in items:
        process(item)
`);
		const result = walkCfgFromEntity(ent);
		assert.equal(result.steps[0]?.kind, 'loop');
		if (result.steps[0]?.kind === 'loop') {
			assert.equal(result.steps[0].loopKind, 'for-of');
			assert.equal(result.steps[0].body[0]?.kind, 'call');
		}
	});

	it('captures while loops', () => {
		const ent = pyEntity('foo', `
def foo():
    while cond():
        work()
`);
		const result = walkCfgFromEntity(ent);
		assert.equal(result.steps[0]?.kind, 'loop');
		if (result.steps[0]?.kind === 'loop') {
			assert.equal(result.steps[0].loopKind, 'while');
		}
	});

	it('captures try/except/finally', () => {
		const ent = pyEntity('foo', `
def foo():
    try:
        risky()
    except ValueError:
        handle_value()
    except KeyError:
        handle_key()
    finally:
        cleanup()
`);
		const result = walkCfgFromEntity(ent);
		assert.equal(result.steps[0]?.kind, 'try');
		if (result.steps[0]?.kind !== 'try') { return; }
		assert.equal(result.steps[0].tryBody[0]?.kind, 'call');
		// Two except clauses collapse into a catch body of two
		// branches.
		assert.notEqual(result.steps[0].catchBody, null);
		assert.equal(result.steps[0].catchBody?.length, 2);
		assert.equal(result.steps[0].catchBody?.[0]?.kind, 'branch');
		assert.notEqual(result.steps[0].finallyBody, null);
	});

	it('captures match (Python 3.10+) as a switch step', () => {
		const ent = pyEntity('foo', `
def foo(state):
    match state:
        case 'a':
            return 1
        case 'b':
            return 2
        case _:
            return 0
`);
		const result = walkCfgFromEntity(ent);
		assert.equal(result.steps[0]?.kind, 'switch');
		if (result.steps[0]?.kind === 'switch') {
			assert.equal(result.steps[0].cases.length, 3);
		}
	});

	it('captures raise / break / continue terminators', () => {
		const ent = pyEntity('foo', `
def foo(items):
    for item in items:
        if not item:
            continue
        if item.bad:
            break
        if item.fatal:
            raise RuntimeError('nope')
        process(item)
`);
		const result = walkCfgFromEntity(ent);
		assert.equal(result.steps[0]?.kind, 'loop');
		if (result.steps[0]?.kind !== 'loop') { return; }
		const loopBody = result.steps[0].body;
		assert.equal(loopBody[0]?.kind, 'branch');
		if (loopBody[0]?.kind === 'branch') {
			assert.equal(loopBody[0].consequent[0]?.kind, 'continue');
		}
		assert.equal(loopBody[1]?.kind, 'branch');
		if (loopBody[1]?.kind === 'branch') {
			assert.equal(loopBody[1].consequent[0]?.kind, 'break');
		}
		assert.equal(loopBody[2]?.kind, 'branch');
		if (loopBody[2]?.kind === 'branch') {
			assert.equal(loopBody[2].consequent[0]?.kind, 'throw');
		}
	});

	it('inlines `with` block contents (no dedicated step)', () => {
		const ent = pyEntity('foo', `
def foo():
    with open('f') as fh:
        do(fh)
        finalise(fh)
`);
		const result = walkCfgFromEntity(ent);
		// `with` body's two calls land at top level.
		assert.equal(result.steps.length, 2);
		assert.equal(result.steps[0]?.kind, 'call');
		assert.equal(result.steps[1]?.kind, 'call');
	});
});

// ---------------------------------------------------------------------------
// Go walker
// ---------------------------------------------------------------------------

function goEntity(name: string, body: string): Entity {
	return {
		id: `id-${name}`,
		kind: 'function',
		name,
		language: 'go',
		repo: '/repo',
		file: '/repo/src/file.go',
		startLine: 1,
		endLine: 1,
		body,
		embedding: [],
		indexedAt: '2026-04-25T00:00:00Z',
	};
}

describe('walkCfgFromEntity - Go step tree', () => {
	it('handles a straight-line func with calls + return', () => {
		const ent = goEntity('Foo', `
func Foo(user User) error {
	audit(user)
	notify(user)
	return done()
}
`);
		const result = walkCfgFromEntity(ent);
		assert.equal(result.entryLabel, 'Foo');
		assert.equal(result.steps.length, 3);
		assert.equal(result.steps[0]?.kind, 'call');
		assert.equal(result.steps[1]?.kind, 'call');
		assert.equal(result.steps[2]?.kind, 'return');
	});

	it('captures if/else as a branch', () => {
		const ent = goEntity('Foo', `
func Foo(u User) error {
	if u.IsAdmin {
		return adminPath()
	} else {
		return userPath()
	}
}
`);
		const result = walkCfgFromEntity(ent);
		assert.equal(result.steps[0]?.kind, 'branch');
		if (result.steps[0]?.kind !== 'branch') { return; }
		assert.match(result.steps[0].predicate, /u\.IsAdmin/);
		assert.equal(result.steps[0].consequent[0]?.kind, 'return');
		assert.notEqual(result.steps[0].alternative, null);
	});

	it('captures `else if` chains in the alternative slot', () => {
		const ent = goEntity('Foo', `
func Foo(state string) int {
	if state == "a" {
		return 1
	} else if state == "b" {
		return 2
	} else {
		return 0
	}
}
`);
		const result = walkCfgFromEntity(ent);
		assert.equal(result.steps[0]?.kind, 'branch');
		if (result.steps[0]?.kind !== 'branch') { return; }
		assert.notEqual(result.steps[0].alternative, null);
		// Alternative is a chained branch (the inner else-if).
		assert.equal(result.steps[0].alternative?.[0]?.kind, 'branch');
	});

	it('captures all three for-statement variants', () => {
		// 1. for cond { } -- while-like
		const ent1 = goEntity('Foo', `
func Foo() {
	for cond() {
		work()
	}
}
`);
		const r1 = walkCfgFromEntity(ent1);
		assert.equal(r1.steps[0]?.kind, 'loop');
		if (r1.steps[0]?.kind === 'loop') {
			assert.equal(r1.steps[0].loopKind, 'while');
		}

		// 2. for init; cond; post { } -- C-style
		const ent2 = goEntity('Foo', `
func Foo(items []string) {
	for i := 0; i < len(items); i++ {
		process(items[i])
	}
}
`);
		const r2 = walkCfgFromEntity(ent2);
		assert.equal(r2.steps[0]?.kind, 'loop');
		if (r2.steps[0]?.kind === 'loop') {
			assert.equal(r2.steps[0].loopKind, 'for');
		}

		// 3. for x := range xs { } -- range
		const ent3 = goEntity('Foo', `
func Foo(items []string) {
	for _, item := range items {
		process(item)
	}
}
`);
		const r3 = walkCfgFromEntity(ent3);
		assert.equal(r3.steps[0]?.kind, 'loop');
		if (r3.steps[0]?.kind === 'loop') {
			assert.equal(r3.steps[0].loopKind, 'for-of');
		}
	});

	it('captures expression switch', () => {
		const ent = goEntity('Foo', `
func Foo(state string) int {
	switch state {
	case "a":
		return 1
	case "b":
		return 2
	default:
		return 0
	}
}
`);
		const result = walkCfgFromEntity(ent);
		assert.equal(result.steps[0]?.kind, 'switch');
		if (result.steps[0]?.kind === 'switch') {
			assert.equal(result.steps[0].cases.length, 3);
			assert.equal(result.steps[0].cases[2]?.label, 'default');
		}
	});

	it('captures select as a switch step', () => {
		const ent = goEntity('Foo', `
func Foo(ch chan int) {
	select {
	case v := <-ch:
		handle(v)
	default:
		nothing()
	}
}
`);
		const result = walkCfgFromEntity(ent);
		assert.equal(result.steps[0]?.kind, 'switch');
		if (result.steps[0]?.kind === 'switch') {
			assert.equal(result.steps[0].subject, 'select');
		}
	});

	it('renders defer + go as call steps with prefixes', () => {
		const ent = goEntity('Foo', `
func Foo() {
	defer cleanup()
	go background()
	work()
}
`);
		const result = walkCfgFromEntity(ent);
		assert.equal(result.steps.length, 3);
		assert.equal(result.steps[0]?.kind, 'call');
		if (result.steps[0]?.kind === 'call') {
			assert.match(result.steps[0].callee, /^defer /);
		}
		assert.equal(result.steps[1]?.kind, 'call');
		if (result.steps[1]?.kind === 'call') {
			assert.match(result.steps[1].callee, /^go /);
		}
	});

	it('special-cases panic() as a throw step', () => {
		const ent = goEntity('Foo', `
func Foo(x int) {
	if x < 0 {
		panic("negative")
	}
}
`);
		const result = walkCfgFromEntity(ent);
		assert.equal(result.steps[0]?.kind, 'branch');
		if (result.steps[0]?.kind !== 'branch') { return; }
		assert.equal(result.steps[0].consequent[0]?.kind, 'throw');
	});

	it('renders break / continue / goto inside a for body', () => {
		const ent = goEntity('Foo', `
func Foo(items []int) {
	for _, item := range items {
		if item < 0 {
			continue
		}
		if item > 100 {
			break
		}
		process(item)
	}
}
`);
		const result = walkCfgFromEntity(ent);
		assert.equal(result.steps[0]?.kind, 'loop');
		if (result.steps[0]?.kind !== 'loop') { return; }
		const loopBody = result.steps[0].body;
		assert.equal(loopBody[0]?.kind, 'branch');
		if (loopBody[0]?.kind === 'branch') {
			assert.equal(loopBody[0].consequent[0]?.kind, 'continue');
		}
		assert.equal(loopBody[1]?.kind, 'branch');
		if (loopBody[1]?.kind === 'branch') {
			assert.equal(loopBody[1].consequent[0]?.kind, 'break');
		}
	});
});

describe('renderCfgMermaid - shape', () => {
	it('emits a flowchart TD header + Enter / end nodes', () => {
		const ent = fnEntity('foo', `
function foo() {
  return 1;
}
		`);
		const out = renderCfgMermaid(walkCfgFromEntity(ent));
		assert.match(out, /^flowchart TD/);
		assert.match(out, /Enter_1\(\[foo\]\)/);
		assert.match(out, /Exit_1\(\[end\]\)/);
		assert.match(out, /Enter_1 --> Return_1/);
	});

	it('renders branches with true/false labels and a join', () => {
		const ent = fnEntity('foo', `
function foo(x) {
  if (x) {
    audit(x);
  }
  return done();
}
		`);
		const out = renderCfgMermaid(walkCfgFromEntity(ent));
		assert.match(out, /If_1\{x\}/);
		assert.match(out, /-->\|true\| Join_1/);
		assert.match(out, /-->\|false\| Join_1/);
	});

	it('emits a back-edge for loops', () => {
		const ent = fnEntity('foo', `
function foo(items) {
  for (const item of items) {
    process(item);
  }
}
		`);
		const out = renderCfgMermaid(walkCfgFromEntity(ent));
		// Loop header node receives both the entry edge and the body
		// back-edge, so it should appear as a target twice.
		const loopHits = out.match(/--> Loop_1/g);
		assert.ok(loopHits !== null && loopHits.length >= 2,
			`expected >= 2 edges into Loop_1, got ${loopHits?.length ?? 0}\n${out}`);
	});

	it('renders try/catch with a dotted catch arrow', () => {
		const ent = fnEntity('foo', `
function foo() {
  try { risky(); } catch (e) { handle(e); }
}
		`);
		const out = renderCfgMermaid(walkCfgFromEntity(ent));
		assert.match(out, /Try_1\[try\]/);
		assert.match(out, /Catch_1\[catch\]/);
		assert.match(out, /-\.->\|throw\| Catch_1/);
	});

	it('does not render a fall-through arrow when both branches terminate', () => {
		const ent = fnEntity('foo', `
function foo(x) {
  if (x) { return 1; }
  else { return 2; }
}
		`);
		const out = renderCfgMermaid(walkCfgFromEntity(ent));
		// No Join node when both arms terminate -- both returns go
		// straight to Exit_1.
		assert.doesNotMatch(out, /Join_/);
		const exitEdges = out.match(/--> Exit_1/g);
		assert.ok(exitEdges !== null && exitEdges.length >= 2);
	});

	it('sanitises labels with brackets and pipes', () => {
		const ent = fnEntity('foo', `
function foo(items) {
  for (const x of items) {
    handle(x);
  }
}
		`);
		const out = renderCfgMermaid(walkCfgFromEntity(ent));
		// Loop predicate combines kind + predicate; verify no raw `[`/`]`
		// inside the slot.
		assert.match(out, /Loop_1\{[^[\]]*\}/);
	});
});
