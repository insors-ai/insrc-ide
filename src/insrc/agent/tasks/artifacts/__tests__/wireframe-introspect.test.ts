/**
 * Tests for §4.1's React-component introspection: classifier
 * dictionaries, the Tailwind utility-class extractor, and the
 * `walkComponentBody` walker (the pure surface that takes a body
 * string + import map directly, no DB / no fs).
 *
 * The DB-aware `introspectComponent` entry point isn't unit-tested
 * here -- it does a live graph lookup + file read; covered later by
 * the smoke script when a real graph is available.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { walkComponentBody } from '../kinds/wireframe-introspect.js';
import { classifyTag, extractTailwindLayout } from '../kinds/wireframe-classifiers/index.js';

// ---------------------------------------------------------------------------
// classifyTag
// ---------------------------------------------------------------------------

describe('classifyTag', () => {
	it('classifies native HTML tags as native', () => {
		const c = classifyTag('div', null);
		assert.equal(c?.library, 'native');
		assert.notEqual(c?.layout, undefined);
	});

	it('classifies <header>/<nav>/<aside>/<footer>/<main> as semantic regions', () => {
		assert.equal(classifyTag('header', null)?.layout?.region, 'header');
		assert.equal(classifyTag('nav', null)?.layout?.region, 'nav');
		assert.equal(classifyTag('aside', null)?.layout?.region, 'sidebar');
		assert.equal(classifyTag('footer', null)?.layout?.region, 'footer');
		assert.equal(classifyTag('main', null)?.layout?.region, 'content');
	});

	it('disambiguates Stack between MUI and Chakra by import source', () => {
		const mui = classifyTag('Stack', '@mui/material');
		assert.equal(mui?.library, 'mui');
		const chakra = classifyTag('Stack', '@chakra-ui/react');
		assert.equal(chakra?.library, 'chakra');
	});

	it('returns null for unknown PascalCase tags', () => {
		assert.equal(classifyTag('CustomThing', null), null);
		assert.equal(classifyTag('CustomThing', 'unknown-lib'), null);
	});

	it('matches MUI subpath imports (@mui/material/Stack)', () => {
		assert.equal(classifyTag('Stack', '@mui/material/Stack')?.library, 'mui');
	});

	it('matches AntD layout member-access tags (Layout.Sider)', () => {
		const c = classifyTag('Layout.Sider', 'antd');
		assert.equal(c?.library, 'antd');
		assert.equal(c?.layout?.region, 'sidebar');
	});

	it('classifies semantic elements with the right label prefix', () => {
		assert.equal(classifyTag('Button', '@mui/material')?.element?.labelPrefix, 'Button');
		assert.equal(classifyTag('TextField', '@mui/material')?.element?.labelPrefix, 'Input');
		assert.equal(classifyTag('Avatar', '@chakra-ui/react')?.element?.labelPrefix, 'Avatar');
	});
});

// ---------------------------------------------------------------------------
// extractTailwindLayout
// ---------------------------------------------------------------------------

describe('extractTailwindLayout', () => {
	it('returns null when className is empty / missing', () => {
		assert.equal(extractTailwindLayout(undefined), null);
		assert.equal(extractTailwindLayout(''), null);
		assert.equal(extractTailwindLayout('text-lg p-4'), null);
	});

	it('detects flex row by default', () => {
		assert.deepEqual(extractTailwindLayout('flex p-4'), { direction: 'row' });
		assert.deepEqual(extractTailwindLayout('flex-row gap-2'), { direction: 'row' });
		assert.deepEqual(extractTailwindLayout('inline-flex'), { direction: 'row' });
	});

	it('detects flex column with flex-col', () => {
		assert.deepEqual(extractTailwindLayout('flex flex-col'), { direction: 'column' });
	});

	it('detects grid + cols', () => {
		assert.deepEqual(extractTailwindLayout('grid grid-cols-3 gap-4'), { direction: 'grid', cols: 3 });
	});

	it('grid wins over flex when both are present', () => {
		assert.deepEqual(extractTailwindLayout('flex grid grid-cols-2'), { direction: 'grid', cols: 2 });
	});

	it('strips responsive / state prefixes (md:flex, hover:grid)', () => {
		assert.deepEqual(extractTailwindLayout('md:flex p-4'), { direction: 'row' });
		assert.deepEqual(extractTailwindLayout('lg:grid lg:grid-cols-4'), { direction: 'grid', cols: 4 });
	});
});

// ---------------------------------------------------------------------------
// walkComponentBody
// ---------------------------------------------------------------------------

describe('walkComponentBody - native HTML', () => {
	it('captures a simple header / main / footer layout', async () => {
		const body = `function App() {
  return (
    <div>
      <header>Hi</header>
      <main>Content</main>
      <footer>End</footer>
    </div>
  );
}`;
		const r = await walkComponentBody({ body, language: 'typescript', file: '/x.tsx' });
		// Outer <div> recurses; rows array has the three regions.
		assert.equal(r.spec.rows.length, 3);
		assert.equal(r.spec.rows[0]?.cells[0]?.kind, 'header');
		assert.equal(r.spec.rows[1]?.cells[0]?.kind, 'content');
		assert.equal(r.spec.rows[2]?.cells[0]?.kind, 'footer');
	});

	it('renders semantic elements as labeled placeholders', async () => {
		const body = `function App() {
  return (
    <div>
      <button>Submit</button>
      <input />
    </div>
  );
}`;
		const r = await walkComponentBody({ body, language: 'typescript', file: '/x.tsx' });
		const cells = r.spec.rows.flatMap(r => r.cells);
		const labels = cells.map(c => c.label ?? '');
		assert.ok(labels.some(l => l.startsWith('Button')), `expected Button label in ${JSON.stringify(labels)}`);
		assert.ok(labels.some(l => l.startsWith('Input')), `expected Input label in ${JSON.stringify(labels)}`);
	});

	it('captures inner text on element labels', async () => {
		const body = `function App() {
  return <button>Save changes</button>;
}`;
		const r = await walkComponentBody({ body, language: 'typescript', file: '/x.tsx' });
		const cell = r.spec.rows[0]?.cells[0];
		assert.match(cell?.label ?? '', /Save changes/);
	});
});

describe('walkComponentBody - MUI', () => {
	it('renders MUI Stack as a column of cells', async () => {
		const body = `function App() {
  return (
    <Stack>
      <Button>Save</Button>
      <Button>Cancel</Button>
    </Stack>
  );
}`;
		const r = await walkComponentBody({
			body, language: 'typescript', file: '/x.tsx',
			imports: [
				{ tagName: 'Stack', importSource: '@mui/material' },
				{ tagName: 'Button', importSource: '@mui/material' },
			],
		});
		// Stack -> column -> 2 rows, each with one Button cell.
		assert.equal(r.spec.rows.length, 2);
		assert.match(r.spec.rows[0]?.cells[0]?.label ?? '', /Button/);
	});

	it('renders MUI AppBar as a header region', async () => {
		const body = `function App() {
  return <AppBar><Toolbar><Button>Login</Button></Toolbar></AppBar>;
}`;
		const r = await walkComponentBody({
			body, language: 'typescript', file: '/x.tsx',
			imports: [
				{ tagName: 'AppBar', importSource: '@mui/material' },
				{ tagName: 'Toolbar', importSource: '@mui/material' },
				{ tagName: 'Button', importSource: '@mui/material' },
			],
		});
		assert.equal(r.spec.rows[0]?.cells[0]?.kind, 'header');
	});
});

describe('walkComponentBody - Chakra UI', () => {
	it('renders HStack as a row of cells', async () => {
		const body = `function App() {
  return (
    <HStack>
      <Button>One</Button>
      <Button>Two</Button>
    </HStack>
  );
}`;
		const r = await walkComponentBody({
			body, language: 'typescript', file: '/x.tsx',
			imports: [
				{ tagName: 'HStack', importSource: '@chakra-ui/react' },
				{ tagName: 'Button', importSource: '@chakra-ui/react' },
			],
		});
		// HStack -> row -> single row with two cells.
		assert.equal(r.spec.rows.length, 1);
		assert.equal(r.spec.rows[0]?.cells.length, 2);
	});

	it('renders SimpleGrid with default 2 cols', async () => {
		const body = `function App() {
  return (
    <SimpleGrid>
      <Button>A</Button>
      <Button>B</Button>
      <Button>C</Button>
      <Button>D</Button>
    </SimpleGrid>
  );
}`;
		const r = await walkComponentBody({
			body, language: 'typescript', file: '/x.tsx',
			imports: [
				{ tagName: 'SimpleGrid', importSource: '@chakra-ui/react' },
				{ tagName: 'Button', importSource: '@chakra-ui/react' },
			],
		});
		// 4 children / 2 cols = 2 rows.
		assert.equal(r.spec.rows.length, 2);
		assert.equal(r.spec.rows[0]?.cells.length, 2);
	});
});

describe('walkComponentBody - AntD', () => {
	it('renders Layout with Sider + Content as proper regions', async () => {
		const body = `function App() {
  return (
    <Layout>
      <Layout.Sider>nav</Layout.Sider>
      <Layout.Content>main</Layout.Content>
    </Layout>
  );
}`;
		const r = await walkComponentBody({
			body, language: 'typescript', file: '/x.tsx',
			imports: [{ tagName: 'Layout', importSource: 'antd' }],
		});
		const allCells = r.spec.rows.flatMap(r => r.cells);
		assert.ok(allCells.some(c => c.kind === 'sidebar'));
		assert.ok(allCells.some(c => c.kind === 'content'));
	});
});

describe('walkComponentBody - shadcn/ui', () => {
	it('renders Card as a layout container', async () => {
		const body = `function App() {
  return (
    <Card>
      <CardHeader>title</CardHeader>
      <CardContent>body</CardContent>
    </Card>
  );
}`;
		const r = await walkComponentBody({
			body, language: 'typescript', file: '/x.tsx',
			imports: [
				{ tagName: 'Card', importSource: '@/components/ui/card' },
				{ tagName: 'CardHeader', importSource: '@/components/ui/card' },
				{ tagName: 'CardContent', importSource: '@/components/ui/card' },
			],
		});
		const allCells = r.spec.rows.flatMap(r => r.cells);
		assert.ok(allCells.some(c => c.kind === 'header'));
	});
});

describe('walkComponentBody - Tailwind utility classes', () => {
	it('promotes div with flex grid utilities to layout containers', async () => {
		const body = `function App() {
  return (
    <div className="grid grid-cols-3 gap-4">
      <button>A</button>
      <button>B</button>
      <button>C</button>
    </div>
  );
}`;
		const r = await walkComponentBody({ body, language: 'typescript', file: '/x.tsx' });
		// Grid with 3 cols + 3 children = 1 row of 3.
		assert.equal(r.spec.rows.length, 1);
		assert.equal(r.spec.rows[0]?.cells.length, 3);
	});
});

describe('walkComponentBody - conditional + list rendering', () => {
	it('renders both arms of a `cond && <X/>` expression', async () => {
		const body = `function App({show}) {
  return (
    <div>
      {show && <button>Hidden</button>}
      <input />
    </div>
  );
}`;
		const r = await walkComponentBody({ body, language: 'typescript', file: '/x.tsx' });
		const allLabels = r.spec.rows.flatMap(r => r.cells.map(c => c.label ?? ''));
		assert.ok(allLabels.some(l => l.startsWith('Button')));
		assert.ok(allLabels.some(l => l.startsWith('Input')));
	});

	it('renders both branches of a ternary', async () => {
		const body = `function App({admin}) {
  return (
    <div>
      {admin ? <button>Admin</button> : <button>User</button>}
    </div>
  );
}`;
		const r = await walkComponentBody({ body, language: 'typescript', file: '/x.tsx' });
		const cells = r.spec.rows.flatMap(r => r.cells);
		const buttonCells = cells.filter(c => (c.label ?? '').startsWith('Button'));
		assert.equal(buttonCells.length, 2);
	});

	it('expands `.map()` over arrays into placeholders', async () => {
		const body = `function App({items}) {
  return (
    <ul>
      {items.map(item => <li>{item}</li>)}
    </ul>
  );
}`;
		const r = await walkComponentBody({ body, language: 'typescript', file: '/x.tsx' });
		// `.map()` arrow body expanded into one li cell per call site.
		const cells = r.spec.rows.flatMap(r => r.cells.flatMap(c => c.children?.flatMap(rc => rc.cells) ?? [c]));
		assert.ok(cells.some(c => (c.label ?? '').startsWith('Item')));
	});
});

describe('walkComponentBody - failure modes', () => {
	it('returns empty rows for a non-JSX-returning function', async () => {
		const body = `function App() {
  return 42;
}`;
		const r = await walkComponentBody({ body, language: 'typescript', file: '/x.tsx' });
		assert.equal(r.spec.rows.length, 0);
		assert.match(r.note ?? '', /no JSX/);
	});

	it('returns empty rows for a non-function body', async () => {
		const r = await walkComponentBody({ body: 'const x = 5;', language: 'typescript', file: '/x.tsx' });
		assert.equal(r.spec.rows.length, 0);
	});

	it('falls back to labeled placeholder for unknown PascalCase tags', async () => {
		const body = `function App() {
  return <div><MyCustomThing /></div>;
}`;
		const r = await walkComponentBody({ body, language: 'typescript', file: '/x.tsx' });
		const allLabels = r.spec.rows.flatMap(r => r.cells.map(c => c.label ?? ''));
		assert.ok(allLabels.some(l => l.includes('MyCustomThing')));
	});
});

describe('walkComponentBody - arrow-function components', () => {
	it('handles `const X = () => <jsx/>` arrow components', async () => {
		const body = `const App = () => (
  <div>
    <button>Click</button>
  </div>
);`;
		const r = await walkComponentBody({ body, language: 'typescript', file: '/x.tsx' });
		const labels = r.spec.rows.flatMap(r => r.cells.map(c => c.label ?? ''));
		assert.ok(labels.some(l => l.startsWith('Button')));
	});
});
