/**
 * Per-library classifier index for §4.1's React introspection.
 *
 * The walker calls `classifyTag(tagName, importMap)` and gets back
 * either a `LayoutContainerSpec`, a `SemanticElementSpec`, or null
 * (unknown -- handled by the walker's fallback).
 *
 * Ordering of library checks matters: shadcn / MUI / Chakra / AntD
 * are tried first because their tag names overlap with each other
 * (e.g. multiple libraries export `Button`); the import map
 * disambiguates. Native HTML is the always-on fallback.
 */

import type {
	LayoutContainerSpec,
	LibraryClassifier,
	SemanticElementSpec,
} from './types.js';
import { ANTD } from './antd.js';
import { CHAKRA } from './chakra.js';
import { MUI } from './mui.js';
import { NATIVE_HTML } from './native-html.js';
import { SHADCN } from './shadcn.js';
export { extractTailwindLayout } from './tailwind.js';
export type { LayoutContainerSpec, SemanticElementSpec, TailwindLayoutHint } from './types.js';

/**
 * Library catalogs in match-priority order. The walker tries each
 * non-native classifier first by checking whether the tag name's
 * import source matches one of the library's `importSources`; if no
 * library claims the tag, the walker falls through to the native
 * HTML catalog (matched by tag name only -- HTML tags are
 * lower-case, library components are PascalCase, so the two
 * namespaces don't overlap).
 */
const LIBRARIES: readonly LibraryClassifier[] = [
	MUI,
	CHAKRA,
	ANTD,
	SHADCN,
];

export interface TagClassification {
	readonly library: string;
	readonly layout?: LayoutContainerSpec | undefined;
	readonly element?: SemanticElementSpec | undefined;
}

/**
 * Classify a JSX tag by name + the import source it was imported
 * from. Returns:
 *   - `{layout}` when the tag is a layout container
 *   - `{element}` when the tag is a semantic element
 *   - null when the tag is unrecognised (walker falls back to a
 *     labeled placeholder)
 */
export function classifyTag(
	tagName: string,
	importSource: string | null,
): TagClassification | null {
	// Library-specific match first (PascalCase tags). Disambiguate by
	// import source when the tag name appears in multiple libraries.
	if (/^[A-Z]/.test(tagName)) {
		for (const lib of LIBRARIES) {
			if (!libraryMatchesImport(lib, importSource)) { continue; }
			const layout = lib.layoutContainers[tagName];
			if (layout !== undefined) {
				return { library: lib.id, layout };
			}
			const element = lib.semanticElements[tagName];
			if (element !== undefined) {
				return { library: lib.id, element };
			}
		}
		return null;   // PascalCase tag with no recognised library match
	}

	// Lowercase tag -> native HTML.
	const layoutNative = NATIVE_HTML.layoutContainers[tagName];
	if (layoutNative !== undefined) {
		return { library: 'native', layout: layoutNative };
	}
	const elementNative = NATIVE_HTML.semanticElements[tagName];
	if (elementNative !== undefined) {
		return { library: 'native', element: elementNative };
	}
	return null;
}

function libraryMatchesImport(lib: LibraryClassifier, importSource: string | null): boolean {
	if (importSource === null) { return false; }
	const sources = lib.importSources;
	if (sources === undefined) { return false; }
	for (const s of sources) {
		// Exact match (covers `@mui/material`, `antd`, etc.).
		if (importSource === s) { return true; }
		// Subpath match for libraries that ship per-component subpaths
		// (`@mui/material/Stack`).
		if (importSource.startsWith(s + '/')) { return true; }
		// Suffix match for the shadcn-style copy-paste path
		// (`@/components/ui` matches both `@/components/ui` and
		// `@/components/ui/button`).
		if (s.includes('components/ui') && importSource.includes(s)) { return true; }
	}
	return false;
}

/** Exported for tests + plan-doc references. */
export const ALL_LIBRARIES: readonly LibraryClassifier[] = [
	NATIVE_HTML,
	...LIBRARIES,
];
