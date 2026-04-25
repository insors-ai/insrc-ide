/**
 * ER diagram artifact kind.
 *
 * Source priority (first match wins; failures soft-fall through):
 *   1. Caller-supplied Mermaid `source` -- rendered verbatim.
 *   2. Live DB via `db:sql:describe` -- when `connection` is set
 *      and `tables` is non-empty. Per-table describe() composed
 *      into an `erDiagram` with FK relationship lines. Probe /
 *      describe failure falls through.
 *   3. Prisma `schema.prisma` parse -- hand-rolled regex parser
 *      emits an `erDiagram` with entity blocks + relation edges.
 *      No @prisma/internals dep.
 *   4. `tables` or `entityIds` against the Kuzu entity graph --
 *      picks up class / interface / type entities + their
 *      REFERENCES edges.
 *   5. Free-text `description` + optional `tables` -- default scaffold.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { getLogger } from '../../../../shared/logger.js';
import type {
	ArtifactResult,
	ErOptions,
} from '../../../../shared/artifacts.js';
import type { KindRunOpts } from '../registry.js';
import {
	cleanOneLine,
	runMermaidArtifact,
	truncate,
	type MermaidCommonInput,
} from './shared-mermaid.js';
import {
	parseKuzuEntitiesSource,
	parseLiveDbSource,
	parsePrismaSource,
} from './er-sources.js';

const log = getLogger('artifact-kind-er');

export interface ErInput extends MermaidCommonInput, ErOptions {}

/** Mermaid ER entity names must match `[A-Z_][A-Z0-9_]*`; normalise. */
function erEntityName(raw: string, fallback: string): string {
	const upper = raw.toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/^_+|_+$/g, '');
	return upper === '' ? fallback : upper;
}

function defaultSource(description: string, tables: readonly string[] | undefined): string {
	const lines: string[] = ['erDiagram'];
	const intent = cleanOneLine(description, 'entity');
	if (tables !== undefined && tables.length > 0) {
		// Emit each requested table as an entity with an id + a description
		// column. Relationships between requested tables aren't inferred
		// in phase 1 -- the scaffold is placeholder enough to confirm the
		// pipeline end-to-end.
		for (const raw of tables) {
			const name = erEntityName(raw, 'ENTITY');
			lines.push(`  ${name} {`);
			lines.push('    string id PK');
			lines.push(`    string description "${intent}"`);
			lines.push('  }');
		}
	} else {
		lines.push('  ENTITY {');
		lines.push('    string id PK');
		lines.push(`    string description "${intent}"`);
		lines.push('  }');
		lines.push('  RELATED {');
		lines.push('    string id PK');
		lines.push('    string entityId FK');
		lines.push('  }');
		lines.push('  ENTITY ||--o{ RELATED : has');
	}
	return lines.join('\n');
}

export interface RunErOpts extends KindRunOpts {
	readonly input: ErInput;
}

/**
 * Look for a Prisma schema at the conventional locations under the
 * repo root. Returns the absolute path when found.
 */
function findPrismaSchema(repoRoot: string): string | null {
	const candidates = [
		join(repoRoot, 'prisma', 'schema.prisma'),
		join(repoRoot, 'schema.prisma'),
	];
	for (const c of candidates) {
		if (existsSync(c)) { return c; }
	}
	return null;
}

export async function runEr(opts: RunErOpts): Promise<ArtifactResult> {
	const { input } = opts;
	const warnings: string[] = [];

	let mermaidSource: string;
	let provenance: string;
	let confidence: 'high' | 'medium' | 'low';
	let metaLineSuffix = '';

	if (input.source !== undefined && input.source.trim() !== '') {
		// 1. Caller-supplied Mermaid.
		mermaidSource = input.source;
		provenance = 'caller-supplied Mermaid source';
		confidence = 'high';
		return finalise();
	}

	// 2. Live DB via the data-driver pool. Only when both `connection`
	// and `tables` are explicitly set. Probe / describe failure soft-
	// falls through to the Prisma / Kuzu / scaffold chain.
	if (
		input.connection !== undefined && input.connection.trim() !== ''
		&& input.tables !== undefined && input.tables.length > 0
		&& opts.repoRoot !== undefined
	) {
		const liveResult = await parseLiveDbSource({
			connection: input.connection.trim(),
			tables: input.tables,
			repoRoot: opts.repoRoot,
		}).catch(err => {
			warnings.push(
				`Live DB ER for connection '${input.connection}' failed: ${(err as Error).message}. ` +
				'Falling through to Prisma / Kuzu / scaffold.',
			);
			return null;
		});
		if (liveResult !== null) {
			mermaidSource = liveResult.mermaidSource;
			provenance = liveResult.provenance;
			confidence = 'high';
			metaLineSuffix = ` · ${liveResult.entityCount} table${liveResult.entityCount === 1 ? '' : 's'}`;
			return finalise();
		}
	} else if (input.connection !== undefined && input.connection.trim() !== '') {
		// `connection` set but `tables` empty (or repoRoot missing) --
		// surface the prereq so the LLM knows to retry with tables.
		warnings.push(
			`Live DB ER needs an explicit \`tables\` list (no \`db:sql:list_tables\` exists). ` +
			'Falling through to Prisma / Kuzu / scaffold.',
		);
	}

	// 3. Prisma schema.
	const prismaPath = opts.repoRoot !== undefined ? findPrismaSchema(opts.repoRoot) : null;
	const prismaHint = input.description !== undefined && /\bprisma\b/i.test(input.description);
	if (prismaPath !== null && (prismaHint || input.tables === undefined)) {
		const prismaResult = await parsePrismaSource(
			isAbsolute(prismaPath) ? prismaPath : resolve(opts.repoRoot ?? process.cwd(), prismaPath),
			opts.repoRoot,
		).catch(err => {
			warnings.push(
				`Prisma schema parse failed: ${(err as Error).message}. ` +
				'Falling through to Kuzu / scaffold.',
			);
			return null;
		});
		if (prismaResult !== null) {
			mermaidSource = prismaResult.mermaidSource;
			provenance = prismaResult.provenance;
			confidence = 'high';
			metaLineSuffix = ` · ${prismaResult.entityCount} model${prismaResult.entityCount === 1 ? '' : 's'}`;
			return finalise();
		}
	}

	// 4. Kuzu entity-graph traversal.
	if ((input.entityIds !== undefined && input.entityIds.length > 0)
		|| (input.tables !== undefined && input.tables.length > 0)) {
		const kuzuResult = await parseKuzuEntitiesSource({
			...(input.entityIds !== undefined ? { entityIds: input.entityIds } : {}),
			...(input.tables !== undefined ? { names: input.tables } : {}),
			...(opts.repoRoot !== undefined ? { repoPath: opts.repoRoot } : {}),
		}).catch(err => {
			warnings.push(
				`Kuzu entity-graph traversal failed: ${(err as Error).message}. ` +
				'Falling through to scaffold.',
			);
			return null;
		});
		if (kuzuResult !== null) {
			mermaidSource = kuzuResult.mermaidSource;
			provenance = kuzuResult.provenance;
			confidence = 'medium';
			metaLineSuffix = ` · ${kuzuResult.entityCount} entit${kuzuResult.entityCount === 1 ? 'y' : 'ies'}`;
			return finalise();
		}
	}

	// 5. Default scaffold.
	mermaidSource = defaultSource(input.description ?? '', input.tables);
	provenance = 'free-text (default scaffold)';
	confidence = 'low';

	return finalise();

	function finalise(): Promise<ArtifactResult> {
		const descLabel = truncate(cleanOneLine(input.description, 'scaffold'), 48);
		const title = input.title?.trim() !== undefined && input.title.trim() !== ''
			? input.title.trim()
			: `ER: ${descLabel}`;

		const metadata: Record<string, string> = {};
		if (input.connection !== undefined) { metadata['connection'] = input.connection; }
		if (input.tables !== undefined && input.tables.length > 0) {
			metadata['tables'] = input.tables.join(',');
		}

		log.info({
			sessionId: opts.sessionId,
			provenance,
			confidence,
			tables: input.tables?.length ?? 0,
			hasCallerSource: input.source !== undefined,
		}, 'er artifact generated');

		return runMermaidArtifact(
			{
				kind: 'er',
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
}
