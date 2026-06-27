/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Data-target template catalog. Four templates: discovery (connections
 * + objects), per-object schema, aggregator. Mirrors the foundational
 * set from design/analyze-framework-data.md "Discovery family" +
 * "Schema family". Subsequent fanout (distribution, relationship,
 * PII, format, lineage, constraint, volume) lands in later commits.
 */

import type { AnalyzeTaskTemplate } from '../../types.js';
import {
	AGGREGATOR_INPUT_SCHEMA,
	AGGREGATOR_OUTPUT_SCHEMA,
} from '../shared-schemas.js';
import { registerTemplate } from '../registry.js';

export const dataDiscoveryConnections: AnalyzeTaskTemplate = {
	id:          'data.discovery.connections',
	target:      'data',
	family:      'discovery',
	kind:        'leaf',
	revision:    'r1',
	description: 'Enumerate every registered data connection in scope: id + driver kind + label + family.',
	inputSchema: {
		type:                 'object',
		additionalProperties: false,
		properties: {
			scopeRefValue: { type: 'string', minLength: 1 },
		},
	},
	produces:    ['connections'],
};

export const dataDiscoveryObjects: AnalyzeTaskTemplate = {
	id:          'data.discovery.objects',
	target:      'data',
	family:      'discovery',
	kind:        'leaf',
	revision:    'r1',
	description: 'Enumerate the tables / files / collections / namespaces in a registered connection. Use `kind` to filter (table | file | collection | namespace).',
	inputSchema: {
		type:                 'object',
		additionalProperties: false,
		required:             ['connectionId'],
		properties: {
			connectionId: { type: 'string', minLength: 1 },
			kind:         { type: 'string', enum: ['table', 'file', 'collection', 'namespace'] },
		},
	},
	produces:    ['objects'],
};

export const dataSchemaTable: AnalyzeTaskTemplate = {
	id:          'data.schema.table',
	target:      'data',
	family:      'schema',
	kind:        'leaf',
	revision:    'r1',
	description: 'Describe the schema of a single SQL table: columns + types + nullability + indexes + FKs.',
	inputSchema: {
		type:                 'object',
		additionalProperties: false,
		required:             ['connectionId', 'table'],
		properties: {
			connectionId: { type: 'string', minLength: 1 },
			table:        { type: 'string', minLength: 1 },
			depth:        { type: 'string', enum: ['shallow', 'deep'] },
		},
	},
	produces:    ['table-schema'],
};

export const dataAggregateReport: AnalyzeTaskTemplate = {
	id:           'data.aggregate.report',
	target:       'data',
	family:       'aggregate',
	kind:         'leaf',
	revision:     'r1',
	description:  'Terminal aggregator for data-target plans. Consumes every upstream task output + emits the final report.',
	inputSchema:  AGGREGATOR_INPUT_SCHEMA,
	outputSchema: AGGREGATOR_OUTPUT_SCHEMA,
	produces:     ['report'],
	isAggregator: true,
};

export const DATA_TEMPLATES: readonly AnalyzeTaskTemplate[] = [
	dataDiscoveryConnections,
	dataDiscoveryObjects,
	dataSchemaTable,
	dataAggregateReport,
];

export function registerDataTemplates(): void {
	for (const t of DATA_TEMPLATES) {
		registerTemplate(t);
	}
}
