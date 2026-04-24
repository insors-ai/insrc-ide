/**
 * Tests for agent/tasks/artifacts/kinds/terraform-source.ts.
 *
 * Uses `terraform show -json` shaped fixtures (subsets -- we only
 * read planned_values.root_module + terraform_version +
 * format_version). Verifies resource extraction, depends_on edges,
 * shape-catalog assignment, child-module recursion, and the
 * auto-detect fast path through tryParseTerraformPlan.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
	isTerraformPlan,
	parseTerraformPlan,
	tryParseTerraformPlan,
} from '../kinds/terraform-source.js';
import { parseDeploymentSource } from '../kinds/deployment-sources.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TF_SIMPLE = {
	format_version: '1.2',
	terraform_version: '1.5.0',
	planned_values: {
		root_module: {
			resources: [
				{
					address: 'aws_vpc.main',
					type: 'aws_vpc',
					name: 'main',
					mode: 'managed',
				},
				{
					address: 'aws_subnet.web',
					type: 'aws_subnet',
					name: 'web',
					mode: 'managed',
					depends_on: ['aws_vpc.main'],
				},
				{
					address: 'aws_instance.web',
					type: 'aws_instance',
					name: 'web',
					mode: 'managed',
					depends_on: ['aws_subnet.web', 'aws_security_group.web'],
				},
				{
					address: 'aws_security_group.web',
					type: 'aws_security_group',
					name: 'web',
					mode: 'managed',
					depends_on: ['aws_vpc.main'],
				},
				{
					address: 'aws_db_instance.primary',
					type: 'aws_db_instance',
					name: 'primary',
					mode: 'managed',
					depends_on: ['aws_subnet.web'],
				},
			],
		},
	},
};

const TF_WITH_CHILD_MODULES = {
	format_version: '1.2',
	terraform_version: '1.5.0',
	planned_values: {
		root_module: {
			resources: [
				{ address: 'aws_s3_bucket.root', type: 'aws_s3_bucket', name: 'root' },
			],
			child_modules: [
				{
					resources: [
						{ address: 'module.api.aws_lambda_function.handler', type: 'aws_lambda_function', name: 'handler' },
					],
					child_modules: [
						{
							resources: [
								{ address: 'module.api.module.db.aws_dynamodb_table.items', type: 'aws_dynamodb_table', name: 'items' },
							],
						},
					],
				},
			],
		},
	},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTempJson<T>(
	name: string,
	payload: unknown,
	fn: (path: string) => Promise<T>,
): Promise<T> {
	const root = mkdtempSync(join(tmpdir(), 'insrc-tf-'));
	const p = join(root, name);
	writeFileSync(p, JSON.stringify(payload));
	return fn(p).finally(() => {
		try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
	});
}

// ---------------------------------------------------------------------------
// isTerraformPlan
// ---------------------------------------------------------------------------

describe('isTerraformPlan', () => {
	it('accepts a shape with terraform_version + planned_values', () => {
		assert.equal(isTerraformPlan(TF_SIMPLE), true);
	});

	it('rejects missing terraform_version', () => {
		assert.equal(isTerraformPlan({ planned_values: {} }), false);
	});

	it('rejects missing planned_values', () => {
		assert.equal(isTerraformPlan({ terraform_version: '1.5.0' }), false);
	});

	it('rejects non-objects', () => {
		assert.equal(isTerraformPlan(null), false);
		assert.equal(isTerraformPlan(42), false);
		assert.equal(isTerraformPlan([]), false);
		assert.equal(isTerraformPlan('plan'), false);
	});
});

// ---------------------------------------------------------------------------
// parseTerraformPlan - main happy path
// ---------------------------------------------------------------------------

describe('parseTerraformPlan', () => {
	it('emits a flowchart LR with one node per resource', async () => {
		await withTempJson('plan.json', TF_SIMPLE, async (path) => {
			const result = await parseTerraformPlan(path);
			assert.equal(result.sourceKind, 'terraform');
			assert.equal(result.nodeCount, 5);
			assert.ok(result.mermaidSource.startsWith('flowchart LR'));
			// One node line per resource (address-based ids).
			assert.match(result.mermaidSource, /aws_vpc_main\{\{/);
			assert.match(result.mermaidSource, /aws_subnet_web\{\{/);
			assert.match(result.mermaidSource, /aws_instance_web\[/);
			assert.match(result.mermaidSource, /aws_security_group_web\(\[/);
			assert.match(result.mermaidSource, /aws_db_instance_primary\[\(/);
		});
	});

	it('emits one edge per depends_on entry', async () => {
		await withTempJson('plan.json', TF_SIMPLE, async (path) => {
			const result = await parseTerraformPlan(path);
			// depends_on references: subnet->vpc, instance->subnet, instance->sg, sg->vpc, db->subnet
			assert.match(result.mermaidSource, /aws_subnet_web --> aws_vpc_main/);
			assert.match(result.mermaidSource, /aws_instance_web --> aws_subnet_web/);
			assert.match(result.mermaidSource, /aws_instance_web --> aws_security_group_web/);
			assert.match(result.mermaidSource, /aws_security_group_web --> aws_vpc_main/);
			assert.match(result.mermaidSource, /aws_db_instance_primary --> aws_subnet_web/);
		});
	});

	it('recurses into child modules (module.api + module.api.module.db)', async () => {
		await withTempJson('plan.json', TF_WITH_CHILD_MODULES, async (path) => {
			const result = await parseTerraformPlan(path);
			assert.equal(result.nodeCount, 3);
			assert.match(result.mermaidSource, /aws_s3_bucket_root\[\(/);
			assert.match(result.mermaidSource, /module_api_aws_lambda_function_handler\[\//);
			assert.match(result.mermaidSource, /module_api_module_db_aws_dynamodb_table_items\[\(/);
		});
	});

	it('uses fallback rectangle shape for unknown resource types', async () => {
		await withTempJson('unknown.json', {
			format_version: '1.2',
			terraform_version: '1.5.0',
			planned_values: {
				root_module: {
					resources: [
						{ address: 'random_uuid.id', type: 'random_uuid', name: 'id' },
					],
				},
			},
		}, async (path) => {
			const result = await parseTerraformPlan(path);
			assert.equal(result.nodeCount, 1);
			// Generic `["..."]` rectangle.
			assert.match(result.mermaidSource, /random_uuid_id\["/);
		});
	});

	it('throws when the file contains no resources', async () => {
		await withTempJson('empty.json', {
			format_version: '1.2',
			terraform_version: '1.5.0',
			planned_values: { root_module: { resources: [] } },
		}, async (path) => {
			await assert.rejects(parseTerraformPlan(path), /no managed resources/);
		});
	});

	it('throws on non-JSON input', async () => {
		const root = mkdtempSync(join(tmpdir(), 'insrc-tf-bad-'));
		const p = join(root, 'plan.json');
		writeFileSync(p, 'not valid json');
		try {
			await assert.rejects(parseTerraformPlan(p), /not valid JSON/);
		} finally {
			try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});
});

// ---------------------------------------------------------------------------
// tryParseTerraformPlan -- detection fast path
// ---------------------------------------------------------------------------

describe('tryParseTerraformPlan', () => {
	it('returns a result when the file is a TF plan', async () => {
		await withTempJson('plan.json', TF_SIMPLE, async (path) => {
			const result = await tryParseTerraformPlan(path);
			assert.ok(result !== null);
			assert.equal(result.sourceKind, 'terraform');
		});
	});

	it('returns null for JSON that is not a TF plan shape', async () => {
		await withTempJson('other.json', { hello: 'world' }, async (path) => {
			const result = await tryParseTerraformPlan(path);
			assert.equal(result, null);
		});
	});

	it('returns null for non-JSON content', async () => {
		const root = mkdtempSync(join(tmpdir(), 'insrc-tf-yaml-'));
		const p = join(root, 'file.yaml');
		writeFileSync(p, 'services:\n  web: {}\n');
		try {
			const result = await tryParseTerraformPlan(p);
			assert.equal(result, null);
		} finally {
			try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});
});

// ---------------------------------------------------------------------------
// Auto-detect integration with parseDeploymentSource
// ---------------------------------------------------------------------------

describe('parseDeploymentSource - Terraform auto-detect', () => {
	it('routes a TF plan JSON to the Terraform parser', async () => {
		await withTempJson('plan.json', TF_SIMPLE, async (path) => {
			const result = await parseDeploymentSource(path);
			assert.ok(result !== null);
			assert.equal(result.sourceKind, 'terraform');
			assert.equal(result.nodeCount, 5);
		});
	});

	it('returns null for JSON that is not a TF plan + not compose/k8s', async () => {
		await withTempJson('random.json', { not: 'a plan' }, async (path) => {
			const result = await parseDeploymentSource(path);
			assert.equal(result, null);
		});
	});
});
