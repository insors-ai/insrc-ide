/**
 * Tests for agent/tasks/artifacts/kinds/deployment-sources.ts.
 *
 * Covers both the docker-compose and the k8s multi-doc manifest
 * branches, plus the auto-detection helper (`parseDeploymentSource`)
 * that picks one based on first-doc shape.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
	parseComposeSource,
	parseDeploymentSource,
	parseK8sSource,
} from '../kinds/deployment-sources.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COMPOSE = `
services:
  web:
    image: nginx:1.25
    ports:
      - "80:80"
    depends_on:
      - api
  api:
    image: ghcr.io/example/api:v1
    depends_on:
      db:
        condition: service_healthy
  db:
    image: postgres:16
    ports: ["5432:5432"]
`;

const K8S = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  selector:
    matchLabels: { app: web }
  template:
    metadata:
      labels: { app: web }
    spec:
      containers:
        - name: web
          image: nginx:1.25
          envFrom:
            - configMapRef: { name: web-config }
---
apiVersion: v1
kind: Service
metadata:
  name: web-svc
spec:
  selector: { app: web }
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web-ing
spec:
  rules:
    - http:
        paths:
          - backend: { service: { name: web-svc } }
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: web-config
data:
  KEY: value
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTempFile<T>(name: string, contents: string, fn: (path: string) => Promise<T>): Promise<T> {
	const root = mkdtempSync(join(tmpdir(), 'insrc-deploy-'));
	const p = join(root, name);
	writeFileSync(p, contents);
	return fn(p).finally(() => {
		try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
	});
}

// ---------------------------------------------------------------------------
// docker-compose
// ---------------------------------------------------------------------------

describe('parseComposeSource', () => {
	it('emits one flowchart LR node per service + one edge per depends_on', async () => {
		await withTempFile('docker-compose.yml', COMPOSE, async (path) => {
			const result = await parseComposeSource(path, undefined);
			assert.equal(result.sourceKind, 'docker-compose');
			assert.equal(result.nodeCount, 3);
			assert.ok(result.mermaidSource.startsWith('flowchart LR'));
			// Node lines: web / api / db
			assert.match(result.mermaidSource, /^\s*web\["/m);
			assert.match(result.mermaidSource, /^\s*api\["/m);
			assert.match(result.mermaidSource, /^\s*db\["/m);
			// Edges: web --> api, api --> db
			assert.match(result.mermaidSource, /web --> api/);
			assert.match(result.mermaidSource, /api --> db/);
		});
	});

	it('includes image + ports in the node label when present', async () => {
		await withTempFile('docker-compose.yml', COMPOSE, async (path) => {
			const result = await parseComposeSource(path, undefined);
			assert.ok(result.mermaidSource.includes('nginx:1.25'));
			assert.ok(result.mermaidSource.includes('ports: 80:80'));
		});
	});

	it('throws when no services are present', async () => {
		await withTempFile('empty.yml', '# nothing\n', async (path) => {
			await assert.rejects(parseComposeSource(path, undefined), /no services/);
		});
	});
});

// ---------------------------------------------------------------------------
// k8s
// ---------------------------------------------------------------------------

describe('parseK8sSource', () => {
	it('emits nodes for every recognised kind', async () => {
		await withTempFile('k8s.yaml', K8S, async (path) => {
			const result = await parseK8sSource(path, undefined);
			assert.equal(result.sourceKind, 'k8s');
			assert.equal(result.nodeCount, 4);  // Deployment + Service + Ingress + ConfigMap
			assert.ok(result.mermaidSource.startsWith('flowchart LR'));
			// The Service node uses the `[[...]]` shape.
			assert.match(result.mermaidSource, /Service_web_svc\[\["Service: web-svc"\]\]/);
			// The Ingress node uses `(((...)))`.
			assert.match(result.mermaidSource, /Ingress_web_ing\(\(\("Ingress: web-ing"\)\)\)/);
			// The ConfigMap node uses `[/.../]`.
			assert.match(result.mermaidSource, /ConfigMap_web_config\[\/"ConfigMap: web-config"\/\]/);
		});
	});

	it('connects Service -> workload via matching selector', async () => {
		await withTempFile('k8s.yaml', K8S, async (path) => {
			const result = await parseK8sSource(path, undefined);
			// Service(web-svc) selects `app=web` and the Deployment(web)
			// publishes that label -> expect an edge.
			assert.match(
				result.mermaidSource,
				/Service_web_svc --> Deployment_web/,
			);
		});
	});

	it('connects Ingress -> Service via backend ref', async () => {
		await withTempFile('k8s.yaml', K8S, async (path) => {
			const result = await parseK8sSource(path, undefined);
			assert.match(
				result.mermaidSource,
				/Ingress_web_ing --> Service_web_svc/,
			);
		});
	});

	it('draws dotted edges for ConfigMap / Secret envFrom refs', async () => {
		await withTempFile('k8s.yaml', K8S, async (path) => {
			const result = await parseK8sSource(path, undefined);
			// Deployment(web) envFrom ConfigMap(web-config)
			assert.match(
				result.mermaidSource,
				/Deployment_web -\.-> ConfigMap_web_config/,
			);
		});
	});

	it('throws when no recognised resources are present', async () => {
		const UNSUPPORTED = `
apiVersion: example.com/v1
kind: Unknown
metadata: { name: x }
`;
		await withTempFile('unknown.yaml', UNSUPPORTED, async (path) => {
			await assert.rejects(parseK8sSource(path, undefined), /no recognised/);
		});
	});
});

// ---------------------------------------------------------------------------
// Auto-detect
// ---------------------------------------------------------------------------

describe('parseDeploymentSource - auto-detect', () => {
	it('routes compose YAML to the compose parser', async () => {
		await withTempFile('compose.yml', COMPOSE, async (path) => {
			const result = await parseDeploymentSource(path, undefined);
			assert.ok(result !== null);
			assert.equal(result.sourceKind, 'docker-compose');
		});
	});

	it('routes k8s multi-doc to the k8s parser', async () => {
		await withTempFile('k8s.yaml', K8S, async (path) => {
			const result = await parseDeploymentSource(path, undefined);
			assert.ok(result !== null);
			assert.equal(result.sourceKind, 'k8s');
		});
	});

	it('returns null when the file matches neither shape', async () => {
		await withTempFile('weird.yaml', '- just: a\n- list: of\n- mappings: true\n', async (path) => {
			const result = await parseDeploymentSource(path, undefined);
			assert.equal(result, null);
		});
	});

	it('returns null when the file does not exist', async () => {
		const result = await parseDeploymentSource('/tmp/insrc-deploy-does-not-exist.yaml', undefined);
		assert.equal(result, null);
	});
});
