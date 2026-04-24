/**
 * Structured source parsers for the deployment artifact kind.
 *
 * Two branches are wired here:
 *   - docker-compose.yml (v2 / v3 "services" shape -- the common case)
 *   - k8s manifests      (multi-doc YAML: Deployment / Service /
 *                         Ingress / StatefulSet / ConfigMap / Secret)
 *
 * Each parser reads the file, builds a small in-memory model, and
 * emits a Mermaid `flowchart` source string suitable for the
 * deployment template. Neither parser shells out to docker/kubectl
 * -- the user supplies the file path, we read it directly.
 *
 * Terraform is deferred to phase 3.
 */

import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

// `js-yaml` ships no type declarations in the daemon's transitive
// install. We'd rather not pull in `@types/js-yaml` for two calls,
// and the ambient `.d.ts` next to this file works under the daemon
// tsconfig but not under the IDE's secondary compile pass. Load
// through `createRequire` so the type system doesn't look up the
// module at all; the runtime still resolves correctly.
const yaml = createRequire(import.meta.url)('js-yaml') as {
	load(input: string): unknown;
	loadAll(input: string): unknown[];
};

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

export interface DeploymentSourceResult {
	readonly mermaidSource: string;
	readonly provenance: string;
	/** Count of primary nodes in the diagram, for the metaLine. */
	readonly nodeCount: number;
	/** Descriptor used on the metaLine ("docker-compose" / "k8s" / etc.). */
	readonly sourceKind: string;
}

/**
 * Normalise a caller-supplied path. Relative paths resolve against
 * the repo root when provided, otherwise the daemon's cwd.
 */
export function resolveSourcePath(fromFile: string, repoRoot?: string): string {
	if (isAbsolute(fromFile)) { return fromFile; }
	return resolve(repoRoot ?? process.cwd(), fromFile);
}

/**
 * Sanitise a raw name into a Mermaid flowchart node id. Mermaid ids
 * must be alphanumeric-ish; swap everything else to underscores.
 */
function nodeId(raw: string, fallback: string, seen: Set<string>): string {
	let base = raw.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
	if (base === '' || /^\d/.test(base)) { base = `${fallback}_${base}`; }
	let id = base;
	let suffix = 2;
	while (seen.has(id)) {
		id = `${base}_${suffix}`;
		suffix++;
	}
	seen.add(id);
	return id;
}

/**
 * Escape a label for a Mermaid flowchart node. Square brackets +
 * double quotes + pipe are reserved; drop or swap them rather than
 * HTML-escape since the binder's narrow Mermaid-source escape runs
 * later on the full string.
 */
function mermaidLabel(raw: string): string {
	return raw.replace(/[[\]"]/g, '').replace(/\|/g, '/').trim();
}

// ---------------------------------------------------------------------------
// docker-compose parser
// ---------------------------------------------------------------------------

interface ComposeService {
	readonly name: string;
	readonly image: string | undefined;
	readonly depends: readonly string[];
	readonly networks: readonly string[];
	readonly ports: readonly string[];
}

interface ComposeFile {
	readonly services: readonly ComposeService[];
}

function parseComposeFile(raw: unknown): ComposeFile {
	const services: ComposeService[] = [];
	if (raw === null || typeof raw !== 'object') { return { services }; }
	const doc = raw as Record<string, unknown>;
	const rawServices = doc['services'];
	if (rawServices === null || typeof rawServices !== 'object' || Array.isArray(rawServices)) {
		return { services };
	}
	for (const [name, value] of Object.entries(rawServices as Record<string, unknown>)) {
		if (value === null || typeof value !== 'object') { continue; }
		const s = value as Record<string, unknown>;
		const dependsRaw = s['depends_on'];
		const depends: string[] = [];
		if (Array.isArray(dependsRaw)) {
			for (const d of dependsRaw) {
				if (typeof d === 'string') { depends.push(d); }
			}
		} else if (dependsRaw !== null && typeof dependsRaw === 'object') {
			for (const key of Object.keys(dependsRaw as Record<string, unknown>)) { depends.push(key); }
		}
		const networks: string[] = [];
		const netsRaw = s['networks'];
		if (Array.isArray(netsRaw)) {
			for (const n of netsRaw) { if (typeof n === 'string') { networks.push(n); } }
		} else if (netsRaw !== null && typeof netsRaw === 'object') {
			for (const key of Object.keys(netsRaw as Record<string, unknown>)) { networks.push(key); }
		}
		const ports: string[] = [];
		const portsRaw = s['ports'];
		if (Array.isArray(portsRaw)) {
			for (const p of portsRaw) {
				if (typeof p === 'string') { ports.push(p); }
				else if (typeof p === 'number') { ports.push(String(p)); }
			}
		}
		const image = typeof s['image'] === 'string' ? (s['image'] as string) : undefined;
		services.push({ name, image, depends, networks, ports });
	}
	return { services };
}

function renderComposeMermaid(model: ComposeFile): string {
	const lines: string[] = ['flowchart LR'];
	const seen = new Set<string>();
	const nameToId = new Map<string, string>();

	for (const svc of model.services) {
		const id = nodeId(svc.name, 'svc', seen);
		nameToId.set(svc.name, id);
		const labelParts: string[] = [svc.name];
		if (svc.image !== undefined) { labelParts.push(svc.image); }
		if (svc.ports.length > 0) { labelParts.push(`ports: ${svc.ports.join(',')}`); }
		const label = mermaidLabel(labelParts.join('\\n'));
		lines.push(`  ${id}["${label}"]`);
	}

	for (const svc of model.services) {
		const from = nameToId.get(svc.name);
		if (from === undefined) { continue; }
		for (const dep of svc.depends) {
			const to = nameToId.get(dep);
			if (to === undefined) { continue; }
			lines.push(`  ${from} --> ${to}`);
		}
	}

	return lines.join('\n');
}

export async function parseComposeSource(
	fromFile: string,
	repoRoot?: string,
): Promise<DeploymentSourceResult> {
	const abs = resolveSourcePath(fromFile, repoRoot);
	const text = await readFile(abs, 'utf8');
	const parsed = yaml.load(text);
	const model = parseComposeFile(parsed);
	if (model.services.length === 0) {
		throw new Error(`docker-compose parse found no services in ${abs}`);
	}
	return {
		mermaidSource: renderComposeMermaid(model),
		provenance: `docker-compose: ${fromFile}`,
		nodeCount: model.services.length,
		sourceKind: 'docker-compose',
	};
}

// ---------------------------------------------------------------------------
// k8s multi-doc manifest parser
// ---------------------------------------------------------------------------

const K8S_KINDS: ReadonlySet<string> = new Set([
	'Deployment',
	'StatefulSet',
	'DaemonSet',
	'Job',
	'CronJob',
	'Service',
	'Ingress',
	'ConfigMap',
	'Secret',
]);

interface K8sResource {
	readonly kind: string;
	readonly name: string;
	readonly namespace: string | undefined;
	readonly selectors: readonly string[];     // label matchers used by Service/Ingress
	readonly matchLabels: readonly string[];   // pod-template labels (Deployment/StatefulSet/DaemonSet)
	readonly backends: readonly string[];      // for Ingress -> Service references
	readonly configRefs: readonly string[];    // ConfigMap / Secret names referenced
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) { return []; }
	const out: string[] = [];
	for (const v of value) { if (typeof v === 'string') { out.push(v); } }
	return out;
}

function labelString(labels: Record<string, unknown> | undefined): string[] {
	if (labels === undefined) { return []; }
	const out: string[] = [];
	for (const [k, v] of Object.entries(labels)) {
		if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
			out.push(`${k}=${String(v)}`);
		}
	}
	return out;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function parseK8sResource(doc: unknown): K8sResource | null {
	const obj = asObject(doc);
	if (obj === undefined) { return null; }
	const kind = obj['kind'];
	if (typeof kind !== 'string' || !K8S_KINDS.has(kind)) { return null; }
	const metadata = asObject(obj['metadata']);
	const name = metadata !== undefined && typeof metadata['name'] === 'string' ? metadata['name'] : undefined;
	if (name === undefined) { return null; }
	const namespace = metadata !== undefined && typeof metadata['namespace'] === 'string'
		? (metadata['namespace'] as string)
		: undefined;

	const spec = asObject(obj['spec']);
	const selectors: string[] = [];
	const matchLabels: string[] = [];
	const backends: string[] = [];
	const configRefs: string[] = [];

	if (spec !== undefined) {
		if (kind === 'Service') {
			selectors.push(...labelString(asObject(spec['selector'])));
		} else if (kind === 'Ingress') {
			const rules = spec['rules'];
			if (Array.isArray(rules)) {
				for (const rule of rules) {
					const ruleObj = asObject(rule);
					const http = ruleObj !== undefined ? asObject(ruleObj['http']) : undefined;
					const paths = http !== undefined ? http['paths'] : undefined;
					if (Array.isArray(paths)) {
						for (const p of paths) {
							const pObj = asObject(p);
							const backend = pObj !== undefined ? asObject(pObj['backend']) : undefined;
							const svc = backend !== undefined ? asObject(backend['service']) : undefined;
							const svcName = svc !== undefined && typeof svc['name'] === 'string' ? (svc['name'] as string) : undefined;
							if (svcName !== undefined) { backends.push(svcName); }
						}
					}
				}
			}
		} else {
			// Deployment / StatefulSet / DaemonSet / Job / CronJob -- extract the
			// pod-template label set so Services can match against it.
			const selector = asObject(spec['selector']);
			const ml = selector !== undefined ? asObject(selector['matchLabels']) : undefined;
			matchLabels.push(...labelString(ml));

			const template = asObject(spec['template']);
			const tmplMeta = template !== undefined ? asObject(template['metadata']) : undefined;
			const tmplLabels = tmplMeta !== undefined ? asObject(tmplMeta['labels']) : undefined;
			matchLabels.push(...labelString(tmplLabels));

			// Collect configmap / secret references from env + volumes.
			const tmplSpec = template !== undefined ? asObject(template['spec']) : undefined;
			if (tmplSpec !== undefined) {
				const containers = tmplSpec['containers'];
				if (Array.isArray(containers)) {
					for (const c of containers) {
						const cObj = asObject(c);
						const envFrom = cObj !== undefined ? cObj['envFrom'] : undefined;
						if (Array.isArray(envFrom)) {
							for (const e of envFrom) {
								const eObj = asObject(e);
								const cmRef = eObj !== undefined ? asObject(eObj['configMapRef']) : undefined;
								const seRef = eObj !== undefined ? asObject(eObj['secretRef']) : undefined;
								if (cmRef !== undefined && typeof cmRef['name'] === 'string') { configRefs.push(cmRef['name'] as string); }
								if (seRef !== undefined && typeof seRef['name'] === 'string') { configRefs.push(seRef['name'] as string); }
							}
						}
					}
				}
				const volumes = tmplSpec['volumes'];
				if (Array.isArray(volumes)) {
					for (const v of volumes) {
						const vObj = asObject(v);
						const cm = vObj !== undefined ? asObject(vObj['configMap']) : undefined;
						const se = vObj !== undefined ? asObject(vObj['secret']) : undefined;
						if (cm !== undefined && typeof cm['name'] === 'string') { configRefs.push(cm['name'] as string); }
						if (se !== undefined && typeof se['secretName'] === 'string') { configRefs.push(se['secretName'] as string); }
					}
				}
			}
		}
	}

	// `stringArray` is defined above as a helper reserved for a
	// future label-value parsing pass; mark as intentionally unused
	// so strict tsc doesn't flag it.
	void stringArray;

	return {
		kind,
		name,
		namespace,
		selectors: Array.from(new Set(selectors)),
		matchLabels: Array.from(new Set(matchLabels)),
		backends: Array.from(new Set(backends)),
		configRefs: Array.from(new Set(configRefs)),
	};
}

function k8sNodeShape(kind: string): [string, string] {
	// Mermaid node shape characters -- [square], (round), [(db)], etc.
	switch (kind) {
		case 'Service':     return ['[[', ']]'];
		case 'Ingress':     return ['(((', ')))'];
		case 'ConfigMap':   return ['[/', '/]'];
		case 'Secret':      return ['[/', '/]'];
		case 'Job':
		case 'CronJob':     return ['[\\', '\\]'];
		case 'DaemonSet':
		case 'StatefulSet':
		case 'Deployment':  return ['[', ']'];
		default:            return ['[', ']'];
	}
}

function renderK8sMermaid(resources: readonly K8sResource[]): string {
	const lines: string[] = ['flowchart LR'];
	const seen = new Set<string>();
	const ids = new Map<string, string>();                // key `${kind}:${name}` -> id

	for (const r of resources) {
		const id = nodeId(`${r.kind}_${r.name}`, r.kind.toLowerCase(), seen);
		ids.set(`${r.kind}:${r.name}`, id);
		const [open, close] = k8sNodeShape(r.kind);
		const label = mermaidLabel(`${r.kind}: ${r.name}`);
		lines.push(`  ${id}${open}"${label}"${close}`);
	}

	// Services -> workloads that match their selector labels.
	for (const svc of resources.filter(r => r.kind === 'Service')) {
		const fromId = ids.get(`Service:${svc.name}`);
		if (fromId === undefined || svc.selectors.length === 0) { continue; }
		for (const target of resources) {
			if (target.kind === 'Service' || target.kind === 'Ingress' || target.kind === 'ConfigMap' || target.kind === 'Secret') { continue; }
			const matches = svc.selectors.every(sel => target.matchLabels.includes(sel));
			if (!matches) { continue; }
			const toId = ids.get(`${target.kind}:${target.name}`);
			if (toId === undefined) { continue; }
			lines.push(`  ${fromId} --> ${toId}`);
		}
	}

	// Ingress -> Service backends.
	for (const ing of resources.filter(r => r.kind === 'Ingress')) {
		const fromId = ids.get(`Ingress:${ing.name}`);
		if (fromId === undefined) { continue; }
		for (const backend of ing.backends) {
			const toId = ids.get(`Service:${backend}`);
			if (toId === undefined) { continue; }
			lines.push(`  ${fromId} --> ${toId}`);
		}
	}

	// Workloads -> ConfigMap / Secret references.
	for (const r of resources) {
		if (r.configRefs.length === 0) { continue; }
		const fromId = ids.get(`${r.kind}:${r.name}`);
		if (fromId === undefined) { continue; }
		for (const ref of r.configRefs) {
			const cmId = ids.get(`ConfigMap:${ref}`);
			const seId = ids.get(`Secret:${ref}`);
			const toId = cmId ?? seId;
			if (toId === undefined) { continue; }
			lines.push(`  ${fromId} -.-> ${toId}`);
		}
	}

	return lines.join('\n');
}

export async function parseK8sSource(
	fromFile: string,
	repoRoot?: string,
): Promise<DeploymentSourceResult> {
	const abs = resolveSourcePath(fromFile, repoRoot);
	const text = await readFile(abs, 'utf8');
	const docs = yaml.loadAll(text);
	const resources: K8sResource[] = [];
	for (const doc of docs) {
		const parsed = parseK8sResource(doc);
		if (parsed !== null) { resources.push(parsed); }
	}
	if (resources.length === 0) {
		throw new Error(`k8s parse found no recognised resources in ${abs}`);
	}
	return {
		mermaidSource: renderK8sMermaid(resources),
		provenance: `k8s: ${fromFile}`,
		nodeCount: resources.length,
		sourceKind: 'k8s',
	};
}

// ---------------------------------------------------------------------------
// Auto-detect compose vs k8s from file content
// ---------------------------------------------------------------------------

/**
 * Sniff the YAML to pick a parser. Compose files have a top-level
 * `services:` key; k8s manifests have `apiVersion` + `kind`. Returns
 * null when neither pattern matches (caller falls back to default
 * scaffold with a warning).
 */
export async function parseDeploymentSource(
	fromFile: string,
	repoRoot?: string,
): Promise<DeploymentSourceResult | null> {
	const abs = resolveSourcePath(fromFile, repoRoot);
	let text: string;
	try {
		text = await readFile(abs, 'utf8');
	} catch {
		return null;
	}
	// k8s manifests are often multi-doc; try that first and fall back
	// to compose if no recognised resources are found.
	try {
		const docs = yaml.loadAll(text);
		const firstDoc = docs[0];
		if (firstDoc !== null && typeof firstDoc === 'object' && !Array.isArray(firstDoc)) {
			const obj = firstDoc as Record<string, unknown>;
			if (typeof obj['apiVersion'] === 'string' && typeof obj['kind'] === 'string') {
				return await parseK8sSource(fromFile, repoRoot);
			}
			if (obj['services'] !== undefined) {
				return await parseComposeSource(fromFile, repoRoot);
			}
		}
	} catch {
		// Fall through to null below.
	}
	return null;
}
