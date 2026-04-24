/**
 * Terraform plan parser for the deployment artifact kind.
 *
 * Input: the JSON output of `terraform show -json plan.tfplan`.
 * We never shell out to `terraform` ourselves; the user pre-generates
 * the plan and points us at the file.
 *
 * Output: a Mermaid `flowchart LR` with one node per resource and
 * one edge per `depends_on` entry. A small curated catalog assigns
 * a visually-distinctive shape to well-known resource types (AWS /
 * k8s / GCP / Azure essentials); anything else falls back to a
 * generic rectangle so unknown resources still render cleanly.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { DeploymentSourceResult } from './deployment-sources.js';

// ---------------------------------------------------------------------------
// Minimal shape of the bits of the Terraform plan JSON we read.
// ---------------------------------------------------------------------------

interface TfModule {
	readonly resources?: readonly TfResource[];
	readonly child_modules?: readonly TfModule[];
}

interface TfResource {
	readonly address: string;
	readonly type: string;
	readonly name: string;
	readonly mode?: string;
	readonly depends_on?: readonly string[];
}

interface TfPlan {
	readonly format_version?: string;
	readonly terraform_version?: string;
	readonly planned_values?: { readonly root_module?: TfModule };
}

// ---------------------------------------------------------------------------
// Shape catalog for well-known resource types
// ---------------------------------------------------------------------------

/**
 * Mermaid node shape chars (`open` / `close`) per known Terraform
 * resource `type`. Unknown types fall back to `['[', ']']` -- plain
 * rectangle. These match the k8s shape idiom in
 * `deployment-sources.ts` so the two families look consistent.
 */
const SHAPE_CATALOG: ReadonlyMap<string, readonly [string, string]> = new Map<string, readonly [string, string]>([
	// Compute
	['aws_instance',            ['[', ']']],
	['aws_ecs_service',         ['[', ']']],
	['aws_ecs_task_definition', ['[\\', '\\]']],
	['aws_lambda_function',     ['[/', '\\]']],
	['google_compute_instance', ['[', ']']],
	['google_cloud_run_service',['[/', '\\]']],
	['azurerm_virtual_machine', ['[', ']']],
	['azurerm_app_service',     ['[/', '\\]']],
	['kubernetes_deployment',   ['[', ']']],
	['kubernetes_stateful_set', ['[', ']']],
	['kubernetes_daemon_set',   ['[', ']']],
	['kubernetes_job',          ['[\\', '\\]']],
	['kubernetes_cron_job',     ['[\\', '\\]']],
	// Load balancers / ingress
	['aws_lb',                  ['[[', ']]']],
	['aws_lb_target_group',     ['[[', ']]']],
	['aws_api_gateway_rest_api',['[[', ']]']],
	['kubernetes_service',      ['[[', ']]']],
	['kubernetes_ingress',      ['(((', ')))']],
	// Datastores
	['aws_db_instance',         ['[(', ')]']],
	['aws_rds_cluster',         ['[(', ')]']],
	['aws_dynamodb_table',      ['[(', ')]']],
	['aws_s3_bucket',           ['[(', ')]']],
	['aws_elasticache_cluster', ['[(', ')]']],
	['google_sql_database_instance',     ['[(', ')]']],
	['google_storage_bucket',            ['[(', ')]']],
	['azurerm_sql_database',             ['[(', ')]']],
	['azurerm_storage_account',          ['[(', ')]']],
	// Messaging
	['aws_sqs_queue',           ['(', ')']],
	['aws_sns_topic',           ['(', ')']],
	['aws_kinesis_stream',      ['(', ')']],
	['google_pubsub_topic',     ['(', ')']],
	// Networking / config
	['aws_vpc',                 ['{{', '}}']],
	['aws_subnet',              ['{{', '}}']],
	['aws_security_group',      ['([', '])']],
	['aws_route53_zone',        ['((', '))']],
	['kubernetes_config_map',   ['[/', '/]']],
	['kubernetes_secret',       ['[/', '/]']],
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function resolveSourcePath(fromFile: string, repoRoot?: string): string {
	return isAbsolute(fromFile) ? fromFile : resolve(repoRoot ?? process.cwd(), fromFile);
}

/** Mermaid node id must be alphanumeric-ish; swap everything else. */
function nodeId(raw: string, seen: Set<string>): string {
	let base = raw.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
	if (base === '' || /^\d/.test(base)) { base = `res_${base}`; }
	let id = base;
	let suffix = 2;
	while (seen.has(id)) {
		id = `${base}_${suffix}`;
		suffix++;
	}
	seen.add(id);
	return id;
}

function mermaidLabel(raw: string): string {
	return raw.replace(/[[\]"]/g, '').replace(/\|/g, '/').trim();
}

function shapeFor(type: string): readonly [string, string] {
	return SHAPE_CATALOG.get(type) ?? ['[', ']'];
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Is this parsed JSON blob a Terraform plan? Checks the two
 * easy-to-verify fields `terraform show -json` always emits.
 */
export function isTerraformPlan(doc: unknown): doc is TfPlan {
	if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) { return false; }
	const obj = doc as Record<string, unknown>;
	return typeof obj['terraform_version'] === 'string'
		&& obj['planned_values'] !== undefined;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function collectResources(module: TfModule | undefined, out: TfResource[]): void {
	if (module === undefined) { return; }
	if (Array.isArray(module.resources)) {
		for (const r of module.resources) {
			if (r !== null && typeof r === 'object' && typeof r.address === 'string') {
				out.push(r);
			}
		}
	}
	if (Array.isArray(module.child_modules)) {
		for (const child of module.child_modules) { collectResources(child, out); }
	}
}

function renderTerraformMermaid(resources: readonly TfResource[]): string {
	const lines: string[] = ['flowchart LR'];
	const seen = new Set<string>();
	const idByAddress = new Map<string, string>();

	for (const r of resources) {
		const id = nodeId(r.address, seen);
		idByAddress.set(r.address, id);
		const [open, close] = shapeFor(r.type);
		// Label: type + short name to keep the diagram scannable; the
		// full address is already reflected in the id / data-attribute.
		const label = mermaidLabel(`${r.type}\\n${r.name}`);
		lines.push(`  ${id}${open}"${label}"${close}`);
	}

	for (const r of resources) {
		if (!Array.isArray(r.depends_on) || r.depends_on.length === 0) { continue; }
		const fromId = idByAddress.get(r.address);
		if (fromId === undefined) { continue; }
		for (const dep of r.depends_on) {
			if (typeof dep !== 'string') { continue; }
			const toId = idByAddress.get(dep);
			if (toId === undefined) { continue; }
			lines.push(`  ${fromId} --> ${toId}`);
		}
	}

	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export async function parseTerraformPlan(
	path: string,
	repoRoot?: string,
): Promise<DeploymentSourceResult> {
	const abs = resolveSourcePath(path, repoRoot);
	const text = await readFile(abs, 'utf8');
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		throw new Error(`Terraform plan at '${abs}' is not valid JSON: ${(err as Error).message}`);
	}
	if (!isTerraformPlan(parsed)) {
		throw new Error(
			`file at '${abs}' doesn't look like a 'terraform show -json' output ` +
			'(missing terraform_version + planned_values)',
		);
	}

	const resources: TfResource[] = [];
	collectResources(parsed.planned_values?.root_module, resources);
	if (resources.length === 0) {
		throw new Error(`Terraform plan '${abs}' has no managed resources to render`);
	}

	return {
		mermaidSource: renderTerraformMermaid(resources),
		provenance: `terraform plan: ${path}`,
		nodeCount: resources.length,
		sourceKind: 'terraform',
	};
}

/**
 * Try Terraform-plan parse. Returns null when the file isn't a
 * terraform plan (caller falls through to compose/k8s detection).
 */
export async function tryParseTerraformPlan(
	path: string,
	repoRoot?: string,
): Promise<DeploymentSourceResult | null> {
	const abs = resolveSourcePath(path, repoRoot);
	let text: string;
	try {
		text = await readFile(abs, 'utf8');
	} catch {
		return null;
	}
	// Cheap prefix check: a Terraform plan JSON always starts with '{';
	// YAML manifests typically don't. Skip the JSON parse on anything
	// that doesn't look like JSON at all.
	const trimmed = text.trimStart();
	if (!trimmed.startsWith('{')) { return null; }
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (!isTerraformPlan(parsed)) { return null; }
	return parseTerraformPlan(path, repoRoot);
}
