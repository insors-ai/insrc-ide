/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Procix Software India. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Runtime: code.discovery.modules
 *
 * Enumerates the modules in the task's scope (per its scopeRef param)
 * via the LMDB graph layer's entity store.
 *
 * Output:
 *   { modules: Array<{ name, path, repo, fileCount? }> }
 *
 * Supported scopeRef kinds in this commit:
 *   - 'repo'      : list every kind='module' entity in the given repo
 *   - 'manifest-dir': resolve manifest dir -> repo path, then same as 'repo'
 *
 * Future scopeRef kinds ('module', 'file', 'symbol', 'workspace') get
 * folded in as the discovery family grows -- each requires its own
 * traversal pattern + test fixture. For now, an unsupported kind
 * surfaces as a runtime error so the template/inputSchema contract
 * stays the unique source of truth.
 *
 * Deterministic: no LLM involvement. Same graph state -> same output.
 */

import { getLogger } from '../../../shared/logger.js';
import { getDb } from '../../../db/client.js';
import { listEntitiesForRepo } from '../../../db/entities.js';

import type {
	TemplateExecuteArgs,
	TemplateExecuteResult,
	TemplateRuntime,
} from '../../executor/types.js';

const log = getLogger('analyze:runtimes:code:discovery-modules');

interface ModuleRecord {
	readonly name:     string;
	readonly path:     string;
	readonly repo:     string;
	readonly entityId: string;
}

export const codeDiscoveryModulesRuntime: TemplateRuntime = {
	templateId: 'code.discovery.modules',

	async execute(args: TemplateExecuteArgs): Promise<TemplateExecuteResult> {
		const scopeRef = readScopeRef(args);
		const repoPath = resolveRepoPath(scopeRef);

		const db       = await getDb();
		const entities = await listEntitiesForRepo(db, repoPath);
		const modules: ModuleRecord[] = [];
		for (const e of entities) {
			if (e.kind !== 'module') continue;
			modules.push({
				name:     e.name,
				path:     e.file,
				repo:     e.repo,
				entityId: e.id,
			});
		}

		// Deterministic order: by module path, ascending. Plans don't
		// see iteration noise across runs.
		modules.sort((a, b) => a.path.localeCompare(b.path));

		log.info(
			{
				runId:    args.runId,
				taskId:   args.task.taskId,
				repoPath,
				moduleCount: modules.length,
			},
			'code.discovery.modules: enumerated modules',
		);

		return {
			outputs: new Map<string, unknown>([['modules', modules]]),
		};
	},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ScopeRef {
	readonly kind:  string;
	readonly value: string;
}

function readScopeRef(args: TemplateExecuteArgs): ScopeRef {
	// Per the template's inputSchema, params.scopeRef is required. If
	// it's missing, INV-5 should have rejected the plan at validation
	// time -- defense-in-depth only.
	const raw = (args.task.params as Record<string, unknown>)['scopeRef'];
	if (raw === null || typeof raw !== 'object') {
		throw new Error(
			`code.discovery.modules: task.params.scopeRef missing (taskId=${args.task.taskId}). ` +
				'INV-5 should have rejected this plan -- check the planner validator.',
		);
	}
	const obj  = raw as Record<string, unknown>;
	const kind = obj['kind'];
	const value = obj['value'];
	if (typeof kind !== 'string' || typeof value !== 'string') {
		throw new Error(
			`code.discovery.modules: task.params.scopeRef has wrong shape (taskId=${args.task.taskId})`,
		);
	}
	return { kind, value };
}

function resolveRepoPath(scopeRef: ScopeRef): string {
	switch (scopeRef.kind) {
		case 'repo':
		case 'manifest-dir':
			return scopeRef.value;
		default:
			throw new Error(
				`code.discovery.modules: scopeRef.kind='${scopeRef.kind}' not supported yet. ` +
					'Supported in this revision: repo, manifest-dir.',
			);
	}
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

export const _readScopeRefForTest    = readScopeRef;
export const _resolveRepoPathForTest = resolveRepoPath;
