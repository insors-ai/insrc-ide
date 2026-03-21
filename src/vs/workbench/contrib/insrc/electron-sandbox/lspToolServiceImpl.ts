/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { MarkerSeverity, IMarkerService } from '../../../../platform/markers/common/markers.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { SymbolKind } from '../../../../editor/common/languages.js';
import {
	IInsrcLSPToolService,
	type DiagnosticInfo,
	type LocationInfo,
	type SymbolInfo,
	type CodeActionInfo,
} from '../common/lspToolService.js';

// ---------------------------------------------------------------------------
// Map MarkerSeverity to string
// ---------------------------------------------------------------------------

function severityToString(severity: MarkerSeverity): 'error' | 'warning' | 'info' | 'hint' {
	switch (severity) {
		case MarkerSeverity.Error: return 'error';
		case MarkerSeverity.Warning: return 'warning';
		case MarkerSeverity.Info: return 'info';
		case MarkerSeverity.Hint: return 'hint';
		default: return 'info';
	}
}

function symbolKindToString(kind: SymbolKind): string {
	const names: Record<number, string> = {
		[SymbolKind.File]: 'file', [SymbolKind.Module]: 'module', [SymbolKind.Namespace]: 'namespace',
		[SymbolKind.Package]: 'package', [SymbolKind.Class]: 'class', [SymbolKind.Method]: 'method',
		[SymbolKind.Property]: 'property', [SymbolKind.Field]: 'field', [SymbolKind.Constructor]: 'constructor',
		[SymbolKind.Enum]: 'enum', [SymbolKind.Interface]: 'interface', [SymbolKind.Function]: 'function',
		[SymbolKind.Variable]: 'variable', [SymbolKind.Constant]: 'constant', [SymbolKind.String]: 'string',
		[SymbolKind.Number]: 'number', [SymbolKind.Boolean]: 'boolean', [SymbolKind.Array]: 'array',
		[SymbolKind.Object]: 'object', [SymbolKind.Key]: 'key', [SymbolKind.Null]: 'null',
		[SymbolKind.EnumMember]: 'enumMember', [SymbolKind.Struct]: 'struct', [SymbolKind.Event]: 'event',
		[SymbolKind.Operator]: 'operator', [SymbolKind.TypeParameter]: 'typeParameter',
	};
	return names[kind] ?? 'unknown';
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class InsrcLSPToolServiceImpl extends Disposable implements IInsrcLSPToolService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeDiagnostics = this._register(new Emitter<string[]>());
	readonly onDidChangeDiagnostics: Event<string[]> = this._onDidChangeDiagnostics.event;

	constructor(
		@IMarkerService private readonly markerService: IMarkerService,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		this._logService.info('[insrc-lsp] LSP tool service initialized');

		// Forward marker changes as file path strings
		this._register(this.markerService.onMarkerChanged(uris => {
			this._onDidChangeDiagnostics.fire(uris.map(u => u.fsPath));
		}));
	}

	// ---------------------------------------------------------------------------
	// Diagnostics
	// ---------------------------------------------------------------------------

	async getDiagnostics(filePath?: string, severity?: string): Promise<DiagnosticInfo[]> {
		const filter: { resource?: URI; severities?: number } = {};

		if (filePath) {
			filter.resource = URI.file(filePath);
		}

		if (severity) {
			switch (severity) {
				case 'error': filter.severities = MarkerSeverity.Error; break;
				case 'warning': filter.severities = MarkerSeverity.Warning; break;
				case 'info': filter.severities = MarkerSeverity.Info; break;
				case 'hint': filter.severities = MarkerSeverity.Hint; break;
			}
		}

		const markers = this.markerService.read(filter);

		return markers.slice(0, 200).map(m => ({
			file: m.resource.fsPath,
			severity: severityToString(m.severity),
			message: m.message,
			code: typeof m.code === 'string' ? m.code : (m.code?.value ?? ''),
			source: m.source ?? '',
			startLine: m.startLineNumber,
			startColumn: m.startColumn,
			endLine: m.endLineNumber,
			endColumn: m.endColumn,
		}));
	}

	// ---------------------------------------------------------------------------
	// Definitions
	// ---------------------------------------------------------------------------

	async getDefinitions(filePath: string, line: number, column: number): Promise<LocationInfo[]> {
		const ref = await this.textModelService.createModelReference(URI.file(filePath));
		try {
			const model = ref.object.textEditorModel;
			const position = new Position(line, column);
			const providers = this.languageFeaturesService.definitionProvider.ordered(model);

			const results: LocationInfo[] = [];
			for (const provider of providers) {
				try {
					const defs = await provider.provideDefinition(model, position, CancellationToken.None);
					if (!defs) { continue; }
					const locations = Array.isArray(defs) ? defs : [defs];
					for (const loc of locations) {
						const l = loc as unknown as Record<string, unknown>;
						const uri = l['targetUri'] ?? l['uri'];
						const range = l['targetRange'] ?? l['range'];
						if (uri && range) {
							results.push({
								file: uri.fsPath,
								startLine: range.startLineNumber,
								startColumn: range.startColumn,
								endLine: range.endLineNumber,
								endColumn: range.endColumn,
							});
						}
					}
					if (results.length > 0) { break; } // Use first provider with results
				} catch { /* skip failing provider */ }
			}

			return results;
		} finally {
			ref.dispose();
		}
	}

	// ---------------------------------------------------------------------------
	// References
	// ---------------------------------------------------------------------------

	async getReferences(filePath: string, line: number, column: number): Promise<LocationInfo[]> {
		const ref = await this.textModelService.createModelReference(URI.file(filePath));
		try {
			const model = ref.object.textEditorModel;
			const position = new Position(line, column);
			const providers = this.languageFeaturesService.referenceProvider.ordered(model);

			const results: LocationInfo[] = [];
			for (const provider of providers) {
				try {
					const refs = await provider.provideReferences(
						model, position, { includeDeclaration: true }, CancellationToken.None,
					);
					if (!refs) { continue; }
					for (const loc of refs) {
						results.push({
							file: loc.uri.fsPath,
							startLine: loc.range.startLineNumber,
							startColumn: loc.range.startColumn,
							endLine: loc.range.endLineNumber,
							endColumn: loc.range.endColumn,
						});
					}
					if (results.length > 0) { break; }
				} catch { /* skip */ }
			}

			return results.slice(0, 50);
		} finally {
			ref.dispose();
		}
	}

	// ---------------------------------------------------------------------------
	// Hover
	// ---------------------------------------------------------------------------

	async getHover(filePath: string, line: number, column: number): Promise<string> {
		const ref = await this.textModelService.createModelReference(URI.file(filePath));
		try {
			const model = ref.object.textEditorModel;
			const position = new Position(line, column);
			const providers = this.languageFeaturesService.hoverProvider.ordered(model);

			for (const provider of providers) {
				try {
					const hover = await provider.provideHover(model, position, CancellationToken.None, undefined);
					if (!hover?.contents) { continue; }

					// Extract text from MarkdownString or string contents
					const parts: string[] = [];
					for (const content of hover.contents) {
						if (typeof content === 'string') {
							parts.push(content);
						} else if ('value' in content) {
							parts.push(content.value);
						}
					}

					if (parts.length > 0) {
						return parts.join('\n\n');
					}
				} catch { /* skip */ }
			}

			return '';
		} finally {
			ref.dispose();
		}
	}

	// ---------------------------------------------------------------------------
	// Document Symbols
	// ---------------------------------------------------------------------------

	async getDocumentSymbols(filePath: string): Promise<SymbolInfo[]> {
		const ref = await this.textModelService.createModelReference(URI.file(filePath));
		try {
			const model = ref.object.textEditorModel;
			const providers = this.languageFeaturesService.documentSymbolProvider.ordered(model);

			for (const provider of providers) {
				try {
					const symbols = await provider.provideDocumentSymbols(model, CancellationToken.None);
					if (!symbols || symbols.length === 0) { continue; }

					const mapSymbol = (s: { name: string; kind: SymbolKind; range: { startLineNumber: number; endLineNumber: number }; children?: unknown[] }): SymbolInfo => ({
						name: s.name,
						kind: symbolKindToString(s.kind),
						file: filePath,
						startLine: s.range.startLineNumber,
						endLine: s.range.endLineNumber,
						children: (s.children as typeof symbols ?? []).map(mapSymbol),
					});

					return symbols.map(mapSymbol);
				} catch { /* skip */ }
			}

			return [];
		} finally {
			ref.dispose();
		}
	}

	// ---------------------------------------------------------------------------
	// Code Actions
	// ---------------------------------------------------------------------------

	async getCodeActions(filePath: string, startLine: number, endLine: number): Promise<CodeActionInfo[]> {
		const ref = await this.textModelService.createModelReference(URI.file(filePath));
		try {
			const model = ref.object.textEditorModel;
			const range = new Range(startLine, 1, endLine, model.getLineMaxColumn(endLine));
			const providers = this.languageFeaturesService.codeActionProvider.ordered(model);

			const results: CodeActionInfo[] = [];
			for (const provider of providers) {
				try {
					const actions = await provider.provideCodeActions(
						model, range,
						{ only: undefined, trigger: 1 /* Invoke */ },
						CancellationToken.None,
					);
					if (!actions?.actions) { continue; }

					for (const action of actions.actions) {
						results.push({
							title: action.title,
							kind: action.kind ?? '',
							isPreferred: action.isPreferred ?? false,
							diagnostics: (action.diagnostics ?? []).map(d => ({
								file: filePath,
								severity: severityToString(d.severity),
								message: d.message,
								code: typeof d.code === 'string' ? d.code : '',
								source: d.source ?? '',
								startLine: d.startLineNumber,
								startColumn: d.startColumn,
								endLine: d.endLineNumber,
								endColumn: d.endColumn,
							})),
						});
					}

					actions.dispose?.();
					if (results.length > 0) { break; }
				} catch { /* skip */ }
			}

			return results.slice(0, 20);
		} finally {
			ref.dispose();
		}
	}
}
