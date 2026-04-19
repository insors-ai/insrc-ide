/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Generate `src/vs/workbench/contrib/insrc/browser/media/insrc-icons.css`
// from `scripts/insrc-icons-map.json` + the committed Heroicons outline
// SVGs under `src/vs/workbench/contrib/insrc/browser/media/icons/heroicons/outline/`.
//
// Usage:   node scripts/build-insrc-icons.mjs
// Inputs:  scripts/insrc-icons-map.json
//          src/vs/workbench/contrib/insrc/browser/media/icons/heroicons/outline/*.svg
// Output:  src/vs/workbench/contrib/insrc/browser/media/insrc-icons.css

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAP_PATH = join(REPO_ROOT, 'scripts', 'insrc-icons-map.json');
const SVG_DIR = join(
	REPO_ROOT,
	'src',
	'vs',
	'workbench',
	'contrib',
	'insrc',
	'browser',
	'media',
	'icons',
	'heroicons',
	'outline',
);
const OUT_PATH = join(
	REPO_ROOT,
	'src',
	'vs',
	'workbench',
	'contrib',
	'insrc',
	'browser',
	'media',
	'insrc-icons.css',
);

function encodeSvgForDataUri(svg) {
	// Collapse whitespace, encode bytes that need escaping in a url().
	// Not a full percent-encode; just the minimal set that matters inside
	// CSS url(...) values.
	return svg
		.replace(/\r?\n/g, ' ')
		.replace(/\s+/g, ' ')
		.replace(/"/g, `'`)
		.replace(/</g, '%3C')
		.replace(/>/g, '%3E')
		.replace(/#/g, '%23')
		.replace(/\{/g, '%7B')
		.replace(/\}/g, '%7D');
}

function main() {
	const map = JSON.parse(readFileSync(MAP_PATH, 'utf8'));
	const entries = Object.entries(map)
		.filter(([key]) => !key.startsWith('_'))
		.sort(([a], [b]) => a.localeCompare(b));

	const blocks = [];
	let missing = 0;
	for (const [codicon, heroicon] of entries) {
		const svgPath = join(SVG_DIR, heroicon);
		if (!existsSync(svgPath)) {
			console.warn(`[skip] ${codicon}: heroicon ${heroicon} not found`);
			missing++;
			continue;
		}
		const svg = readFileSync(svgPath, 'utf8');
		const dataUri = `url("data:image/svg+xml;utf8,${encodeSvgForDataUri(svg)}")`;
		// The icon glyph is rendered by a dynamically-injected
		// `.codicon-X::before { content: '\\eXXX' }` rule. We win
		// against it with an `!important` on `content` (to drop the
		// font character) and layer the SVG mask on the same
		// `::before`, sized to the inherited font-size so it matches
		// surrounding codicons' footprint.
		blocks.push(
			`.monaco-workbench .codicon.codicon-${codicon}::before,\n` +
			`.codicon.codicon-${codicon}::before {\n` +
			`\tcontent: '' !important;\n` +
			`\tdisplay: inline-block;\n` +
			`\twidth: 1em;\n` +
			`\theight: 1em;\n` +
			`\tvertical-align: middle;\n` +
			`\t-webkit-mask-image: ${dataUri};\n` +
			`\tmask-image: ${dataUri};\n` +
			`\t-webkit-mask-size: contain;\n` +
			`\tmask-size: contain;\n` +
			`\t-webkit-mask-repeat: no-repeat;\n` +
			`\tmask-repeat: no-repeat;\n` +
			`\t-webkit-mask-position: center;\n` +
			`\tmask-position: center;\n` +
			`\tbackground-color: currentColor;\n` +
			`}\n`
		);
	}

	const header =
		`/*---------------------------------------------------------------------------------------------\n` +
		` *  Copyright (c) Procix Software India. All rights reserved.\n` +
		` *  Licensed under the MIT License. See License.txt in the project root for license information.\n` +
		` *--------------------------------------------------------------------------------------------*/\n\n` +
		`/*\n` +
		` *  GENERATED FILE -- do not edit by hand.\n` +
		` *  Run 'node scripts/build-insrc-icons.mjs' to regenerate from\n` +
		` *  'scripts/insrc-icons-map.json' + the Heroicons outline SVGs.\n` +
		` *\n` +
		` *  Icons: Heroicons v2 (https://heroicons.com) -- MIT licensed,\n` +
		` *  (c) Refactoring UI Inc. See media/icons/heroicons/LICENSE.\n` +
		` */\n\n`;

	writeFileSync(OUT_PATH, header + blocks.join('\n'));
	console.log(`wrote ${OUT_PATH}`);
	console.log(`mapped ${entries.length - missing} codicons (skipped ${missing})`);
}

main();
