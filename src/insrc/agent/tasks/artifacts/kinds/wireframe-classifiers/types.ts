/**
 * Per-library classifier dictionary types for §4.1's React-component
 * introspection. Each library (native HTML, MUI, Chakra, AntD,
 * shadcn, Tailwind) ships one classifier; the walker indexes them
 * by import source + tag name to map a JSX node onto a wireframe
 * primitive.
 *
 * The walker stays library-agnostic: it consults the merged
 * classifier index and dispatches based on what kind of primitive
 * the tag maps to (layout container vs semantic element vs unknown).
 *
 * Tailwind is special -- it doesn't have JSX tags of its own; it
 * adds layout signal via `className` utility tokens. Handled
 * separately in `tailwind.ts`.
 */

import type { WireframeCellKind } from '../../../../../shared/artifacts.js';

/**
 * A layout container is a JSX tag whose role is to arrange children.
 * The walker emits a `WireframeRow` (or rows) for each layout
 * container it descends into.
 */
export interface LayoutContainerSpec {
	/** How children arrange. `row` -> one wireframe row with each
	 *  child as a cell; `column` -> one row per child; `grid` -> N
	 *  cells per row, where N is `defaultCols` or read from a known
	 *  prop. */
	readonly direction: 'row' | 'column' | 'grid';
	/** Optional region kind when this container semantically marks a
	 *  region (e.g. native `<header>` -> 'header'). When set, the
	 *  walker emits a single labeled cell of that kind rather than
	 *  recursing. */
	readonly region?: WireframeCellKind;
	/** For grid containers without an explicit `cols` prop. */
	readonly defaultCols?: number;
	/** Prop name to inspect for the column count on grid containers
	 *  (e.g. MUI Grid's `columns`, Chakra SimpleGrid's `columns`). */
	readonly colsProp?: string;
}

/**
 * A semantic element is a JSX tag whose role is to render a single
 * UI element (button, input, image). The walker emits a labeled
 * `WireframeCell` for each one.
 */
export interface SemanticElementSpec {
	/** Wireframe cell kind. Most semantic elements map to
	 *  'placeholder' with a label prefix; a few region-shaped tags
	 *  (header / nav / sidebar / footer) map directly. */
	readonly kind: WireframeCellKind;
	/** Label prefix prepended to the user-supplied label / tag name
	 *  in the rendered cell. e.g. `Button` for a Button tag with
	 *  prefix `Button` -> "Button: Submit". */
	readonly labelPrefix?: string;
}

export interface LibraryClassifier {
	readonly id: string;
	/** npm import sources this library matches. The walker uses these
	 *  to disambiguate same-named tags across libraries (e.g. `Stack`
	 *  in MUI vs. Chakra). When a tag's import source matches one of
	 *  these, the corresponding library's catalog wins. Missing for
	 *  the native-HTML classifier (no import). */
	readonly importSources?: readonly string[];
	readonly layoutContainers: Readonly<Record<string, LayoutContainerSpec>>;
	readonly semanticElements: Readonly<Record<string, SemanticElementSpec>>;
}

/**
 * Output of the Tailwind className extractor. The walker calls
 * `extractTailwindLayout(classNames)` on a JSX tag's className prop;
 * a non-null result signals "this tag is a layout container by way
 * of its utility classes" with the inferred direction + cols.
 */
export interface TailwindLayoutHint {
	readonly direction: 'row' | 'column' | 'grid';
	readonly cols?: number;
}
