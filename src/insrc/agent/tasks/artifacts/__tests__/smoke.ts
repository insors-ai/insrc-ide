/**
 * Artifact kinds -- end-to-end smoke script.
 *
 * Exercises the full pipeline (source-fetch -> source-render ->
 * template-bind) for every kind, against deterministic fixtures or
 * a mock LLM provider. No Kuzu DB required: kinds that would hit
 * Kuzu (sequence / flow code / ER Kuzu branch) run here in their
 * free-text-scaffold mode.
 *
 * Usage:
 *     cd /path/to/insrc-ide
 *     npx tsx scripts/test-artifacts-smoke.ts
 *
 * Expected output: "ALL KINDS OK" after every row shows `[ok]`.
 * Any `[fail]` row prints the reason + exits non-zero.
 *
 * User-memory note: this script is NOT auto-run. Invoke explicitly.
 */

import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { ArtifactResult } from '../../../../shared/artifacts.js';
import type {
	LLMMessage, LLMProvider, LLMResponse,
} from '../../../../shared/types.js';

import { runWireframe } from '../kinds/wireframe.js';
import { runSequence } from '../kinds/sequence.js';
import { runFlow } from '../kinds/flow.js';
import { runEr } from '../kinds/er.js';
import { runDeployment } from '../kinds/deployment.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = `smoke-${Date.now()}`;

const PRISMA_SCHEMA = `
model User {
  id    String @id
  email String @unique
  posts Post[]
}

model Post {
  id       String @id
  title    String
  authorId String
  author   User @relation(fields: [authorId], references: [id])
}
`;

const COMPOSE_YML = `
services:
  web:
    image: nginx:1.25
    ports: ["80:80"]
    depends_on: [api]
  api:
    image: example/api:v1
    depends_on: [db]
  db:
    image: postgres:16
`;

const K8S_YAML = `
apiVersion: apps/v1
kind: Deployment
metadata: { name: api }
spec:
  selector: { matchLabels: { app: api } }
  template:
    metadata: { labels: { app: api } }
    spec:
      containers:
        - name: api
          image: example/api:v1
---
apiVersion: v1
kind: Service
metadata: { name: api-svc }
spec:
  selector: { app: api }
`;

// ---------------------------------------------------------------------------
// Mock LLM provider that returns a valid WireframeSpec JSON.
// ---------------------------------------------------------------------------

const MOCK_LLM_RESPONSE = JSON.stringify({
	layout: 'desktop',
	rows: [
		{ height: 56, cells: [{ kind: 'header', label: 'Header' }] },
		{
			height: 'auto',
			cells: [
				{ kind: 'nav', label: 'Nav', widthRatio: 1 },
				{ kind: 'content', label: 'Main', widthRatio: 4 },
			],
		},
		{ height: 48, cells: [{ kind: 'footer', label: 'Footer' }] },
	],
}, null, 2);

function mockProvider(text: string): LLMProvider {
	return {
		async complete(_msgs: LLMMessage[]): Promise<LLMResponse> {
			return { text, stopReason: 'end_turn' };
		},
		async *stream(): AsyncIterable<string> { yield text; },
		async embed(): Promise<number[]> { return []; },
		supportsTools: false,
	};
}

// ---------------------------------------------------------------------------
// Assertions -- tiny helpers so the script stays dep-free.
// ---------------------------------------------------------------------------

type CaseResult = { name: string; ok: true } | { name: string; ok: false; reason: string };

function ok(name: string): CaseResult { return { name, ok: true }; }
function fail(name: string, reason: string): CaseResult {
	return { name, ok: false, reason };
}

function checkArtifact(name: string, result: ArtifactResult): CaseResult {
	if (result.source === '' || result.source.length < 5) {
		return fail(name, `empty source`);
	}
	if (!result.renderedHtml.embedded.includes('data-artifact-id=')) {
		return fail(name, `embedded HTML missing data-artifact-id`);
	}
	if (!result.renderedHtml.standalone.includes('data-artifact-id=')) {
		return fail(name, `standalone HTML missing data-artifact-id`);
	}
	if (result.kind !== 'wireframe') {
		// Mermaid diagram kinds should contain a Mermaid grammar marker.
		const markers = ['erDiagram', 'sequenceDiagram', 'flowchart'];
		const hasMarker = markers.some(m =>
			result.renderedHtml.embedded.includes(m) || result.source.includes(m),
		);
		if (!hasMarker) {
			return fail(name, `no Mermaid grammar marker found (source head: ${result.source.slice(0, 60)})`);
		}
	}
	return ok(name);
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

async function runCases(): Promise<CaseResult[]> {
	const results: CaseResult[] = [];
	const tmpRoot = mkdtempSync(join(tmpdir(), 'insrc-smoke-'));

	try {
		// ----- Wireframe ----------------------------------------------------

		const wfSpec = await runWireframe({
			sessionId: SESSION_ID,
			input: {
				spec: {
					layout: 'desktop',
					rows: [{ height: 48, cells: [{ kind: 'header', label: 'Caller' }] }],
				},
			},
		});
		results.push(checkArtifact('wireframe (caller spec)', wfSpec));

		const wfLlm = await runWireframe({
			sessionId: SESSION_ID,
			provider: mockProvider(MOCK_LLM_RESPONSE),
			input: { description: 'dashboard with side nav' },
		});
		results.push(checkArtifact('wireframe (LLM mock)', wfLlm));
		if (wfLlm.confidence !== 'medium') {
			results[results.length - 1] = fail(
				'wireframe (LLM mock)', `expected confidence=medium got ${wfLlm.confidence}`,
			);
		}

		const wfScaffold = await runWireframe({
			sessionId: SESSION_ID,
			input: { description: 'no provider path' },
		});
		results.push(checkArtifact('wireframe (no-provider scaffold)', wfScaffold));

		// ----- Sequence (scaffold only; Kuzu path needs a real DB) ---------

		const seqScaffold = await runSequence({
			sessionId: SESSION_ID,
			input: { description: 'user logs in' },
		});
		results.push(checkArtifact('sequence (scaffold)', seqScaffold));

		// ----- Flow -- process + code scaffolds -----------------------------

		const flowProcess = await runFlow({
			sessionId: SESSION_ID,
			input: { description: 'checkout flow', kind: 'process' },
		});
		results.push(checkArtifact('flow (process scaffold)', flowProcess));

		const flowCode = await runFlow({
			sessionId: SESSION_ID,
			input: { description: 'function body', kind: 'code' },
		});
		results.push(checkArtifact('flow (code scaffold)', flowCode));

		// ----- ER -- Prisma (structured) + scaffold branches ----------------

		mkdirSync(join(tmpRoot, 'prisma'), { recursive: true });
		const schemaPath = join(tmpRoot, 'prisma', 'schema.prisma');
		writeFileSync(schemaPath, PRISMA_SCHEMA);
		const er = await runEr({
			sessionId: SESSION_ID,
			repoRoot: tmpRoot,
			input: {},
		});
		results.push(checkArtifact('er (Prisma auto-detect)', er));
		if (!er.metadata['provenance']?.includes('Prisma')) {
			results[results.length - 1] = fail(
				'er (Prisma auto-detect)',
				`expected provenance to mention Prisma, got "${er.metadata['provenance']}"`,
			);
		}

		const erScaffold = await runEr({
			sessionId: SESSION_ID,
			input: { description: 'users and orders' },
		});
		results.push(checkArtifact('er (scaffold)', erScaffold));

		// ----- Deployment -- compose + k8s + scaffold -----------------------

		const composePath = join(tmpRoot, 'docker-compose.yml');
		writeFileSync(composePath, COMPOSE_YML);
		const deployCompose = await runDeployment({
			sessionId: SESSION_ID,
			repoRoot: tmpRoot,
			input: { fromFile: composePath },
		});
		results.push(checkArtifact('deployment (docker-compose)', deployCompose));

		const k8sPath = join(tmpRoot, 'k8s.yaml');
		writeFileSync(k8sPath, K8S_YAML);
		const deployK8s = await runDeployment({
			sessionId: SESSION_ID,
			repoRoot: tmpRoot,
			input: { fromFile: k8sPath },
		});
		results.push(checkArtifact('deployment (k8s)', deployK8s));

		const deployScaffold = await runDeployment({
			sessionId: SESSION_ID,
			input: { description: 'api + db' },
		});
		results.push(checkArtifact('deployment (scaffold)', deployScaffold));
	} finally {
		try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
	}

	return results;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	console.log('insrc artifact smoke');
	console.log('====================');

	let results: CaseResult[] = [];
	try {
		results = await runCases();
	} catch (err) {
		console.error('smoke-script crashed:', (err as Error).stack ?? err);
		process.exit(2);
	}

	let failures = 0;
	for (const r of results) {
		if (r.ok) {
			console.log(`  [ok]   ${r.name}`);
		} else {
			failures++;
			console.log(`  [fail] ${r.name} -- ${r.reason}`);
		}
	}

	console.log('--------------------');
	if (failures === 0) {
		console.log(`ALL KINDS OK (${results.length} cases)`);
		process.exit(0);
	} else {
		console.log(`FAILED (${failures}/${results.length})`);
		process.exit(1);
	}
}

main().catch((err: unknown) => {
	console.error('smoke-script crashed:', (err as Error).stack ?? err);
	process.exit(2);
});
