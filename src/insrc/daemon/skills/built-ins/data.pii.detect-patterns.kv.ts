/**
 * data.pii.detect-patterns.kv -- Phase 5e.1 (KV-side variant).
 *
 * Samples values from a KV connection's namespace, walks the value
 * tree to flatten leaves into strings, and runs the same PII regex
 * catalog as the rdbms / file variants. Caller targets a namespace
 * via `namespace`; if omitted, the skill samples every namespace
 * `db_kv_list_namespaces` returns (capped to keep the round-trip
 * count bounded).
 */

import { registerSkill } from '../registry.js';
import type { Skill, SkillDeps, SkillResult } from '../types.js';
import {
	type PiiDetectPatternsOutput,
	PII_OUTPUT_SCHEMA,
	buildPiiDetectionsFromValues,
	clampPiiSample,
	emptyPii,
} from './data.pii.detect-patterns.algo.js';

interface PiiDetectPatternsKvInput {
	readonly connectionId: string;
	/** Namespace to sample. If omitted, the skill enumerates via
	 *  `db_kv_list_namespaces` and samples up to `maxNamespaces`. */
	readonly namespace?: string;
	readonly maxNamespaces?: number;
	readonly sampleSize?: number;
}

const KV_FAMILY_TAGS = [
	'kv',
	'redis', 'valkey', 'keydb',
	'mongodb', 'cassandra',
	'nats', 'dynamodb', 'etcd', 'memcached',
] as const;

interface NamespaceListRaw {
	readonly namespaces: readonly { readonly name: string }[];
	readonly truncated: boolean;
	readonly supported: boolean;
}

interface ScanResultRaw {
	readonly keys: readonly (string | Readonly<Record<string, unknown>>)[];
	readonly truncated: boolean;
}

interface KvValueRaw {
	readonly key: unknown;
	readonly value: unknown;
	readonly type: string;
}

function isNamespaceList(v: unknown): v is NamespaceListRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return Array.isArray(o['namespaces']);
}

function isScanResult(v: unknown): v is ScanResultRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return Array.isArray(o['keys']);
}

function isKvValue(v: unknown): v is KvValueRaw {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return typeof o['type'] === 'string' && 'value' in o;
}

/**
 * Walk a JSON-ish value tree and emit each leaf as a string. Used to
 * flatten document-store values (Mongo, Redis-with-JSON) into the
 * regex catalog's input shape.
 */
function flattenLeaves(v: unknown, out: string[]): void {
	if (v === null || v === undefined) return;
	if (typeof v === 'string') { out.push(v); return; }
	if (typeof v === 'number' || typeof v === 'boolean') { out.push(String(v)); return; }
	if (Array.isArray(v)) {
		for (const x of v) flattenLeaves(x, out);
		return;
	}
	if (typeof v === 'object') {
		for (const x of Object.values(v as Record<string, unknown>)) flattenLeaves(x, out);
		return;
	}
}

const skill: Skill<PiiDetectPatternsKvInput, PiiDetectPatternsOutput> = {
	id: 'data.pii.detect-patterns.kv',
	name: 'PII: detect patterns (KV)',
	description:
		'Sample values from a KV connection (one namespace or many) and apply the same PII regex catalog as ' +
		'the rdbms / file variants. Walks nested document values; each leaf is a candidate match. Reports per-' +
		'pattern hit count + rate + examples.',
	family: 'sensitivity',
	owner: 'data-analyzer',
	version: 1,
	inputs: {
		type: 'object',
		properties: {
			connectionId:  { type: 'string' },
			namespace:     { type: 'string', description: 'Specific namespace (Mongo collection / Cassandra table / NATS bucket / Redis prefix). Omit to enumerate via db_kv_list_namespaces.' },
			maxNamespaces: { type: 'integer', minimum: 1, maximum: 20, description: 'When `namespace` is omitted, cap the number of namespaces sampled. Default 5.' },
			sampleSize:    { type: 'integer', minimum: 1, maximum: 50, description: 'Default 50 (the tool cap).' },
		},
		required: ['connectionId'],
		additionalProperties: false,
	},
	outputs: PII_OUTPUT_SCHEMA,
	toolDeps: ['db_kv_scan', 'db_kv_get', 'db_kv_list_namespaces'],
	providerAffinity: 'local',
	preconditions: [
		{ kind: 'required-tools', tools: ['db_kv_scan', 'db_kv_get'], reason: 'scan + get supply the values we regex over' },
		{ kind: 'connection-family', families: KV_FAMILY_TAGS, reason: 'KV-only' },
	],

	async execute(input, deps): Promise<SkillResult<PiiDetectPatternsOutput>> {
		const callBase = `skill-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
		const sampleSize = clampPiiSample(input.sampleSize);
		const target = input.namespace ?? input.connectionId;

		const namespaces = await resolveNamespaces(input, deps, callBase);
		if (typeof namespaces === 'string') {
			return { value: emptyPii(target, '<kv>', sampleSize), confidence: 'low', notes: [namespaces], toolCalls: [] };
		}
		if (namespaces.length === 0) {
			return { value: emptyPii(target, '<kv>', sampleSize), confidence: 'low', notes: ['no namespaces to scan'], toolCalls: [] };
		}

		const allValues: string[] = [];
		const sampledNamespaces: string[] = [];
		for (let i = 0; i < namespaces.length; i++) {
			const ns = namespaces[i]!;
			const scanInput: Record<string, unknown> = { connectionId: input.connectionId, limit: sampleSize };
			// Mongo / Cassandra / DynamoDB take the namespace via `prefix`.
			scanInput['prefix'] = ns;
			const scanRes = await deps.runTool({ id: `${callBase}-scan-${i}`, name: 'db_kv_scan', input: scanInput });
			if (scanRes.isError) continue;
			if (!isScanResult(scanRes.data)) continue;
			sampledNamespaces.push(ns);
			for (let k = 0; k < Math.min(scanRes.data.keys.length, sampleSize); k++) {
				const key = scanRes.data.keys[k]!;
				const getRes = await deps.runTool({
					id: `${callBase}-get-${i}-${k}`,
					name: 'db_kv_get',
					input: { connectionId: input.connectionId, key },
				});
				if (getRes.isError || !isKvValue(getRes.data)) continue;
				flattenLeaves(getRes.data.value, allValues);
				if (allValues.length >= sampleSize * 10) break;
			}
		}

		const out = buildPiiDetectionsFromValues(target, sampledNamespaces.join(','), allValues);
		const hasMatches = out.detections.length > 0;
		return {
			value: out,
			confidence: hasMatches ? 'high' : (out.sampleSize > 0 ? 'medium' : 'low'),
			toolCalls: [],
		};
	},
};

async function resolveNamespaces(
	input: PiiDetectPatternsKvInput,
	deps: SkillDeps,
	callBase: string,
): Promise<readonly string[] | string> {
	if (input.namespace !== undefined && input.namespace.length > 0) return [input.namespace];
	const cap = Math.min(Math.max(1, Math.floor(input.maxNamespaces ?? 5)), 20);
	const listRes = await deps.runTool({
		id: `${callBase}-ns`,
		name: 'db_kv_list_namespaces',
		input: { connectionId: input.connectionId, limit: cap },
	});
	if (listRes.isError) return `db_kv_list_namespaces error: ${listRes.content.slice(0, 200)}`;
	if (!isNamespaceList(listRes.data)) return 'db_kv_list_namespaces returned a result without the expected structured data shape';
	return listRes.data.namespaces.map(n => n.name).slice(0, cap);
}

export function registerDataPiiDetectPatternsKvSkill(): void {
	registerSkill(skill as unknown as Skill);
}
