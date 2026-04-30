/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IOpener, IOpenerService, OpenInternalOptions, OpenExternalOptions } from '../../../../../platform/opener/common/opener.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { DbDriversInput } from '../dbDrivers/dbDriversInput.js';

/**
 * `data-conn:` URI opener (plans/analyzers/data-analyzer.md Phase 5.6).
 *
 * The data-analyzer's synthesise prompt emits citation links in the
 * form `[<label>](data-conn:<connectionId>/<schema?>/<table>?col=<column>&pk=<key>)`.
 * In-IDE clicks resolve here so they navigate to a useful surface
 * instead of silently doing nothing.
 *
 * v1 behavior (this commit):
 *
 *   - Open the Data Sources pane (`DbDriversInput`) so the user
 *     lands on the connection-roster surface where they can drill
 *     into the cited connection.
 *   - Surface the parsed citation (connection / schema / table /
 *     column / pk) as an info notification so the user knows which
 *     target was being referenced.
 *
 * Deferred (follow-up when dbDrivers exposes a reveal API):
 *
 *   - Auto-expand the cited connection's accordion section.
 *   - When `pk=` is present, run a one-row sample query and surface
 *     the result inline.
 *
 * URI shape:
 *   `data-conn:<connectionId>(/<schema>)?/<table>(?col=<column>&pk=<value>)?`
 *
 * Tolerant of:
 *   - missing schema (path = `<connectionId>/<table>`),
 *   - missing table (just `data-conn:<connectionId>` -- opens pane
 *     without a target context),
 *   - extra / unknown query params (passed through but ignored).
 */
class DataConnUriOpener implements IOpener {

	constructor(
		private readonly editorService: IEditorService,
		private readonly notificationService: INotificationService,
	) { }

	async open(resource: URI | string, _options?: OpenInternalOptions | OpenExternalOptions): Promise<boolean> {
		const uri = typeof resource === 'string' ? URI.parse(resource) : resource;
		if (uri.scheme !== 'data-conn') {
			return false;
		}

		const parsed = parseDataConnUri(uri);
		if (parsed === null) {
			// Unparseable shape -- still open the pane so the user
			// gets *something* and surface a warning. Returning false
			// would let the click silently do nothing.
			await this.editorService.openEditor(DbDriversInput.getInstance());
			this.notificationService.warn(`Could not parse data-conn URI: ${uri.toString()}`);
			return true;
		}

		await this.editorService.openEditor(DbDriversInput.getInstance());

		const summary = renderCitationSummary(parsed);
		this.notificationService.info(`Data citation: ${summary}`);

		return true;
	}
}

interface ParsedDataConn {
	readonly connectionId: string;
	readonly schema?: string;
	readonly table?: string;
	readonly column?: string;
	readonly pk?: string;
}

/**
 * Parse `data-conn:<connectionId>(/<schema>)?/<table>` plus optional
 * `?col=<column>&pk=<value>` query params.
 *
 * URI.parse splits the after-colon portion into `path` and `query`.
 * The path is `<connectionId>/<schema>/<table>` or
 * `<connectionId>/<table>`. The query carries `col` and `pk`.
 */
function parseDataConnUri(uri: URI): ParsedDataConn | null {
	const path = uri.path.replace(/^\/+/, '');
	if (path.length === 0) { return null; }
	const segments = path.split('/').filter(s => s.length > 0);
	if (segments.length === 0) { return null; }

	const params = new URLSearchParams(uri.query);
	const col = params.get('col') ?? undefined;
	const pk = params.get('pk') ?? undefined;

	const connectionId = segments[0]!;
	const out: ParsedDataConn = (() => {
		if (segments.length === 1) {
			return { connectionId };
		}
		if (segments.length === 2) {
			return { connectionId, table: segments[1]! };
		}
		// 3+ segments: schema is segment[1], table is the rest joined
		// (handles dotted-table names like `public.users` if a model
		// emits them as path segments rather than literally).
		return {
			connectionId,
			schema: segments[1]!,
			table: segments.slice(2).join('/'),
		};
	})();

	return {
		...out,
		...(col !== undefined ? { column: col } : {}),
		...(pk !== undefined ? { pk } : {}),
	};
}

function renderCitationSummary(p: ParsedDataConn): string {
	const parts: string[] = [`connection \`${p.connectionId}\``];
	if (p.schema !== undefined && p.table !== undefined) {
		parts.push(`table \`${p.schema}.${p.table}\``);
	} else if (p.table !== undefined) {
		parts.push(`table \`${p.table}\``);
	}
	if (p.column !== undefined) { parts.push(`column \`${p.column}\``); }
	if (p.pk !== undefined) { parts.push(`pk=\`${p.pk}\``); }
	return parts.join(', ');
}

/**
 * Workbench contribution that wires the `data-conn:` URI opener into
 * the global IOpenerService at AfterRestored phase. Mirrors
 * `PathUriOpenerContribution` for the code-analyzer's `path:` scheme.
 */
export class DataConnUriOpenerContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'insrc.dataConnUriOpener';

	constructor(
		@IOpenerService openerService: IOpenerService,
		@IEditorService editorService: IEditorService,
		@INotificationService notificationService: INotificationService,
	) {
		super();
		this._register(openerService.registerOpener(new DataConnUriOpener(editorService, notificationService)));
	}
}
