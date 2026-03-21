/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { Event } from '../../../../base/common/event.js';

// ---------------------------------------------------------------------------
// Types returned by LSP tool queries
// ---------------------------------------------------------------------------

export interface DiagnosticInfo {
	readonly file: string;
	readonly severity: 'error' | 'warning' | 'info' | 'hint';
	readonly message: string;
	readonly code: string;
	readonly source: string;
	readonly startLine: number;
	readonly startColumn: number;
	readonly endLine: number;
	readonly endColumn: number;
}

export interface LocationInfo {
	readonly file: string;
	readonly startLine: number;
	readonly startColumn: number;
	readonly endLine: number;
	readonly endColumn: number;
}

export interface SymbolInfo {
	readonly name: string;
	readonly kind: string;
	readonly file: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly children: SymbolInfo[];
}

export interface CodeActionInfo {
	readonly title: string;
	readonly kind: string;
	readonly isPreferred: boolean;
	readonly diagnostics: DiagnosticInfo[];
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export const IInsrcLSPToolService = createDecorator<IInsrcLSPToolService>('insrcLSPToolService');

export interface IInsrcLSPToolService {
	readonly _serviceBrand: undefined;

	/** Get diagnostics (errors/warnings) for a file or all open files */
	getDiagnostics(filePath?: string | undefined, severity?: string | undefined): Promise<DiagnosticInfo[]>;

	/** Get definition locations for a symbol at position */
	getDefinitions(filePath: string, line: number, column: number): Promise<LocationInfo[]>;

	/** Get all references to a symbol at position */
	getReferences(filePath: string, line: number, column: number): Promise<LocationInfo[]>;

	/** Get hover info (type, docs) at position */
	getHover(filePath: string, line: number, column: number): Promise<string>;

	/** Get all symbols in a file */
	getDocumentSymbols(filePath: string): Promise<SymbolInfo[]>;

	/** Get available code actions for a range */
	getCodeActions(filePath: string, startLine: number, endLine: number): Promise<CodeActionInfo[]>;

	/** Fires when diagnostics change */
	readonly onDidChangeDiagnostics: Event<string[]>;
}
