/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Infra-target template catalog. Four templates: family discovery,
 * per-family inventory (kubernetes + terraform), aggregator. Mirrors
 * the foundational set from design/analyze-framework-infrastructure.md
 * "Discovery family" + "Inventory family". Helm / GHA / Compose /
 * Ansible / Pulumi / CloudFormation inventory templates land in
 * subsequent commits.
 */

import type { AnalyzeTaskTemplate } from '../../types.js';
import {
	AGGREGATOR_INPUT_SCHEMA,
	AGGREGATOR_OUTPUT_SCHEMA,
	SCOPE_REF_SCHEMA,
} from '../shared-schemas.js';
import { registerTemplate } from '../registry.js';

export const infraDiscoveryFamilies: AnalyzeTaskTemplate = {
	id:          'infra.discovery.families',
	target:      'infra',
	family:      'discovery',
	kind:        'leaf',
	revision:    'r1',
	description: 'Detect every IaC family present in scope (terraform, kubernetes, helm, github-actions, gitlab-ci, docker-compose, ansible, pulumi, cloudformation).',
	inputSchema: {
		type:                 'object',
		additionalProperties: false,
		required:             ['scopeRef'],
		properties: {
			scopeRef: SCOPE_REF_SCHEMA,
		},
	},
	produces:    ['families'],
};

export const infraInventoryKubernetes: AnalyzeTaskTemplate = {
	id:          'infra.inventory.kubernetes',
	target:      'infra',
	family:      'inventory',
	kind:        'leaf',
	revision:    'r1',
	description: 'Enumerate Kubernetes manifests in scope + their resource kinds, namespaces, labels.',
	inputSchema: {
		type:                 'object',
		additionalProperties: false,
		required:             ['scopeRef'],
		properties: {
			scopeRef: SCOPE_REF_SCHEMA,
		},
	},
	produces:    ['k8s-inventory'],
};

export const infraInventoryTerraform: AnalyzeTaskTemplate = {
	id:          'infra.inventory.terraform',
	target:      'infra',
	family:      'inventory',
	kind:        'leaf',
	revision:    'r1',
	description: 'Enumerate Terraform configurations in scope + their resources, providers, modules, variables.',
	inputSchema: {
		type:                 'object',
		additionalProperties: false,
		required:             ['scopeRef'],
		properties: {
			scopeRef: SCOPE_REF_SCHEMA,
		},
	},
	produces:    ['tf-inventory'],
};

export const infraAggregateReport: AnalyzeTaskTemplate = {
	id:           'infra.aggregate.report',
	target:       'infra',
	family:       'aggregate',
	kind:         'leaf',
	revision:     'r1',
	description:  'Terminal aggregator for infra-target plans. Consumes every upstream task output + emits the final report.',
	inputSchema:  AGGREGATOR_INPUT_SCHEMA,
	outputSchema: AGGREGATOR_OUTPUT_SCHEMA,
	produces:     ['report'],
	isAggregator: true,
};

export const INFRA_TEMPLATES: readonly AnalyzeTaskTemplate[] = [
	infraDiscoveryFamilies,
	infraInventoryKubernetes,
	infraInventoryTerraform,
	infraAggregateReport,
];

export function registerInfraTemplates(): void {
	for (const t of INFRA_TEMPLATES) {
		registerTemplate(t);
	}
}
