/**
 * Deployment diagram artifact kind.
 *
 * Source priority (first match wins):
 *   1. Caller-supplied Mermaid `source` -- rendered verbatim.
 *   2. `fromFile` pointing at a docker-compose.yml OR k8s manifest --
 *      parser auto-detects via first-doc shape, emits a flowchart.
 *   3. Free-text `description` -- three-tier scaffold
 *      (client -> service -> datastore).
 *
 * Terraform plan parse is phase 3.
 */

import { getLogger } from '../../../../shared/logger.js';
import type {
	ArtifactResult,
	DeploymentOptions,
} from '../../../../shared/artifacts.js';
import type { KindRunOpts } from '../registry.js';
import {
	cleanOneLine,
	runMermaidArtifact,
	truncate,
	type MermaidCommonInput,
} from './shared-mermaid.js';
import { parseDeploymentSource } from './deployment-sources.js';

const log = getLogger('artifact-kind-deployment');

export interface DeploymentInput extends MermaidCommonInput, DeploymentOptions {}

function nodeLabel(raw: string, fallback: string): string {
	const cleaned = cleanOneLine(raw, fallback)
		.replace(/[[\]"]/g, '')
		.replace(/\|/g, '/');
	return cleaned === '' ? fallback : cleaned;
}

function defaultSource(description: string): string {
	const service = nodeLabel(description, 'service');
	return [
		'flowchart LR',
		'  Client([Client])',
		`  Service["${service}"]`,
		'  Datastore[(Datastore)]',
		'  Client --> Service --> Datastore',
	].join('\n');
}

export interface RunDeploymentOpts extends KindRunOpts {
	readonly input: DeploymentInput;
}

export async function runDeployment(opts: RunDeploymentOpts): Promise<ArtifactResult> {
	const { input } = opts;
	const warnings: string[] = [];

	let mermaidSource: string;
	let provenance: string;
	let confidence: 'high' | 'medium' | 'low';
	let metaLineSuffix = '';

	if (input.source !== undefined && input.source.trim() !== '') {
		mermaidSource = input.source;
		provenance = 'caller-supplied Mermaid source';
		confidence = 'high';
	} else if (input.fromFile !== undefined && input.fromFile.trim() !== '') {
		const parsed = await parseDeploymentSource(input.fromFile, opts.repoRoot)
			.catch(err => {
				warnings.push(
					`Config-file parse failed for '${input.fromFile}': ${(err as Error).message}. ` +
					'Returned a free-text scaffold instead.',
				);
				return null;
			});
		if (parsed !== null) {
			mermaidSource = parsed.mermaidSource;
			provenance = parsed.provenance;
			confidence = 'high';
			metaLineSuffix = ` · ${parsed.nodeCount} node${parsed.nodeCount === 1 ? '' : 's'}`;
		} else {
			if (warnings.length === 0) {
				warnings.push(
					`Config-file '${input.fromFile}' did not match docker-compose or ` +
					'k8s shapes (Terraform is phase 3). Returned a free-text scaffold instead.',
				);
			}
			mermaidSource = defaultSource(input.description ?? '');
			provenance = 'free-text (default scaffold)';
			confidence = 'low';
		}
	} else {
		mermaidSource = defaultSource(input.description ?? '');
		provenance = 'free-text (default scaffold)';
		confidence = 'low';
	}

	const descLabel = truncate(cleanOneLine(input.description, 'scaffold'), 48);
	const title = input.title?.trim() !== undefined && input.title.trim() !== ''
		? input.title.trim()
		: `Deployment: ${descLabel}`;

	const metadata: Record<string, string> = {};
	if (input.fromFile !== undefined) { metadata['fromFile'] = input.fromFile; }

	log.info({
		sessionId: opts.sessionId,
		provenance,
		confidence,
		hasCallerSource: input.source !== undefined,
		fromFile: input.fromFile,
	}, 'deployment artifact generated');

	return runMermaidArtifact(
		{
			kind: 'deployment',
			title,
			mermaidSource,
			metaLine: provenance + metaLineSuffix,
			provenance,
			confidence,
			warnings,
			metadata,
		},
		opts,
	);
}
