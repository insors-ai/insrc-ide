/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { joinPath } from '../../../../../base/common/resources.js';

/**
 * Rewrite analyzer-internal citation URIs into stock-VS-Code-friendly
 * forms before writing the report markdown to disk. Shared between
 * the Code Analyzer and Data Analyzer save-report commands
 * (plans/analyzers/code-analyzer.md Phase 2.1; plans/analyzers/data-analyzer.md Phase 2.1).
 *
 * In-IDE rendering uses our custom URI openers (`PathUriOpener` for
 * `path:`, future `DataConnOpener` for `data-conn:`). The saved file
 * is opened by VS Code's stock markdown preview where those schemes
 * are unknown and clicks fall through. Rewriting `path:src/foo.ts#L42`
 * to a file:// URI -- which the stock preview natively understands,
 * including the `#L42-L58` fragment for line-range selection -- makes
 * the saved report self-contained on the saving machine.
 *
 * Trade-off: cross-machine portability. The saved file embeds the
 * absolute path of *this* user's repo root. Sharing the .md across
 * machines breaks the links. Acceptable because (a) `docs/code-analysis/`
 * is intended for the local team, and (b) a relative-path scheme would
 * require the reader to know the file lives at a specific depth under
 * the repo, which we can't guarantee for users who rename or move it.
 *
 * Currently rewrites:
 *   - `path:<rel>(#<frag>)?` -> `file://<repoRoot>/<rel>(#<frag>)?`
 *
 * Reserved for Phase 5.6 (data-conn: opener wiring): `data-conn:` URIs
 * are left untouched here; they're navigation anchors keyed on the
 * connection registry, not file references. In the saved markdown
 * they'll be inert, but the IDE-side opener will still resolve them
 * if the user re-opens the saved file inside the IDE.
 */
export function rewriteCustomUrisForSave(body: string, repoRoot: URI): string {
	return body.replace(
		/\]\(path:([^)\s]+)\)/g,
		(_match, pathSpec: string) => {
			// pathSpec is the post-`path:` portion: "src/foo.ts#L42-L58"
			// or "src/foo.ts" with no fragment. Split on first '#' to
			// keep the fragment intact when re-emitting.
			const hashIdx = pathSpec.indexOf('#');
			const rel = hashIdx === -1 ? pathSpec : pathSpec.slice(0, hashIdx);
			const fragment = hashIdx === -1 ? '' : pathSpec.slice(hashIdx);
			const absolute = joinPath(repoRoot, rel);
			return `](${absolute.toString()}${fragment})`;
		},
	);
}
