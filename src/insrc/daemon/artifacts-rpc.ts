/**
 * Artifacts RPC handlers -- template introspection + user-override
 * seeding for the template-editing commands on the workbench side
 * (plans/artifact-tasks.md §2.3).
 *
 * Three wire entries are exposed from `daemon/index.ts`:
 *   - `artifacts.listTemplates`      -- TemplateInfo[] per kind
 *   - `artifacts.ensureUserTemplate` -- copy bundled -> user if
 *                                       missing, return user path
 *   - `artifacts.resetUserTemplate`  -- delete user override if
 *                                       present, return the path
 *                                       that was removed (or null)
 *
 * Keeps the workbench commands dependency-free from the daemon's
 * file layout -- all path knowledge stays inside this module.
 */

import { copyFile, mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getLogger } from '../shared/logger.js';
import { PATHS } from '../shared/paths.js';
import {
	ARTIFACT_KINDS,
	isArtifactKind,
	type ArtifactKind,
	type TemplateInfo,
} from '../shared/artifacts.js';
import {
	clearTemplateCache,
	listTemplates,
} from '../agent/tasks/artifacts/template-loader.js';

const log = getLogger('artifacts-rpc');

// ---------------------------------------------------------------------------
// User-override path layout (kept in sync with template-loader.ts)
// ---------------------------------------------------------------------------

const USER_TEMPLATE_DIR = join(PATHS.insrc, 'artifacts', 'templates');

function userTemplatePath(userDir: string, kind: ArtifactKind): string {
	return join(userDir, `${kind}.html`);
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException | undefined)?.code;
		if (code === 'ENOENT') { return false; }
		throw err;
	}
}

// ---------------------------------------------------------------------------
// artifacts.listTemplates
// ---------------------------------------------------------------------------

export interface ListTemplatesParams {
	readonly repoRoot?: string | undefined;
}

export async function listTemplatesRpc(
	params: unknown,
): Promise<readonly TemplateInfo[]> {
	const p = (params ?? {}) as Partial<ListTemplatesParams>;
	const opts: { repoRoot?: string } = {};
	if (typeof p.repoRoot === 'string' && p.repoRoot.length > 0) {
		opts.repoRoot = p.repoRoot;
	}
	return listTemplates(opts);
}

// ---------------------------------------------------------------------------
// artifacts.ensureUserTemplate
// ---------------------------------------------------------------------------

export interface EnsureUserTemplateParams {
	readonly kind: string;
}

export interface EnsureUserTemplateResult {
	readonly kind: ArtifactKind;
	/** Absolute path to the user-override file, created if it
	 *  didn't exist. */
	readonly userPath: string;
	/** True when the file was just seeded from the bundled template;
	 *  false when it already existed. */
	readonly seeded: boolean;
}

export async function ensureUserTemplateRpc(
	params: unknown,
): Promise<EnsureUserTemplateResult> {
	return ensureUserTemplate(params, USER_TEMPLATE_DIR);
}

/**
 * Functional core of `ensureUserTemplateRpc`, exposed for tests that
 * want to redirect the user-override dir to a tmp path. Production
 * callers should use `ensureUserTemplateRpc` which plugs in
 * `USER_TEMPLATE_DIR`.
 */
export async function ensureUserTemplate(
	params: unknown,
	userDir: string,
): Promise<EnsureUserTemplateResult> {
	const p = (params ?? {}) as Partial<EnsureUserTemplateParams>;
	if (typeof p.kind !== 'string' || !isArtifactKind(p.kind)) {
		throw new Error(
			`artifacts.ensureUserTemplate: 'kind' must be one of ${ARTIFACT_KINDS.join(', ')}`,
		);
	}
	const kind: ArtifactKind = p.kind;
	const dest = userTemplatePath(userDir, kind);

	if (await fileExists(dest)) {
		return { kind, userPath: dest, seeded: false };
	}

	// Not present -- find the bundled version via the loader (so we
	// follow the same layering rules: if a repo override exists we'd
	// STILL seed from bundled, since the point of editing the user
	// override is to shadow the repo copy too). The loader returns
	// `layer: 'bundled'` with the absolute path when nothing else is
	// set; we read that path directly.
	const infos = await listTemplates();
	const info = infos.find(i => i.kind === kind && i.layer === 'bundled');
	if (info === undefined) {
		throw new Error(
			`artifacts.ensureUserTemplate: no bundled template for kind '${kind}' -- daemon install is incomplete`,
		);
	}

	const contents = await readFile(info.path, 'utf8');
	await mkdir(dirname(dest), { recursive: true });
	await copyFile(info.path, dest);
	void contents; // readFile doubles as existence check; copyFile writes
	// Ensure any cached resolution picks up the new user-layer file
	// on next read.
	clearTemplateCache();
	log.info({ kind, from: info.path, to: dest }, 'seeded user template from bundled');
	return { kind, userPath: dest, seeded: true };
}

// ---------------------------------------------------------------------------
// artifacts.resetUserTemplate
// ---------------------------------------------------------------------------

export interface ResetUserTemplateParams {
	readonly kind: string;
}

export interface ResetUserTemplateResult {
	readonly kind: ArtifactKind;
	/** Path that was deleted, or null when no override existed. */
	readonly removedPath: string | null;
}

export async function resetUserTemplateRpc(
	params: unknown,
): Promise<ResetUserTemplateResult> {
	return resetUserTemplate(params, USER_TEMPLATE_DIR);
}

/** Functional core of `resetUserTemplateRpc`. See `ensureUserTemplate` above. */
export async function resetUserTemplate(
	params: unknown,
	userDir: string,
): Promise<ResetUserTemplateResult> {
	const p = (params ?? {}) as Partial<ResetUserTemplateParams>;
	if (typeof p.kind !== 'string' || !isArtifactKind(p.kind)) {
		throw new Error(
			`artifacts.resetUserTemplate: 'kind' must be one of ${ARTIFACT_KINDS.join(', ')}`,
		);
	}
	const kind: ArtifactKind = p.kind;
	const dest = userTemplatePath(userDir, kind);

	if (!(await fileExists(dest))) {
		return { kind, removedPath: null };
	}

	await unlink(dest);
	clearTemplateCache();
	log.info({ kind, path: dest }, 'user-template override removed');
	return { kind, removedPath: dest };
}
