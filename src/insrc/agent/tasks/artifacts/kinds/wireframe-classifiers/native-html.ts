/**
 * Native HTML classifier -- the always-available baseline.
 *
 * No import source; matches by tag name when no library-specific
 * classifier claims the tag.
 */

import type { LibraryClassifier } from './types.js';

export const NATIVE_HTML: LibraryClassifier = {
	id: 'native',
	layoutContainers: {
		// Region-shaped semantic regions -- single cell, no descent.
		'header':  { direction: 'row', region: 'header' },
		'nav':     { direction: 'row', region: 'nav' },
		'aside':   { direction: 'column', region: 'sidebar' },
		'footer':  { direction: 'row', region: 'footer' },
		'main':    { direction: 'column', region: 'content' },

		// Generic flow containers -- recurse, default to column
		// layout (block flow). Children of `div` / `section` become
		// rows inside the parent's cell.
		'div':     { direction: 'column' },
		'section': { direction: 'column' },
		'article': { direction: 'column' },
		'fieldset':{ direction: 'column' },
		'form':    { direction: 'column' },
		'span':    { direction: 'row' },
	},
	semanticElements: {
		// Form controls -> placeholder cells with prefix.
		'button':   { kind: 'placeholder', labelPrefix: 'Button' },
		'input':    { kind: 'placeholder', labelPrefix: 'Input' },
		'textarea': { kind: 'placeholder', labelPrefix: 'Input' },
		'select':   { kind: 'placeholder', labelPrefix: 'Select' },
		'label':    { kind: 'placeholder', labelPrefix: 'Label' },

		// Media + tables.
		'img':      { kind: 'placeholder', labelPrefix: 'Image' },
		'video':    { kind: 'placeholder', labelPrefix: 'Video' },
		'audio':    { kind: 'placeholder', labelPrefix: 'Audio' },
		'canvas':   { kind: 'placeholder', labelPrefix: 'Canvas' },
		'table':    { kind: 'placeholder', labelPrefix: 'Table' },

		// Lists + items.
		'ul':       { kind: 'placeholder', labelPrefix: 'List' },
		'ol':       { kind: 'placeholder', labelPrefix: 'List' },
		'dl':       { kind: 'placeholder', labelPrefix: 'List' },
		'li':       { kind: 'placeholder', labelPrefix: 'Item' },

		// Inline + typographic.
		'a':        { kind: 'placeholder', labelPrefix: 'Link' },
		'h1':       { kind: 'placeholder', labelPrefix: 'Heading' },
		'h2':       { kind: 'placeholder', labelPrefix: 'Heading' },
		'h3':       { kind: 'placeholder', labelPrefix: 'Heading' },
		'h4':       { kind: 'placeholder', labelPrefix: 'Heading' },
		'h5':       { kind: 'placeholder', labelPrefix: 'Heading' },
		'h6':       { kind: 'placeholder', labelPrefix: 'Heading' },
		'p':        { kind: 'placeholder', labelPrefix: 'Text' },
		'pre':      { kind: 'placeholder', labelPrefix: 'Code' },
		'code':     { kind: 'placeholder', labelPrefix: 'Code' },
		'blockquote':{ kind: 'placeholder', labelPrefix: 'Quote' },
	},
};
